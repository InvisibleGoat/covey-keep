"""rsvp list visibility and the stay_included rename

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-02

Phase CK-27 — RSVP, the "are you coming" half. Two changes, no new table.

(1) rsvps.is_observer -> rsvps.stay_included. "Observer" is retired from the
product vocabulary entirely (decisions/2026-09-02-participation-terminology.md
— the word was carrying four jobs), and a column named for a retired concept
is how the confusion returns. The column's SHAPE was always right — a boolean
on the RSVP — and its meaning is now settled: "I can't make it, but keep me
included." It changes interest, never access; no authorization check may ever
consult it. This closes an ambiguity that had stood since migration 0001 with
an empty notes cell.

(2) gatherings.rsvp_list_visibility — the host's first real per-gathering
option, in requires_approval's shape: a value on the gathering, never a
capability-profile lookup at read time. HOST_ONLY | INVITEES | ATTENDEES;
default INVITEES (suits a private family gathering — adult/child counts
disclose household composition, so the default is not broader). The server
default backfills the deployed rows that predate this migration; application
code sets the value explicitly on every create and never relies on it
(database-schema decision 22's discipline). Type-derived defaults belong to
the presets work, deliberately not here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

rsvp_list_visibility = postgresql.ENUM(
    'HOST_ONLY', 'INVITEES', 'ATTENDEES', name='rsvp_list_visibility', create_type=False
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    rsvp_list_visibility.create(bind, checkfirst=True)
    # A bare rename — no index or constraint carries the old column's name
    # (0001 built none on is_observer), so nothing else needs renaming.
    op.alter_column('rsvps', 'is_observer', new_column_name='stay_included')
    op.add_column(
        'gatherings',
        sa.Column(
            'rsvp_list_visibility',
            rsvp_list_visibility,
            server_default=sa.text("'INVITEES'"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0011's shape, names included."""
    op.drop_column('gatherings', 'rsvp_list_visibility')
    op.alter_column('rsvps', 'stay_included', new_column_name='is_observer')
    rsvp_list_visibility.drop(op.get_bind(), checkfirst=True)
