"""Emailed invitations to a group (CK-75;
decisions/2026-10-23-joining-a-group-and-co-admins.md §2) — CK-25's
machinery with the group as the target, and nothing new invented.

An emailed invitation ADMITS DIRECTLY, because the admin or a co-admin
chose the person — where a join through the group's link waits for an
approval (api/group_links.py). The shape is api/invitations.py's exactly,
re-pointed: an organiser invites a DESTINATION (channel + destination —
email today, SMS when A2P registration unblocks it; `SMS` is schema-valid
and refused here with the CK-25 422, word for word), which writes an
ephemeral pending row holding only the token's SHA-256 hash. The invitee
opens the link, signs in through the UNMODIFIED magic-link path —
/auth/verify is the one place a person, their accounts row and their
tos_acceptances row are born, and any accept flow that created a person
itself would silently skip the ToS record — and then the token is redeemed
against the session: acceptance consumes the pending row and creates the
MEMBERSHIP for the real person, in one transaction, and closes any open
join request by the same person as `approved` with no deciding person
(the acceptance decided it).

The token is the credential, the CK-9 email-change precedent: whoever holds
the link may accept under any account they sign in with.

Rate limiting rides the request_link pattern: pending rows ARE the tally,
counted by created_at over auth.RATE_WINDOW per group and per inviter —
the group router's own names, bound to CK-25's values so the two surfaces
cannot drift apart silently; the per-inviter tally counts GROUP invitation
rows (two tables, two tallies — a person may send CK-25's twenty gathering
invitations and twenty group invitations in one window, recorded). Which is
why revocation and supersession STAMP revoked_at and force expires_at to
now, never delete: a deletable tally is a disabled rate limit (the CK-24
lesson), and the reaper removes the row once its forced expiry is
PURGE_GRACE past. This table is purge_stale's customer at the top of the
create endpoint.

Non-enumeration (the CK-5 rule): no endpoint here ever reveals whether the
invited destination already has an account — creation never looks the
destination up in people at all, the 201 is uniform, and the list shows
only what the organisers themselves typed (accepted people are members, on
the member list by display name). Authorization is the group posture:
management is the ORGANISERS' — the admin or a co-admin, the delegable set
(`_group_for_organiser`) — 404-never-403, byte-identical to a missing id.

The frontend route does not exist yet (Groups 3). Since CK-75.1 the app's
catch-all keeps such an address — path and fragment, the token with it —
and says the page isn't available, offering a reload when a newer bundle is
waiting; before CK-75.1 it redirected to `/` and dropped the fragment
(CK-75's finding 1). What this router knows is only that the route does not
exist yet, never where the link lands.

DATA-HANDLING: `destination` is an address supplied by one person ABOUT
another — the invitee did not type it. The row is ephemeral (expires,
reaped), only the token hash is stored, and no destination is ever written
to an application log (console-mode email prints the full message to the
service log by design — that is the delivery channel, not logging — and the
private test notice says so).
"""

import secrets
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import RATE_WINDOW
from app.api.deps import AuthContext, get_auth_context, get_db, normalize_email
from app.api.gatherings import _field_422
from app.api.groups import _group_for_organiser
from app.api.invitations import (
    INVITATION_TTL,
    MAX_INVITATIONS_PER_GATHERING,
    MAX_INVITATIONS_PER_INVITER,
    SMS_UNAVAILABLE_MESSAGE,
    TokenBody,
)
from app.brand import PRODUCT_NAME
from app.config import settings
from app.models import (
    Group,
    GroupInvitationPending,
    GroupJoinRequest,
    InvitationChannel,
    JoinRequestOutcome,
    Membership,
)
from app.security import hash_token
from app.services.email import send_email
from app.services.groups import invite_newcomer_to_upcoming_gatherings
from app.services.retention import purge_stale

router = APIRouter(prefix="", tags=["group-invitations"])

# The group router's own names at CK-25's values, bound to them so the two
# surfaces cannot drift apart silently. Per-group bounds mail about one
# group; per-inviter bounds one caller across all their groups (group
# invitation rows alone — the gathering tally is its own).
MAX_INVITATIONS_PER_GROUP = MAX_INVITATIONS_PER_GATHERING
MAX_GROUP_INVITATIONS_PER_INVITER = MAX_INVITATIONS_PER_INVITER


def _not_found() -> HTTPException:
    # One body for "does not exist" and "not yours to touch" — the existence
    # of an invitation is not public information (the gatherings posture).
    return HTTPException(404, "No such invitation.")


class GroupInvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # channel first: the destination validator reads it from info.data. Both
    # channels pass the SCHEMA — SMS is refused by the endpoint with a usable
    # 422 (CK-25's, word for word).
    channel: InvitationChannel
    destination: str

    @field_validator("destination")
    @classmethod
    def _normalize(cls, value: str, info) -> str:
        if info.data.get("channel") is InvitationChannel.EMAIL:
            return normalize_email(value)
        return value.strip()


