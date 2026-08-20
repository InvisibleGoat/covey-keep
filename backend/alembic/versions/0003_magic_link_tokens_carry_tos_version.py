"""magic link tokens carry the accepted ToS version

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no backfill: pre-CK-6 rows recorded no consent, and inventing a
    # version here would be exactly the assumed-consent bug CK-6 removes. The
    # verify endpoint refuses to create an account from a NULL-version token.
    op.add_column('magic_link_tokens', sa.Column('tos_version', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('magic_link_tokens', 'tos_version')
