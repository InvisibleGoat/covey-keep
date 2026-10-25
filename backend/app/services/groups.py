"""Groups — the person-spine writes that live outside the routers
(CK-45; succession since CK-75 — decisions/2026-09-14-groups-get-a-surface.md,
decisions/2026-10-23-joining-a-group-and-co-admins.md §7; the group's
gatherings since CK-76 — §4 there, decisions/2026-09-17-a-group-is-archived-
never-deleted.md §6–§6.1, decisions/2026-10-04-a-groups-gathering-stays-in-
the-group.md §4, §9).

Four functions. `lapse_group_roles` is called from the account-deletion
transaction (api/profile.py::delete_account) beside services/keeping.py's
lapse_kept_statuses — the sixth deletion-path integration, after 0006's
email-change purge, 0007's WebAuthn hard-delete, CK-13's kept-status lapse,
CK-15's consent revocation, and host relinquishment. It is its own module
rather than a clause inside lapse_kept_statuses because the two live on
different spines: keeping is an ACCOUNT fact (lapse_kept_statuses takes an
account id), and group administration is a PERSON fact (`groups.
admin_person_id` and `group_co_admins.person_id` are person FKs) — the same
separation api/groups.py's authorization rests on.

THE OTHER THREE WRITE A GROUP GATHERING'S PLACES (CK-76; the host's choice
CK-77), and the rule they serve is the archive record's §6.1: EVERY MEMBER'S
PLACE IN A GROUP'S GATHERING IS A ROW — a person-targeted
`gathering_invitations` row for the INVITED, a `gathering_member_places` row
for the SHARED WITH and the LEFT OUT (the 2026-10-04 record §4; a sibling
relation, never a kind on the invitation row — models/gathering.py) —
materialized when the gathering is created (`invite_group_members` for the
whole group; `place_group_members` when the host chose) and when someone
joins the group afterwards (`invite_newcomer_to_upcoming_gatherings`) — and
NEVER computed from membership at read time. A live membership lookup would
make removing someone from the group silently revoke every gathering they
were part of, the precise outcome §6 refuses; with rows, removing or
leaving a member changes none of their gatherings (api/groups.py's leave
and remove touch no invitation row and no place row, pinned). One helper
per place each, so the routers that admit a member (api/group_links.py's
approve, api/group_invitations.py's accept) cannot re-type the newcomer's
rule and drift. Every function here leaves the commit to the caller, so the
change lands in the caller's transaction or not at all.

KEEPING LETS NO ONE IN (CK-77; keeping-explained §5.11): nothing here reads
a keeper column, and no row written here is a keeper's. Who sees a
gathering is its host, its co-hosts and the people the rows below name.

`lapse_group_roles` was RENAMED at CK-75 from `relinquish_group_admin`, for
what it now does: the admin role is no longer merely relinquished — it is
HANDED to the longest-serving co-admin where one exists (record §7:
deleting an account is a right and cannot wait on a handover, so succession
is automatic), and the person's other group roles — co-admin rows, open
join requests — end with the account. It stopped touching
`groups.backup_admin_person_id` at CK-76 (unmapped), and the column itself
was dropped at 0034 (CK-77).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import Uuid, delete, exists, func, insert, literal, null, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Gathering,
    GatheringInvitation,
    GatheringMemberPlace,
    Group,
    GroupCoAdmin,
    GroupJoinRequest,
    MemberPlace,
    Membership,
    Occurrence,
    Person,
)
from app.models.enums import MEMBER_PLACE


async def lapse_group_roles(db: AsyncSession, person_id: UUID) -> None:
    """An anonymized person's group roles lapse (CK-45 §8 as superseded by
    the joining-a-group record §7). Three writes, in this order:

    (1) For each group the person ADMINISTERS: the longest-serving co-admin
        — the earliest `group_co_admins.created_at`, then `person_id` as
        the tiebreak, whose own person is not anonymized — becomes the
        admin and their co-admin row is deleted (an admin is never also a
        co-admin). With no co-admin, `admin_person_id` goes NULL — the
        "needs an admin" state, whose home is the claim flow. This REPLACES
        CK-45's "the backup admin is not promoted", which deferred
        succession rather than refusing it.
    (2) The person's co-admin rows are DELETED everywhere — a row here IS
        the role, and there is no "needs a co-admin" state to leave behind
        (the CK-68 co-host leg's reasoning). Rows the person ADDED stay:
        `added_by_person_id` is provenance, and nothing cascades from a
        person.
    (3) The person's OPEN join requests are deleted: a request waiting on a
        decision for someone who can never join is noise to its approvers.
        Decided ones are left to the reaper (they are stamped data that
        keeps counting toward the rate tally until the grace is past).

    The retired `backup_admin_person_id` is gone (dropped at 0034, CK-77):
    unmapped at CK-76, and from CK-45 to CK-75 this function NULLed it
    wherever the person held it — a write that could only ever have been a
    no-op, because nothing ever set the column.

    Memberships are RETAINED, still attributed to the anonymized person —
    the retention default (database-schema decisions 12 and 15: nothing
    cascades from a person): a group's history of who belonged is the same
    class as a retained contribution. The member list and `member_count`
    exclude the anonymized person (api/groups.py), so the row is unlisted
    and uncounted but never gone. The person's `gathering_invitations` rows
    on the group's gatherings stay too (CK-76) — an invitation is a
    contribution-class fact, and the read audience already answers an
    anonymized person's rows to nobody (nobody can sign in as one). The
    group's KEEPER is untouched here — that is the account-spine lapse's
    (services/keeping.py), and keeping never falls back to the admin
    (record §7).

    The person's `gathering_member_places` rows on the group's gatherings
    stay too (CK-77), for the same reason their invitation rows do: a place
    is a contribution-class fact about who stood where, and it admits
    nobody once the person is anonymized (nobody can sign in as one).

    `updated_at` is not stamped — it records renames, and this is a
    lifecycle write, not a rename. The caller commits."""
    administered = (
        await db.scalars(select(Group).where(Group.admin_person_id == person_id))
    ).all()
    for group in administered:
        successor = (
            await db.execute(
                select(GroupCoAdmin.person_id)
                .join(Person, Person.id == GroupCoAdmin.person_id)
                .where(
                    GroupCoAdmin.group_id == group.id,
                    # An anonymized co-admin's rows go with their own
                    # deletion (2), so none should be here — guarded all
                    # the same: a successor must be someone who can sign in.
                    Person.anonymized_at.is_(None),
                )
                .order_by(GroupCoAdmin.created_at, GroupCoAdmin.person_id)
                .limit(1)
            )
        ).scalar_one_or_none()
        group.admin_person_id = successor
        if successor is not None:
            await db.execute(
                delete(GroupCoAdmin).where(
                    GroupCoAdmin.group_id == group.id, GroupCoAdmin.person_id == successor
                )
            )
    await db.execute(delete(GroupCoAdmin).where(GroupCoAdmin.person_id == person_id))
    await db.execute(
        delete(GroupJoinRequest).where(
            GroupJoinRequest.person_id == person_id, GroupJoinRequest.decided_at.is_(None)
        )
    )


# --- a group gathering's places: rows, never a lookup (CK-76; the choice CK-77) ---


def _upcoming(now: datetime):
    """A gathering is UPCOMING when at least one of its dates ENDS at or
    after `now` — `ends_at`, else `starts_at` (the planning session's
    definition for CK-76): a season with dates both past and ahead is
    upcoming, and so is a date in progress. An EXISTS correlated on
    `Gathering.id` in the caller's FROM."""
    return exists(
        select(Occurrence.id).where(
            Occurrence.gathering_id == Gathering.id,
            func.coalesce(Occurrence.ends_at, Occurrence.starts_at) >= now,
        )
    )


async def invite_group_members(
    db: AsyncSession, *, gathering_id: UUID, group_id: UUID, invited_by_person_id: UUID
) -> int:
    """At create, THE WHOLE GROUP INVITED (record §4; the 2026-10-04 record
    §4's default — the create with neither list, `invitees_chosen` false):
    one person-targeted `gathering_invitations` row for every member of the
    group whose person is not anonymized, EXCEPT the creator, who is the
    host and needs no invitation; each row's `invited_by_person_id` is the
    creator. ONE INSERT ... SELECT over the memberships joined to their
    people — the gathering is new, so no row can conflict, and `memberships`
    is UNIQUE on (group, person), so no member is written twice. Returns the
    number of rows written. Never commits: the create transaction does, so
    the gathering, its dates and its members' places land together or not
    at all (the CK-16 ordering, extended). The caller has already checked
    that the creator is a member and the group a HOUSEHOLD; this function
    trusts neither and checks nothing — it is a write, not a gate. When the
    host CHOSE, `place_group_members` writes the rows instead."""
    source = (
        select(
            literal(gathering_id, type_=Uuid()).label("gathering_id"),
            Membership.person_id.label("person_id"),
            literal(invited_by_person_id, type_=Uuid()).label("invited_by_person_id"),
        )
        .select_from(Membership)
        .join(Person, Person.id == Membership.person_id)
        .where(
            Membership.group_id == group_id,
            Membership.person_id != invited_by_person_id,
            Person.anonymized_at.is_(None),
        )
    )
    result = await db.execute(
        insert(GatheringInvitation).from_select(
            ["gathering_id", "person_id", "invited_by_person_id"], source
        )
    )
    return result.rowcount


async def place_group_members(
    db: AsyncSession,
    *,
    gathering_id: UUID,
    group_id: UUID,
    chooser_person_id: UUID,
    invited_person_ids: set[UUID],
    left_out_person_ids: set[UUID],
) -> tuple[int, int, int]:
    """At create, THE HOST CHOSE (CK-77; the 2026-10-04 record §4): the
    members in `invited_person_ids` get a person-targeted
    `gathering_invitations` row (`invited_by_person_id` the chooser —
    exactly `invite_group_members`' row); the members in
    `left_out_person_ids` get a `left_out` place row; EVERY OTHER live member
    of the group — not the creator, not anonymized, in neither set — gets a
    `shared_with` place row (`set_by_person_id` the chooser): "the rest are
    shared with the gathering automatically", Steven's model. Three INSERT
    ... SELECTs over the memberships joined to their people, each filtering
    on the person ids the caller resolved from membership ids and checked
    (a live member of THIS group, not the creator, no id twice or in both
    sets — api/gatherings.py's create path; this function trusts and checks
    nothing, it is a write). The gathering is new, so no row can conflict.
    Returns (invited, left out, shared with) row counts. Never commits —
    the create transaction does. The caller sets `invitees_chosen` true in
    the same transaction; nothing here reads or writes it."""
    live_members = (
        select(Membership.person_id)
        .join(Person, Person.id == Membership.person_id)
        .where(
            Membership.group_id == group_id,
            Membership.person_id != chooser_person_id,
            Person.anonymized_at.is_(None),
        )
    )
    invited_source = live_members.where(Membership.person_id.in_(invited_person_ids)).with_only_columns(
        literal(gathering_id, type_=Uuid()).label("gathering_id"),
        Membership.person_id.label("person_id"),
        literal(chooser_person_id, type_=Uuid()).label("invited_by_person_id"),
    )
    invited = await db.execute(
        insert(GatheringInvitation).from_select(
            ["gathering_id", "person_id", "invited_by_person_id"], invited_source
        )
    )

    def place_source(place: MemberPlace, criterion):
        return live_members.where(criterion).with_only_columns(
            literal(gathering_id, type_=Uuid()).label("gathering_id"),
            Membership.person_id.label("person_id"),
            literal(place.value, type_=MEMBER_PLACE).label("place"),
            literal(chooser_person_id, type_=Uuid()).label("set_by_person_id"),
        )

    columns = ["gathering_id", "person_id", "place", "set_by_person_id"]
    left_out = await db.execute(
        insert(GatheringMemberPlace).from_select(
            columns,
            place_source(MemberPlace.LEFT_OUT, Membership.person_id.in_(left_out_person_ids)),
        )
    )
    shared = await db.execute(
        insert(GatheringMemberPlace).from_select(
            columns,
            place_source(
                MemberPlace.SHARED_WITH,
                Membership.person_id.notin_(invited_person_ids | left_out_person_ids),
            ),
        )
    )
    return invited.rowcount, left_out.rowcount, shared.rowcount


async def invite_newcomer_to_upcoming_gatherings(
    db: AsyncSession, *, group_id: UUID, person_id: UUID, now: datetime
) -> int:
    """At join (the 2026-10-04 record §9; the archive record §6.1 as
    amended): when a person BECOMES a member of the group — CK-75's two
    admission paths, an approved join request (api/group_links.py::_decide)
    and an accepted emailed invitation (api/group_invitations.py::accept),
    both in the transaction that writes the membership — one row for each
    of the group's UPCOMING gatherings (`_upcoming`) that the person holds
    NO ROW OF EITHER KIND for: AN INVITATION ROW where the gathering invites
    the whole group (`invitees_chosen` false — CK-76's rule as it stood),
    with `invited_by_person_id` NULL; A `shared_with` PLACE ROW where the
    host chose who is invited (`invitees_chosen` true — CK-77; the record
    §9: "shared with the upcoming ones whose host chose who is invited —
    exactly the place every other uninvited member has"), with
    `set_by_person_id` NULL. THE GROUP'S RULE PLACED THEM, NOT A PERSON (the
    CK-43 shape — a NULL publisher means the rule published it). Past
    gatherings are NEVER written: a newcomer is given what is coming, never
    what is past (§9 — the past stays behind the group's history setting, a
    different mechanism, unbuilt). The newcomer's place FOLLOWS the choice:
    the host may invite them afterwards through the places route.

    IDEMPOTENT against the partial unique on (gathering, person) and the
    places table's primary key: each SELECT excludes gatherings the person
    already holds a row of EITHER kind for, and each INSERT carries ON
    CONFLICT DO NOTHING on its index, so two admissions racing — an approval
    and an acceptance landing together — write each row once. TWO
    statements, one per table. Returns the number of rows written, both
    kinds. Never commits — the admission's transaction does, so the
    membership and the newcomer's places land together or not at all."""
    already_invited = exists(
        select(GatheringInvitation.id).where(
            GatheringInvitation.gathering_id == Gathering.id,
            GatheringInvitation.person_id == person_id,
        )
    )
    already_placed = exists(
        select(GatheringMemberPlace.gathering_id).where(
            GatheringMemberPlace.gathering_id == Gathering.id,
            GatheringMemberPlace.person_id == person_id,
        )
    )
    upcoming_without_a_row = (
        select(Gathering.id)
        .select_from(Gathering)
        .where(
            Gathering.owning_group_id == group_id,
            _upcoming(now),
            ~already_invited,
            ~already_placed,
        )
    )
    invitation_source = upcoming_without_a_row.where(
        Gathering.invitees_chosen.is_(False)
    ).with_only_columns(
        Gathering.id.label("gathering_id"),
        literal(person_id, type_=Uuid()).label("person_id"),
        null().label("invited_by_person_id"),
    )
    invitations = await db.execute(
        pg_insert(GatheringInvitation)
        .from_select(["gathering_id", "person_id", "invited_by_person_id"], invitation_source)
        .on_conflict_do_nothing(
            index_elements=["gathering_id", "person_id"],
            index_where=GatheringInvitation.person_id.is_not(None),
        )
    )
    place_source = upcoming_without_a_row.where(
        Gathering.invitees_chosen.is_(True)
    ).with_only_columns(
        Gathering.id.label("gathering_id"),
        literal(person_id, type_=Uuid()).label("person_id"),
        literal(MemberPlace.SHARED_WITH.value, type_=MEMBER_PLACE).label("place"),
        null().label("set_by_person_id"),
    )
    places = await db.execute(
        pg_insert(GatheringMemberPlace)
        .from_select(["gathering_id", "person_id", "place", "set_by_person_id"], place_source)
        .on_conflict_do_nothing(index_elements=["gathering_id", "person_id"])
    )
    return invitations.rowcount + places.rowcount
