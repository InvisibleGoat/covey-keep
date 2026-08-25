import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    SESSION_ABSOLUTE_CAP,
    SESSION_TTL,
    AuthContext,
    client_ip,
    get_auth_context,
    get_db,
    normalize_email,
)
from app.brand import PRODUCT_NAME
from app.config import settings
from app.models import (
    Account,
    AccountKind,
    EmailChangeRequest,
    MagicLinkToken,
    Person,
    Session,
    TosAcceptance,
)
from app.security import encode_session_jwt, hash_token
from app.services.email import send_email

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_TTL = timedelta(minutes=15)
RATE_WINDOW = timedelta(minutes=15)
MAX_REQUESTS_PER_EMAIL = 5
# Defence-in-depth only. Behind the proxy the client identity comes from
# X-Forwarded-For, whose leftmost value a caller can rotate at will — so this
# cap is evadable and must never be treated as the load-bearing limit.
# MAX_REQUESTS_PER_EMAIL above is what actually protects an account.
MAX_REQUESTS_PER_IP = 20
TOS_VERSION = 1

# The one and only /auth/request-link success body. Byte-identical whether or
# not the email is known, and it must NEVER gain a send-status field — failure
# would then uniquely mean "this address exists", an enumeration oracle.
# Pinned by test (transactional-email standard v1.0.0).
REQUEST_LINK_RESPONSE = {
    "detail": "If that address can receive email, a sign-in link is on its way."
}

# Missing, expired, already-consumed, and consent-less tokens are deliberately
# indistinguishable — one uniform error redirect into the frontend callback.
_ERROR_FRAGMENT = "error=invalid_link"


def _callback_redirect(fragment: str) -> RedirectResponse:
    # The payload rides the URL FRAGMENT, never the query string: fragments are
    # not sent to servers, do not land in access logs, and are not leaked in
    # Referer (decisions/2026-08-20-browser-session-storage.md).
    return RedirectResponse(
        f"{settings.app_base_url}/auth/callback#{fragment}", status_code=302
    )


