"""billing_customers and subscriptions — the paid tiers' local rows

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-11

Phase CK-73 — paid tiers, the backend: two photo plans on Stripe, and the
allowance read from a local row (decisions/2026-10-10-paid-tiers-on-stripe.md
§5, §6, §9). Two new enum types, two new tables, and nothing else.

THE SHAPE (record §9, finalised here):

billing_provider  ENUM ('stripe') — the provider column's type. One value
                  today; a store build later is another label and another
                  row, read by the same allowance rule (record §4).
billing_plan      ENUM ('photos_100k', 'photos_300k') — what is sold (§3).
                  Design-fixed, so a native enum (database-schema decision
                  2); a third plan is a decision record plus one ADD VALUE
                  — one migration EARLIER than any migration that writes it
                  (the CK-32 trap).

billing_customers
    account_id             uuid PK, FK -> accounts (no delete rule)
    provider               billing_provider NOT NULL
    provider_customer_id   text NOT NULL
    created_at             timestamptz NOT NULL DEFAULT now()
    UNIQUE (provider, provider_customer_id)
    One provider customer per account, created the first time the account
    opens Checkout and reused after.

subscriptions
    id                        uuid PK
    account_id                uuid NOT NULL, FK -> accounts (no delete
                              rule), indexed
    provider                  billing_provider NOT NULL
    provider_subscription_id  text NOT NULL; UNIQUE (provider,
                              provider_subscription_id)
    plan                      billing_plan NOT NULL — read from the price's
                              LOOKUP KEY at sync, never the price's id
    status                    text NOT NULL — the provider's value VERBATIM,
                              never an enum: a status the provider adds is
                              stored rather than refused, and which
                              statuses are PAID is the allowance's decision
                              (services/keeping.py::PAID_STATUSES)
    current_period_end        timestamptz NULL
    cancel_at_period_end      boolean NOT NULL
    created_at                timestamptz NOT NULL DEFAULT now()
    updated_at                timestamptz NULL — the 0004/0010/0014/0021
                              shape: NULL until the webhook first changes
                              the row, stamped by the update path alone
    PARTIAL UNIQUE uq_subscriptions_account_id_paid ON (account_id)
        WHERE status IN ('active', 'past_due')
        — AT MOST ONE SUBSCRIPTION PER ACCOUNT IN A PAID STATUS: the
        database's own backstop for record §5's one-subscription rule
        (Checkout is refused for an account that already holds one; a
        second would bill twice for one allowance). The predicate names
        the paid set literally, because an index cannot read a Python
        constant; the two are pinned to agree by test.

NO ALLOWANCE COLUMN, NO IS-PAID BOOLEAN, NOTHING ELSE — the never-stored
rule (record §6; the docs-root rule that entitlement and quota are never
stored). The allowance is a function of `plan` and `status` computed at
read time (keeping.PLAN_PHOTOGRAPHS, keeping.PAID_STATUSES); a column that
cached it would be the second representation decision 20 bans, stale the
moment a card failed. The verifier asserts the absence.

NO FK DELETE RULE on either table (decision 15: nothing cascades from an
account). The deletion leg (api/profile.py::delete_account) closes the
provider's customer FIRST — refused with a 503 if the provider cannot be
reached, so nobody is deleted here and still billed there — and then
DELETES both rows explicitly in the anonymization transaction. No billing
row survives an account's deletion (verifier-asserted).

THE TYPES ARE CREATED BY `CREATE TYPE` HERE, SO THEIR LABELS ARE USABLE AT
ONCE — not the CK-32 trap, which is `ALTER TYPE ... ADD VALUE` on an
existing type (measured at CK-71: a label made by CREATE TYPE is safe in
the transaction that created it; a label added by ADD VALUE is not, even
on a type created in that transaction). Nothing here writes a row either
way: the first writer is this phase's own code, which arrives with the new
instance.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT.
`render.yaml` runs this migration while the OLD web instance is still
serving. Two new tables and two new types that no deployed code names are
invisible to that instance — it neither reads nor writes them, and
nothing here touches a table, column or constraint the old code uses. The
first reader and the first writer are this phase's own code, which
arrives with the new instance (the 0027 reasoning).

The downgrade drops the tables, then the types; every billing row is lost
(the provider keeps its own record of every subscription and invoice, as
it must), and nothing else is touched.

DATA-HANDLING: these rows hold the provider's customer and subscription
ids, the plan, the provider's status, the period end and the cancel flag
— and nothing else. No card detail, no billing address, no invoice, no
event payload is stored anywhere (record, DATA-HANDLING). The migration
creates empty tables and writes no row.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0029'
down_revision: Union[str, Sequence[str], None] = '0028'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The two types, created explicitly below (the 0016 / 0028 pattern) so the
# columns' table creation never tries to create them a second time.
billing_provider = postgresql.ENUM('stripe', name='billing_provider', create_type=False)
billing_plan = postgresql.ENUM('photos_100k', 'photos_300k', name='billing_plan', create_type=False)

# The paid set, literally — the partial unique's predicate. Pinned by test
# to agree with services/keeping.py::PAID_STATUSES.
PAID_PREDICATE = "status IN ('active', 'past_due')"


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    # The types first — NEW in this transaction, made by CREATE TYPE, so
    # their labels are usable at once (see the docstring).
    billing_provider.create(bind, checkfirst=True)
    billing_plan.create(bind, checkfirst=True)

    op.create_table('billing_customers',
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('provider', billing_provider, nullable=False),
    sa.Column('provider_customer_id', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # No delete rule: nothing cascades from an account (decision 15); the
    # deletion leg deletes this row explicitly, after closing the
    # provider's customer.
    sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], name=op.f('fk_billing_customers_account_id')),
    # The account IS the key: one provider customer per account.
    sa.PrimaryKeyConstraint('account_id', name=op.f('pk_billing_customers')),
    # And the other direction: a provider customer belongs to one account.
    sa.UniqueConstraint('provider', 'provider_customer_id', name=op.f('uq_billing_customers_provider_provider_customer_id'))
    )

    op.create_table('subscriptions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('provider', billing_provider, nullable=False),
    sa.Column('provider_subscription_id', sa.Text(), nullable=False),
    sa.Column('plan', billing_plan, nullable=False),
    # TEXT, never an enum: the provider's status verbatim (see the docstring).
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('current_period_end', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancel_at_period_end', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], name=op.f('fk_subscriptions_account_id')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_subscriptions')),
    sa.UniqueConstraint('provider', 'provider_subscription_id', name=op.f('uq_subscriptions_provider_provider_subscription_id'))
    )
    # "What does this account hold" — the allowance's read, the deletion
    # leg's and GET /billing's, over every status.
    op.create_index(op.f('ix_subscriptions_account_id'), 'subscriptions', ['account_id'], unique=False)
    # THE BACKSTOP: at most one subscription per account in a paid status.
    op.create_index(
        'uq_subscriptions_account_id_paid',
        'subscriptions',
        ['account_id'],
        unique=True,
        postgresql_where=sa.text(PAID_PREDICATE),
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0028's shape: the indexes, the
    tables, then the types. Every billing row is lost; nothing else is
    touched."""
    bind = op.get_bind()
    op.drop_index('uq_subscriptions_account_id_paid', table_name='subscriptions', postgresql_where=sa.text(PAID_PREDICATE))
    op.drop_index(op.f('ix_subscriptions_account_id'), table_name='subscriptions')
    op.drop_table('subscriptions')
    op.drop_table('billing_customers')
    billing_plan.drop(bind, checkfirst=True)
    billing_provider.drop(bind, checkfirst=True)