def _pending_body(row: GroupInvitationPending) -> dict:
    return {
        "id": str(row.id),
        "channel": row.channel.value,
        "destination": row.destination,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
    }


async def _resolve_token(
    db: AsyncSession, token: str, now: datetime
) -> tuple[str, Optional[GroupInvitationPending]]:
    """Resolve a raw invitation token to (status, row). Statuses: valid,
    expired, used, revoked, invalid — CK-25's exactly, revoked outranking
    expired for CK-25's reason."""
    supplied_hash = hash_token(token)
    row = (
        await db.execute(
            select(GroupInvitationPending).where(
                GroupInvitationPending.token_hash == supplied_hash
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


async def _is_member(db: AsyncSession, group_id: UUID, person_id: UUID) -> bool:
    return (
        await db.scalar(
            select(Membership.id).where(
                Membership.group_id == group_id, Membership.person_id == person_id
            )
        )
    ) is not None


@router.post("/groups/{group_id}/invitations", status_code=201)
async def create_group_invitation(
    group_id: UUID,
    body: GroupInvitationCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """INVITE BY EMAIL — delegable (record §3): the admin or a co-admin; a
    member and a stranger draw the group 404. **201** with the pending
    body; **422** on `channel` for `SMS` (CK-25's message); **429** over
    either rate limit. A fresh invite to a destination with a live pending
    row supersedes it. The email carries the group's name, the inviter's
    display name and the link; console mode prints it, as every send
    does."""
    group = await _group_for_organiser(db, ctx, group_id)
    now = datetime.now(timezone.utc)

    if body.channel is InvitationChannel.SMS:
        raise _field_422("channel", SMS_UNAVAILABLE_MESSAGE)

    # Reap pending rows more than PURGE_GRACE past expiry (CK-24's mechanism):
    # a row here is an address supplied by one person about another and must
    # not outlive its purpose. Keyed off expires_at, NEVER consumed_at.
    await purge_stale(db, GroupInvitationPending, GroupInvitationPending.expires_at, now)

    window_start = now - RATE_WINDOW
    group_count = await db.scalar(
        select(func.count())
        .select_from(GroupInvitationPending)
        .where(
            GroupInvitationPending.group_id == group.id,
            GroupInvitationPending.created_at > window_start,
        )
    )
    inviter_count = await db.scalar(
        select(func.count())
        .select_from(GroupInvitationPending)
        .where(
            GroupInvitationPending.invited_by_person_id == ctx.person.id,
            GroupInvitationPending.created_at > window_start,
        )
    )
    if group_count >= MAX_INVITATIONS_PER_GROUP or inviter_count >= MAX_GROUP_INVITATIONS_PER_INVITER:
        raise HTTPException(429, "Too many invitations just now. Try again later.")

    # Supersession: stamp the outstanding row revoked and force its expiry;
    # it REMAINS for the tally (the CK-24 lesson).
    await db.execute(
        update(GroupInvitationPending)
        .where(
            GroupInvitationPending.group_id == group.id,
            GroupInvitationPending.channel == body.channel,
            GroupInvitationPending.destination == body.destination,
            GroupInvitationPending.consumed_at.is_(None),
            GroupInvitationPending.revoked_at.is_(None),
        )
        .values(revoked_at=now, expires_at=now)
    )

    raw_token = secrets.token_urlsafe(32)
    row = GroupInvitationPending(
        group_id=group.id,
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
    # URL fragment (never the query string).
    link = f"{settings.app_base_url}/groups/invitations/accept#token={raw_token}"
    send_email(
        to=body.destination,
        subject=f"You're invited to join {group.name} on {PRODUCT_NAME}",
        body=(
            f"{ctx.person.display_name} invited you to join \"{group.name}\" "
            f"on {PRODUCT_NAME}.\n\n"
            f"Open the invitation: {link}\n\n"
            "This invitation expires in 7 days. If you weren't expecting it, "
            "you can ignore this email."
        ),
    )
    return _pending_body(row)


@router.get("/groups/{group_id}/invitations")
async def list_group_invitations(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE PENDING INVITATIONS — the admin's and co-admins' (record §5): a
    pending destination is a third party's address, and a member and a
    stranger draw the group 404. **200** `{"pending": [...]}` — live rows
    (unconsumed, unrevoked — expired-but-unconsumed included, since an
    organiser needs the expiry to know when to re-invite), each the create
    body's shape. No `accepted` list: an accepted invitee is a member, on
    the member list by display name."""
    group = await _group_for_organiser(db, ctx, group_id)
    pending = (
        await db.scalars(
            select(GroupInvitationPending)
            .where(
                GroupInvitationPending.group_id == group.id,
                GroupInvitationPending.consumed_at.is_(None),
                GroupInvitationPending.revoked_at.is_(None),
            )
            .order_by(GroupInvitationPending.created_at, GroupInvitationPending.id)
        )
    ).all()
    return {"pending": [_pending_body(row) for row in pending]}


@router.delete("/groups/{group_id}/invitations/{invitation_id}", status_code=204)
async def revoke_group_invitation(
    group_id: UUID,
    invitation_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """REVOKE — delegable. The row is stamped, never deleted (it keeps
    feeding the rate tally; the reaper removes it an hour after the forced
    expiry). Idempotent: revoking an already-revoked invitation is a 204. A
    consumed invitation is not pending and gets the same 404 as a missing
    id or another group's; everyone who is not an organiser drew the
    group 404 one door earlier."""
    group = await _group_for_organiser(db, ctx, group_id)
    now = datetime.now(timezone.utc)
    row = await db.get(GroupInvitationPending, invitation_id)
    if row is None or row.group_id != group.id or row.consumed_at is not None:
        raise _not_found()
    if row.revoked_at is None:
        row.revoked_at = now
        if row.expires_at > now:
            row.expires_at = now
        await db.commit()


@router.post("/group-invitations/preview")
async def preview_group_invitation(body: TokenBody, db: AsyncSession = Depends(get_db)) -> dict:
    """UNAUTHENTICATED, deliberately (CK-25's reason): the acceptance screen
    renders its distinguished states — and the group's name — before
    pushing anyone through the magic-link round trip. **200**
    `{"status", "group_name"}`; the name only on `valid`. The token is the
    authorization; it discloses the name only to whoever holds the link,
    which is exactly what the invitation email already did. A POST so the
    token stays out of access logs."""
    now = datetime.now(timezone.utc)
    status, row = await _resolve_token(db, body.token, now)
    name = None
    if status == "valid" and row is not None:
        group = await db.get(Group, row.group_id)
        if group is None:
            status = "invalid"
        else:
            name = group.name
    return {"status": status, "group_name": name}


@router.post("/group-invitations/accept")
async def accept_group_invitation(
    body: TokenBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Redeem an invitation token against the CALLER'S session — the step
    that turns a pending destination into a MEMBERSHIP, in one transaction
    with the token's consumption, and closes any open join request by the
    same person as `approved` with no deciding person. A flow endpoint:
    every resolvable outcome is a **200** with `{"status", "group_id"}` —
    `accepted` | `already_accepted` (already a member; the group id either
    way) | `expired` | `used` (consumed by someone else) | `revoked` |
    `invalid`. Idempotent: re-accepting yields `already_accepted`, never a
    500 — the memberships UNIQUE is checked first and backstopped."""
    now = datetime.now(timezone.utc)
    status, row = await _resolve_token(db, body.token, now)

    if status == "used" and row is not None:
        if await _is_member(db, row.group_id, ctx.person.id):
            return {"status": "already_accepted", "group_id": str(row.group_id)}
        return {"status": "used", "group_id": None}
    if status != "valid" or row is None:
        return {"status": status, "group_id": None}
    group_id = row.group_id

    row.consumed_at = now
    member = await _is_member(db, group_id, ctx.person.id)
    if not member:
        db.add(Membership(group_id=group_id, person_id=ctx.person.id))
        # THE NEWCOMER'S PLACES (CK-76; the 2026-10-04 record §9): a row on
        # each of the group's UPCOMING gatherings they hold none for,
        # `invited_by_person_id` NULL — the group's rule invited them — in
        # the transaction that writes the membership. Past gatherings are
        # never written. The one helper both admission paths call
        # (api/group_links.py's approve is the other).
        await invite_newcomer_to_upcoming_gatherings(
            db, group_id=group_id, person_id=ctx.person.id, now=now
        )
    # The acceptance decides any open request of theirs: approved, by nobody.
    await db.execute(
        update(GroupJoinRequest)
        .where(
            GroupJoinRequest.group_id == group_id,
            GroupJoinRequest.person_id == ctx.person.id,
            GroupJoinRequest.decided_at.is_(None),
        )
        .values(decided_at=now, outcome=JoinRequestOutcome.APPROVED, decided_by_person_id=None)
    )
    try:
        await db.commit()
    except IntegrityError:
        # Two accepts for the same (group, person) racing — or an approval
        # landing meanwhile: the membership exists (and whichever path
        # wrote it wrote the newcomer's places), so consume the token in a
        # fresh transaction and report the idempotent outcome.
        await db.rollback()
        fresh = await db.get(GroupInvitationPending, row.id)
        if fresh is not None and fresh.consumed_at is None and fresh.revoked_at is None:
            fresh.consumed_at = datetime.now(timezone.utc)
            await db.commit()
        return {"status": "already_accepted", "group_id": str(group_id)}
    return {
        "status": "already_accepted" if member else "accepted",
        "group_id": str(group_id),
    }
