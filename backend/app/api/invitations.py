"""Person-targeted invitations (CK-25) — the first multiplayer surface.

The shape: an admin invites a DESTINATION (channel + destination — email
today, SMS when A2P registration unblocks it), which writes an ephemeral
pending row holding only the token's SHA-256 hash. The invitee opens the
link, signs in through the UNMODIFIED magic-link path — /auth/verify is the
one place a person, their accounts row, and their tos_acceptances row are
born, and any accept flow that creates a person itself would silently skip
the ToS record — and then the token is redeemed against the session:
acceptance consumes the pending row and creates the gathering_invitations
row for the real person, in one transaction. One token, redeemed
post-session; the invitation token never mints a session (whether it should
— the text-first flow's way of not demanding an email from someone you chose
to text — is a real question that belongs to the guest-claim phase, recorded
in the api-reference, not answered here).

The token is the credential, the CK-9 email-change precedent: whoever holds
the link may accept under any account they sign in with — acceptance is
deliberately NOT bound to the invited address (the invitee may sign in under
a different address they own, and an SMS destination has no address at all).

Rate limiting rides the request_link pattern: pending rows ARE the tally,
counted by created_at over auth.RATE_WINDOW per gathering and per inviter —
an invitation endpoint sends mail on demand and is a spam vector otherwise.
Which is why revocation and supersession STAMP revoked_at and force
expires_at to now, never delete: a deletable tally is a disabled rate limit
(the CK-24 lesson), and the reaper removes the row once its forced expiry is
PURGE_GRACE past. This table is purge_stale's fourth customer, reaped at the
top of the create endpoint.

Non-enumeration (the CK-5 rule): no endpoint here ever reveals whether the
invited destination already has an account — creation never looks the
destination up in people at all, the 201 is uniform, and the admin's list
shows only what the admin themselves typed plus the display names of people
who accepted (an account email is a credential and is never auto-exposed to
an admin). Authorization is the gatherings posture: admin-only management,
404-never-403, byte-identical to a missing id.

requires_approval is deliberately NOT touched by this phase: the recorded
relaxation is a GROUP-TYPE rule (ON for TEAM/CONGREGATION-sourced invites,
OFF for HOUSEHOLD/CLUB) and this phase ships no group-targeted invitations,
so a person-targeted invite has no inviting context to default from. It
stays hard-coded True at creation; the trigger waits for group-targeted
invitations.

DATA-HANDLING: `destination` is an address supplied by one person ABOUT
another — the invitee did not type it. The row is ephemeral (expires,
reaped), only the token hash is stored, and no destination is ever written
to an application log (console-mode email prints the full message to the
service log by design — that is the delivery channel, not logging).
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import RATE_WINDOW
from app.api.deps import AuthContext, get_auth_context, get_db, normalize_email
from app.api.gatherings import _field_422, _gathering_for_admin
from app.brand import PRODUCT_NAME
from app.config import settings
from app.models import (
    Gathering,
    GatheringInvitation,
    GatheringInvitationPending,
    InvitationChannel,
    Person,
)
from app.security import hash_token
from app.services.email import send_email
from app.services.retention import purge_stale

router = APIRouter(prefix="", tags=["invitations"])

# Seven days, not the magic link's 15 minutes: an invitation is not an auth
# credential — redeeming it still requires signing in — and family invitees
# read email on family time. Must stay comfortably above auth.RATE_WINDOW:
# the reap-vs-tally arithmetic (services/retention.py) needs every row to
# outlive the window it was created in, and an expired row is TTL old.
INVITATION_TTL = timedelta(days=7)

# Counted over auth.RATE_WINDOW against pending rows by created_at — revoked
# and superseded rows included (they are stamped, never deleted, precisely so
# they keep counting). Per-gathering bounds mail about one gathering;
# per-inviter bounds one caller across all their gatherings.
MAX_INVITATIONS_PER_GATHERING = 10
MAX_INVITATIONS_PER_INVITER = 20

SMS_UNAVAILABLE_MESSAGE = (
    "text-message invitations aren't available yet — invite by email for now"
)


def _not_found() -> HTTPException:
    # One body for "does not exist" and "not yours to touch" — the existence
    # of an invitation is not public information (the gatherings posture).
    return HTTPException(404, "No such invitation.")


class InvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # channel first: the destination validator reads it from info.data. Both
    # channels pass the SCHEMA — SMS is refused by the endpoint with a usable
    # 422 (not a 500, not silently treated as email): the column shape is
    # decided now so SMS ships without a migration, but its delivery is
    # blocked upstream (A2P → name gate).
    channel: InvitationChannel
    destination: str

    @field_validator("destination")
    @classmethod
    def _normalize(cls, value: str, info) -> str:
        if info.data.get("channel") is InvitationChannel.EMAIL:
            # Stored normalized — trimmed and lowercased, the address rule
            # every other endpoint uses (E.164 is the SMS analogue, later).
            return normalize_email(value)
        return value.strip()


class TokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str


def _pending_body(row: GatheringInvitationPending) -> dict:
    return {
        "id": str(row.id),
        "channel": row.channel.value,
        "destination": row.destination,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
    }


async def _resolve_token(
    db: AsyncSession, token: str, now: datetime
) -> tuple[str, Optional[GatheringInvitationPending]]:
    """Resolve a raw invitation token to (status, row). Statuses: valid,
    expired, used, revoked, invalid. Revoked outranks expired — a superseded
    row has BOTH stamps' semantics (revoked_at set, expires_at forced), and
    "withdrawn or replaced" is the truthful message for it."""
    supplied_hash = hash_token(token)
    row = (
        await db.execute(
            select(GatheringInvitationPending).where(
                GatheringInvitationPending.token_hash == supplied_hash
            )
        )
    ).scalar_one_or_none()
    if row is None or not secrets.compare_digest(supplied_hash, row.token_hash):
        return "invalid", None
    if row.revoked_at is not None:
        return "revoked", row
    if row.consumed_at is not None:
        return "used", row
    if row.expires_at <= now:
        return "expired", row
    return "valid", row


@router.post("/gatherings/{gathering_id}/invitations", status_code=201)
async def create_invitation(
    gathering_id: UUID,
    body: InvitationCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_admin(db, ctx, gathering_id)
    now = datetime.now(timezone.utc)

    if body.channel is InvitationChannel.SMS:
        # Accepted by the schema, refused by the endpoint — a clear field-level
        # 422, never a 500 and never silently treated as email.
        raise _field_422("channel", SMS_UNAVAILABLE_MESSAGE)

    # Reap pending rows more than PURGE_GRACE past expiry (CK-24 mechanism,
    # fourth customer): a row here is an address supplied by one person about
    # another and must not outlive its purpose. Keyed off expires_at, NEVER
    # consumed_at — the counts below tally every row created in the window.
    await purge_stale(
        db, GatheringInvitationPending, GatheringInvitationPending.expires_at, now
    )

    window_start = now - RATE_WINDOW
    gathering_count = await db.scalar(
        select(func.count())
        .select_from(GatheringInvitationPending)
        .where(
            GatheringInvitationPending.gathering_id == gathering.id,
            GatheringInvitationPending.created_at > window_start,
        )
    )
    inviter_count = await db.scalar(
        select(func.count())
        .select_from(GatheringInvitationPending)
        .where(
            GatheringInvitationPending.invited_by_person_id == ctx.person.id,
            GatheringInvitationPending.created_at > window_start,
        )
    )
    if (
        gathering_count >= MAX_INVITATIONS_PER_GATHERING
        or inviter_count >= MAX_INVITATIONS_PER_INVITER
    ):
        raise HTTPException(429, "Too many invitations just now. Try again later.")

    # A fresh invite to the same destination supersedes the outstanding one:
    # stamp revoked (frees the one-live-invite slot the partial unique index
    # enforces) and force expiry (puts it on the reaper's schedule). The row
    # REMAINS for the rate tally above — deleting it would let a caller
    # supersede their way past the limit (the CK-24 lesson).
    await db.execute(
        update(GatheringInvitationPending)
        .where(
            GatheringInvitationPending.gathering_id == gathering.id,
            GatheringInvitationPending.channel == body.channel,
            GatheringInvitationPending.destination == body.destination,
            GatheringInvitationPending.consumed_at.is_(None),
            GatheringInvitationPending.revoked_at.is_(None),
        )
        .values(revoked_at=now, expires_at=now)
    )

    raw_token = secrets.token_urlsafe(32)
    row = GatheringInvitationPending(
        gathering_id=gathering.id,
        channel=body.channel,
        destination=body.destination,
        token_hash=hash_token(raw_token),
        expires_at=now + INVITATION_TTL,
        invited_by_person_id=ctx.person.id,
    )
    db.add(row)
    # Commit before the send, the request_link precedent: the pending record
    # exists whether or not delivery works.
    await db.commit()

    # The link targets the FRONTEND acceptance screen with the token in the
    # URL fragment (never the query string — fragments don't reach servers,
    # access logs, or Referer): the frontend must hold the token across the
    # sign-in round trip, so the API never needs to see the raw token in a URL.
    link = f"{settings.app_base_url}/invitations/accept#token={raw_token}"
    send_email(
        to=body.destination,
        subject=f"You're invited to {gathering.title} on {PRODUCT_NAME}",
        body=(
            f"{ctx.person.display_name} invited you to \"{gathering.title}\" "
            f"on {PRODUCT_NAME}.\n\n"
            f"Open the invitation: {link}\n\n"
            "This invitation expires in 7 days. If you weren't expecting it, "
            "you can ignore this email."
        ),
    )
    return _pending_body(row)


@router.get("/gatherings/{gathering_id}/invitations")
async def list_invitations(
    gathering_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin only — an invitee sees the gathering, never its invitation
    roster (who else was invited is not theirs to read, and a pending
    destination is a third party's address). `pending` shows live rows,
    expired-but-unconsumed included (the admin needs the expiry to know when
    to re-invite); `accepted` shows display names ONLY — an account email is
    a credential and is never auto-exposed to an admin."""
    gathering = await _gathering_for_admin(db, ctx, gathering_id)
    pending = (
        await db.scalars(
            select(GatheringInvitationPending)
            .where(
                GatheringInvitationPending.gathering_id == gathering.id,
                GatheringInvitationPending.consumed_at.is_(None),
                GatheringInvitationPending.revoked_at.is_(None),
            )
            .order_by(
                GatheringInvitationPending.created_at,
                GatheringInvitationPending.id,
            )
        )
    ).all()
    accepted = (
        await db.execute(
            select(GatheringInvitation, Person.display_name)
            .join(Person, Person.id == GatheringInvitation.person_id)
            .where(GatheringInvitation.gathering_id == gathering.id)
            .order_by(GatheringInvitation.created_at, GatheringInvitation.id)
        )
    ).all()
    return {
        "pending": [_pending_body(row) for row in pending],
        "accepted": [
            {
                "id": str(invitation.id),
                "display_name": display_name,
                "accepted_at": invitation.created_at.isoformat(),
            }
            for invitation, display_name in accepted
        ],
    }


