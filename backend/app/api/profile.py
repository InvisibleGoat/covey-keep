from datetime import datetime, timezone
from functools import lru_cache
from typing import Optional
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.models import MagicLinkToken, Person, Session

router = APIRouter(prefix="/me", tags=["me"])

MAX_DISPLAY_NAME_LENGTH = 120

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

    # Hard-delete (not revoke) every piece of auth material: all sessions —
    # every device, not just this one — and any magic-link tokens for the old
    # address, consumed or not, since their rows carry the address itself.
    await db.execute(delete(Session).where(Session.person_id == person.id))
    if old_email is not None:
        await db.execute(delete(MagicLinkToken).where(MagicLinkToken.email == old_email))

    # One commit = one transaction: anonymization and auth-material deletion
    # land together or not at all.
    await db.commit()
