"""Groups — the person-spine lifecycle write that lives outside the router
(CK-45; decisions/2026-09-14-groups-get-a-surface.md).

One function today, called from the account-deletion transaction
(api/profile.py::delete_account) beside services/keeping.py's
lapse_kept_statuses — the sixth deletion-path integration, after 0006's
email-change purge, 0007's WebAuthn hard-delete, CK-13's kept-status lapse,
CK-15's consent revocation, and host relinquishment. It is its own module
rather than a clause inside lapse_kept_statuses because the two live on
different spines: keeping is an ACCOUNT fact (lapse_kept_statuses takes an
account id), and group administration is a PERSON fact (`groups.
admin_person_id` is a person FK) — the same separation api/groups.py's
authorization rests on. Every function here leaves the commit to the
caller, so the change lands in the caller's transaction or not at all.
"""

from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Group


async def relinquish_group_admin(db: AsyncSession, person_id: UUID) -> None:
    """An anonymized person administers nothing: `admin_person_id` and
    `backup_admin_person_id` are set NULL wherever the person held them —
    the nullable columns' documented "needs an admin" state, reachable for
    the first time. Nothing dangles without this (anonymization keeps the
    person row), which is exactly why it is easy to miss and would otherwise
    leave a group administered by "a former member".

    The backup admin is NOT promoted: nothing sets that column this phase,
    succession is a Phase 2 concern (database-schema build-once,
    Stewardship), and a promotion rule invented here would pre-shape it.

    Memberships are RETAINED, still attributed to the anonymized person —
    the retention default (database-schema decisions 12 and 15: nothing
    cascades from a person): a group's history of who belonged is the same
    class as a retained contribution.

    `updated_at` is not stamped — it records renames, and this is a
    lifecycle write, not a rename. The caller commits."""
    await db.execute(
        update(Group)
        .where(Group.admin_person_id == person_id)
        .values(admin_person_id=None)
    )
    await db.execute(
        update(Group)
        .where(Group.backup_admin_person_id == person_id)
        .values(backup_admin_person_id=None)
    )
