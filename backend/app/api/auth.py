import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.config import settings
from app.models import MagicLinkToken, Person, Session, TosAcceptance
from app.security import encode_session_jwt, hash_token
from app.services.email import send_email

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_TTL = timedelta(minutes=15)
SESSION_TTL = timedelta(days=30)
RATE_WINDOW = timedelta(minutes=15)
MAX_REQUESTS_PER_EMAIL = 5
MAX_REQUESTS_PER_IP = 20
TOS_VERSION = 1

# The one and only /auth/request-link success body. Byte-identical whether or
# not the email is known, and it must NEVER gain a send-status field — failure
# would then uniquely mean "this address exists", an enumeration oracle.
# Pinned by test (transactional-email standard v1.0.0).
REQUEST_LINK_RESPONSE = {
    "detail": "If that address can receive email, a sign-in link is on its way."
}

# Missing, expired, and already-consumed tokens are deliberately
# indistinguishable — one uniform rejection.
_INVALID_LINK = "This sign-in link is invalid, expired, or already used."


def _client_ip(request: Request) -> Optional[str]:
    return request.client.host if request.client else None


class RequestLinkBody(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def _normalize(cls, value: str) -> str:
        value = value.strip().lower()
        if "@" not in value.strip("@") or " " in value or len(value) > 320:
            raise ValueError("not an email address")
        return value


@router.post("/request-link", status_code=202)
async def request_link(
    body: RequestLinkBody, request: Request, db: AsyncSession = Depends(get_db)
) -> dict:
    now = datetime.now(timezone.utc)
    window_start = now - RATE_WINDOW
    client_ip = _client_ip(request)

    # Rate limit on request volume (in-DB counts), never on account existence —
    # a 429 reveals nothing about whether the address is known.
    email_count = await db.scalar(
        select(func.count())
        .select_from(MagicLinkToken)
        .where(MagicLinkToken.email == body.email, MagicLinkToken.created_at > window_start)
    )
    ip_count = 0
    if client_ip is not None:
        ip_count = await db.scalar(
            select(func.count())
            .select_from(MagicLinkToken)
            .where(
                MagicLinkToken.requested_ip == client_ip,
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
            requested_ip=client_ip,
        )
    )
    # Commit before the send: the token record exists whether or not delivery works.
    await db.commit()

    link = f"{settings.api_base_url}/auth/verify?token={raw_token}"
    send_email(
        to=body.email,
        subject="Your Covey Keep sign-in link",
        body=(
            "Sign in to Covey Keep:\n\n"
            f"{link}\n\n"
            "This link expires in 15 minutes and can be used once. "
            "If you didn't request it, you can ignore this email."
        ),
    )
    return REQUEST_LINK_RESPONSE


@router.get("/verify")
async def verify(token: str, request: Request, db: AsyncSession = Depends(get_db)) -> dict:
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
        raise HTTPException(400, _INVALID_LINK)

    row.consumed_at = now

    person = (
        await db.execute(select(Person).where(Person.email == row.email))
    ).scalar_one_or_none()
    if person is None:
        # New account: local-part placeholder display name; ToS acceptance is
        # recorded at creation (roadmap §2), versioned — the copy is a later pass.
        person = Person(display_name=row.email.split("@", 1)[0], email=row.email)
        db.add(person)
        await db.flush()
        db.add(
            TosAcceptance(
                person_id=person.id,
                version=TOS_VERSION,
                accepted_at=now,
                accepted_ip=_client_ip(request),
            )
        )

    session = Session(
        person_id=person.id,
        issued_at=now,
        expires_at=now + SESSION_TTL,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(session)
    await db.flush()
    await db.commit()

    jwt = encode_session_jwt(
        person_id=str(person.id),
        session_id=str(session.id),
        expires_at=session.expires_at,
        secret=settings.session_secret,
    )
    # Dev-only JSON response — CK-6 replaces this with a redirect into the frontend.
    return {"token": jwt, "token_type": "bearer"}


@router.get("/me")
async def me(ctx: AuthContext = Depends(get_auth_context)) -> dict:
    return {
        "id": str(ctx.person.id),
        "display_name": ctx.person.display_name,
        "email": ctx.person.email,
    }


@router.post("/logout", status_code=204)
async def logout(
    ctx: AuthContext = Depends(get_auth_context), db: AsyncSession = Depends(get_db)
) -> None:
    ctx.session.revoked_at = datetime.now(timezone.utc)
    await db.commit()
