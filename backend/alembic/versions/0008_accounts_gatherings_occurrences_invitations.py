"""accounts supertype, gatherings + occurrences, invitation many-to-many

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-24

Phase CK-12 — the structural half of the keeper model (keeper record §9).
This is a RESTRUCTURE of the 0001 spine, not a data migration: step 0 of the
phase verified every re-pointed table is empty, and the NOT-NULL column adds
below fail loudly if that ever stops being true. Only `people` and
`organizations` may hold rows (Render's dev DB does) — they are backfilled
with one accounts row each.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# New types (create_type=False keeps op.create_table from re-issuing CREATE TYPE).
account_kind = postgresql.ENUM('PERSON', 'ORGANIZATION', name='account_kind', create_type=False)
gathering_type = postgresql.ENUM(
    'potluck', 'hosted', 'hosted_with_help', 'simple', 'wedding',
    'season', 'memorial', 'church_gathering',
    name='gathering_type', create_type=False,
)
# Existing type, referenced by gatherings; and the retired type, recreated on downgrade.
publication_state = postgresql.ENUM('pending', 'live', 'removed', name='publication_state', create_type=False)
event_type = postgresql.ENUM('potluck', 'hosted', 'hosted_with_help', 'simple', 'wedding', name='event_type', create_type=False)

# The four tables that move from events to occurrences wholesale.
OCCURRENCE_CHILDREN = ('rsvps', 'attendance_records', 'item_slots', 'item_claims')
# The two that move to gatherings and gain an optional occurrence label.
GATHERING_CHILDREN = ('posts', 'media')


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    account_kind.create(bind, checkfirst=True)
    gathering_type.create(bind, checkfirst=True)

    # --- 1. The accounts supertype -----------------------------------------
    # people and organizations point AT accounts, never the reverse:
    # accounts.id is the single FK target quota, subscription, keeping, and
    # entitlement will all reference. A nullable person/org pair here could
    # not be foreign-keyed to and would force every quota query to branch.
    op.create_table('accounts',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('kind', account_kind, nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_accounts'))
    )

    op.add_column('people', sa.Column('account_id', sa.Uuid(), nullable=True))
    op.add_column('organizations', sa.Column('account_id', sa.Uuid(), nullable=True))
    # Backfill one account per existing person/organization, carrying the
    # source row's created_at (the account has conceptually existed as long).
    op.execute("UPDATE people SET account_id = gen_random_uuid()")
    op.execute(
        "INSERT INTO accounts (id, kind, created_at) "
        "SELECT account_id, 'PERSON', created_at FROM people"
    )
    op.execute("UPDATE organizations SET account_id = gen_random_uuid()")
    op.execute(
        "INSERT INTO accounts (id, kind, created_at) "
        "SELECT account_id, 'ORGANIZATION', created_at FROM organizations"
    )
    op.alter_column('people', 'account_id', existing_type=sa.Uuid(), nullable=False)
    op.alter_column('organizations', 'account_id', existing_type=sa.Uuid(), nullable=False)
    op.create_unique_constraint(op.f('uq_people_account_id'), 'people', ['account_id'])
    op.create_unique_constraint(op.f('uq_organizations_account_id'), 'organizations', ['account_id'])
    op.create_foreign_key(op.f('fk_people_account_id'), 'people', 'accounts', ['account_id'], ['id'])
    op.create_foreign_key(op.f('fk_organizations_account_id'), 'organizations', 'accounts', ['account_id'], ['id'])

    # --- 2. gatherings — the one keepable object ---------------------------
    # Account-owned, never group-owned. requires_approval moves here from the
    # group's capability profile: a gathering belongs to no group, so the
    # moderation flag lives on the gathering, defaulted at creation from the
    # inviting context.
    op.create_table('gatherings',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('gathering_type', gathering_type, nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('requires_approval', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('publication_state', publication_state, nullable=False),
    sa.Column('removed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], name=op.f('fk_gatherings_account_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gatherings'))
    )
    op.create_index(op.f('ix_gatherings_account_id'), 'gatherings', ['account_id'], unique=False)

    # --- 3. occurrences — the dates ----------------------------------------
    # A one-off gathering has exactly one; a season has many. Nothing else in
    # the schema treats a season as a special case.
    op.create_table('occurrences',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ends_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('location', sa.Text(), nullable=True),
    sa.Column('map_url', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_occurrences_gathering_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_occurrences'))
    )
    op.create_index(op.f('ix_occurrences_gathering_id'), 'occurrences', ['gathering_id'], unique=False)

    # --- 4. gathering_invitations — the many-to-many -----------------------
    # The ONLY link between a gathering and a group (groups own nothing).
    # Exactly one target per row; one row per (gathering, target).
    op.create_table('gathering_invitations',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=True),
    sa.Column('sub_group_id', sa.Uuid(), nullable=True),
    sa.Column('person_id', sa.Uuid(), nullable=True),
    sa.Column('invited_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('num_nonnulls(group_id, sub_group_id, person_id) = 1', name=op.f('ck_gathering_invitations_exactly_one_target')),
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_gathering_invitations_gathering_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_gathering_invitations_group_id')),
    sa.ForeignKeyConstraint(['sub_group_id'], ['sub_groups.id'], name=op.f('fk_gathering_invitations_sub_group_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_gathering_invitations_person_id')),
    sa.ForeignKeyConstraint(['invited_by_person_id'], ['people.id'], name=op.f('fk_gathering_invitations_invited_by_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gathering_invitations'))
    )
    op.create_index(op.f('ix_gathering_invitations_gathering_id'), 'gathering_invitations', ['gathering_id'], unique=False)
    op.create_index('uq_gathering_invitations_gathering_group', 'gathering_invitations', ['gathering_id', 'group_id'], unique=True, postgresql_where=sa.text('group_id IS NOT NULL'))
    op.create_index('uq_gathering_invitations_gathering_sub_group', 'gathering_invitations', ['gathering_id', 'sub_group_id'], unique=True, postgresql_where=sa.text('sub_group_id IS NOT NULL'))
    op.create_index('uq_gathering_invitations_gathering_person', 'gathering_invitations', ['gathering_id', 'person_id'], unique=True, postgresql_where=sa.text('person_id IS NOT NULL'))

    # --- 5. Re-point the children ------------------------------------------
    # RSVP, attendance, and items belong to a DATE; posts and media belong to
    # the GATHERING (the keeping/storage unit) with the occurrence as an
    # optional label. The NOT NULL adds double as the emptiness guard: they
    # fail if any of these tables has rows. Every guest-identity column,
    # CHECK, publication state, and provenance column stays exactly as 0001
    # defined it — only the parent pointer moves.
    op.drop_index('uq_rsvps_event_person', table_name='rsvps', postgresql_where=sa.text('person_id IS NOT NULL'))
    for table in OCCURRENCE_CHILDREN:
        op.drop_index(op.f(f'ix_{table}_event_id'), table_name=table)
        op.drop_column(table, 'event_id')
        op.add_column(table, sa.Column('occurrence_id', sa.Uuid(), nullable=False))
        op.create_foreign_key(op.f(f'fk_{table}_occurrence_id'), table, 'occurrences', ['occurrence_id'], ['id'])
        op.create_index(op.f(f'ix_{table}_occurrence_id'), table, ['occurrence_id'], unique=False)
    op.create_index('uq_rsvps_occurrence_person', 'rsvps', ['occurrence_id', 'person_id'], unique=True, postgresql_where=sa.text('person_id IS NOT NULL'))

    for table in GATHERING_CHILDREN:
        op.drop_index(op.f(f'ix_{table}_event_id'), table_name=table)
        op.drop_column(table, 'event_id')
        op.add_column(table, sa.Column('gathering_id', sa.Uuid(), nullable=False))
        op.add_column(table, sa.Column('occurrence_id', sa.Uuid(), nullable=True))
        op.create_foreign_key(op.f(f'fk_{table}_gathering_id'), table, 'gatherings', ['gathering_id'], ['id'])
        op.create_foreign_key(op.f(f'fk_{table}_occurrence_id'), table, 'occurrences', ['occurrence_id'], ['id'])
        op.create_index(op.f(f'ix_{table}_gathering_id'), table, ['gathering_id'], unique=False)
        op.create_index(op.f(f'ix_{table}_occurrence_id'), table, ['occurrence_id'], unique=False)

    # --- 6. Drop events and event_series -----------------------------------
    op.drop_index(op.f('ix_events_series_id'), table_name='events')
    op.drop_table('events')
    op.drop_index(op.f('ix_event_series_group_id'), table_name='event_series')
    op.drop_table('event_series')
    event_type.drop(bind, checkfirst=True)


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0007's shape, dropped tables included."""
    bind = op.get_bind()
    event_type.create(bind, checkfirst=True)

    # Recreate event_series and events exactly as 0001 shipped them.
    op.create_table('event_series',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('created_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by_person_id'], ['people.id'], name=op.f('fk_event_series_created_by_person_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_event_series_group_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_event_series'))
    )
    op.create_index(op.f('ix_event_series_group_id'), 'event_series', ['group_id'], unique=False)
    op.create_table('events',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('series_id', sa.Uuid(), nullable=False),
    sa.Column('event_type', event_type, nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('location', sa.Text(), nullable=True),
    sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ends_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('publication_state', publication_state, nullable=False),
    sa.Column('removed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by_person_id'], ['people.id'], name=op.f('fk_events_created_by_person_id')),
    sa.ForeignKeyConstraint(['series_id'], ['event_series.id'], name=op.f('fk_events_series_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_events'))
    )
    op.create_index(op.f('ix_events_series_id'), 'events', ['series_id'], unique=False)

    # Point the children back at events (same restructure discipline: the
    # NOT NULL add fails loudly if rows exist).
    op.drop_index('uq_rsvps_occurrence_person', table_name='rsvps', postgresql_where=sa.text('person_id IS NOT NULL'))
    for table in OCCURRENCE_CHILDREN:
        op.drop_index(op.f(f'ix_{table}_occurrence_id'), table_name=table)
        op.drop_column(table, 'occurrence_id')
        op.add_column(table, sa.Column('event_id', sa.Uuid(), nullable=False))
        op.create_foreign_key(op.f(f'fk_{table}_event_id'), table, 'events', ['event_id'], ['id'])
        op.create_index(op.f(f'ix_{table}_event_id'), table, ['event_id'], unique=False)
    op.create_index('uq_rsvps_event_person', 'rsvps', ['event_id', 'person_id'], unique=True, postgresql_where=sa.text('person_id IS NOT NULL'))

    for table in GATHERING_CHILDREN:
        op.drop_index(op.f(f'ix_{table}_occurrence_id'), table_name=table)
        op.drop_index(op.f(f'ix_{table}_gathering_id'), table_name=table)
        op.drop_column(table, 'occurrence_id')
        op.drop_column(table, 'gathering_id')
        op.add_column(table, sa.Column('event_id', sa.Uuid(), nullable=False))
        op.create_foreign_key(op.f(f'fk_{table}_event_id'), table, 'events', ['event_id'], ['id'])
        op.create_index(op.f(f'ix_{table}_event_id'), table, ['event_id'], unique=False)

    # Drop the keeper-spine tables.
    op.drop_index('uq_gathering_invitations_gathering_person', table_name='gathering_invitations', postgresql_where=sa.text('person_id IS NOT NULL'))
    op.drop_index('uq_gathering_invitations_gathering_sub_group', table_name='gathering_invitations', postgresql_where=sa.text('sub_group_id IS NOT NULL'))
    op.drop_index('uq_gathering_invitations_gathering_group', table_name='gathering_invitations', postgresql_where=sa.text('group_id IS NOT NULL'))
    op.drop_index(op.f('ix_gathering_invitations_gathering_id'), table_name='gathering_invitations')
    op.drop_table('gathering_invitations')
    op.drop_index(op.f('ix_occurrences_gathering_id'), table_name='occurrences')
    op.drop_table('occurrences')
    op.drop_index(op.f('ix_gatherings_account_id'), table_name='gatherings')
    op.drop_table('gatherings')

    # Unhook people/organizations from accounts and drop the supertype.
    # (The backfilled accounts rows are derivable; dropping them restores
    # 0007's shape exactly.)
    op.drop_constraint(op.f('fk_people_account_id'), 'people', type_='foreignkey')
    op.drop_constraint(op.f('uq_people_account_id'), 'people', type_='unique')
    op.drop_column('people', 'account_id')
    op.drop_constraint(op.f('fk_organizations_account_id'), 'organizations', type_='foreignkey')
    op.drop_constraint(op.f('uq_organizations_account_id'), 'organizations', type_='unique')
    op.drop_column('organizations', 'account_id')
    op.drop_table('accounts')

    gathering_type.drop(bind, checkfirst=True)
    account_kind.drop(bind, checkfirst=True)
