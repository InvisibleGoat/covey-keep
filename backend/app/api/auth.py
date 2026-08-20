import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
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


def _client_ip(request: Request) -> Optional[str]:
    # request.client is the real client (not Render's load balancer) only
    # because the deployed start command (render.yaml) runs uvicorn with
    # --proxy-headers --forwarded-allow-ips="*", which rewrites the peer
    # address from X-Forwarded-For at the server layer. Never hand-parse
    # forwarding headers here — that would be a second, divergent
    # implementation of what uvicorn already does.
    return request.client.host if request.client else None


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
        value = value.strip().lower()
        if "@" not in value.strip("@") or " " in value or len(value) > 320:
            raise ValueError("not an email address")
        return value

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
            tos_version=body.tos_version,
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
        # sign-in form (carried on the token row), never assumed.
        person = Person(display_name=row.email.split("@", 1)[0], email=row.email)
        db.add(person)
        await db.flush()
        db.add(
            TosAcceptance(
                person_id=person.id,
                version=row.tos_version,
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
    return _callback_redirect(f"token={jwt}")


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
