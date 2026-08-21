import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import RATE_WINDOW
from app.api.deps import AuthContext, client_ip, get_auth_context, get_db, normalize_email
from app.config import settings
from app.models import EmailChangeRequest, MagicLinkToken, Person, Session
from app.security import hash_token
from app.services.email import send_email

router = APIRouter(prefix="/me", tags=["me"])

MAX_DISPLAY_NAME_LENGTH = 120

# One hour, not the magic link's 15 minutes: the person has to reach a
# DIFFERENT inbox, possibly on another device, and a link that dies mid-task
# trains people to distrust it.
EMAIL_CHANGE_TOKEN_TTL = timedelta(hours=1)
# Same window and ceiling as /auth/request-link, keyed per person.
MAX_EMAIL_CHANGE_REQUESTS_PER_PERSON = 5

# The one and only /me/email-change success body. Byte-identical whether or
# not the target address already belongs to another account — a signed-in
# prober is still a prober, and this is the same enumeration oracle CK-5
# closed on /auth/request-link. It must never gain a send-status field.
# Pinned by test.
EMAIL_CHANGE_RESPONSE = {
    "detail": "If that address can receive email, a confirmation link is on its way."
}

# The neutral historical label an anonymized person's contributions are
# attributed to (decision record 2026-08-19). Deliberately lowercase — it
# reads as a description in "shared by a former member", not as a name.
ANONYMIZED_DISPLAY_NAME = "a former member"


@lru_cache(maxsize=1)
def iana_zones() -> frozenset[str]:
    # available_timezones() walks the tzdata files, so compute once per
    # process. The set includes links/aliases (Asia/Calcutta, US/Eastern),
    # which browsers still report — accept them; render-time normalization is
    # not this endpoint's job.
    return frozenset(available_timezones())


