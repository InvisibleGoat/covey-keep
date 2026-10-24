"""The group's link, and joining through it (CK-75;
decisions/2026-10-23-joining-a-group-and-co-admins.md §2–§3).

Steven's case decides the shape: *"I can invite 20 of my family members via
my phone contacts, but I don't know most of their emails."* A text
CoveyKeep sends is blocked by A2P; what works today is a link the person
sends THEMSELVES from their own phone — CoveyKeep sends nothing, so A2P does
not apply, and no phone number is stored anywhere. ONE link for the group,
not one per person (a one-time link in a group text admits only whoever
taps first), and because a link in a family text gets forwarded, EVERY JOIN
THROUGH IT WAITS FOR THE ADMIN'S OR A CO-ADMIN'S YES: a forwarded link
would otherwise hand a stranger the group's upcoming gatherings, addresses
included. Any member may see and share the link (once every join waits for
an approval, the approval is the control); the admin and co-admins make,
replace and revoke it, and approve and decline the requests.

THE TOKEN IS NEVER STORED. It is `<link id>.<MAC>`, the MAC an HMAC-SHA256
under the session secret over a context string plus the link id
(app/security.py::group_link_token), base64url without padding. The row
holds no token column, so any member can be shown the link again and a
leaked database yields no working link; verification parses the id,
recomputes and compares in constant time, and an unknown id and a wrong MAC
are the same `invalid`. Rotating the session secret kills every link, as it
kills every session — accepted. **NEVER LOGGED, in any record, on any
path** — not the token, not a URL carrying it (the presigned-URL
discipline; pinned with the root at DEBUG). It rides the URL FRAGMENT
(`${APP_BASE_URL}/groups/join#token=…`), never a query string, and the two
endpoints that take it are POSTs so it stays out of access logs (CK-25's
reason). The frontend route does not exist yet (Groups 3). Since CK-75.1 the
app's catch-all keeps such an address — path and fragment, the token with
it — and says the page isn't available, offering a reload when a newer
bundle is waiting; before CK-75.1 it redirected to `/` and dropped the
fragment (CK-75's finding 1). What this router knows is only that the route
does not exist yet, never where the link lands.

THE REQUEST. A person who follows the link signs in through the UNMODIFIED
path — /auth/verify stays the one place a person, their account and their
ToS acceptance are born (the CK-25 rule); nothing here creates a person —
and asks to join. The request shows its approvers the person's display name
and nothing else about them. An open request never expires (a keeping
request's shape, keeping-explained §5.12); one open request per (group,
person) — the partial unique, which two concurrent joins run into and the
second answers `pending`. Someone already in the group who follows the link
is simply in: `already_member`, never a duplicate request. Approving
creates the membership in the same transaction as the decision; a decided
request is stamped, never deleted (it keeps counting toward the rate limit
below), and the reaper takes it an hour after the decision. The group id
goes only to a member.

WHETHER A DECLINED REQUESTER IS TOLD IS OPEN (record §12). Nothing here
claims a decision that was not made: a declined person who follows the link
again simply makes a new request, and the approvers see it again.

RATE LIMIT: open-or-decided requests per group over auth.RATE_WINDOW,
counted by `created_at`, refused past MAX_JOIN_REQUESTS_PER_GROUP — fifty,
because a family text can bring thirty people in a quarter of an hour.
Decided rows are stamped and never deleted by any endpoint, so they keep
counting; the reaper's grace exceeds the window (services/retention.py).

DATA-HANDLING: the preview discloses the group's NAME to whoever holds the
link, which is what the link already did. A join request names its
requester and nothing else about them; once decided it is ephemeral. The
link row holds no secret. Nothing here is logged.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import RATE_WINDOW
from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.groups import _group_for_organiser, _group_for_read, is_group_admin
from app.api.invitations import INVITATION_TTL, TokenBody
from app.config import settings
from app.models import Group, GroupJoinRequest, GroupLink, JoinRequestOutcome, Membership, Person
from app.security import group_link_token, parse_group_link_token
from app.services.groups import invite_newcomer_to_upcoming_gatherings
from app.services.retention import purge_stale

router = APIRouter(prefix="", tags=["group-links"])

# The link lives as long as an emailed invitation (seven days) — CK-25's
# number, bound to it so the two ways in cannot drift apart silently.
LINK_TTL = INVITATION_TTL

# Counted over auth.RATE_WINDOW against join requests by created_at — open
# and decided alike (decided rows are stamped, never deleted, precisely so
# they keep counting). A family text can bring thirty people in a quarter
# of an hour; fifty leaves room and still bounds a forwarded link.
MAX_JOIN_REQUESTS_PER_GROUP = 50

# The one 409 on the decisions (the CK-30 marker precedent).
ALREADY_DECIDED = "already_decided"

NO_LINK = {"url": None, "expires_at": None}


def _no_such_request() -> HTTPException:
    # One body for "no open request of this group by that id" — reachable
    # only by an organiser, who reads the list; everyone else drew the
    # group's 404 one door earlier.
    return HTTPException(404, "No such join request.")


def _link_url(link_id: UUID) -> str:
    # The token in the URL FRAGMENT (never the query string — fragments
    # don't reach servers, access logs, or Referer). Minted here and
    # returned in the body; never logged.
    return f"{settings.app_base_url}/groups/join#token={group_link_token(link_id, settings.session_secret)}"


def _link_body(row: GroupLink) -> dict:
    return {"url": _link_url(row.id), "expires_at": row.expires_at.isoformat()}


async def _resolve_link_token(
    db: AsyncSession, token: str, now: datetime
) -> tuple[str, Optional[GroupLink]]:
    """Resolve a raw link token to (status, row). Statuses: valid, expired,
    revoked, invalid. Revoked outranks expired — a replaced link has BOTH
    stamps' semantics (revoked_at set, expires_at forced), and "withdrawn
    or replaced" is the truthful message for it. An unknown id and a wrong
    MAC are the same `invalid`."""
    link_id = parse_group_link_token(token, settings.session_secret)
    if link_id is None:
        return "invalid", None
    row = await db.get(GroupLink, link_id)
    if row is None:
        return "invalid", None
    if row.revoked_at is not None:
        return "revoked", row
    if row.expires_at <= now:
        return "expired", row
    return "valid", row


async def _revoke_links(db: AsyncSession, group_id: UUID, now: datetime) -> None:
    """Stamp every unrevoked link of the group revoked, forcing its expiry
    to now where it was later (never later than it was — the reaper's
    schedule), so the partial unique's one-live-link slot is free."""
    await db.execute(
        update(GroupLink)
        .where(GroupLink.group_id == group_id, GroupLink.revoked_at.is_(None))
        .values(revoked_at=now, expires_at=func.least(GroupLink.expires_at, now))
    )


