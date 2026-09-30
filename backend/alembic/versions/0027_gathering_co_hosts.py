"""gathering_co_hosts — the co-host relation beside the host

Revision ID: 0027
Revises: 0026
Create Date: 2026-09-29

Phase CK-68 — co-hosts: the relation, the two helpers, and every check
classified (decisions/2026-09-03-co-hosts.md §1, §4, §5; amended by
decisions/2026-09-27-two-bins.md §4). One new table, and nothing else.

THE SHAPE, AND WHY IT IS A TABLE BESIDE THE HOST AND NOT A COLUMN'S
REPLACEMENT. `gatherings.host_account_id` keeps its shape — one nullable
FK, one host, who remains the consent controller (CK-15 §4). That column is
singular in five recorded places (co-hosts §2: CK-20's authorization,
CK-13's claim flow — a NULL host IS the claimable state — CK-13's grace,
the managed-profile exclusion, and the consent controller itself), and
replacing it with a join table would force all five to be re-decided at
once. A relation BESIDE it forces none: the host is the controller by
construction, and a co-host is a row.

gathering_co_hosts
    gathering_id          uuid NOT NULL, FK -> gatherings (no delete rule)
    account_id            uuid NOT NULL, FK -> accounts (no delete rule)
    added_by_account_id   uuid NOT NULL, FK -> accounts (no delete rule) —
                          provenance: who made them a co-host
    created_at            timestamptz NOT NULL DEFAULT now()
    PRIMARY KEY (gathering_id, account_id) — the uniqueness: an account
                          co-hosts a gathering once
    INDEX (account_id)    "what does this account co-host" — the deletion
                          leg's reader

KEYED ON THE ACCOUNT, as `host_account_id` is, so `is_host` and
`may_administer` (api/gatherings.py) compare the same spine. No capability
column and none may be added: one flag and a reserved list, never a
permission matrix (co-hosts §4).

NO DELETE CASCADE FROM ACCOUNTS. Account deletion is anonymization and
nothing cascades from an account (database-schema decision 15); the
deletion leg (services/keeping.py::lapse_kept_statuses) DELETES an
anonymized account's co-host rows explicitly, in the transaction that
relinquishes host — a row here IS the role, and there is no "needs a
co-host" state to leave behind. `added_by_account_id` is left alone by
that leg: it is provenance, the accounts row is retained at anonymization,
and a FK with no delete rule keeps it pointing at that retained row (the
`published_by_person_id` shape, 0020).

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT
SPLIT. `render.yaml` runs this migration while the OLD web instance is
still serving. A new table that no deployed code names is invisible to
that instance — it neither reads nor writes it, and nothing here touches a
table, column or constraint the old code uses. The first reader and the
first writer are this phase's own code, which arrives with the new
instance; nothing has to be maintained through a deploy window before it
is read (the 0024 concern), because nothing exists to maintain.

The downgrade drops the index and the table; every co-host row is lost,
and nothing else is touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0027'
down_revision: Union[str, Sequence[str], None] = '0026'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('gathering_co_hosts',
    sa.Column('gathering_id', sa.Uuid(), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('added_by_account_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # Three FKs, no delete rule on any: nothing cascades from an account or
    # a gathering (decision 15); the deletion leg removes rows explicitly.
    sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], name=op.f('fk_gathering_co_hosts_account_id')),
    sa.ForeignKeyConstraint(['added_by_account_id'], ['accounts.id'], name=op.f('fk_gathering_co_hosts_added_by_account_id')),
    sa.ForeignKeyConstraint(['gathering_id'], ['gatherings.id'], name=op.f('fk_gathering_co_hosts_gathering_id')),
    # The composite key IS the uniqueness — an account co-hosts a gathering
    # once — and it leads with gathering_id, so "who co-hosts this
    # gathering" needs no second index.
    sa.PrimaryKeyConstraint('gathering_id', 'account_id', name=op.f('pk_gathering_co_hosts'))
    )
    # "What does this account co-host": the deletion leg's reader, and the
    # co-host half of `may_administer` when asked per account.
    op.create_index(op.f('ix_gathering_co_hosts_account_id'), 'gathering_co_hosts', ['account_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0026's shape. Every co-host
    row is gone; nothing else is touched."""
    op.drop_index(op.f('ix_gathering_co_hosts_account_id'), table_name='gathering_co_hosts')
    op.drop_table('gathering_co_hosts')
