"""rename gatherings.admin_account_id to host_account_id

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-03

Phase CK-28 — one column rename, nothing else. The product says "host"; the
schema said "admin", and the two words have had exactly one referent — until
co-hosts (decisions/2026-09-03-co-hosts.md), which add a second party who
administers a gathering. The moment they exist, an unqualified "admin" means
two things: precisely the failure rsvps.is_observer had, which 0012 spent a
migration renaming out of the schema one revision ago. This rename runs
first, alone, while there is still one concept; the co-host relation lands
afterwards, against clean names.

Nothing else changes: nullability (NULL host is still the claimable state —
CK-13), the FK to accounts, and every behaviour behind the column are
untouched. groups.admin_person_id / backup_admin_person_id are a DIFFERENT
concept (a group has an admin; a gathering has a host — the words differing
is the point) and are deliberately not touched.

The FK constraint is renamed alongside the column — the 0009 precedent
(fk_gatherings_account_id -> fk_gatherings_created_by_account_id): RENAME
CONSTRAINT preserves the constraint itself, and the metadata naming
convention (fk_%(table_name)s_%(column_0_name)s) derives the name from the
column, so leaving the old name would strand the DB out of step with the
models. No index carries the old column's name (0009 built none on it).
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0013'
down_revision: Union[str, Sequence[str], None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column('gatherings', 'admin_account_id', new_column_name='host_account_id')
    op.execute(
        'ALTER TABLE gatherings RENAME CONSTRAINT '
        'fk_gatherings_admin_account_id TO fk_gatherings_host_account_id'
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0012's shape, names included."""
    op.execute(
        'ALTER TABLE gatherings RENAME CONSTRAINT '
        'fk_gatherings_host_account_id TO fk_gatherings_admin_account_id'
    )
    op.alter_column('gatherings', 'host_account_id', new_column_name='admin_account_id')
