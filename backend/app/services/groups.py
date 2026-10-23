"""Groups — the person-spine lifecycle write that lives outside the router
(CK-45; succession since CK-75 — decisions/2026-09-14-groups-get-a-surface.md,
decisions/2026-10-23-joining-a-group-and-co-admins.md §7).

One function, called from the account-deletion transaction
(api/profile.py::delete_account) beside services/keeping.py's
lapse_kept_statuses — the sixth deletion-path integration, after 0006's
email-change purge, 0007's WebAuthn hard-delete, CK-13's kept-status lapse,
CK-15's consent revocation, and host relinquishment. It is its own module
rather than a clause inside lapse_kept_statuses because the two live on
different spines: keeping is an ACCOUNT fact (lapse_kept_statuses takes an
account id), and group administration is a PERSON fact (`groups.
admin_person_id` and `group_co_admins.person_id` are person FKs) — the same
separation api/groups.py's authorization rests on. Every function here
leaves the commit to the caller, so the change lands in the caller's
transaction or not at all.

RENAMED at CK-75 from `relinquish_group_admin`, for what it now does: the
admin role is no longer merely relinquished — it is HANDED to the
longest-serving co-admin where one exists (record §7: deleting an account
is a right and cannot wait on a handover, so succession is automatic), and
the person's other group roles — co-admin rows, open join requests — end
with the account.
"""

from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Group, GroupCoAdmin, GroupJoinRequest, Person


async def lapse_group_roles(db: AsyncSession, person_id: UUID) -> None:
    """An anonymized person's group roles lapse (CK-45 §8 as superseded by
    the joining-a-group record §7). Four writes, in this order:

    (1) For each group the person ADMINISTERS: the longest-serving co-admin
        — the earliest `group_co_admins.created_at`, then `person_id` as
        the tiebreak, whose own person is not anonymized — becomes the
        admin and their co-admin row is deleted (an admin is never also a
        co-admin). With no co-admin, `admin_person_id` goes NULL — the
        "needs an admin" state, whose home is the claim flow. This REPLACES
        CK-45's "the backup admin is not promoted", which deferred
        succession rather than refusing it.
    (2) The retired `backup_admin_person_id` is NULLed wherever the person
        held it — unchanged from CK-45; the column stays mapped and unwritten
        until a later contract step drops it, so the NULLing is kept so the
        verifier's "NULL on every row" cannot fail on a row a deleted
        person once held.
    (3) The person's co-admin rows are DELETED everywhere — a row here IS
        the role, and there is no "needs a co-admin" state to leave behind
        (the CK-68 co-host leg's reasoning). Rows the person ADDED stay:
        `added_by_person_id` is provenance, and nothing cascades from a
        person.
    (4) The person's OPEN join requests are deleted: a request waiting on a
        decision for someone who can never join is noise to its approvers.
        Decided ones are left to the reaper (they are stamped data that
        keeps counting toward the rate tally until the grace is past).

    Memberships are RETAINED, still attributed to the anonymized person —
    the retention default (database-schema decisions 12 and 15: nothing
    cascades from a person): a group's history of who belonged is the same
    class as a retained contribution. The member list and `member_count`
    exclude the anonymized person (api/groups.py), so the row is unlisted
    and uncounted but never gone. The group's KEEPER is untouched here —
    that is the account-spine lapse's (services/keeping.py), and keeping
    never falls back to the admin (record §7).

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
                    # deletion (3), so none should be here — guarded all
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
    await db.execute(
        update(Group)
        .where(Group.backup_admin_person_id == person_id)
        .values(backup_admin_person_id=None)
    )
    await db.execute(delete(GroupCoAdmin).where(GroupCoAdmin.person_id == person_id))
    await db.execute(
        delete(GroupJoinRequest).where(
            GroupJoinRequest.person_id == person_id, GroupJoinRequest.decided_at.is_(None)
        )
    )
