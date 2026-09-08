"""media.uploaded_at: nullable, no default — stamped at the uploaded transition

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-08

Phase CK-34 — the upload intent and the confirm step. One column, one
decision (decisions/2026-09-08-upload-intent-limits-and-quota.md §6).

`uploaded_at` came from 0001 as `NOT NULL DEFAULT now()`, when the media row
was written after the bytes existed. Since 0016 the row is born at INTENT —
before any upload — so that default stamped intent time under a name that
asserts something the data does not (the defect `size_bytes` →
`upload_size_bytes` was renamed to fix). Two of the three honest shapes were
open: rename it to say "intent", or redefine it as set at confirm. The rename
loses: a row's `created_at` IS the intent time already, so an `intent_at`
would be a second column carrying the same instant — the two-representations
defect. So the column keeps its name and earns it: NULL while the row waits
in `pending_upload`, stamped by the confirm step in the same transaction that
moves `status` to `uploaded`, and never touched again. The shape is
`claimed_at`'s — nullable, no default, written by the transition it records.

The downgrade restores 0016's shape honestly: a NULL row is an unconfirmed
intent, and 0016's default would have stamped it with its intent time, which
is exactly `created_at` — so the backfill writes that, not an invented
value, before the NOT NULL and the default return.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0017'
down_revision: Union[str, Sequence[str], None] = '0016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column(
        'media',
        'uploaded_at',
        existing_type=sa.DateTime(timezone=True),
        nullable=True,
        server_default=None,
    )


def downgrade() -> None:
    """Downgrade schema — 0016's NOT NULL DEFAULT now() restored. Unconfirmed
    rows (NULL) take their intent time, which is what 0016's default would
    have stamped on them; confirmed rows keep the confirm stamp."""
    op.execute("UPDATE media SET uploaded_at = created_at WHERE uploaded_at IS NULL")
    op.alter_column(
        'media',
        'uploaded_at',
        existing_type=sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.text('now()'),
    )