# --- the link (record §3) -------------------------------------------------------------


@router.post("/groups/{group_id}/link", status_code=201)
async def make_link(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """MAKE, OR REPLACE, THE GROUP'S LINK — delegable: the admin or a
    co-admin; a member and a stranger draw the group 404. Every unrevoked
    link for the group is stamped revoked first (the old token reads
    `revoked` from then on), then one row is inserted with `expires_at` =
    now + LINK_TTL. **201** `{"url", "expires_at"}` — the URL with the
    token in its fragment, which appears in this body and nowhere else.
    The reaper runs first: expired rows an hour past expiry go."""
    group = await _group_for_organiser(db, ctx, group_id)
    now = datetime.now(timezone.utc)
    await purge_stale(db, GroupLink, GroupLink.expires_at, now)
    await _revoke_links(db, group.id, now)
    row = GroupLink(
        group_id=group.id, created_by_person_id=ctx.person.id, expires_at=now + LINK_TTL
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _link_body(row)


@router.get("/groups/{group_id}/link")
async def read_link(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """ANY MEMBER MAY SEE AND SHARE THE LINK (record §3) — the read audience.
    **200** `{"url", "expires_at"}` for the live link (unrevoked and not yet
    expired), or `{"url": null, "expires_at": null}` when there is none —
    the same shape either way. A stranger draws the group 404. Shown again
    on every read because nothing is stored: the token is recomputed."""
    group = await _group_for_read(db, ctx, group_id)
    now = datetime.now(timezone.utc)
    row = await db.scalar(
        select(GroupLink).where(
            GroupLink.group_id == group.id,
            GroupLink.revoked_at.is_(None),
            GroupLink.expires_at > now,
        )
    )
    return _link_body(row) if row is not None else dict(NO_LINK)


@router.delete("/groups/{group_id}/link", status_code=204)
async def revoke_link(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """REVOKE THE LINK — delegable: the admin or a co-admin. Stamped, never
    deleted (the reaper takes the row an hour past the forced expiry).
    **204**, and idempotent: revoking a group with no live link is a 204."""
    group = await _group_for_organiser(db, ctx, group_id)
    await _revoke_links(db, group.id, datetime.now(timezone.utc))
    await db.commit()


# --- joining through the link (record §2) --------------------------------------------


@router.post("/group-links/preview")
async def preview_link(body: TokenBody, db: AsyncSession = Depends(get_db)) -> dict:
    """UNAUTHENTICATED, deliberately (CK-25's reason): the join screen must
    render its distinguished states — and the group's name, as context
    worth signing in for — BEFORE pushing someone through the magic-link
    round trip. **200** `{"status", "group_name"}` — `status` one of
    `valid` | `expired` | `revoked` | `invalid`; the name only when valid.
    It discloses the group's name to whoever holds the link, which is what
    the link already did; nothing about any account is revealed. A POST so
    the token stays out of access logs."""
    now = datetime.now(timezone.utc)
    status, row = await _resolve_link_token(db, body.token, now)
    name = None
    if status == "valid" and row is not None:
        group = await db.get(Group, row.group_id)
        if group is None:
            status = "invalid"
        else:
            name = group.name
    return {"status": status, "group_name": name}


@router.post("/group-links/join")
async def join_through_link(
    body: TokenBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """ASK TO JOIN — authenticated: the person already exists (born, if new,
    by /auth/verify with their ToS acceptance — never here). A flow
    endpoint: every resolvable outcome is a **200** with `{"status",
    "group_id"}`. `already_member` carries the group id — the caller is a
    member (a membership row, or the admin) and is simply in; `pending` —
    they have an open request already; `requested` — the request was
    created and waits for the admin's or a co-admin's yes; a dead token
    answers its own status (`expired` | `revoked` | `invalid`). **The group
    id goes only to a member**: the other outcomes carry null. Two
    concurrent joins by one person make ONE open request (the partial
    unique; the loser answers `pending`). **429** past the per-group rate
    limit. The reaper runs first: decided requests an hour past their
    decision go."""
    now = datetime.now(timezone.utc)
    await purge_stale(db, GroupJoinRequest, GroupJoinRequest.decided_at, now)
    status, row = await _resolve_link_token(db, body.token, now)
    if status != "valid" or row is None:
        return {"status": status, "group_id": None}
    group = await db.get(Group, row.group_id)
    if group is None:
        return {"status": "invalid", "group_id": None}

    member = await db.scalar(
        select(Membership.id).where(
            Membership.group_id == group.id, Membership.person_id == ctx.person.id
        )
    )
    if member is not None or is_group_admin(group, ctx):
        return {"status": "already_member", "group_id": str(group.id)}
    open_request = await db.scalar(
        select(GroupJoinRequest.id).where(
            GroupJoinRequest.group_id == group.id,
            GroupJoinRequest.person_id == ctx.person.id,
            GroupJoinRequest.decided_at.is_(None),
        )
    )
    if open_request is not None:
        return {"status": "pending", "group_id": None}

    recent = await db.scalar(
        select(func.count())
        .select_from(GroupJoinRequest)
        .where(
            GroupJoinRequest.group_id == group.id,
            GroupJoinRequest.created_at > now - RATE_WINDOW,
        )
    )
    if recent >= MAX_JOIN_REQUESTS_PER_GROUP:
        raise HTTPException(429, "Too many requests to join this group just now. Try again later.")

    db.add(GroupJoinRequest(group_id=group.id, person_id=ctx.person.id))
    try:
        await db.commit()
    except IntegrityError:
        # Two joins by one person racing: the partial unique held, so an
        # open request exists — the outcome the check above would draw.
        await db.rollback()
        return {"status": "pending", "group_id": None}
    return {"status": "requested", "group_id": None}


@router.get("/groups/{group_id}/join-requests")
async def list_join_requests(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE OPEN REQUESTS — the admin's and co-admins' (record §5): a member
    and a stranger draw the group 404. **200** `{"join_requests": [{"id",
    "display_name", "created_at"}, …]}`, oldest first — the requester's
    display name and nothing else about them; no email, no person id. ONE
    statement."""
    group = await _group_for_organiser(db, ctx, group_id)
    rows = (
        await db.execute(
            select(GroupJoinRequest.id, Person.display_name, GroupJoinRequest.created_at)
            .join(Person, Person.id == GroupJoinRequest.person_id)
            .where(
                GroupJoinRequest.group_id == group.id,
                GroupJoinRequest.decided_at.is_(None),
                Person.anonymized_at.is_(None),
            )
            .order_by(GroupJoinRequest.created_at, GroupJoinRequest.id)
        )
    ).all()
    return {
        "join_requests": [
            {"id": str(request_id), "display_name": display_name, "created_at": created_at.isoformat()}
            for request_id, display_name, created_at in rows
        ]
    }


async def _decide(
    db: AsyncSession, ctx: AuthContext, group_id: UUID, request_id: UUID, outcome: JoinRequestOutcome
) -> dict:
    """ONE guarded UPDATE keyed on `decided_at IS NULL` — a decided request
    is a **409** `already_decided` carrying the outcome, whether read
    before the write or lost to a racing decision. Approving also writes
    the membership in the same transaction — idempotent: a requester who is
    already a member (an emailed invitation accepted meanwhile) approves to
    nothing new. The membership insert can race an acceptance on the
    memberships UNIQUE; then the decision alone is re-applied."""
    group = await _group_for_organiser(db, ctx, group_id)
    request = await db.get(GroupJoinRequest, request_id)
    if request is None or request.group_id != group.id:
        raise _no_such_request()
    if request.decided_at is not None:
        raise _already_decided(request.outcome)
    person_id, created_at = request.person_id, request.created_at
    now = datetime.now(timezone.utc)

    async def decide() -> int:
        result = await db.execute(
            update(GroupJoinRequest)
            .where(GroupJoinRequest.id == request_id, GroupJoinRequest.decided_at.is_(None))
            .values(decided_at=now, outcome=outcome, decided_by_person_id=ctx.person.id)
        )
        return result.rowcount

    if await decide() != 1:
        # Lost to a racing decision: nothing of ours is written.
        await db.rollback()
        fresh = await db.get(GroupJoinRequest, request_id)
        raise _already_decided(fresh.outcome if fresh is not None else None)
    if outcome is JoinRequestOutcome.APPROVED:
        member = await db.scalar(
            select(Membership.id).where(
                Membership.group_id == group.id, Membership.person_id == person_id
            )
        )
        if member is None:
            db.add(Membership(group_id=group.id, person_id=person_id))
            # THE NEWCOMER'S PLACES (CK-76; the 2026-10-04 record §9): a row
            # on each of the group's UPCOMING gatherings they hold none for,
            # `invited_by_person_id` NULL — the group's rule invited them —
            # in the transaction that writes the membership, so the two
            # land together or not at all. Past gatherings are never
            # written. The one helper both admission paths call.
            await invite_newcomer_to_upcoming_gatherings(
                db, group_id=group.id, person_id=person_id, now=now
            )
    try:
        await db.commit()
    except IntegrityError:
        # The membership landed by another path between our check and our
        # commit (an acceptance, which wrote the newcomer's places itself):
        # the decision stands on its own.
        await db.rollback()
        if await decide() != 1:
            await db.rollback()
            fresh = await db.get(GroupJoinRequest, request_id)
            raise _already_decided(fresh.outcome if fresh is not None else None)
        await db.commit()
    display_name = await db.scalar(select(Person.display_name).where(Person.id == person_id))
    return {
        "id": str(request_id),
        "display_name": display_name,
        "created_at": created_at.isoformat(),
        "outcome": outcome.value,
        "decided_at": now.isoformat(),
    }


def _already_decided(outcome: Optional[JoinRequestOutcome]) -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": ALREADY_DECIDED,
            "outcome": outcome.value if outcome is not None else None,
            "message": "this request has already been decided",
        },
    )


@router.post("/groups/{group_id}/join-requests/{request_id}/approve")
async def approve_join_request(
    group_id: UUID,
    request_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """APPROVE — delegable: the admin or a co-admin opens the door (record
    §3). The request is stamped `approved` with the approver, and the
    membership is created in the same transaction (idempotent if they are
    already in). **200** `{"id", "display_name", "created_at", "outcome",
    "decided_at"}`; **409** `already_decided` for a decided request;
    **404** for a request that is not this group's, and the group's 404
    for everyone who is not an organiser."""
    return await _decide(db, ctx, group_id, request_id, JoinRequestOutcome.APPROVED)


@router.post("/groups/{group_id}/join-requests/{request_id}/decline")
async def decline_join_request(
    group_id: UUID,
    request_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """DECLINE — delegable, the same shape as approve with no membership
    written. The requester is not told (open, record §12): following the
    link again simply makes a new request."""
    return await _decide(db, ctx, group_id, request_id, JoinRequestOutcome.DECLINED)
