"""auth tables and household role ladder

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-19

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('magic_link_tokens',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('token_hash', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('requested_ip', postgresql.INET(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_magic_link_tokens')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_magic_link_tokens_token_hash'))
    )
    op.create_index(op.f('ix_magic_link_tokens_email'), 'magic_link_tokens', ['email'], unique=False)
    op.create_table('sessions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('issued_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('user_agent', sa.Text(), nullable=True),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_sessions_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions'))
    )
    op.create_index(op.f('ix_sessions_person_id'), 'sessions', ['person_id'], unique=False)
    op.create_table('tos_acceptances',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('accepted_ip', postgresql.INET(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_tos_acceptances_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_tos_acceptances'))
    )
    op.create_index(op.f('ix_tos_acceptances_person_id'), 'tos_acceptances', ['person_id'], unique=False)

    # Seed: the flat household role ladder (0001 deliberately left ladders empty
    # for this phase). Ranks compare numerically; 0 is most senior.
    op.execute("INSERT INTO role_ladders (key, name) VALUES ('household', 'Household')")
    op.execute(
        "INSERT INTO roles (role_ladder_id, key, name, rank) "
        "SELECT id, 'steward', 'Steward', 0 FROM role_ladders WHERE key = 'household'"
    )
    op.execute(
        "INSERT INTO roles (role_ladder_id, key, name, rank) "
        "SELECT id, 'member', 'Member', 10 FROM role_ladders WHERE key = 'household'"
    )
    op.execute(
        "INSERT INTO roles (role_ladder_id, key, name, rank) "
        "SELECT id, 'observer', 'Observer', 20 FROM role_ladders WHERE key = 'household'"
    )
    op.execute(
        "UPDATE capability_profiles "
        "SET role_ladder_id = (SELECT id FROM role_ladders WHERE key = 'household') "
        "WHERE name = 'household-default'"
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Unseed first so 0001's ladder tables return to their shipped-empty state.
    op.execute(
        "UPDATE capability_profiles SET role_ladder_id = NULL "
        "WHERE role_ladder_id = (SELECT id FROM role_ladders WHERE key = 'household')"
    )
    op.execute(
        "DELETE FROM roles WHERE role_ladder_id = "
        "(SELECT id FROM role_ladders WHERE key = 'household')"
    )
    op.execute("DELETE FROM role_ladders WHERE key = 'household'")

    op.drop_index(op.f('ix_tos_acceptances_person_id'), table_name='tos_acceptances')
    op.drop_table('tos_acceptances')
    op.drop_index(op.f('ix_sessions_person_id'), table_name='sessions')
    op.drop_table('sessions')
    op.drop_index(op.f('ix_magic_link_tokens_email'), table_name='magic_link_tokens')
    op.drop_table('magic_link_tokens')
