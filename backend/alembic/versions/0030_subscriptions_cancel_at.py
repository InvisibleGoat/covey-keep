"""subscriptions.cancel_at — when a subscription is set to end

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-12

Phase CK-73.1 — a portal cancellation is recognised
(decisions/2026-10-10-paid-tiers-on-stripe.md §7, §11 as amended there).
One nullable column, and nothing else.

THE DEFECT (CK-73's deploy check (ir), 2026-10-12): Steven cancelled his
sandbox subscription in the Customer Portal; the portal read "Cancels Nov
12" and the subscription stayed `active`, yet `GET /billing` still said
`cancel_at_period_end: false`. The `customer.subscription.updated`
delivery explained it — under API version 2026-09-30.endive the portal
cancels "at the end of the period" by setting `cancel_at` to the
period-end instant and leaving `cancel_at_period_end` FALSE, and
`sync_subscription` read only the boolean. The allowance and the status
were right throughout (a plan cancelled at the period's end stays paid
until it ends); the "this plan is ending" fact was lost.

subscriptions.cancel_at   timestamptz NULL — Stripe's `cancel_at`, verbatim,
                          as an instant (Stripe sends epoch seconds; the
                          writer converts). NULL when Stripe holds no
                          cancellation date. No default: the webhook writes
                          it from a subscription FETCHED by id, or nothing
                          does.

BOTH FACTS ARE STORED, AND WHAT THE SURFACE NEEDS IS DERIVED. `cancel_at`
and `cancel_at_period_end` are each Stripe's own field, kept verbatim (the
`status`-is-text discipline: the provider's facts copied, never its
decisions); `GET /billing` derives ONE field from them — `ends_at`:
`cancel_at` when set, else `current_period_end` when the boolean is true,
else null — so every reader gets the answer rather than two facts to
combine (the never-stored rule's other half: a column holding `ends_at`
would be a second representation, stale the moment either input moved).
The allowance reads neither (services/keeping.py): a plan with an end date
is paid until Stripe says it is not.

NOTHING BACKFILLED. A migration cannot ask Stripe what a subscription's
`cancel_at` is, and NULL here means "no cancellation date is known
locally" — true of every row at this instant, and true of a subscription
that has none. The next webhook event for a subscription writes the column
from the fetched subscription; on the deploy, Steven's one subscription is
re-synced by check (iv).

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT.
`render.yaml` runs this migration while the OLD web instance is still
serving. A nullable column with no default is invisible to that instance:
its ORM INSERT names the columns it knows and the new one takes NULL, its
reads name no column that moved (the 0026 reasoning).

The downgrade drops the column; whatever `cancel_at` values the webhook
wrote are lost, and the next event after the next upgrade writes them
again from Stripe, which keeps its own.

DATA-HANDLING: a Stripe timestamp about a subscription — when it is set
to end. It carries nothing about a person, is never logged, and is deleted
with the account's billing rows (CK-73's deletion leg).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0030'
down_revision: Union[str, Sequence[str], None] = '0029'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no default, nothing backfilled (the docstring says why each).
    op.add_column('subscriptions', sa.Column('cancel_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0029's shape: the column
    dropped, its values lost (Stripe keeps its own; the next event after
    the next upgrade writes them again)."""
    op.drop_column('subscriptions', 'cancel_at')
