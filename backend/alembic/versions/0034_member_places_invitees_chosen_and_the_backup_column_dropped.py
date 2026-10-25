"""gathering_member_places, gatherings.invitees_chosen; groups.backup_admin_person_id dropped

Revision ID: 0034
Revises: 0033
Create Date: 2026-10-24

Phase CK-77 — Groups 2b: choosing who is invited — shared with, left out,
and keeping lets no one in (decisions/2026-10-04-a-groups-gathering-stays-in-
the-group.md §4, §9, §10, §11; decisions/2026-09-02-participation-
terminology.md §4, §5; decisions/2026-09-27-keeping-explained.md §5.11;
decisions/2026-10-23-joining-a-group-and-co-admins.md §6 — the backup slot).
One new type, one new table, one new column with its CHECK, and ONE COLUMN
DROPPED — the contract step CK-75 retired and CK-76 unmapped.

member_place (a NEW type, made by CREATE TYPE here — so its labels are
usable at once, the CK-71 rule; no data step here names one anyway)
    'shared_with'   memory only: the photographs, never the logistics
    'left_out'      no trace, anywhere
  INVITED IS NOT A LABEL. An invited member holds a person-targeted
  `gathering_invitations` row — what the product has always understood —
  and this type discriminates a SIBLING relation for the two other places,
  so no check that admits an invitee learns a new filter, and a place row
  grants nothing until a read path opts in to it.

gathering_member_places (the record §4, §9, §10)
    gathering_id        uuid NOT NULL, FK -> gatherings (no delete rule)
    person_id           uuid NOT NULL, FK -> people (no delete rule)
    place               member_place NOT NULL
    set_by_person_id    uuid NULL, FK -> people (no delete rule) —
                        provenance: the host or co-host who chose it; NULL
                        when the group's rule placed a newcomer (the CK-43
                        publisher shape)
    created_at          timestamptz NOT NULL DEFAULT now()
    updated_at          timestamptz NULL — stamped when the place CHANGES
    PRIMARY KEY (gathering_id, person_id) — one place per person per
                        gathering on this table; across the two tables the
                        verifier asserts it (no person holds both rows)
    INDEX (person_id) — "where does this person stand": the list and the
                        media audience look rows up by person

gatherings.invitees_chosen   boolean NOT NULL DEFAULT false
    Did the host choose who is invited? False: the whole group is invited
    (CK-76's rows; a newcomer gets an invitation row). True: some members
    hold a place row instead (a newcomer gets a `shared_with` one). Once
    chosen, chosen — nothing sets it back. THE SERVER DEFAULT IS RIGHT
    HERE, unlike `requires_approval`'s (decision 33): every writer that
    does not know about choosing — the CK-76.1 instance serving during
    this migration's pre-deploy window included — means "the whole group",
    which is exactly what false says; the create path sets it explicitly
    anyway (the CK-16 discipline). No backfill: every existing group
    gathering was created whole-group, so false is TRUE of it, and no place
    row existed before this phase.
    CHECK ck_gatherings_invitees_chosen_needs_group:
        owning_group_id IS NOT NULL OR NOT invitees_chosen
    — a standalone gathering has no group to choose from.

groups.backup_admin_person_id — DROPPED (its FK first). Retired at CK-75
(the co-admin relation replaced it; in no body, written by nothing,
asserted NULL on every row by the verifier), UNMAPPED at CK-76 (the model
stopped selecting it, so the instance serving during THIS pre-deploy window
reads it nowhere — which is what makes the drop safe under Render's
ordering), dropped here: expand / migrate / contract on one column over
three phases. It held only NULLs (verifier-asserted since CK-75), so
nothing is lost. alembic/env.py's `include_object` hook, which passed the
unmapped column over for autogenerate, is deleted in the same commit.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING. A new type, a new table and a
new column with a default are invisible to the CK-76.1 instance (it names
none of them, and an INSERT that omits `invitees_chosen` takes the
default); the dropped column is one that instance already selects nowhere.

THE DOWNGRADE drops what the upgrade made — the CHECK, the column, the
index, the table, the type — and RE-ADDS `groups.backup_admin_person_id`
nullable with its FK under its old name, every value NULL, which is all it
ever held. Place rows and the chosen flag are lost with the table and the
column; a re-upgrade finds every group gathering whole-group again.

DATA-HANDLING: a place row names a person, a gathering, and who chose —
nothing else about anyone. Nothing here is logged.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0034'
down_revision: Union[str, Sequence[str], None] = '0033'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# NEW at 0034, made by CREATE TYPE below — its labels are usable at once
# (the CK-71 rule), though no data step here names one.
member_place = postgresql.ENUM('shared_with', 'left_out', name='member_place', create_type=False)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    member_place.create(bind, checkfirst=True)

    # --- gathering_member_places (record §4, §9, §10) ------------------------
    op.create_table('gathering_member_places',
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('place', member_place, nullable=False),
    sa.Column('set_by_person_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    # Three FKs, no delete rule on any: nothing cascades from a person or a
    # gathering (decision 15); a deleted account's row stays and admits nobody.
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_gathering_member_places_gathering_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_gathering_member_places_person_id')),
    sa.ForeignKeyConstraint(['set_by_person_id'], ['people.id'], name=op.f('fk_gathering_member_places_set_by_person_id')),
    # The composite key IS the uniqueness on this table — one place per
    # person per gathering — and it leads with gathering_id, so "who stands
    # where on this gathering" needs no second index.
    sa.PrimaryKeyConstraint('gathering_id', 'person_id', name=op.f('pk_gathering_member_places'))
    )
    # "Where does this person stand": the list statement's and the media
    # audience's reader.
    op.create_index(op.f('ix_gathering_member_places_person_id'), 'gathering_member_places', ['person_id'], unique=False)

    # --- gatherings.invitees_chosen, with its CHECK ----------------------------
    op.add_column(
        'gatherings',
        sa.Column('invitees_chosen', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )
    op.create_check_constraint(
        op.f('ck_gatherings_invitees_chosen_needs_group'),
        'gatherings',
        'owning_group_id IS NOT NULL OR NOT invitees_chosen',
    )

    # --- the contract step: groups.backup_admin_person_id dropped --------------
    op.drop_constraint('fk_groups_backup_admin_person_id', 'groups', type_='foreignkey')
    op.drop_column('groups', 'backup_admin_person_id')


def downgrade() -> None:
    """Downgrade schema — what the upgrade made goes, in reverse, and the
    retired backup column comes back nullable with its FK, every value NULL
    (all it ever held)."""
    op.add_column('groups', sa.Column('backup_admin_person_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        'fk_groups_backup_admin_person_id', 'groups', 'people', ['backup_admin_person_id'], ['id']
    )
    op.drop_constraint(op.f('ck_gatherings_invitees_chosen_needs_group'), 'gatherings', type_='check')
    op.drop_column('gatherings', 'invitees_chosen')
    op.drop_index(op.f('ix_gathering_member_places_person_id'), table_name='gathering_member_places')
    op.drop_table('gathering_member_places')
    member_place.drop(op.get_bind(), checkfirst=True)
