"""inviting people outside the group: the setting, from_outside, the alert's dismissals

Revision ID: 0037
Revises: 0036
Create Date: 2026-11-10

Phase CK-92 — inviting people outside the group, the backend: the setting
on a group's gathering, invitations from outside while it is on, turning it
off, and the alert's data (decisions/2026-10-04-a-groups-gathering-stays-
in-the-group.md §5, §6, §7, §11; decisions/2026-10-23-joining-a-group-and-
co-admins.md §6, §9). EXPAND-ONLY: two columns and two CHECKs on
`gatherings`, one column on `gathering_invitations`, one new table. Nothing
is backfilled — every existing gathering reads off, every existing
invitation row is a member's, and nobody has dismissed anything.

gatherings.outside_invitations_since         timestamptz NULL
gatherings.outside_invitations_by_person_id  uuid NULL, FK -> people (no delete rule)
    The setting is ON exactly when the stamp is set; the stamp is also the
    outside alert's version (turning it on again writes a new one, so a
    dismissed alert comes back). The person is who turned it on — the alert
    names them and is not shown to them.
    CHECK ck_gatherings_outside_invitations_both_or_neither:
        num_nonnulls(outside_invitations_since, outside_invitations_by_person_id) IN (0, 2)
    CHECK ck_gatherings_outside_invitations_need_group:
        owning_group_id IS NOT NULL OR outside_invitations_since IS NULL
    — only a group's gathering has a group to be outside of.

gathering_invitations.from_outside   boolean NOT NULL DEFAULT false
    TRUE ON EXACTLY THE ROWS AN OUTSIDER HOLDS: written true when a person
    who is not a member of the owning group accepts an emailed invitation;
    set false when they join the group. A fact on the row, never worked out
    from membership at read time, so a member who leaves is never an
    outsider. THE SERVER DEFAULT IS RIGHT HERE (0034's `invitees_chosen`
    precedent): every writer that does not know about outsiders — the
    CK-91 instance serving during this migration's pre-deploy window, the
    create path, the newcomer rows — writes a member's row, which is
    exactly what false says.

gathering_outside_alert_dismissals
    gathering_id   uuid NOT NULL, FK -> gatherings (no delete rule)
    person_id      uuid NOT NULL, FK -> people (no delete rule)
    dismissed_at   timestamptz NOT NULL
    PRIMARY KEY (gathering_id, person_id) — one row per person per
                   gathering, replaced on each dismissal; the key answers
                   the detail body's one lookup, so no second index
    A CONTENT TABLE, never in services/retention.py's EPHEMERAL_TABLES.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING. Two nullable columns, a column
with a default, two CHECKs every existing row satisfies (every gathering
off), and a new table are invisible to the CK-91 instance: it names none of
them, and an INSERT into `gathering_invitations` that omits `from_outside`
takes the default. The verifier's members-only line is narrowed beside this
migration to *no LIVE pending invitation sits on a group's gathering whose
outside invitations are off*, which every deployed row satisfies today.

THE DOWNGRADE drops what the upgrade made, in reverse. Outsiders' rows stay
as ordinary person-targeted invitation rows — they would then read as
members' — and the stamps and the dismissals are lost; a re-upgrade finds
every gathering off and every row false.

DATA-HANDLING: a stamp, a person who turned the setting on, a flag on an
invitation row, and a person's dismissal of an alert. No address, nothing
logged.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0037'
down_revision: Union[str, Sequence[str], None] = '0036'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # --- the setting on gatherings, with its two CHECKs ----------------------
    op.add_column(
        'gatherings',
        sa.Column('outside_invitations_since', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'gatherings',
        sa.Column('outside_invitations_by_person_id', sa.Uuid(), nullable=True),
    )
    # No delete rule: nothing cascades from a person (decision 15).
    op.create_foreign_key(
        op.f('fk_gatherings_outside_invitations_by_person_id'),
        'gatherings',
        'people',
        ['outside_invitations_by_person_id'],
        ['id'],
    )
    op.create_check_constraint(
        op.f('ck_gatherings_outside_invitations_both_or_neither'),
        'gatherings',
        'num_nonnulls(outside_invitations_since, outside_invitations_by_person_id) IN (0, 2)',
    )
    op.create_check_constraint(
        op.f('ck_gatherings_outside_invitations_need_group'),
        'gatherings',
        'owning_group_id IS NOT NULL OR outside_invitations_since IS NULL',
    )

    # --- from_outside on gathering_invitations ---------------------------------
    op.add_column(
        'gathering_invitations',
        sa.Column('from_outside', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )

    # --- the alert's dismissals ------------------------------------------------
    op.create_table('gathering_outside_alert_dismissals',
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('dismissed_at', sa.DateTime(timezone=True), nullable=False),
    # Two FKs, no delete rule on either (decision 15).
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_gathering_outside_alert_dismissals_gathering_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_gathering_outside_alert_dismissals_person_id')),
    sa.PrimaryKeyConstraint('gathering_id', 'person_id', name=op.f('pk_gathering_outside_alert_dismissals'))
    )


def downgrade() -> None:
    """Downgrade schema — what the upgrade made goes, in reverse."""
    op.drop_table('gathering_outside_alert_dismissals')
    op.drop_column('gathering_invitations', 'from_outside')
    op.drop_constraint(op.f('ck_gatherings_outside_invitations_need_group'), 'gatherings', type_='check')
    op.drop_constraint(op.f('ck_gatherings_outside_invitations_both_or_neither'), 'gatherings', type_='check')
    op.drop_constraint(
        op.f('fk_gatherings_outside_invitations_by_person_id'), 'gatherings', type_='foreignkey'
    )
    op.drop_column('gatherings', 'outside_invitations_by_person_id')
    op.drop_column('gatherings', 'outside_invitations_since')
