"""group_co_admins, group_invitations_pending, group_links, group_join_requests; the keeper backfill

Revision ID: 0032
Revises: 0031
Create Date: 2026-10-23

Phase CK-75 — Groups 1: joining a group, the member list, co-admins, and
handing over (decisions/2026-10-23-joining-a-group-and-co-admins.md §2, §3,
§5, §6, §7, §8). Four new tables, one new enum type, and one UPDATE — and
nothing dropped or renamed on a live table.

group_co_admins (record §6; the co-host shape, CK-68, keyed on the PERSON)
    group_id             uuid NOT NULL, FK -> groups (no delete rule)
    person_id            uuid NOT NULL, FK -> people (no delete rule)
    added_by_person_id   uuid NOT NULL, FK -> people (no delete rule) —
                         provenance: who appointed them
    created_at           timestamptz NOT NULL DEFAULT now()
    PRIMARY KEY (group_id, person_id) — a person co-administers a group once
    INDEX (person_id) — "what does this person co-administer": the deletion
                         leg's reader
  Every co-admin is a member and no co-admin is the admin — both asserted
  by the verifier, kept true by the endpoints (the add refuses the admin, a
  hand-over deletes the new admin's row, leaving and removal delete the
  co-admin row with the membership). No capability column, ever.

group_invitations_pending (record §2 — CK-25's machinery, the group as the
target; a SIBLING of gathering_invitations_pending, never a widened target
on it, so no live table changes shape)
    the 0011 columns with group_id in place of gathering_id: id, group_id
    (FK -> groups), channel (the EXISTING type invitation_channel — made by
    CREATE TYPE at 0011; this migration names none of its labels),
    destination, token_hash (UNIQUE; the SHA-256 only), expires_at,
    consumed_at, revoked_at, invited_by_person_id (FK -> people), created_at
    CHECK consumed_or_revoked: num_nonnulls(consumed_at, revoked_at) <= 1
    partial UNIQUE (group_id, channel, destination) WHERE live — one live
    invitation per destination; a fresh invite supersedes

group_links (record §2–§3)
    id, group_id (FK -> groups), created_by_person_id (FK -> people),
    created_at, expires_at NOT NULL, revoked_at NULL
    NO TOKEN COLUMN. The token is derived from `id` with the server's
    session secret (app/security.py::group_link_token), so any member can
    be shown the link again and a leaked database yields no working link.
    partial UNIQUE (group_id) WHERE revoked_at IS NULL — at most one
    unrevoked link per group; making a link stamps every unrevoked row for
    the group first.

group_join_requests (record §2)
    id, group_id (FK -> groups), person_id (FK -> people), created_at,
    decided_at NULL, outcome join_request_outcome NULL (a NEW type, made by
    CREATE TYPE here, so its labels are usable at once — the CK-71 rule),
    decided_by_person_id NULL (FK -> people; NULL when an emailed
    invitation's acceptance closed the request as approved)
    CHECK decided_with_outcome: (decided_at IS NULL) = (outcome IS NULL)
    partial UNIQUE (group_id, person_id) WHERE decided_at IS NULL — one
    open request per person per group; an open request never expires

THE KEEPER BACKFILL, LAST (record §8). `POST /groups` had never written
`groups.keeper_account_id`: migration 0022's one-time backfill was the only
thing that ever set it, so every group created since 0022 (2026-09-18 on
the deploy) has no keeper, though the records say the creator is the first
keeper. It has not bitten only because no gathering belongs to a group yet.
CK-75's create path writes it; this UPDATE fixes the rest, once:

    keeper_account_id = the admin person's account
    ONLY WHERE the keeper is NULL, the admin is set, and the admin's person
    is not anonymized

— today the admin is always the creator, because no hand-over existed
before this phase, and an anonymized account is never assigned (0022's own
rule). The count is reported on an INFO line on alembic's own logger (the
0023/0024 pattern — it lands in the deploy log beside `Running upgrade`),
ASCII only. On the deploy, ZERO IS A FINDING as much as any number: every
group created through the API since 0022 whose creator still holds an
account should be counted. (The local dev DB holds no groups; zero there
is expected and is the same line.)

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT.
`render.yaml` runs this migration while the OLD web instance (CK-74.2's
code) still serves. Four new tables and a new type that no deployed code
names are invisible to it; the UPDATE writes a column it reads only through
the keeper resolver, which answers "kept" where it answered "unkept" — the
truth, a moment earlier. `groups.backup_admin_person_id` is NOT dropped
here, for exactly this reason: the old instance selects it in every group
body, so the drop is a later contract step (queued in WORKING-ON-NOW.md);
this phase stops writing it and the verifier asserts it NULL.

THE DOWNGRADE drops the four tables (their indexes and constraints with
them) and the new type. The backfilled keepers STAY: they are true — the
creator is the first keeper, and 0022's own backfill wrote the same fact
from the same column — and un-writing a true fact is not a restoration of
anything. `invitation_channel` is untouched: 0011 owns it.

DATA-HANDLING: a co-admin row names a person and who appointed them; a
pending invitation holds an address a third party supplied, hashed-token-
only, ephemeral and reaped (CK-25 and CK-24); a link row holds no secret at
all; a join request names its requester and nothing else about them, and
is reaped once decided. The backfill writes an account id already present
on the person row. Nothing here is logged but a count.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0032'
down_revision: Union[str, Sequence[str], None] = '0031'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the count
# lands in the deploy log beside them at INFO (the 0023/0024 pattern).
log = logging.getLogger("alembic.runtime.migration")

# The type exists since 0011 (CREATE TYPE); this migration only names it,
# never a label — nothing here reads or writes a channel value.
invitation_channel = postgresql.ENUM('EMAIL', 'SMS', name='invitation_channel', create_type=False)

# NEW at 0032, made by CREATE TYPE below — its labels are usable at once
# (the CK-71 rule), though no data step here names one.
join_request_outcome = postgresql.ENUM(
    'approved', 'declined', name='join_request_outcome', create_type=False
)

# The keeper backfill (the docstring): only where NULL, only where the admin
# is a person who can still sign in. `anonymized_at` is read, never a label.
BACKFILL = """
UPDATE groups g
   SET keeper_account_id = p.account_id
  FROM people p
 WHERE p.id = g.admin_person_id
   AND g.keeper_account_id IS NULL
   AND p.anonymized_at IS NULL