async def mint_session(
    db: AsyncSession, person: Person, request: Request, now: datetime
) -> str:
    """Create the sessions row and mint its bearer JWT — the ONE place a
    session is born. Magic-link verify and passkey sign-in (CK-10) both call
    this, so the two credentials cannot drift: same TTL, same absolute cap,
    same JWT shape. The caller commits.

    The JWT's exp is the ABSOLUTE cap, not the row's expires_at: the window
    slides (deps.py pushes the row forward on use), and a bearer token that
    died at the first 90-day mark would silently undo the slide. The row is
    what actually gates every request — the JWT alone is never sufficient —
    so exp only needs to bound the credential's outer life, and the cap is
    exactly that bound: one forced re-authentication a year.
    """
    session = Session(
        person_id=person.id,
        issued_at=now,
        expires_at=now + SESSION_TTL,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(session)
    await db.flush()
    return encode_session_jwt(
        person_id=str(person.id),
        session_id=str(session.id),
        expires_at=now + SESSION_ABSOLUTE_CAP,
        secret=settings.session_secret,
    )


class RequestLinkBody(BaseModel):
    email: str
    # Roadmap §2: ToS agreed by affirmative checkbox at signup. The form cannot
    # know whether the address is new (that would be enumeration), so consent is
    # collected on every request and recorded only at account creation.
    tos_accepted: bool
    tos_version: int

    @field_validator("email")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("tos_accepted")
    @classmethod
    def _affirmative(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("the Terms of Service must be affirmatively accepted")
        return value

    @field_validator("tos_version")
    @classmethod
    def _known_version(cls, value: int) -> int:
        # Module global read at call time, not bound at class creation.
        if not 1 <= value <= TOS_VERSION:
            raise ValueError("unknown Terms of Service version")
        return value


@router.post("/request-link", status_code=202)
async def request_link(
    body: RequestLinkBody, request: Request, db: AsyncSession = Depends(get_db)
) -> dict:
    now = datetime.now(timezone.utc)
    window_start = now - RATE_WINDOW
    requester_ip = client_ip(request)

    # Rate limit on request volume (in-DB counts), never on account existence —
    # a 429 reveals nothing about whether the address is known.
    email_count = await db.scalar(
        select(func.count())
        .select_from(MagicLinkToken)
        .where(MagicLinkToken.email == body.email, MagicLinkToken.created_at > window_start)
    )
    ip_count = 0
    if requester_ip is not None:
        ip_count = await db.scalar(
            select(func.count())
            .select_from(MagicLinkToken)
            .where(
                MagicLinkToken.requested_ip == requester_ip,
                MagicLinkToken.created_at > window_start,
            )
        )
    if email_count >= MAX_REQUESTS_PER_EMAIL or ip_count >= MAX_REQUESTS_PER_IP:
        raise HTTPException(429, "Too many sign-in link requests. Try again later.")

    # A new link supersedes any outstanding one for the same address.
    await db.execute(
        update(MagicLinkToken)
        .where(
            MagicLinkToken.email == body.email,
            MagicLinkToken.consumed_at.is_(None),
            MagicLinkToken.expires_at > now,
        )
        .values(expires_at=now)
    )

    raw_token = secrets.token_urlsafe(32)
    db.add(
        MagicLinkToken(
            email=body.email,
            token_hash=hash_token(raw_token),
            expires_at=now + TOKEN_TTL,
            requested_ip=requester_ip,
            tos_version=body.tos_version,
        )
    )
    # Commit before the send: the token record exists whether or not delivery works.
    await db.commit()

    link = f"{settings.api_base_url}/auth/verify?token={raw_token}"
    send_email(
        to=body.email,
        subject=f"Your {PRODUCT_NAME} sign-in link",
        body=(
            f"Sign in to {PRODUCT_NAME}:\n\n"
            f"{link}\n\n"
            "This link expires in 15 minutes and can be used once. "
            "If you didn't request it, you can ignore this email."
        ),
    )
    return REQUEST_LINK_RESPONSE


@router.get("/verify")
async def verify(
    request: Request, db: AsyncSession = Depends(get_db), token: str = ""
) -> RedirectResponse:
    now = datetime.now(timezone.utc)
    supplied_hash = hash_token(token)
    row = (
        await db.execute(select(MagicLinkToken).where(MagicLinkToken.token_hash == supplied_hash))
    ).scalar_one_or_none()
    if (
        row is None
        or not secrets.compare_digest(supplied_hash, row.token_hash)
        or row.consumed_at is not None
        or row.expires_at <= now
    ):
        return _callback_redirect(_ERROR_FRAGMENT)

    person = (
        await db.execute(select(Person).where(Person.email == row.email))
    ).scalar_one_or_none()
    if person is None and row.tos_version is None:
        # Pre-CK-6 token: no consent was collected when it was minted, so no
        # account may be created from it. (Existing people are unaffected —
        # a returning sign-in records no new acceptance.)
        return _callback_redirect(_ERROR_FRAGMENT)

    row.consumed_at = now

    if person is None:
        # New account: local-part placeholder display name; the ToS acceptance
        # is recorded from the version the person actually agreed to on the
        # sign-in form (carried on the token row), never assumed. Every person
        # points at an accounts row (CK-12) — the anchor quota, subscription,
        # and keeping will reference.
        account = Account(kind=AccountKind.PERSON)
        db.add(account)
        await db.flush()
        person = Person(
            display_name=row.email.split("@", 1)[0],
            email=row.email,
            account_id=account.id,
        )
        db.add(person)
        await db.flush()
        db.add(
            TosAcceptance(
                person_id=person.id,
                version=row.tos_version,
                accepted_at=now,
                accepted_ip=client_ip(request),
            )
        )

    jwt = await mint_session(db, person, request, now)
    await db.commit()
    return _callback_redirect(f"token={jwt}")


def _email_change_redirect(status: str) -> RedirectResponse:
    # Same fragment discipline as the sign-in callback (CK-6): the payload
    # rides the URL fragment, never the query string. Unlike the sign-in
    # verify's deliberately uniform error, the failure states here are
    # DISTINGUISHED — the person opened this link from their own inbox, so
    # telling them which thing went wrong costs nothing and a blank page is
    # never acceptable (kickoff CK-9).
    return RedirectResponse(
        f"{settings.app_base_url}/email-change#status={status}", status_code=302
    )


@router.get("/email-change/verify")
async def verify_email_change(db: AsyncSession = Depends(get_db), token: str = "") -> RedirectResponse:
    """Complete an email change. UNAUTHENTICATED, deliberately: the person
    often opens the link on a different device with no session — the token IS
    the authorization, which is exactly why it is single-use, one hour,
    ≥32 bytes, hashed at rest, and compared with compare_digest."""
    now = datetime.now(timezone.utc)
    supplied_hash = hash_token(token)
    row = (
        await db.execute(
            select(EmailChangeRequest).where(EmailChangeRequest.token_hash == supplied_hash)
        )
    ).scalar_one_or_none()
    if row is None or not secrets.compare_digest(supplied_hash, row.token_hash):
        return _email_change_redirect("invalid")
    if row.consumed_at is not None:
        return _email_change_redirect("used")
    if row.expires_at <= now:
        return _email_change_redirect("expired")

    # The race is real: two people can request the same new address inside the
    # window, and only the request endpoint's availability check has run so
    # far. Re-check inside this transaction; people.email's UNIQUE constraint
    # backstops it. The token is deliberately NOT consumed on this failure —
    # the proof of inbox control stands, so if the address frees up within the
    # hour (the holder deletes their account), retrying the link is correct.
    holder = (
        await db.execute(select(Person).where(Person.email == row.new_email))
    ).scalar_one_or_none()
    if holder is not None:
        return _email_change_redirect("taken")

    person = await db.get(Person, row.person_id)
    if person is None or person.anonymized_at is not None:
        # Deletion purges this table in the same transaction that anonymizes,
        # so this arm should be unreachable — belt and braces, same as the
        # auth gate's anonymized check.
        return _email_change_redirect("invalid")

    # One transaction: the address moves, the token dies, outstanding requests
    # die, and every other session dies — email is the credential, so a change
    # must not leave old sessions alive. The requesting session survives (the
    # device the person asked from stays signed in); if it was revoked in the
    # meantime it stays revoked — being spared here never resurrects anything.
    person.email = row.new_email
    person.updated_at = now
    row.consumed_at = now
    await db.execute(
        update(EmailChangeRequest)
        .where(
            EmailChangeRequest.person_id == person.id,
            EmailChangeRequest.id != row.id,
            EmailChangeRequest.consumed_at.is_(None),
            EmailChangeRequest.expires_at > now,
        )
        .values(expires_at=now)
    )
    await db.execute(
        update(Session)
        .where(
            Session.person_id == person.id,
            Session.id != row.requested_session_id,
            Session.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await db.commit()
    return _email_change_redirect("success")


@router.get("/me")
async def me(ctx: AuthContext = Depends(get_auth_context)) -> dict:
    return {
        "id": str(ctx.person.id),
        "display_name": ctx.person.display_name,
        "email": ctx.person.email,
        # The auth context is what the frontend holds; timezone rides along so
        # the client can tell "never captured" (null) from a set value (CK-7).
        "timezone": ctx.person.timezone,
    }


@router.post("/logout", status_code=204)
async def logout(
    ctx: AuthContext = Depends(get_auth_context), db: AsyncSession = Depends(get_db)
) -> None:
    ctx.session.revoked_at = datetime.now(timezone.utc)
    await db.commit()
