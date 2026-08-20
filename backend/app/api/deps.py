from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncIterator, Optional
from uuid import UUID

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import async_session_factory
from app.models import Person, Session
from app.security import decode_session_jwt


async def get_db() -> AsyncIterator[AsyncSession]:
    async with async_session_factory() as db:
        yield db


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

    session.last_seen_at = now
    await db.commit()
    return AuthContext(person=person, session=session)
