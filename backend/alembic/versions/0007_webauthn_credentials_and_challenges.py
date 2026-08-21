"""webauthn credentials and challenges

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-21

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Passkeys (CK-10). webauthn_credentials holds the PUBLIC half of each
    # enrolled credential — never a biometric; those never leave the person's
    # authenticator. webauthn_challenges are single-use and 5-minute-lived,
    # the same discipline as every other token in this codebase; person_id is
    # NULL for sign-in challenges (usernameless — no known person yet).
    op.create_table('webauthn_credentials',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('credential_id', sa.Text(), nullable=False),
    sa.Column('public_key', sa.LargeBinary(), nullable=False),
    sa.Column('sign_count', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.Column('transports', sa.Text(), nullable=True),
    sa.Column('nickname', sa.Text(), nullable=True),
    sa.Column('backup_eligible', sa.Boolean(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_webauthn_credentials_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_webauthn_credentials')),
    sa.UniqueConstraint('credential_id', name=op.f('uq_webauthn_credentials_credential_id'))
    )
    op.create_index(op.f('ix_webauthn_credentials_person_id'), 'webauthn_credentials', ['person_id'], unique=False)
    op.create_table('webauthn_challenges',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=True),
    sa.Column('challenge', sa.Text(), nullable=False),
    sa.Column('purpose', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_webauthn_challenges_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_webauthn_challenges'))
    )
    op.create_index(op.f('ix_webauthn_challenges_person_id'), 'webauthn_challenges', ['person_id'], unique=False)
    op.create_index(op.f('ix_webauthn_challenges_challenge'), 'webauthn_challenges', ['challenge'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_webauthn_challenges_challenge'), table_name='webauthn_challenges')
    op.drop_index(op.f('ix_webauthn_challenges_person_id'), table_name='webauthn_challenges')
    op.drop_table('webauthn_challenges')
    op.drop_index(op.f('ix_webauthn_credentials_person_id'), table_name='webauthn_credentials')
    op.drop_table('webauthn_credentials')
