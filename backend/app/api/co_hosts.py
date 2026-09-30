"""Co-hosts (CK-68; decisions/2026-09-03-co-hosts.md) — the relation's own
surface: the host makes a co-host and removes one, a co-host steps down,
and the host and the co-hosts read the list.

THE HOST STAYS SINGULAR AND STAYS THE CONSENT CONTROLLER (co-hosts §1–§2;
CK-15 §4). A co-host is a row in `gathering_co_hosts` (migration 0027)
beside `gatherings.host_account_id` — one flag and a reserved list (§4),
never a permission matrix: there is no per-co-host toggle here and none may
be added. What a co-host may do is decided by the two helpers in
api/gatherings.py — `is_host` (the reserved set) and `may_administer` (the
delegable set) — and every check in the backend is one or the other (§5's
audit; the classification, one line per check, is in
reference/backend/api-reference.md). ADDING OR REMOVING CO-HOSTS IS ITSELF
RESERVED (§4): `POST` and the host's `DELETE` go through
`_gathering_for_host`; a co-host may step down (their OWN row — not
"removing a co-host" in §4's sense) and may NOT remove another co-host
(§7's second open item: the answer built is no, and revisiting it is a
decision to record, never a one-line code change).

WHO MAY BE MADE ONE, AND HOW THEY ARE NAMED. A person who holds an ACCEPTED
invitation to this gathering (a person-targeted `gathering_invitations`
row — the CK-25 read audience), who is not the host and not already a
co-host. The identifier is THE ACCEPTED INVITATION'S ID — the one handle
for a person in this gathering that the host already reads
(`GET /gatherings/{id}/invitations`'s `accepted` entries carry it beside a
display name) — so this router never exposes an email, a person id or an
account id the host could not already read, and the list below carries the
same handle beside a display name and nothing else. Two consequences,
recorded rather than discovered: a KEEPER who holds no accepted invitation
has no handle the host can read and cannot be made a co-host through this
surface (every keeper on the deploy is the host — the sponsorship shape
exists only by psql — and the keeper surface is the trigger); and an
ANONYMIZED invitee is refused, because deletion ends co-hosting
(services/keeping.py's deletion leg) and a later add must not undo it.

Refusals on the add are field-level 422s on `invitation_id` carrying a
STABLE CODE (the CK-30 marker precedent): `not_invited`, `is_host`,
`already_co_host`, `account_deleted`. Every other refusal is a 404 — the
GATHERING's for anyone who is not an organiser (byte-identical to a missing
gathering: the gatherings posture) and, on the reserved add, for a co-host
too (the route hides; a person who can read the gathering and may not act
on it draws the same 404 an uploader draws on `publish`); and the co-host
404 for a handle that names no accepted invitee of this gathering, or one a
co-host may not remove. The host's remove is idempotent (a 204 for an
invitee who is not a co-host — revoke's precedent). Nothing here logs
(pinned with the root at DEBUG): a co-host list is a roster.

DATA-HANDLING: this router widens who can ACT on a gathering and never who
can decide a consent question (co-hosts §8). It writes one fact — this
account co-hosts this gathering, added by that account — and reads back
display names alone. An anonymized account's co-hosting ends with its
deletion and cannot be restored here.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import (
    _gathering_for_host,
    _gathering_for_organiser,
    is_co_host,
    is_host,
)
from app.models import Gathering, GatheringCoHost, GatheringInvitation, Person

router = APIRouter(prefix="", tags=["co-hosts"])

# The stable codes on the add's 422 (the CK-30 marker precedent): the
# frontend switches on these, never on wording.
NOT_INVITED = "not_invited"
IS_HOST = "is_host"
ALREADY_CO_HOST = "already_co_host"
ACCOUNT_DELETED = "account_deleted"


def _not_found() -> HTTPException:
    # One body for "no such accepted invitee here" and "not yours to remove"
    # — reachable only by an organiser, who can read the list; everyone
    # else drew the gathering's 404 one door earlier.
    return HTTPException(404, "No such co-host.")


def _refusal(code: str, message: str) -> HTTPException:
    # Field-level, on the one field the body has, carrying the code beside
    # the message (the batch-publish item shape) so the frontend can switch
    # on it.
    return HTTPException(
        422,
        detail=[
            {
                "loc": ["body", "invitation_id"],
                "msg": message,
                "type": "value_error",
                "code": code,
            }
        ],
    )


class CoHostCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The accepted invitation's id — the handle the host already reads in
    # `GET /gatherings/{id}/invitations`. Never an email, a person id or an
    # account id (the module docstring).
    invitation_id: UUID


def _body(invitation_id: UUID, display_name: Optional[str], added_at: datetime, *, is_self: bool) -> dict:
    # A display name and the handle — never an email, a person id or an
    # account id (the RSVP roster's rule). `is_self` is the one
    # caller-relative fact, so a co-host can find their own row to step
    # down from without holding any id of their own.
    return {
        "invitation_id": str(invitation_id),
        "display_name": display_name,
        "added_at": added_at.isoformat(),
        "is_self": is_self,
    }


async def _accepted(
    db: AsyncSession, gathering: Gathering, invitation_id: UUID
) -> Optional[tuple[GatheringInvitation, Person]]:
    """The accepted, person-targeted invitation by that id IN THIS
    GATHERING, with its person — or None. The inner join on `people`
    excludes a group-targeted row (person_id NULL) by construction."""
    return (
        await db.execute(
            select(GatheringInvitation, Person)
            .join(Person, Person.id == GatheringInvitation.person_id)
            .where(
                GatheringInvitation.id == invitation_id,
                GatheringInvitation.gathering_id == gathering.id,
            )
        )
    ).first()


@router.post("/gatherings/{gathering_id}/co-hosts", status_code=201)
async def add_co_host(
    gathering_id: UUID,
    body: CoHostCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE HOST MAKES A CO-HOST — reserved (co-hosts §4): a co-host, an
    invitee, a keeper and a stranger each draw the gathering 404
    byte-identical to a missing id. The subject is an accepted invitee of
    this gathering, named by their invitation id; the four refusals are
    422s on that field with stable codes, and none writes a row. **201**
    with the new co-host's entry (the list's item shape)."""
    gathering = await _gathering_for_host(db, ctx, gathering_id)
    found = await _accepted(db, gathering, body.invitation_id)
    if found is None:
        raise _refusal(
            NOT_INVITED, "nobody has accepted an invitation to this gathering by that id"
        )
    invitation, person = found
    if person.anonymized_at is not None:
        # Deletion ended their co-hosting (services/keeping.py) and must
        # not be undone by a later add: an anonymized account organises
        # nothing. The host already reads this person as "a former member"
        # in the accepted list, so the code discloses nothing new.
        raise _refusal(ACCOUNT_DELETED, "that account has been deleted, so it can't co-host")
    if person.account_id == gathering.host_account_id:
        # Host and co-host are exclusive — the verifier asserts no co-host
        # row names its gathering's host, and this is where it is kept
        # true (a host CAN hold an accepted invitation to their own
        # gathering: nothing stops them inviting and accepting).
        raise _refusal(IS_HOST, "the host runs this gathering already and can't be made its co-host")
    if await is_co_host(db, gathering.id, person.account_id):
        raise _refusal(ALREADY_CO_HOST, "they're already a co-host of this gathering")
    # Read before the write: on the racing-add path below the session is
    # rolled back, and nothing loaded may be touched after that.
    invitation_id = invitation.id
    display_name = person.display_name
    row = GatheringCoHost(
        gathering_id=gathering.id,
        account_id=person.account_id,
        # Provenance: who made them a co-host — the host, by construction
        # of the loader above.
        added_by_account_id=ctx.person.account_id,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        # Two adds of the same person racing: the primary key held, so the
        # row exists — the same refusal the check above would have drawn.
        await db.rollback()
        raise _refusal(ALREADY_CO_HOST, "they're already a co-host of this gathering")
    await db.refresh(row)
    return _body(invitation_id, display_name, row.created_at, is_self=False)


@router.get("/gatherings/{gathering_id}/co-hosts")
async def list_co_hosts(
    gathering_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The gathering's co-hosts — readable by the organisers (the host and
    the co-hosts, `may_administer`) and by nobody else: an invitee, a
    keeper and a stranger each draw the gathering 404. **200**
    `{"co_hosts": [{"invitation_id", "display_name", "added_at",
    "is_self"}, …]}`, oldest first — display names and the handle, never
    an email, a person id or an account id; the adder is provenance and
    rides no body. ONE statement: the co-host rows joined to their person
    (people ↔ accounts is one-to-one) and to that person's accepted
    invitation in this gathering — every co-host was made through one,
    and nothing deletes an accepted invitation."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    rows = (
        await db.execute(
            select(
                GatheringInvitation.id,
                Person.display_name,
                GatheringCoHost.created_at,
                GatheringCoHost.account_id,
            )
            .select_from(GatheringCoHost)
            .join(Person, Person.account_id == GatheringCoHost.account_id)
            .join(
                GatheringInvitation,
                and_(
                    GatheringInvitation.gathering_id == GatheringCoHost.gathering_id,
                    GatheringInvitation.person_id == Person.id,
                ),
            )
            .where(GatheringCoHost.gathering_id == gathering.id)
            .order_by(GatheringCoHost.created_at, GatheringCoHost.account_id)
        )
    ).all()
    return {
        "co_hosts": [
            _body(invitation_id, display_name, added_at, is_self=(account_id == ctx.person.account_id))
            for invitation_id, display_name, added_at, account_id in rows
        ]
    }


@router.delete("/gatherings/{gathering_id}/co-hosts/{invitation_id}", status_code=204)
async def remove_co_host(
    gathering_id: UUID,
    invitation_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """THE HOST REMOVES A CO-HOST, or A CO-HOST STEPS DOWN. Two callers, one
    route: the host may remove anyone (reserved — co-hosts §4), and a
    co-host may remove exactly themselves (stepping down is not "removing
    a co-host" in §4's sense). A co-host naming ANOTHER co-host draws the
    co-host 404 — hidden, not refused (§7's second item, open; the answer
    built is no) — and so does a handle that names no accepted invitee of
    this gathering. Everyone who is not an organiser drew the gathering
    404 already. **204**, and idempotent for the host: removing an invitee
    who is not a co-host is a 204 (revoke's precedent) — the state asked
    for is the state that holds."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    found = await _accepted(db, gathering, invitation_id)
    if found is None:
        raise _not_found()
    _, person = found
    if not is_host(gathering, ctx) and person.account_id != ctx.person.account_id:
        raise _not_found()
    await db.execute(
        delete(GatheringCoHost).where(
            GatheringCoHost.gathering_id == gathering.id,
            GatheringCoHost.account_id == person.account_id,
        )
    )
    await db.commit()
