"""Billing — the two tables that connect an account to a payment provider
(CK-73, migration 0029; decisions/2026-10-10-paid-tiers-on-stripe.md §9).

STRIPE OWNS THE MONEY; THESE ROWS OWN THE ALLOWANCE'S INPUTS. A
`billing_customers` row is the one link between an account and the
provider's customer; a `subscriptions` row is a local copy of the facts the
allowance is derived from — the plan and the provider's status — kept
current by the webhook (services/billing.py::sync_subscription, which
FETCHES the subscription by id on every event and upserts from what it
reads, so event order and duplicate delivery cannot leave it stale). The
quota reads these rows and never calls the provider
(services/keeping.py::account_quota).

THE ALLOWANCE IS DERIVED, NEVER STORED (record §6; the docs-root rule that
entitlement and quota are never stored). There is NO allowance column, NO
is-paid boolean and NO entitlement table — `keeping.PLAN_PHOTOGRAPHS` maps
the plan to its number at read time, and `keeping.PAID_STATUSES` decides
whether the status grants it. A column that cached either would be the
second representation database-schema decision 20 bans, and it would go
stale the moment a card failed. The verifier asserts the absence.

PROVIDER-AGNOSTIC BY SHAPE (record §4): every row names its `provider`, and
`stripe` is the only value today. A plan bought through a store later is
another row with another provider, read by the same allowance rule;
nothing in the quota path may name a provider.

`status` IS TEXT, NEVER AN ENUM — the provider's own value verbatim, so a
status the provider adds is stored rather than refused; which statuses are
PAID is the allowance's decision (keeping.py), not the schema's.

NO FK DELETE RULE, as everywhere: account deletion is anonymization and
nothing cascades from an account (decision 15). The deletion leg
(api/profile.py) closes the provider's customer FIRST — the deletion
contract's first outbound call — and then DELETES both rows explicitly in
the anonymization transaction: the ids name a provider object that no
longer exists, and a row about a person who is gone is data with no
purpose. **No billing row survives an account's deletion** (verifier-
asserted through `people.account_id`).
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import BILLING_PLAN, BILLING_PROVIDER, BillingPlan, BillingProvider


class BillingCustomer(Base):
    """One provider customer per account — created the first time the
    account opens Checkout and reused after (record §9). Keyed on the
    ACCOUNT (`accounts.id`, the one FK target quota and subscription
    reference — keeper record §9.1), so an account holds at most one
    customer; `UNIQUE (provider, provider_customer_id)` is the other
    direction: a provider customer belongs to one account. The customer id
    is the provider's own string, stored verbatim and never parsed."""

    __tablename__ = "billing_customers"
    __table_args__ = (
        # The naming convention yields uq_billing_customers_provider_provider_customer_id.
        UniqueConstraint("provider", "provider_customer_id"),
    )

    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    provider: Mapped[BillingProvider] = mapped_column(BILLING_PROVIDER, nullable=False)
    provider_customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class Subscription(Base):
    """A local copy of one provider subscription's allowance-bearing facts
    (record §6, §9): the PLAN (read from the subscription's price by its
    LOOKUP KEY, never by the price's id — a price id differs between the
    sandbox and live mode, a lookup key does not), the provider's STATUS
    verbatim, the period end, the cancel-at-period-end flag, since 0030
    (CK-73.1) `cancel_at` — the instant Stripe will end it — and,
    since 0031, CK-73.2 — THE SCHEDULED CHANGE, `scheduled_plan` and
    `scheduled_plan_at`: the plan of the subscription schedule's next phase
    and the instant it starts, both null when nothing is scheduled (a
    downgrade in the Customer Portal takes effect at renewal, and Stripe
    does that with a schedule — record §7, §12). Upserted by the webhook
    keyed on (provider, provider_subscription_id); never written by any
    other path.

    AT MOST ONE SUBSCRIPTION PER ACCOUNT IN A PAID STATUS — the partial
    unique index `uq_subscriptions_account_id_paid` over `status IN
    ('active', 'past_due')`, the database's own backstop for the record's
    one-subscription rule (§5: Checkout is refused for an account that
    already holds one, because a second would bill twice for one
    allowance). The predicate names the paid set LITERALLY: a partial
    index cannot read keeping.PAID_STATUSES, so the two are pinned to agree
    by test. A subscription in a terminal status (`canceled`,
    `incomplete_expired`) or a pre-paid one (`incomplete`) is outside the
    predicate and may sit beside a paid one — the history Stripe keeps,
    mirrored here, and the allowance reads none of it.

    `updated_at` is the 0004/0010/0014/0021 shape: NULL until the webhook
    first changes the row, stamped by the upsert's update path alone."""

    __tablename__ = "subscriptions"
    __table_args__ = (
        UniqueConstraint("provider", "provider_subscription_id"),
        Index(
            "uq_subscriptions_account_id_paid",
            "account_id",
            unique=True,
            postgresql_where=text("status IN ('active', 'past_due')"),
        ),
        # The scheduled change is ONE fact — a plan and the instant it
        # starts — so its two columns are set together or not at all
        # (0031, CK-73.2): half of one is a row nothing wrote. The naming
        # convention yields ck_subscriptions_scheduled_plan_both_or_neither.
        CheckConstraint(
            "(scheduled_plan IS NULL) = (scheduled_plan_at IS NULL)",
            name="scheduled_plan_both_or_neither",
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # "What does this account hold" — the allowance's read, the deletion
    # leg's, and GET /billing's; the plain index serves every status, the
    # partial unique above the paid ones.
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, index=True
    )
    provider: Mapped[BillingProvider] = mapped_column(BILLING_PROVIDER, nullable=False)
    provider_subscription_id: Mapped[str] = mapped_column(Text, nullable=False)
    plan: Mapped[BillingPlan] = mapped_column(BILLING_PLAN, nullable=False)
    # The provider's value, verbatim — text on purpose (see the module
    # docstring). Which values are PAID is keeping.PAID_STATUSES's.
    status: Mapped[str] = mapped_column(Text, nullable=False)
    current_period_end: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # WHEN the subscription is set to end, as an instant — Stripe's
    # `cancel_at`, verbatim (0030, CK-73.1). Under API 2026-09-30.endive the
    # Customer Portal cancels "at the end of the period" by setting THIS to
    # the period-end instant and leaving `cancel_at_period_end` FALSE, so a
    # reader of the boolean alone never sees a portal cancellation (CK-73's
    # check (ir)). Both are stored as Stripe's facts; what the surface
    # needs — "this plan is ending, on this date" — is DERIVED by
    # api/billing.py (`ends_at`: this when set, else the period end when
    # the boolean is true, else null) and never stored. The allowance
    # reads neither: a plan with an end date is paid until Stripe says it
    # is not. NULL means Stripe holds no cancellation date — or, for a row
    # last synced before 0030, that none is known locally until the next
    # event writes it (nothing backfilled; a migration cannot ask Stripe).
    cancel_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # THE SCHEDULED CHANGE (0031, CK-73.2; record §12 as amended): a
    # downgrade in the Customer Portal takes effect at renewal, and Stripe
    # does that with a SUBSCRIPTION SCHEDULE — two phases, the current
    # price until the period ends and the lower price after it. These are
    # two of its facts, verbatim: the plan of the schedule's NEXT phase
    # (the first phase starting at or after the current phase's end, by
    # its price's lookup key) and the instant that phase starts. BOTH SET
    # OR BOTH NULL (the CHECK above); null when nothing is scheduled — no
    # schedule, no next phase, the same plan, or a schedule released,
    # canceled or completed. THE ALLOWANCE NEVER READS THEM: a downgrade
    # waiting for renewal is still the higher plan until Stripe changes
    # the item (record §2's portal bullet), and `keeping.account_quota`
    # reads `plan` alone. What the surface needs — `GET /billing`'s
    # `scheduled_change`, with the next plan's allowance from
    # `keeping.PLAN_PHOTOGRAPHS` — is DERIVED by api/billing.py and never
    # stored (no "next allowance" column), and is null whenever the plan
    # is ending (`ends_at`): cancelling releases the schedule anyway.
    # Nothing backfilled (a migration cannot ask Stripe); the next event
    # for a subscription writes both.
    scheduled_plan: Mapped[Optional[BillingPlan]] = mapped_column(BILLING_PLAN, nullable=True)
    scheduled_plan_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
