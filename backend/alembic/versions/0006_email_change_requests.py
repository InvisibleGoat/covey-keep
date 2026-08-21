"""email change requests

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Mirrors magic_link_tokens' conventions (CK-5): only the SHA-256 hash of
    # the verification token is ever stored. requested_session_id records which
    # session asked — verification revokes every other session, and this is how
    # the requesting device stays signed in.
    op.create_table('email_change_requests',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('requested_session_id', sa.Uuid(), nullable=False),
    sa.Column('new_email', sa.Text(), nullable=False),
    sa.Column('token_hash', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('requested_ip', postgresql.INET(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_email_change_requests_person_id')),
    sa.ForeignKeyConstraint(['requested_session_id'], ['sessions.id'], name=op.f('fk_email_change_requests_requested_session_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_email_change_requests')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_email_change_requests_token_hash'))
    )
    op.create_index(op.f('ix_email_change_requests_person_id'), 'email_change_requests', ['person_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_email_change_requests_person_id'), table_name='email_change_requests')
    op.drop_table('email_change_requests')
