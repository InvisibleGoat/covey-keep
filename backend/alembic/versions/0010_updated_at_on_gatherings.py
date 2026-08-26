"""updated_at on gatherings

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-25

Phase CK-16 — gatherings become user-mutable (PATCH /gatherings/{id}), so the
row gains `updated_at`, mirroring 0004's `people.updated_at` precedent exactly:
per-table, added by the phase that makes the row mutable. Nothing else in this
migration — the CK-16 moderation default (requires_approval ON at creation) is
application code, deliberately NOT a server-default change (database-schema
decision 22).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Stamped on every successful patch. Nullable: never-edited rows have no
    # meaningful value, same as people.updated_at (0004).
    op.add_column('gatherings', sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('gatherings', 'updated_at')
