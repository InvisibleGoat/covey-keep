"""kept relation, derived grace, memorial exemption, admin claim state

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-24

Phase CK-13 — the lifecycle half of the keeper model (keeper record §2.3–2.7,
§8, §9). `kept_gatherings` is the SINGLE source of truth for both the quota
arithmetic and the reference count; grace is ONE derived-from timestamp, never
stored dates or a state column; the memorial exemption is keyed on the TYPE
and gated by a named decedent. Same restructure discipline as 0008: no
gathering CRUD exists yet, so `gatherings` holds no rows anywhere — and the
memorial CHECK add fails loudly if that ever stops being true.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MEMORIAL_DECEDENT_CHECK = (
    "(gathering_type = 'memorial' AND memorial_decedent_name IS NOT NULL"
    " AND btrim(memorial_decedent_name) <> '')"
    " OR (gathering_type <> 'memorial' AND memorial_decedent_name IS NULL)"
)


def upgrade() -> None:
    """Upgrade schema."""
    # --- 1. kept_gatherings — the kept relation ----------------------------
    # One account keeping one gathering. This table alone answers "who keeps
    # what": quota is a sum over these rows computed at request time, and a
    # gathering lives while at least one row exists. No boolean on gatherings,
    # no counter column — a second representation could drift.
    op.create_table('kept_gatherings',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('kept_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], name=op.f('fk_kept_gatherings_account_id')),
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_kept_gatherings_gathering_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_kept_gatherings')),
    sa.UniqueConstraint('account_id', 'gathering_id', name=op.f('uq_kept_gatherings_account_id_gathering_id'))
    )
    op.create_index(op.f('ix_kept_gatherings_account_id'), 'kept_gatherings', ['account_id'], unique=False)
    op.create_index(op.f('ix_kept_gatherings_gathering_id'), 'kept_gatherings', ['gathering_id'], unique=False)

    # --- 2. Grace: one timestamp, derived thresholds -----------------------
    # Stamped when the last keeper leaves, cleared when anyone keeps again.
    # Archive (30d) and delete (90d) are derived from this plus policy
    # constants in services/keeping.py — deliberately NOT stored as
    # archive_at/delete_at: two stored dates can disagree with each other and
    # with the refcount.
    op.add_column('gatherings', sa.Column('last_keeper_left_at', sa.DateTime(timezone=True), nullable=True))

    # --- 3. Memorial: exempt by TYPE, gated by a named decedent ------------
    # Without the gate, everything becomes a memorial (keeper record §9.4).
    # The CHECK add fails loudly if a memorial row without a decedent exists.
    op.add_column('gatherings', sa.Column('memorial_decedent_name', sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f('ck_gatherings_memorial_decedent_name'), 'gatherings', MEMORIAL_DECEDENT_CHECK
    )

    # --- 4. Media size rollup, because quota needs it ----------------------
    # A maintained fact about ONE gathering (media.size_bytes summed as media
    # is added/removed) — quota itself stays computed at request time by
    # summing this across an account's kept gatherings.
    op.add_column('gatherings', sa.Column('total_bytes', sa.BigInteger(), server_default=sa.text('0'), nullable=False))

    # --- 5. Admin and claim ------------------------------------------------
    # account_id → created_by_account_id: immutable and historical. "Owner"
    # is not a concept in the keeper model, and the old name implied one.
    op.alter_column('gatherings', 'account_id', new_column_name='created_by_account_id')
    op.execute('ALTER TABLE gatherings RENAME CONSTRAINT fk_gatherings_account_id TO fk_gatherings_created_by_account_id')
    op.execute('ALTER INDEX ix_gatherings_account_id RENAME TO ix_gatherings_created_by_account_id')
    # Transferable admin; NULLABLE IS THE CLAIMABLE STATE ("needs an admin"),
    # mirroring the nullable admin fields on groups. The claim flow is a
    # later phase — this only makes the state representable.
    op.add_column('gatherings', sa.Column('admin_account_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f('fk_gatherings_admin_account_id'), 'gatherings', 'accounts', ['admin_account_id'], ['id'])

    # steward → admin on groups, per the CK-11 narrowing of stewardship.
    op.alter_column('groups', 'steward_person_id', new_column_name='admin_person_id')
    op.alter_column('groups', 'backup_steward_person_id', new_column_name='backup_admin_person_id')
    op.execute('ALTER TABLE groups RENAME CONSTRAINT fk_groups_steward_person_id TO fk_groups_admin_person_id')
    op.execute('ALTER TABLE groups RENAME CONSTRAINT fk_groups_backup_steward_person_id TO fk_groups_backup_admin_person_id')


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0008's shape, names included."""
    op.execute('ALTER TABLE groups RENAME CONSTRAINT fk_groups_backup_admin_person_id TO fk_groups_backup_steward_person_id')
    op.execute('ALTER TABLE groups RENAME CONSTRAINT fk_groups_admin_person_id TO fk_groups_steward_person_id')
    op.alter_column('groups', 'backup_admin_person_id', new_column_name='backup_steward_person_id')
    op.alter_column('groups', 'admin_person_id', new_column_name='steward_person_id')

    op.drop_constraint(op.f('fk_gatherings_admin_account_id'), 'gatherings', type_='foreignkey')
    op.drop_column('gatherings', 'admin_account_id')
    op.execute('ALTER INDEX ix_gatherings_created_by_account_id RENAME TO ix_gatherings_account_id')
    op.execute('ALTER TABLE gatherings RENAME CONSTRAINT fk_gatherings_created_by_account_id TO fk_gatherings_account_id')
    op.alter_column('gatherings', 'created_by_account_id', new_column_name='account_id')

    op.drop_column('gatherings', 'total_bytes')
    op.drop_constraint(op.f('ck_gatherings_memorial_decedent_name'), 'gatherings', type_='check')
    op.drop_column('gatherings', 'memorial_decedent_name')
    op.drop_column('gatherings', 'last_keeper_left_at')

    op.drop_index(op.f('ix_kept_gatherings_gathering_id'), table_name='kept_gatherings')
    op.drop_index(op.f('ix_kept_gatherings_account_id'), table_name='kept_gatherings')
    op.drop_table('kept_gatherings')
