"""phase 1 spine with build-once columns

Revision ID: 0001
Revises: 
Create Date: 2026-08-18 19:22:10.648879

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Several tables share these Postgres enum types, so they are created once here
# (create_type=False keeps op.create_table from re-issuing CREATE TYPE per table).
group_type = postgresql.ENUM('HOUSEHOLD', 'CONGREGATION', 'TEAM', 'CLUB', name='group_type', create_type=False)
event_type = postgresql.ENUM('potluck', 'hosted', 'hosted_with_help', 'simple', 'wedding', name='event_type', create_type=False)
rsvp_response = postgresql.ENUM('yes', 'no', 'maybe', name='rsvp_response', create_type=False)
media_status = postgresql.ENUM('processing', 'ready', name='media_status', create_type=False)
publication_state = postgresql.ENUM('pending', 'live', 'removed', name='publication_state', create_type=False)

ENUM_TYPES = (group_type, event_type, rsvp_response, media_status, publication_state)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    for enum in ENUM_TYPES:
        enum.create(bind, checkfirst=True)

    op.create_table('households',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_households'))
    )
    op.create_table('next_step_triggers',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('config', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_next_step_triggers')),
    sa.UniqueConstraint('key', name=op.f('uq_next_step_triggers_key'))
    )
    op.create_table('organizations',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_organizations'))
    )
    op.create_table('role_ladders',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_role_ladders')),
    sa.UniqueConstraint('key', name=op.f('uq_role_ladders_key'))
    )
    op.create_table('capability_profiles',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_type', group_type, nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('requires_approval', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('role_ladder_id', sa.Uuid(), nullable=True),
    sa.Column('feature_flags', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['role_ladder_id'], ['role_ladders.id'], name=op.f('fk_capability_profiles_role_ladder_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_capability_profiles')),
    sa.UniqueConstraint('name', name=op.f('uq_capability_profiles_name'))
    )
    op.create_table('people',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('household_id', sa.Uuid(), nullable=True),
    sa.Column('display_name', sa.Text(), nullable=False),
    sa.Column('email', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['household_id'], ['households.id'], name=op.f('fk_people_household_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_people')),
    sa.UniqueConstraint('email', name=op.f('uq_people_email'))
    )
    op.create_index(op.f('ix_people_household_id'), 'people', ['household_id'], unique=False)
    op.create_table('roles',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('role_ladder_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('rank', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['role_ladder_id'], ['role_ladders.id'], name=op.f('fk_roles_role_ladder_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_roles')),
    sa.UniqueConstraint('role_ladder_id', 'key', name=op.f('uq_roles_role_ladder_id_key'))
    )
    op.create_index(op.f('ix_roles_role_ladder_id'), 'roles', ['role_ladder_id'], unique=False)
    op.create_table('groups',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=True),
    sa.Column('group_type', group_type, nullable=False),
    sa.Column('capability_profile_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('steward_person_id', sa.Uuid(), nullable=True),
    sa.Column('backup_steward_person_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['backup_steward_person_id'], ['people.id'], name=op.f('fk_groups_backup_steward_person_id')),
    sa.ForeignKeyConstraint(['capability_profile_id'], ['capability_profiles.id'], name=op.f('fk_groups_capability_profile_id')),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], name=op.f('fk_groups_organization_id')),
    sa.ForeignKeyConstraint(['steward_person_id'], ['people.id'], name=op.f('fk_groups_steward_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_groups'))
    )
    op.create_index(op.f('ix_groups_organization_id'), 'groups', ['organization_id'], unique=False)
    op.create_table('next_step_acceptances',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('trigger_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_next_step_acceptances_person_id')),
    sa.ForeignKeyConstraint(['trigger_id'], ['next_step_triggers.id'], name=op.f('fk_next_step_acceptances_trigger_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_next_step_acceptances'))
    )
    op.create_index('ix_next_step_acceptances_person_trigger', 'next_step_acceptances', ['person_id', 'trigger_id'], unique=False)
    op.create_table('next_step_dismissals',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('trigger_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('dismissed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_next_step_dismissals_person_id')),
    sa.ForeignKeyConstraint(['trigger_id'], ['next_step_triggers.id'], name=op.f('fk_next_step_dismissals_trigger_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_next_step_dismissals'))
    )
    op.create_index('ix_next_step_dismissals_person_trigger', 'next_step_dismissals', ['person_id', 'trigger_id'], unique=False)
    op.create_table('consent_records',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('subject_person_id', sa.Uuid(), nullable=False),
    sa.Column('granted_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('group_id', sa.Uuid(), nullable=True),
    sa.Column('channel', sa.Text(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('granted', sa.Boolean(), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['granted_by_person_id'], ['people.id'], name=op.f('fk_consent_records_granted_by_person_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_consent_records_group_id')),
    sa.ForeignKeyConstraint(['subject_person_id'], ['people.id'], name=op.f('fk_consent_records_subject_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_consent_records'))
    )
    op.create_index('ix_consent_records_subject_channel', 'consent_records', ['subject_person_id', 'channel'], unique=False)
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
    op.create_table('sub_groups',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_sub_groups_group_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sub_groups'))
    )
    op.create_index(op.f('ix_sub_groups_group_id'), 'sub_groups', ['group_id'], unique=False)
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
    op.create_table('memberships',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('household_id', sa.Uuid(), nullable=True),
    sa.Column('sub_group_id', sa.Uuid(), nullable=True),
    sa.Column('role_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_memberships_group_id')),
    sa.ForeignKeyConstraint(['household_id'], ['households.id'], name=op.f('fk_memberships_household_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_memberships_person_id')),
    sa.ForeignKeyConstraint(['role_id'], ['roles.id'], name=op.f('fk_memberships_role_id')),
    sa.ForeignKeyConstraint(['sub_group_id'], ['sub_groups.id'], name=op.f('fk_memberships_sub_group_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_memberships')),
    sa.UniqueConstraint('group_id', 'person_id', name=op.f('uq_memberships_group_id_person_id'))
    )
    op.create_index(op.f('ix_memberships_group_id'), 'memberships', ['group_id'], unique=False)
    op.create_index(op.f('ix_memberships_household_id'), 'memberships', ['household_id'], unique=False)
    op.create_index(op.f('ix_memberships_person_id'), 'memberships', ['person_id'], unique=False)
    op.create_table('attendance_records',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=True),
    sa.Column('display_name', sa.Text(), nullable=True),
    sa.Column('recorded_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('person_id IS NOT NULL OR display_name IS NOT NULL', name=op.f('ck_attendance_records_identity_present')),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_attendance_records_event_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_attendance_records_person_id')),
    sa.ForeignKeyConstraint(['recorded_by_person_id'], ['people.id'], name=op.f('fk_attendance_records_recorded_by_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_attendance_records'))
    )
    op.create_index(op.f('ix_attendance_records_event_id'), 'attendance_records', ['event_id'], unique=False)
    op.create_index(op.f('ix_attendance_records_person_id'), 'attendance_records', ['person_id'], unique=False)
    op.create_table('item_slots',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('category', sa.Text(), nullable=True),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('target_quantity', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_item_slots_event_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_item_slots'))
    )
    op.create_index(op.f('ix_item_slots_event_id'), 'item_slots', ['event_id'], unique=False)
    op.create_table('media',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('uploader_person_id', sa.Uuid(), nullable=True),
    sa.Column('guest_name', sa.Text(), nullable=True),
    sa.Column('uploaded_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('storage_key', sa.Text(), nullable=False),
    sa.Column('content_type', sa.Text(), nullable=False),
    sa.Column('size_bytes', sa.BigInteger(), nullable=True),
    sa.Column('storage_class', sa.Text(), server_default=sa.text("'standard'"), nullable=False),
    sa.Column('last_accessed', sa.DateTime(timezone=True), nullable=True),
    sa.Column('status', media_status, server_default=sa.text("'processing'"), nullable=False),
    sa.Column('publication_state', publication_state, nullable=False),
    sa.Column('removed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('uploader_person_id IS NOT NULL OR guest_name IS NOT NULL', name=op.f('ck_media_identity_present')),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_media_event_id')),
    sa.ForeignKeyConstraint(['uploader_person_id'], ['people.id'], name=op.f('fk_media_uploader_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_media'))
    )
    op.create_index(op.f('ix_media_event_id'), 'media', ['event_id'], unique=False)
    op.create_table('posts',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('parent_post_id', sa.Uuid(), nullable=True),
    sa.Column('author_person_id', sa.Uuid(), nullable=True),
    sa.Column('guest_name', sa.Text(), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('publication_state', publication_state, nullable=False),
    sa.Column('removed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('author_person_id IS NOT NULL OR guest_name IS NOT NULL', name=op.f('ck_posts_identity_present')),
    sa.ForeignKeyConstraint(['author_person_id'], ['people.id'], name=op.f('fk_posts_author_person_id')),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_posts_event_id')),
    sa.ForeignKeyConstraint(['parent_post_id'], ['posts.id'], name=op.f('fk_posts_parent_post_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_posts'))
    )
    op.create_index(op.f('ix_posts_event_id'), 'posts', ['event_id'], unique=False)
    op.create_index(op.f('ix_posts_parent_post_id'), 'posts', ['parent_post_id'], unique=False)
    op.create_table('rsvps',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=True),
    sa.Column('guest_name', sa.Text(), nullable=True),
    sa.Column('guest_email', sa.Text(), nullable=True),
    sa.Column('response', rsvp_response, nullable=False),
    sa.Column('adult_count', sa.SmallInteger(), server_default=sa.text('1'), nullable=False),
    sa.Column('child_count', sa.SmallInteger(), server_default=sa.text('0'), nullable=False),
    sa.Column('arrival_time', sa.Time(), nullable=True),
    sa.Column('is_observer', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('person_id IS NOT NULL OR guest_name IS NOT NULL', name=op.f('ck_rsvps_identity_present')),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_rsvps_event_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_rsvps_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_rsvps'))
    )
    op.create_index(op.f('ix_rsvps_event_id'), 'rsvps', ['event_id'], unique=False)
    op.create_index('uq_rsvps_event_person', 'rsvps', ['event_id', 'person_id'], unique=True, postgresql_where=sa.text('person_id IS NOT NULL'))
    op.create_table('item_claims',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=False),
    sa.Column('item_slot_id', sa.Uuid(), nullable=True),
    sa.Column('person_id', sa.Uuid(), nullable=True),
    sa.Column('guest_name', sa.Text(), nullable=True),
    sa.Column('write_in_text', sa.Text(), nullable=True),
    sa.Column('quantity', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('item_slot_id IS NOT NULL OR write_in_text IS NOT NULL', name=op.f('ck_item_claims_slot_or_write_in')),
    sa.CheckConstraint('person_id IS NOT NULL OR guest_name IS NOT NULL', name=op.f('ck_item_claims_identity_present')),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_item_claims_event_id')),
    sa.ForeignKeyConstraint(['item_slot_id'], ['item_slots.id'], name=op.f('fk_item_claims_item_slot_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_item_claims_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_item_claims'))
    )
    op.create_index(op.f('ix_item_claims_event_id'), 'item_claims', ['event_id'], unique=False)
    op.create_index(op.f('ix_item_claims_item_slot_id'), 'item_claims', ['item_slot_id'], unique=False)
    # ### end Alembic commands ###

    # Seed: the Phase 1 HOUSEHOLD capability profile (the only seed content of
    # this migration). No role ladder yet — the auth/roles phase seeds ladders.
    op.execute(
        "INSERT INTO capability_profiles (group_type, name, requires_approval, feature_flags) "
        "VALUES ('HOUSEHOLD', 'household-default', false, '{}'::jsonb)"
    )


def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f('ix_item_claims_item_slot_id'), table_name='item_claims')
    op.drop_index(op.f('ix_item_claims_event_id'), table_name='item_claims')
    op.drop_table('item_claims')
    op.drop_index('uq_rsvps_event_person', table_name='rsvps', postgresql_where=sa.text('person_id IS NOT NULL'))
    op.drop_index(op.f('ix_rsvps_event_id'), table_name='rsvps')
    op.drop_table('rsvps')
    op.drop_index(op.f('ix_posts_parent_post_id'), table_name='posts')
    op.drop_index(op.f('ix_posts_event_id'), table_name='posts')
    op.drop_table('posts')
    op.drop_index(op.f('ix_media_event_id'), table_name='media')
    op.drop_table('media')
    op.drop_index(op.f('ix_item_slots_event_id'), table_name='item_slots')
    op.drop_table('item_slots')
    op.drop_index(op.f('ix_attendance_records_person_id'), table_name='attendance_records')
    op.drop_index(op.f('ix_attendance_records_event_id'), table_name='attendance_records')
    op.drop_table('attendance_records')
    op.drop_index(op.f('ix_memberships_person_id'), table_name='memberships')
    op.drop_index(op.f('ix_memberships_household_id'), table_name='memberships')
    op.drop_index(op.f('ix_memberships_group_id'), table_name='memberships')
    op.drop_table('memberships')
    op.drop_index(op.f('ix_events_series_id'), table_name='events')
    op.drop_table('events')
    op.drop_index(op.f('ix_sub_groups_group_id'), table_name='sub_groups')
    op.drop_table('sub_groups')
    op.drop_index(op.f('ix_event_series_group_id'), table_name='event_series')
    op.drop_table('event_series')
    op.drop_index('ix_consent_records_subject_channel', table_name='consent_records')
    op.drop_table('consent_records')
    op.drop_index('ix_next_step_dismissals_person_trigger', table_name='next_step_dismissals')
    op.drop_table('next_step_dismissals')
    op.drop_index('ix_next_step_acceptances_person_trigger', table_name='next_step_acceptances')
    op.drop_table('next_step_acceptances')
    op.drop_index(op.f('ix_groups_organization_id'), table_name='groups')
    op.drop_table('groups')
    op.drop_index(op.f('ix_roles_role_ladder_id'), table_name='roles')
    op.drop_table('roles')
    op.drop_index(op.f('ix_people_household_id'), table_name='people')
    op.drop_table('people')
    op.drop_table('capability_profiles')
    op.drop_table('role_ladders')
    op.drop_table('organizations')
    op.drop_table('next_step_triggers')
    op.drop_table('households')
    # ### end Alembic commands ###

    bind = op.get_bind()
    for enum in ENUM_TYPES:
        enum.drop(bind, checkfirst=True)
