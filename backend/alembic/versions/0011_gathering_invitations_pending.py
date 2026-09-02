"""gathering invitations pending

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-02

Phase CK-25 — person-targeted invitations. The pending table holds an
invitation to a DESTINATION (channel + destination — an email address today,
a phone number when SMS ships) until someone who controls it accepts; the
gathering_invitations row is created only at acceptance, when a real person
exists. Pre-creating a people row at invite time was rejected: it would leave
permanent person rows holding an address a third party supplied, for invitees
who never accept — the defect class CK-24 purged from email_change_requests.

Channel-agnostic from the first row, deliberately (launch-shape decision
2026-08-31): the primary invitation channel at launch is a text message, so
the columns are `channel` + `destination`, never `email` — enabling SMS is a
validator-and-delivery change, never a migration against live invitation
rows. Only the token's SHA-256 hash is stored (magic_link_tokens'
conventions); rows are reaped by services/retention.py::purge_stale.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0011'
down_revision: Union[str, Sequence[str], None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

invitation_channel = postgresql.ENUM('EMAIL', 'SMS', name='invitation_channel', create_type=False)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    invitation_channel.create(bind, checkfirst=True)
    op.create_table('gathering_invitations_pending',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('channel', invitation_channel, nullable=False),
    sa.Column('destination', sa.Text(), nullable=False),
    sa.Column('token_hash', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('invited_by_person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # A row is consumed (accepted) or revoked (withdrawn/superseded), never
    # both — the acceptance state machine, pinned in the schema.
    sa.CheckConstraint('num_nonnulls(consumed_at, revoked_at) <= 1', name=op.f('ck_gathering_invitations_pending_consumed_or_revoked')),
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_gathering_invitations_pending_gathering_id')),
    sa.ForeignKeyConstraint(['invited_by_person_id'], ['people.id'], name=op.f('fk_gathering_invitations_pending_invited_by_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gathering_invitations_pending')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_gathering_invitations_pending_token_hash'))
    )
    op.create_index(op.f('ix_gathering_invitations_pending_gathering_id'), 'gathering_invitations_pending', ['gathering_id'], unique=False)
    # At most one LIVE invitation per (gathering, channel, destination): a
    # fresh invite supersedes (revokes) the old row rather than stacking live
    # tokens; consumed and revoked rows stay for the rate-limit tally until
    # the reaper takes them.
    op.create_index('uq_gathering_invitations_pending_live_destination', 'gathering_invitations_pending', ['gathering_id', 'channel', 'destination'], unique=True, postgresql_where=sa.text('consumed_at IS NULL AND revoked_at IS NULL'))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_gathering_invitations_pending_live_destination', table_name='gathering_invitations_pending', postgresql_where=sa.text('consumed_at IS NULL AND revoked_at IS NULL'))
    op.drop_index(op.f('ix_gathering_invitations_pending_gathering_id'), table_name='gathering_invitations_pending')
    op.drop_table('gathering_invitations_pending')
    invitation_channel.drop(op.get_bind(), checkfirst=True)
