"""anonymization stamp on people

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Account deletion is anonymization, not cascade (decision record
    # 2026-08-19): the stamp is the ONLY schema change — an anonymized row is
    # identifiable by it alone, and no boolean exists to disagree with it.
    # Deletion nulls email/timezone, replaces display_name, and hard-deletes
    # auth material at the app layer; contributions stay attributed to the row.
    op.add_column('people', sa.Column('anonymized_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('people', 'anonymized_at')
