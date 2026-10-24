"""the belongs-to link gets its index: ix_gatherings_owning_group_id

Revision ID: 0033
Revises: 0032
Create Date: 2026-10-23

Phase CK-76 — Groups 2a: a gathering in a group, the whole group invited
(decisions/2026-10-23-joining-a-group-and-co-admins.md §4;
decisions/2026-09-02-groups-as-homes.md §3;
decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §9).

ONE INDEX AND NOTHING ELSE. `gatherings.owning_group_id` has existed since
0022 (CK-49a) as a column with no writer; CK-76 writes it for the first
time (`POST /gatherings` with a `group_id`), and the column gains its first
readers that look rows up BY the column rather than by primary key:
`GET /groups/{id}/gatherings` (the group's gatherings — `WHERE
owning_group_id = :group`) and the newcomer rows written at join
(`services/groups.py::invite_newcomer_to_upcoming_gatherings` — the
group's upcoming gatherings the person holds no row for). An index arrives
with its reader (the 0024 rule, which left this column unindexed on the
stated ground that it had no writer); this is the reader's migration.

Named as the model's `index=True` names it (`ix_%(column_0_label)s`), so
`alembic check` and the verifier agree. The downgrade drops it. No column,
no CHECK, no backfill, no data moves: `groups.backup_admin_person_id` is
UNMAPPED at CK-76 (the model no longer carries it, the deletion leg no
longer NULLs it) and is NOT dropped here — the CK-75.1 instance still
serving during this pre-deploy window selects it in every group body, so
the drop is the next contract step (CK-77's migration), after the release
that stops reading it.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING: an index on a column the old
instance never writes and reads only through the keeper resolver is
invisible to it.

DATA-HANDLING: nothing here reads or writes a row.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0033'
down_revision: Union[str, Sequence[str], None] = '0032'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        op.f('ix_gatherings_owning_group_id'), 'gatherings', ['owning_group_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema — the index goes; the column (0022's) stays."""
    op.drop_index(op.f('ix_gatherings_owning_group_id'), table_name='gatherings')