@router.delete("/invitations/pending/{invitation_id}", status_code=204)
async def revoke_invitation(
    invitation_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Revoke an unaccepted invitation — the old link stops working. The row
    is stamped, never deleted (it keeps feeding the rate tally; the reaper
    removes it an hour after the forced expiry). Idempotent: revoking an
    already-revoked invitation is a 204. A consumed invitation is not pending
    and gets the same 404 as a missing or foreign id."""
    now = datetime.now(timezone.utc)
    row = await db.get(GatheringInvitationPending, invitation_id)
    if row is None or row.consumed_at is not None:
        raise _not_found()
    gathering = await db.get(Gathering, row.gathering_id)
    if gathering is None or gathering.host_account_id != ctx.person.account_id:
        raise _not_found()
    if row.revoked_at is None:
        row.revoked_at = now
        if row.expires_at > now:
            row.expires_at = now
        await db.commit()


@router.post("/invitations/preview")
async def preview_invitation(
    body: TokenBody, db: AsyncSession = Depends(get_db)
) -> dict:
    """UNAUTHENTICATED, deliberately: the acceptance screen must render its
    distinguished states (and the gathering's title, as context worth signing
    in for) BEFORE pushing someone through the magic-link round trip — an
    expired invite discovered only after signing in is a wasted sign-in. The
    token is the authorization; it discloses the title only to whoever holds
    the link, which is exactly what the invitation email already did. Reveals
    nothing about any account, and a POST so the token stays out of access
    logs (the emailed link carries it in the URL fragment for the same
    reason)."""
    now = datetime.now(timezone.utc)
    status, row = await _resolve_token(db, body.token, now)
    title = None
    if status == "valid" and row is not None:
        gathering = await db.get(Gathering, row.gathering_id)
        if gathering is None:
            status = "invalid"
        else:
            title = gathering.title
    return {"status": status, "gathering_title": title}


@router.post("/invitations/accept")
async def accept_invitation(
    body: TokenBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Redeem an invitation token against the CALLER'S session — the step
    that turns a pending destination into a person-targeted
    gathering_invitations row, in one transaction with the token's
    consumption. Auth required: the person already exists here (created, if
    new, by /auth/verify with their ToS acceptance — never by this endpoint).

    A flow endpoint, not CRUD: every resolvable outcome is a 200 with a
    status — accepted | already_accepted | expired | used | revoked | invalid
    — because expired-and-friends are results the screen renders, not errors
    (the CK-9 /email-change precedent). Idempotent: re-accepting yields
    already_accepted with the gathering id, never a 500 — the partial unique
    index on (gathering, person) is checked first and backstopped."""
    now = datetime.now(timezone.utc)
    status, row = await _resolve_token(db, body.token, now)

    if status == "used" and row is not None:
        # Consumed — by this person (a re-click: idempotent success pointing
        # back at the gathering) or by someone else (the token is spent).
        existing = await db.scalar(
            select(GatheringInvitation.id).where(
                GatheringInvitation.gathering_id == row.gathering_id,
                GatheringInvitation.person_id == ctx.person.id,
            )
        )
        if existing is not None:
            return {"status": "already_accepted", "gathering_id": str(row.gathering_id)}
        return {"status": "used", "gathering_id": None}
    if status != "valid" or row is None:
        return {"status": status, "gathering_id": None}

    row.consumed_at = now
    existing = await db.scalar(
        select(GatheringInvitation.id).where(
            GatheringInvitation.gathering_id == row.gathering_id,
            GatheringInvitation.person_id == ctx.person.id,
        )
    )
    if existing is None:
        db.add(
            GatheringInvitation(
                gathering_id=row.gathering_id,
                person_id=ctx.person.id,
                invited_by_person_id=row.invited_by_person_id,
            )
        )
    try:
        await db.commit()
    except IntegrityError:
        # Two accepts for the same (gathering, person) racing: the partial
        # unique index held, so the invitation row exists — consume the token
        # in a fresh transaction and report the idempotent outcome.
        await db.rollback()
        fresh = await db.get(GatheringInvitationPending, row.id)
        if fresh is not None and fresh.consumed_at is None and fresh.revoked_at is None:
            fresh.consumed_at = datetime.now(timezone.utc)
            await db.commit()
        return {"status": "already_accepted", "gathering_id": str(row.gathering_id)}
    return {
        "status": "already_accepted" if existing is not None else "accepted",
        "gathering_id": str(row.gathering_id),
    }
