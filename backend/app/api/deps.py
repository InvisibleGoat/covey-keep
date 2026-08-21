from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import async_session_factory
from app.models import Person, Session
from app.security import decode_session_jwt

# Trusted-device session lifetime (CK-9, decisions/2026-08-20-sign-in-ergonomics.md
# §2). The window SLIDES: an authenticated request pushes expires_at forward, so
# a device that visits a few times a year stays signed in — but never past the
# absolute cap, which forces one re-authentication a year and is what "trusted
# device" actually means. Accepted and recorded: a longer session is a longer
# window for a lost device; tolerable while sessions stay individually revocable
# and the asset is family photographs — NOT a posture for org tiers holding
# payment instruments.
SESSION_TTL = timedelta(days=90)
SESSION_ABSOLUTE_CAP = timedelta(days=365)
# Refresh only when last_seen_at has gone stale — otherwise every authenticated
# call becomes a database write for no benefit.
SESSION_REFRESH_THRESHOLD = timedelta(hours=24)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with async_session_factory() as db:
        yield db


def client_ip(request: Request) -> Optional[str]:
    # request.client is the real client (not Render's load balancer) only
    # because the deployed start command (render.yaml) runs uvicorn with
    # --proxy-headers --forwarded-allow-ips="*", which rewrites the peer
    # address from X-Forwarded-For at the server layer. Never hand-parse
    # forwarding headers here — that would be a second, divergent
    # implementation of what uvicorn already does.
    return request.client.host if request.client else None


def normalize_email(value: str) -> str:
    """Trim + lowercase, syntactic validation only. Raises ValueError on
    garbage shape — shared by every endpoint that accepts an address, so the
    same string always normalizes the same way."""
    value = value.strip().lower()
    if "@" not in value.strip("@") or " " in value or len(value) > 320:
        raise ValueError("not an email address")
    return value


@dataclass
class AuthContext:
    person: Person
    session: Session


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="Not authenticated.",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_auth_context(
    db: AsyncSession = Depends(get_db),
    authorization: Optional[str] = Header(default=None),
) -> AuthContext:
    """Resolve the bearer JWT to a live person + session.

    A valid signature alone is NOT sufficient: the sessions row must exist and
    be neither expired nor revoked — that row is what makes the JWT revocable.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized()
    payload = decode_session_jwt(authorization.removeprefix("Bearer "), settings.session_secret)
    if payload is None:
        raise _unauthorized()
    try:
        session_id = UUID(str(payload.get("sid")))
        person_id = UUID(str(payload.get("sub")))
    except ValueError:
        raise _unauthorized()

    session = await db.get(Session, session_id)
    now = datetime.now(timezone.utc)
    if (
        session is None
        or session.person_id != person_id
        or session.revoked_at is not None
        or session.expires_at <= now
    ):
        raise _unauthorized()

    person = await db.get(Person, person_id)
    if person is None or person.anonymized_at is not None:
        # An anonymized person is no longer a user. Deletion hard-deletes the
        # sessions rows, so normally this arm is unreachable — but a token
        # minted before deletion must fail HERE too, not merely usually: this
        # check is what makes the guarantee true rather than likely (CK-8).
        raise _unauthorized()

    # Sliding window (CK-9). This point is only reachable for a live session —
    # the 401s above are what guarantee a revoked or expired session is never
    # extended (resurrecting one would break the revocation guarantee deletion
    # and email change both depend on). Refresh at most ~daily, never past the
    # absolute cap, and never backwards.
    if session.last_seen_at is None or now - session.last_seen_at >= SESSION_REFRESH_THRESHOLD:
        session.last_seen_at = now
        slid = min(now + SESSION_TTL, session.issued_at + SESSION_ABSOLUTE_CAP)
        if slid > session.expires_at:
            session.expires_at = slid
        await db.commit()
    return AuthContext(person=person, session=session)
