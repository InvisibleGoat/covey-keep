"""profile columns on people

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # timezone holds an IANA zone name (America/Chicago), NEVER a UTC offset —
    # offsets are wrong twice a year and carry no DST rules. Nullable, no
    # backfill: existing rows have none and no value can be invented
    # server-side; the client captures the browser zone on first sign-in.
    op.add_column('people', sa.Column('timezone', sa.Text(), nullable=True))
    # The profile is the first user-mutable row in the system; stamped on every
    # successful patch. Nullable: never-edited rows have no meaningful value.
    op.add_column('people', sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True))
    # Safe on existing rows: every display_name so far is a non-empty email
    # local-part (the email validator rejects addresses with an empty one).
    op.create_check_constraint(
        op.f('ck_people_display_name_not_blank'), 'people', "btrim(display_name) <> ''"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('ck_people_display_name_not_blank'), 'people', type_='check')
    op.drop_column('people', 'updated_at')
    op.drop_column('people', 'timezone')
