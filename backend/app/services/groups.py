"""Groups — the person-spine writes that live outside the routers
(CK-45; succession since CK-75 — decisions/2026-09-14-groups-get-a-surface.md,
decisions/2026-10-23-joining-a-group-and-co-admins.md §7; the group's
gatherings since CK-76 — §4 there, decisions/2026-09-17-a-group-is-archived-
never-deleted.md §6–§6.1, decisions/2026-10-04-a-groups-gathering-stays-in-
the-group.md §4, §9).

Three functions. `lapse_group_roles` is called from the account-deletion
transaction (api/profile.py::delete_account) beside services/keeping.py's
lapse_kept_statuses — the sixth deletion-path integration, after 0006's
email-change purge, 0007's WebAuthn hard-delete, CK-13's kept-status lapse,
CK-15's consent revocation, and host relinquishment. It is its own module
rather than a clause inside lapse_kept_statuses because the two live on
different spines: keeping is an ACCOUNT fact (lapse_kept_statuses takes an
account id), and group administration is a PERSON fact (`groups.
admin_person_id` and `group_co_admins.person_id` are person FKs) — the same
separation api/groups.py's authorization rests on.

THE OTHER TWO WRITE A GROUP GATHERING'S INVITATIONS (CK-76), and the rule
they serve is the archive record's §6.1: EVERY MEMBER'S PLACE IN A GROUP'S
GATHERING IS A ROW — a person-targeted `gathering_invitations` row,
materialized when the gathering is created (`invite_group_members`) and
when someone joins the group afterwards
(`invite_newcomer_to_upcoming_gatherings`) — and NEVER computed from
membership at read time. A live membership lookup would make removing
someone from the group silently revoke every gathering they were part of,
the precise outcome §6 refuses; with rows, removing or leaving a member
changes none of their gatherings (api/groups.py's leave and remove touch
no invitation row, pinned). Two helpers, one place each, so the routers
that admit a member (api/group_links.py's approve, api/group_invitations.py's
accept) cannot re-type the newcomer's rule and drift. Every function here
leaves the commit to the caller, so the change lands in the caller's
transaction or not at all.

`lapse_group_roles` was RENAMED at CK-75 from `relinquish_group_admin`, for
what it now does: the admin role is no longer merely relinquished — it is
HANDED to the longest-serving co-admin where one exists (record §7:
deleting an account is a right and cannot wait on a handover, so succession
is automatic), and the person's other group roles — co-admin rows, open
join requests — end with the account. Since CK-76 it no longer touches
`groups.backup_admin_person_id`: the column is UNMAPPED (models/group.py —
nothing writes it, nothing reads it through the model; the verifier asserts
it NULL by raw SQL until CK-77 drops it).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import Uuid, delete, exists, func, insert, literal, null, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Gathering,
    GatheringInvitation,
    Group,
    GroupCoAdmin,
    GroupJoinRequest,
    Membership,
    Occurrence,
    Person,
)


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

    The retired `backup_admin_person_id` is NOT written here any more
    (CK-76): the column is unmapped, nothing ever set it, and the verifier
    reads it NULL by raw SQL until the drop. (CK-45 to CK-75 this function
    NULLed it wherever the person held it — a write that could only ever
    have been a no-op.)

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


# --- a group gathering's invitations: rows, never a lookup (CK-76) ----------------


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
    """At create (record §4; the 2026-10-04 record §4 — in this phase every
    member's place is INVITED): one person-targeted `gathering_invitations`
    row for every member of the group whose person is not anonymized, EXCEPT
    the creator, who is the host and needs no invitation; each row's
    `invited_by_person_id` is the creator. ONE INSERT ... SELECT over the
    memberships joined to their people — the gathering is new, so no row can
    conflict, and `memberships` is UNIQUE on (group, person), so no member
    is written twice. Returns the number of rows written. Never commits:
    the create transaction does, so the gathering, its dates and its
    members' places land together or not at all (the CK-16 ordering,
    extended). The caller has already checked that the creator is a member
    and the group a HOUSEHOLD; this function trusts neither and checks
    nothing — it is a write, not a gate."""
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


async def invite_newcomer_to_upcoming_gatherings(
    db: AsyncSession, *, group_id: UUID, person_id: UUID, now: datetime
) -> int:
    """At join (the 2026-10-04 record §9; the archive record §6.1 as
    amended): when a person BECOMES a member of the group — CK-75's two
    admission paths, an approved join request (api/group_links.py::_decide)
    and an accepted emailed invitation (api/group_invitations.py::accept),
    both in the transaction that writes the membership — one row for each
    of the group's UPCOMING gatherings (`_upcoming`) that the person holds
    no invitation row to, with `invited_by_person_id` NULL: THE GROUP'S RULE
    INVITED THEM, NOT A PERSON (the CK-43 shape — a NULL publisher means
    the rule published it). Past gatherings are NEVER written: a newcomer is
    given what is coming, never what is past (§9 — the past stays behind
    the group's history setting, a different mechanism, unbuilt).

    IDEMPOTENT against the partial unique on (gathering, person): the
    SELECT excludes gatherings the person already holds a row for, and the
    INSERT carries ON CONFLICT DO NOTHING on that index, so two admissions
    racing — an approval and an acceptance landing together — write each
    row once. ONE statement. Returns the number of rows written. Never
    commits — the admission's transaction does, so the membership and the
    newcomer's places land together or not at all."""
    already = exists(
        select(GatheringInvitation.id).where(
            GatheringInvitation.gathering_id == Gathering.id,
            GatheringInvitation.person_id == person_id,
        )
    )
    source = (
        select(
            Gathering.id.label("gathering_id"),
            literal(person_id, type_=Uuid()).label("person_id"),
            null().label("invited_by_person_id"),
        )
        .select_from(Gathering)
        .where(Gathering.owning_group_id == group_id, _upcoming(now), ~already)
    )
    statement = (
        pg_insert(GatheringInvitation)
        .from_select(["gathering_id", "person_id", "invited_by_person_id"], source)
        .on_conflict_do_nothing(
            index_elements=["gathering_id", "person_id"],
            index_where=GatheringInvitation.person_id.is_not(None),
        )
    )
    result = await db.execute(statement)
    return result.rowcount
