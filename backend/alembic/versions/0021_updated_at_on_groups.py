"""updated_at on groups

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-14

Phase CK-45 — groups get a surface (create, read, rename; the creator as
admin and first member — decisions/2026-09-14-groups-get-a-surface.md). The
`groups` row becomes user-mutable for the first time since 0001 created the
table, so it gains `updated_at` in the SAME phase: the 0004 / 0010 / 0014
precedent (people at CK-7, gatherings at CK-16, rsvps at CK-29 — that last
one a phase late, which cost CK-28's check (bt) its evidence; database-schema
decision 13 says add the stamp WITH the mutability, and this is that).

Nullable, no default, no backfill: a group that has never been renamed has
no meaningful value, and NULL is that fact. Stamped by PATCH /groups/{id}
and by nothing else — a read stamps nothing, creation stamps nothing, and
account deletion's admin relinquishment (a lifecycle write, not a rename)
stamps nothing either.

Nothing else in this migration, deliberately. No group type is seeded
(`capability_profiles` keeps its one HOUSEHOLD row — TEAM/CONGREGATION are
endpoint-refused until rung 2 of the publication ladder exists), no column
the ladder would read is added to `groups` (rung 2 is the next phase's, and
a column with no producer smuggles a feature in as a schema detail —
decision 33), and no delete rule changes anywhere (`gathering_invitations.
group_id` still carries none; the group delete is unbuilt for that reason).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0021'
down_revision: Union[str, Sequence[str], None] = '0020'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Stamped on every successful rename. Nullable: never-renamed rows have
    # no meaningful value, same as gatherings.updated_at (0010).
    op.add_column('groups', sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('groups', 'updated_at')
