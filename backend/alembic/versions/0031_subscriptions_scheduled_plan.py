"""subscriptions.scheduled_plan and scheduled_plan_at — a downgrade waiting for renewal

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-19

Phase CK-73.2 — a downgrade waiting for renewal is stored and shown
(decisions/2026-10-10-paid-tiers-on-stripe.md §12 as amended 2026-10-19;
§2's portal bullet; §7). Two nullable columns and one CHECK, and nothing
else.

WHAT IT STORES. In the Customer Portal a downgrade takes effect at the end
of the period (§7), and Stripe does that with a SUBSCRIPTION SCHEDULE: the
subscription's `schedule` names a `sub_sched_…` with two phases — the
current price until the period ends, the lower price after it. The code
read the current item's price alone (§2), so the plan and the allowance
stayed right until renewal, by design — and nothing knew a change was
coming: the plan screen (CK-74) could not say "switches to 100,000 photos
on Nov 12" (found by the design session on 2026-10-14, confirmed by the
planning session on 2026-10-19). Two Stripe facts now ride the row,
written by the webhook's upsert from what Stripe holds at every fetch:

subscriptions.scheduled_plan     billing_plan NULL — the plan of the
                                 schedule's NEXT phase (the first phase
                                 starting at or after the current phase's
                                 end), by its price's lookup key.
subscriptions.scheduled_plan_at  timestamptz NULL — the instant that phase
                                 starts (Stripe's epoch seconds, as an
                                 instant).

BOTH SET OR BOTH NULL — the CHECK `ck_subscriptions_scheduled_plan_both_or_neither`
(`(scheduled_plan IS NULL) = (scheduled_plan_at IS NULL)`). Null when
nothing is scheduled: no schedule, no next phase, a next phase on the SAME
plan, or a schedule in any status but `active` / `not_started` (released,
canceled, completed). A plan and an instant are one fact — a change — and
half of one is a row nothing wrote.

THE ALLOWANCE NEVER READS THEM (record §12's banner). A downgrade scheduled
for renewal is still the higher plan until Stripe changes the item, and
`keeping.account_quota` reads the current item's plan alone; the surface's
one fact — `GET /billing`'s `scheduled_change` — is derived in
api/billing.py from these two columns and `keeping.PLAN_PHOTOGRAPHS`, and
never stored (no "next allowance" column; the never-stored rule).

THE TYPE `billing_plan` ALREADY EXISTS (0029, made by CREATE TYPE), and
this migration names none of its labels — the column is added with no
default and nothing backfilled, so the CK-71 enum-label trap has nothing
to bite on; a data step that ever names a label compares text.

NOTHING BACKFILLED. A migration cannot ask Stripe what a subscription's
schedule holds, and NULL means "no scheduled change is known locally" —
true of every row at this instant. The next event for a subscription
writes both columns from the fetched subscription (the six schedule
events the webhook learns at CK-73.2 among them); on the deploy, check
(ix) makes one.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT.
`render.yaml` runs this migration while the OLD web instance still serves.
Two nullable columns with no default are invisible to it: its ORM INSERT
names the columns it knows and the new ones take NULL — which the CHECK
admits — and nothing it reads moved (the 0026 / 0030 reasoning).

The downgrade drops the CHECK and both columns; whatever the webhook wrote
is lost, and the next event after the next upgrade writes it again from
Stripe, which keeps its own.

DATA-HANDLING: a plan label and an instant about a subscription. They
carry nothing about a person, are never logged, and are deleted with the
account's billing rows (CK-73's deletion leg, unchanged).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0031'
down_revision: Union[str, Sequence[str], None] = '0030'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The type exists since 0029 (CREATE TYPE); this migration only names it,
# never a label — nothing here reads or writes a value.
billing_plan = postgresql.ENUM('photos_100k', 'photos_300k', name='billing_plan', create_type=False)

# Both set or both null: a plan and an instant are one fact.
SCHEDULED_PLAN_BOTH_OR_NEITHER_CHECK = '(scheduled_plan IS NULL) = (scheduled_plan_at IS NULL)'


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no default, nothing backfilled (the docstring says why each).
    op.add_column('subscriptions', sa.Column('scheduled_plan', billing_plan, nullable=True))
    op.add_column(
        'subscriptions', sa.Column('scheduled_plan_at', sa.DateTime(timezone=True), nullable=True)
    )
    # Every existing row is NULL / NULL, which the CHECK admits — so it can
    # be added after the columns with nothing to populate first.
    op.create_check_constraint(
        op.f('ck_subscriptions_scheduled_plan_both_or_neither'),
        'subscriptions',
        SCHEDULED_PLAN_BOTH_OR_NEITHER_CHECK,
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0030's shape: the CHECK, then
    both columns, dropped; their values lost (Stripe keeps its own; the
    next event after the next upgrade writes them again)."""
    op.drop_constraint(
        op.f('ck_subscriptions_scheduled_plan_both_or_neither'), 'subscriptions', type_='check'
    )
    op.drop_column('subscriptions', 'scheduled_plan_at')
    op.drop_column('subscriptions', 'scheduled_plan')