class ProfilePatch(BaseModel):
    # Nothing else on people is patchable. Email is deliberately NOT here —
    # changing the sign-in address is a security surface of its own (CK-9),
    # never a settings-form field. extra="forbid" makes an attempt a 422
    # instead of a silent no-op.
    model_config = ConfigDict(extra="forbid")

    display_name: Optional[str] = None
    timezone: Optional[str] = None

    @field_validator("display_name")
    @classmethod
    def _non_blank(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("display name cannot be empty")
        if len(value) > MAX_DISPLAY_NAME_LENGTH:
            raise ValueError(f"display name is limited to {MAX_DISPLAY_NAME_LENGTH} characters")
        return value

    @field_validator("timezone")
    @classmethod
    def _recognized_iana_zone(cls, value: Optional[str]) -> Optional[str]:
        # An IANA zone NAME, never a UTC offset: offsets are wrong twice a year
        # and carry no DST rules. Validated against the tz database rather than
        # a hand-maintained list.
        if value is None:
            return None
        if value not in iana_zones():
            raise ValueError("not a recognized IANA time zone (e.g. America/Chicago)")
        return value

    @model_validator(mode="after")
    def _something_to_patch(self) -> "ProfilePatch":
        if self.display_name is None and self.timezone is None:
            raise ValueError("nothing to update — provide display_name and/or timezone")
        return self


def _profile_body(person: Person) -> dict:
    return {
        "id": str(person.id),
        "display_name": person.display_name,
        "email": person.email,
        "timezone": person.timezone,
        "updated_at": person.updated_at.isoformat() if person.updated_at else None,
    }


@router.get("/profile")
async def get_profile(ctx: AuthContext = Depends(get_auth_context)) -> dict:
    return _profile_body(ctx.person)


@router.patch("/profile")
async def patch_profile(
    body: ProfilePatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    person = ctx.person
    if body.display_name is not None:
        person.display_name = body.display_name
    if body.timezone is not None:
        person.timezone = body.timezone
    person.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _profile_body(person)


class EmailChangeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_email: str

    @field_validator("new_email")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return normalize_email(value)


@router.post("/email-change", status_code=202)
async def request_email_change(
    body: EmailChangeBody,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Start an email change (CK-9). Email is the credential, not a profile
    field — nothing moves until the person proves control of the new inbox by
    opening the link sent there. The current address gets a plain notice (no
    link, no token, no new address) so a hijacked session is VISIBLE to the
    real owner rather than silent.
    """
    person = ctx.person
    now = datetime.now(timezone.utc)

    # Rate limit per person, same window and ceiling as /auth/request-link.
    # Counted over ALL request rows — a row is inserted below whether or not
    # the target address is free, precisely so this count cannot diverge
    # between the two cases (a 429 that only free addresses can trip would be
    # the enumeration oracle wearing a rate limit).
    request_count = await db.scalar(
        select(func.count())
        .select_from(EmailChangeRequest)
        .where(
            EmailChangeRequest.person_id == person.id,
            EmailChangeRequest.created_at > now - RATE_WINDOW,
        )
    )
    if request_count >= MAX_EMAIL_CHANGE_REQUESTS_PER_PERSON:
        raise HTTPException(429, "Too many email change requests. Try again later.")

    # A new request supersedes any outstanding one, in both branches alike.
    await db.execute(
        update(EmailChangeRequest)
        .where(
            EmailChangeRequest.person_id == person.id,
            EmailChangeRequest.consumed_at.is_(None),
            EmailChangeRequest.expires_at > now,
        )
        .values(expires_at=now)
    )

    # Taken = held by ANY account, the requester's own included (changing to
    # your current address is a no-op wearing a request). The caller must not
    # be able to tell: same response, same DB writes, and the only branch
    # difference below is whether the verification link goes out.
    taken = (
        await db.execute(select(Person.id).where(Person.email == body.new_email))
    ).first() is not None

    raw_token = secrets.token_urlsafe(32)
    db.add(
        EmailChangeRequest(
            person_id=person.id,
            requested_session_id=ctx.session.id,
            new_email=body.new_email,
            token_hash=hash_token(raw_token),
            expires_at=now + EMAIL_CHANGE_TOKEN_TTL,
            requested_ip=client_ip(request),
        )
    )
    # Commit before any send, mirroring /auth/request-link: the request row
    # exists whether or not delivery works. When the address is taken the raw
    # token simply goes out of scope here — never sent, never stored, and the
    # row it hashes into is an unusable rate-limit tally.
    await db.commit()

    if not taken:
        # The link goes to the NEW address: controlling that inbox is the
        # entire proof.
        send_email(
            to=body.new_email,
            subject="Confirm your new Covey Keep sign-in email",
            body=(
                "A request was made to make this address the sign-in email for a "
                "Covey Keep account.\n\n"
                f"Confirm the change: {settings.api_base_url}/auth/email-change/verify?token={raw_token}\n\n"
                "This link expires in 1 hour and can be used once. If you didn't "
                "expect this, you can ignore this email and nothing will change."
            ),
        )

    # The old address is notified in both branches: a change WAS requested, and
    # this notice is what makes a session hijack visible to the real owner.
    # Deliberately no action link, no token, and no mention of the new address
    # — this goes to a party who may no longer control the account. A send
    # failure degrades (send_email never raises) and must not fail the request.
    if person.email is not None:
        send_email(
            to=person.email,
            subject="A change to your Covey Keep sign-in email was requested",
            body=(
                "Someone signed in to your Covey Keep account asked to change its "
                "sign-in email address just now.\n\n"
                "If this was you, check the new address's inbox for the "
                "confirmation link.\n\n"
                "If this wasn't you, someone with access to your account made the "
                "request. You can cancel it from Settings, and your sign-in email "
                "will not change unless the confirmation link is used."
            ),
        )
    return EMAIL_CHANGE_RESPONSE


@router.delete("/email-change", status_code=204)
async def cancel_email_change(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Cancel any outstanding email-change request (the settings screen's
    pending-state cancel, and the remedy the old-address notice points at).
    Idempotent: nothing outstanding is still a 204."""
    now = datetime.now(timezone.utc)
    await db.execute(
        update(EmailChangeRequest)
        .where(
            EmailChangeRequest.person_id == ctx.person.id,
            EmailChangeRequest.consumed_at.is_(None),
            EmailChangeRequest.expires_at > now,
        )
        .values(expires_at=now)
    )
    await db.commit()


class DeleteAccountBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm: str

    @field_validator("confirm")
    @classmethod
    def _typed_confirmation(cls, value: str) -> str:
        # The literal string, exactly — no trimming, no case-folding. The
        # typed confirmation is the whole point of the field; a forgiving
        # match would quietly weaken it.
        if value != "DELETE":
            raise ValueError('account deletion requires the exact confirmation "DELETE"')
        return value


@router.post("/delete", status_code=204)
async def delete_account(
    body: DeleteAccountBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Account deletion by anonymization (CK-8, decision record 2026-08-19).

    Identity and auth material are destroyed; contributions stay where they
    are, attributed to the anonymized row — cascade deletion would let any
    member hollow out every group they ever contributed to. Irreversibility is
    a requirement: nothing derived from the old address (hash, fingerprint)
    may be stored anywhere. `tos_acceptances` is deliberately retained — the
    audit record of contract formation, now pointing at a row with no PII.
    """
    person = ctx.person
    old_email = person.email
    now = datetime.now(timezone.utc)

    person.email = None
    person.display_name = ANONYMIZED_DISPLAY_NAME
    person.timezone = None
    person.anonymized_at = now
    person.updated_at = now

    # Hard-delete (not revoke) every piece of auth material: all email-change
    # requests (their rows carry unverified addresses — leaving them behind
    # would be retained PII after a promised erasure, CK-9), all sessions —
    # every device, not just this one — and any magic-link tokens for the old
    # address, consumed or not, since their rows carry the address itself.
    # Requests go first: their requested_session_id FK references sessions.
    await db.execute(
        delete(EmailChangeRequest).where(EmailChangeRequest.person_id == person.id)
    )
    await db.execute(delete(Session).where(Session.person_id == person.id))
    if old_email is not None:
        await db.execute(delete(MagicLinkToken).where(MagicLinkToken.email == old_email))

    # One commit = one transaction: anonymization and auth-material deletion
    # land together or not at all.
    await db.commit()
