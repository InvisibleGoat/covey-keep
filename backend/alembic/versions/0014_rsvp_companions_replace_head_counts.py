"""rsvp companions replace the head counts; updated_at on rsvps

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-04

Phase CK-29 — RSVP is for yourself: named companions replace the head count.
Three changes, one table's worth of scope.

(1) rsvps.adult_count and rsvps.child_count are DROPPED. They came from 0001,
when this was framed as a generic event tool — nobody chose them for
CoveyKeep; they survived. A family wants to know WHO is coming, not how many:
the count the host reads is now derived from named companions, never typed
("store who, compute how many" — a typed count can disagree with the list of
names beside it; a computed one cannot). The stored values are lost on
upgrade, and that is acceptable: alpha data is disposable
(decisions/2026-08-31-private-alpha-scope.md §1 condition 2 — dev database,
deleted when the test ends), which is exactly why this drop is cheap today
and would be expensive after the alpha's rows start meaning something. The
downgrade restores both columns with their 0001 types and defaults; the
values do not come back.

(2) rsvp_companions — one row per accompanying person an attendee declared,
keyed to the RSVP, ordered, holding a NAME and nothing else. No person_id, no
account, no channel: a companion is a name, not somebody the system knows.
The name is deliberately NOT built on RSVP's no-account identity columns —
that word already means a person participating with no account of their own,
a different axis entirely (participation-terminology record §8). Rows are
replaced wholesale on each RSVP write and deleted with their RSVP
(ON DELETE CASCADE): third-party names declared about other people outlive
nothing.

(3) rsvps.updated_at — the row has been mutable since CK-27 (the upsert is
the normal path) with only a created_at, and that gap cost a verification at
CK-28: RSVP rows that did not match expectation could be read but not
accounted for. The 0004/0010 precedent exactly: nullable, NULL until first
changed, stamped by the application's update path.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0014'
down_revision: Union[str, Sequence[str], None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column('rsvps', 'adult_count')
    op.drop_column('rsvps', 'child_count')
    # Stamped by the upsert's update path only — a never-changed row keeps
    # NULL, so the column never merely mirrors created_at.
    op.add_column('rsvps', sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True))
    op.create_table('rsvp_companions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('rsvp_id', sa.Uuid(), nullable=False),
    sa.Column('position', sa.SmallInteger(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['rsvp_id'], ['rsvps.id'], name=op.f('fk_rsvp_companions_rsvp_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_rsvp_companions')),
    # Order is part of the value; the unique pair also indexes the FK (it
    # leads with rsvp_id), so no separate index is created.
    sa.UniqueConstraint('rsvp_id', 'position', name=op.f('uq_rsvp_companions_rsvp_id_position'))
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0013's shape (columns, types,
    defaults); the dropped counts' VALUES are gone, accepted above."""
    op.drop_table('rsvp_companions')
    op.drop_column('rsvps', 'updated_at')
    # 0001's originals: SmallInteger, NOT NULL, server defaults 1 and 0.
    op.add_column('rsvps', sa.Column('adult_count', sa.SmallInteger(), server_default=sa.text('1'), nullable=False))
    op.add_column('rsvps', sa.Column('child_count', sa.SmallInteger(), server_default=sa.text('0'), nullable=False))