"""


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    join_request_outcome.create(bind, checkfirst=True)

    # --- group_co_admins (record §6) ---------------------------------------
    op.create_table('group_co_admins',
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('added_by_person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # Three FKs, no delete rule on any: nothing cascades from a person or a
    # group (decision 15); the deletion leg removes rows explicitly.
    sa.ForeignKeyConstraint(['added_by_person_id'], ['people.id'], name=op.f('fk_group_co_admins_added_by_person_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_group_co_admins_group_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_group_co_admins_person_id')),
    # The composite key IS the uniqueness — a person co-administers a group
    # once — and it leads with group_id, so "who co-administers this group"
    # needs no second index.
    sa.PrimaryKeyConstraint('group_id', 'person_id', name=op.f('pk_group_co_admins'))
    )
    # "What does this person co-administer": the deletion leg's reader.
    op.create_index(op.f('ix_group_co_admins_person_id'), 'group_co_admins', ['person_id'], unique=False)

    # --- group_invitations_pending (record §2; 0011's shape, re-targeted) ---
    op.create_table('group_invitations_pending',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('channel', invitation_channel, nullable=False),
    sa.Column('destination', sa.Text(), nullable=False),
    sa.Column('token_hash', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('invited_by_person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # A row is consumed (accepted) or revoked (withdrawn/superseded), never
    # both — the acceptance state machine, pinned in the schema (0011).
    sa.CheckConstraint('num_nonnulls(consumed_at, revoked_at) <= 1', name=op.f('ck_group_invitations_pending_consumed_or_revoked')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_group_invitations_pending_group_id')),
    sa.ForeignKeyConstraint(['invited_by_person_id'], ['people.id'], name=op.f('fk_group_invitations_pending_invited_by_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_group_invitations_pending')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_group_invitations_pending_token_hash'))
    )
    op.create_index(op.f('ix_group_invitations_pending_group_id'), 'group_invitations_pending', ['group_id'], unique=False)
    # At most one LIVE invitation per (group, channel, destination): a fresh
    # invite supersedes (revokes) the old row rather than stacking live
    # tokens; consumed and revoked rows stay for the rate-limit tally until
    # the reaper takes them.
    op.create_index('uq_group_invitations_pending_live_destination', 'group_invitations_pending', ['group_id', 'channel', 'destination'], unique=True, postgresql_where=sa.text('consumed_at IS NULL AND revoked_at IS NULL'))

    # --- group_links (record §2–§3): no token column -------------------------
    op.create_table('group_links',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('created_by_person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['created_by_person_id'], ['people.id'], name=op.f('fk_group_links_created_by_person_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_group_links_group_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_group_links'))
    )
    # At most one unrevoked link per group: making a link stamps every
    # unrevoked row for the group first, then inserts.
    op.create_index('uq_group_links_live', 'group_links', ['group_id'], unique=True, postgresql_where=sa.text('revoked_at IS NULL'))

    # --- group_join_requests (record §2) -------------------------------------
    op.create_table('group_join_requests',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('outcome', join_request_outcome, nullable=True),
    sa.Column('decided_by_person_id', sa.Uuid(), nullable=True),
    # Decided means both: the instant and the outcome are one fact.
    sa.CheckConstraint('(decided_at IS NULL) = (outcome IS NULL)', name=op.f('ck_group_join_requests_decided_with_outcome')),
    sa.ForeignKeyConstraint(['decided_by_person_id'], ['people.id'], name=op.f('fk_group_join_requests_decided_by_person_id')),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_group_join_requests_group_id')),
    sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_group_join_requests_person_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_group_join_requests'))
    )
    op.create_index(op.f('ix_group_join_requests_group_id'), 'group_join_requests', ['group_id'], unique=False)
    op.create_index(op.f('ix_group_join_requests_person_id'), 'group_join_requests', ['person_id'], unique=False)
    # One OPEN request per (group, person); decided rows pile up until reaped.
    op.create_index('uq_group_join_requests_open', 'group_join_requests', ['group_id', 'person_id'], unique=True, postgresql_where=sa.text('decided_at IS NULL'))

    # --- The keeper backfill, last (record §8) ---------------------------------
    result = bind.execute(sa.text(BACKFILL))
    # ASCII only: a Windows console under cp1252 raises on an em dash, and
    # a migration must not fail for a log line.
    log.info(
        "0032 backfilled groups.keeper_account_id from the admin's account: "
        "%d group(s) (NULL keeper, admin set, admin's person not anonymized; "
        "on a database that holds groups created since 0022, a zero here is a finding)",
        result.rowcount,
    )


def downgrade() -> None:
    """Downgrade schema — the four tables and the new type go, in reverse;
    the backfilled keepers STAY (they are true, and 0022's own backfill
    wrote the same fact); `invitation_channel` is 0011's and is untouched."""
    op.drop_index('uq_group_join_requests_open', table_name='group_join_requests', postgresql_where=sa.text('decided_at IS NULL'))
    op.drop_index(op.f('ix_group_join_requests_person_id'), table_name='group_join_requests')
    op.drop_index(op.f('ix_group_join_requests_group_id'), table_name='group_join_requests')
    op.drop_table('group_join_requests')
    op.drop_index('uq_group_links_live', table_name='group_links', postgresql_where=sa.text('revoked_at IS NULL'))
    op.drop_table('group_links')
    op.drop_index('uq_group_invitations_pending_live_destination', table_name='group_invitations_pending', postgresql_where=sa.text('consumed_at IS NULL AND revoked_at IS NULL'))
    op.drop_index(op.f('ix_group_invitations_pending_group_id'), table_name='group_invitations_pending')
    op.drop_table('group_invitations_pending')
    op.drop_index(op.f('ix_group_co_admins_person_id'), table_name='group_co_admins')
    op.drop_table('group_co_admins')
    join_request_outcome.drop(op.get_bind(), checkfirst=True)
