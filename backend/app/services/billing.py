"""Billing — the ONE module that imports `stripe` (CK-73;
decisions/2026-10-10-paid-tiers-on-stripe.md §5, §8, §10, §11).

STRIPE OWNS THE MONEY; COVEYKEEP OWNS THE ALLOWANCE. Stripe-hosted Checkout
and the Customer Portal are the only payment surfaces, so no card detail
ever touches this process; this module creates the sessions the browser
follows, fetches a subscription by id, upserts the local row the allowance
is derived from, and — at account deletion — closes the customer. Nothing
else here calls Stripe, and NOTHING OUTSIDE THIS MODULE IMPORTS IT: the
quota path (services/keeping.py), the upload path (api/media.py) and the
worker never do (pinned by test — a source scan of the first two, and
`'stripe' not in sys.modules` after `import app.worker`). An upload must
never wait on, or fail because of, a payment provider (record §5).

THE CLIENT IS BUILT LAZILY, ONCE PER PROCESS (the storage-client pattern),
from the RESTRICTED key `Settings.stripe_api_key` — checked at boot to be a
test-mode restricted key (config.py; record §10) — with
`max_network_retries` and an HTTP timeout of ten seconds: the SDK's default
is eighty, and a request handler waits on it. EVERY SDK CALL RUNS THROUGH
`asyncio.to_thread` (the botocore pattern — the SDK is synchronous), so a
slow Stripe never stalls the event loop; the client's HTTP session is
thread-local inside the SDK, so one client serves every thread.

WEBHOOKS ARE A NUDGE, NOT A PAYLOAD TO TRUST IN ORDER (record §5). The
router verifies the signature over the RAW body (`verify_event`), takes
the subscription id out of the event, and then `fetch_subscription` reads
the subscription from Stripe BY ID and `sync_subscription` upserts the
local row from what it reads — so event order and duplicate delivery
cannot leave the row stale, and no event table is kept for deduplication.
A subscription Stripe NO LONGER HOLDS — `resource_missing` on the fetch —
is a finding, not an outage: `fetch_subscription` answers None and the
router acknowledges the event with one ERROR line naming the event and
subscription ids, never the 503 that would have Stripe retry it for days
(CK-73.1, the record's own rule applied to the fetch).

WHAT `sync_subscription` TRUSTS, AND WHAT IT DOES NOT. The ACCOUNT comes
from the subscription's CUSTOMER through `billing_customers` — never from
the metadata alone (metadata is what the Checkout request wrote, and a row
this process created is the thing to key on); an unknown customer is
acknowledged and dropped (a webhook arriving after the account's deletion,
record §8). The PLAN comes from the price's LOOKUP KEY through the two
configured keys — never the price's id, which differs between the sandbox
and live mode; an unknown lookup key writes nothing and logs an ERROR
naming the event id — a finding, never a crash. The STATUS is stored
verbatim; a status outside the six this product can produce is stored and
logged at WARNING (record §6: `trialing` and `paused` are not sold, and a
status nobody configured is a finding, never silently paid).
`current_period_end` IS READ FROM THE SUBSCRIPTION ITEM — since API
version 2025-03-31 Stripe carries it on `items.data[].current_period_end`,
not on the subscription (the pinned SDK, 16.0.0, speaks 2026-09-30.endive:
`stripe.Subscription` has no such attribute and
`stripe.SubscriptionItem` does); pinned by test against an object built
in the pinned version's shape. `cancel_at` IS STORED BESIDE
`cancel_at_period_end`, both verbatim (0030, CK-73.1): under
2026-09-30.endive the Customer Portal cancels "at the end of the period"
by setting `cancel_at` to that instant and leaving the boolean FALSE, so
a reader of the boolean alone misses every portal cancellation (CK-73's
check (ir)); the one fact the surface needs — `ends_at` — is derived in
api/billing.py, and the allowance reads neither (a plan with an end date
is paid until Stripe says it is not).
THE SCHEDULED CHANGE IS TWO MORE STRIPE FACTS (0031, CK-73.2; record §12 as
amended 2026-10-19): in the Customer Portal a downgrade takes effect at
renewal (record §7), and Stripe does that with a SUBSCRIPTION SCHEDULE on
the subscription's `schedule` — two phases, the current price until the
period ends and the lower price after it. The one fetch asks for it
EXPANDED four levels deep (`SUBSCRIPTION_EXPAND`: `schedule.phases.items.
price` — Stripe's limit), and `sync_subscription` writes the NEXT phase's
plan (the first phase starting at or after the current phase's end, its
price by lookup key) and that phase's start as `scheduled_plan` /
`scheduled_plan_at` — both null when nothing is scheduled: no schedule, no
such phase, the same plan, or a schedule in any status but `active` /
`not_started`. A next phase whose price names no configured plan — or a
schedule or a price that came back unexpanded — is ONE ERROR line naming
the event and subscription ids, both columns null, and the rest of the
upsert written as usual: it never blocks the current plan. THE ALLOWANCE
NEVER READS THEM — a downgrade waiting for renewal is still the higher
plan until Stripe changes the item (record §2's portal bullet) — and
api/billing.py derives the one fact the surface needs, `scheduled_change`,
null whenever `ends_at` is set. THE WEBHOOK LEARNS THE SIX SCHEDULE EVENTS
(`SCHEDULE_EVENT_TYPES`) because a schedule can change without any field
on the subscription itself changing, so `customer.subscription.updated`
alone can miss it: each is the same nudge — the subscription id read from
the event's schedule (`subscription`, else `released_subscription`), the
subscription fetched by id, the row upserted — and a schedule naming
neither is acknowledged with nothing done. Not `.expiring`, a seven-day
reminder nothing reads.
A SECOND PAID SUBSCRIPTION FOR ONE ACCOUNT
(two Checkout sessions opened before either completed) writes nothing,
logs an ERROR with both subscription ids and is acknowledged: the partial
unique `uq_subscriptions_account_id_paid` is the backstop, Steven cancels
the duplicate by hand, and it is recorded as known and not prevented —
preventing it would need a lock held across Stripe's hosted page.

CLOSING A CUSTOMER DELETES IT, AND THAT CANCELS ITS SUBSCRIPTIONS (record
§8). The SDK's own documentation on `CustomerService.delete` (stripe
16.0.0, `_customer_service.py`): *"Permanently deletes a customer. It
cannot be undone. Also immediately cancels any active subscriptions on
the customer."* — so `close_customer` is ONE call, the delete, rather
than a cancel per subscription followed by the delete; no proration
credit is issued, because nothing here asks for one (a cancel issues one
only when told to). A customer already gone (`resource_missing`) is a
SUCCESS — the absent-object rule, so a retried deletion goes through.

LOGGING. The `stripe` logger is pinned above DEBUG at import, beside
botocore's in storage.py: at DEBUG it logs every request's body and
every response's body (`_api_requestor.py`), and at INFO it logs every
request's URL — so it is held at WARNING, and the two SDK lines that
would carry a URL never print. Nothing in this module logs an email, a
URL, a key or a payload: event ids, subscription ids and plan names only.
A Checkout or portal URL is a bearer credential for a payment surface —
it is returned and never logged (the presigned-URL rule, CK-34). THESE
LINES REACH THE DEPLOY ONLY SINCE CK-73.1: the API process configured no
logging before it (the worker's basicConfig is the worker's alone), so
every INFO line this module wrote was dropped at a root logger with no
handler — app/logging_setup.py configures the `covey-keep` namespace,
and nothing else, at app.main's import.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

# THE SDK'S OWN LOGGER PRINTS REQUEST AND RESPONSE BODIES AT DEBUG, AND
# REQUEST URLS AT INFO (stripe/_api_requestor.py: `log_debug("API response
# body", body=...)`, `log_info("Request to Stripe api", method=..., url=...)`).
# A response body is a customer object with an email on it; a request URL
# names the resource. Pinned at WARNING here, at import of the one home
# for Stripe access, so a root `basicConfig(level=DEBUG)` — which sets the
# ROOT level and leaves this one alone — cannot turn either on while
# someone chases a deploy. Pinned by test.
logging.getLogger("stripe").setLevel(logging.WARNING)

import stripe  # noqa: E402  — after the logger pin, on purpose

from sqlalchemy import select  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.config import settings  # noqa: E402
from app.models import (  # noqa: E402
    Account,
    BillingCustomer,
    BillingPlan,
    BillingProvider,
    Subscription,
)
from app.services.keeping import PAID_STATUSES  # noqa: E402

log = logging.getLogger("covey-keep.billing")

PROVIDER = BillingProvider.STRIPE

# The SDK's default HTTP timeout is 80 seconds, and a request handler
# (checkout, the portal, deletion) waits on the call: ten is the bound.
HTTP_TIMEOUT_SECONDS = 10.0
# Transient failures retried by the SDK (idempotent on Stripe's side for
# every call this module makes — creates carry a key or are safe to repeat).
MAX_NETWORK_RETRIES = 2

# The statuses this product can produce (record §6): a Checkout session
# that completed (`active`), a card Stripe is retrying (`past_due`), a
# first payment not yet made (`incomplete`) or abandoned
# (`incomplete_expired`), and the two ends (`canceled`, `unpaid`).
# `trialing` and `paused` are NOT sold — a status outside this set is
# stored verbatim and logged at WARNING.
KNOWN_STATUSES = frozenset(
    {"active", "past_due", "incomplete", "incomplete_expired", "canceled", "unpaid"}
)

# The event types the webhook handles (record §11, §12): each carries, or
# names, one subscription, which is then FETCHED and upserted. Four on the
# subscription itself (CK-73) ...
SUBSCRIPTION_EVENT_TYPES = frozenset(
    {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }
)
# ... and six on a SUBSCRIPTION SCHEDULE (CK-73.2): the portal's downgrade
# at renewal is a schedule, and a schedule can change without any field on
# the subscription changing, so `customer.subscription.updated` alone can
# miss it. Each names its subscription on the schedule — `subscription`,
# else `released_subscription` once the schedule is released. NOT
# `subscription_schedule.expiring`, a seven-day reminder nothing reads.
SCHEDULE_EVENT_TYPES = frozenset(
    {
        "subscription_schedule.created",
        "subscription_schedule.updated",
        "subscription_schedule.released",
        "subscription_schedule.canceled",
        "subscription_schedule.completed",
        "subscription_schedule.aborted",
    }
)
HANDLED_EVENT_TYPES = SUBSCRIPTION_EVENT_TYPES | SCHEDULE_EVENT_TYPES

# A schedule in one of these statuses still has a change to come; a
# released, canceled or completed one schedules nothing (both columns
# null). `not_started` has no current phase, so its boundary is the
# subscription item's period end.
SCHEDULE_STATUSES_PENDING = frozenset({"active", "not_started"})

# What the ONE subscription fetch asks Stripe to expand: the schedule, its
# phases, their items and each item's PRICE — four levels, Stripe's limit —
# so the next phase's lookup key is on the object `sync_subscription`
# reads, in the same call that reads the current item (one nudge, one
# fetch). Pinned by test on the wrapper.
SUBSCRIPTION_EXPAND = ("schedule.phases.items.price",)

# The two exception classes the ROUTERS catch, re-exported so that nothing
# outside this module imports `stripe` to name them.
ProviderError = stripe.StripeError
SignatureError = stripe.SignatureVerificationError


class PriceUnavailable(Exception):
    """A configured lookup key resolves to no active price — the sandbox's
    products are not set up as record §3 says, or a price was archived. A
    503 for Checkout and an ERROR line, never a 500."""

    def __init__(self, plan: BillingPlan) -> None:
        super().__init__(f"no active price for plan {plan.value}")
        self.plan = plan


# --- The client -----------------------------------------------------------------

_client: Optional[stripe.StripeClient] = None


def client() -> stripe.StripeClient:
    """The one StripeClient per process, built on first use from the
    restricted key (the storage-client pattern: nothing at import). The
    SDK's `RequestsClient` keeps its HTTP session thread-local, so the one
    instance is safe to share across the `asyncio.to_thread` workers."""
    global _client
    if _client is None:
        _client = stripe.StripeClient(
            settings.stripe_api_key,
            max_network_retries=MAX_NETWORK_RETRIES,
            http_client=stripe.RequestsClient(timeout=HTTP_TIMEOUT_SECONDS),
        )
    return _client


def _lookup_key(plan: BillingPlan) -> str:
    """The configured lookup key for a plan (record §3, §10) — the two
    settings, never a literal: the key is the sandbox's and live mode's
    to name."""
    if plan == BillingPlan.PHOTOS_100K:
        return settings.stripe_price_lookup_100k
    return settings.stripe_price_lookup_300k


def _plan_for_lookup_key(lookup_key: Optional[str]) -> Optional[BillingPlan]:
    """The inverse: which plan a price's lookup key names, or None when it
    names neither configured key."""
    if lookup_key is None:
        return None
    if lookup_key == settings.stripe_price_lookup_100k:
        return BillingPlan.PHOTOS_100K
    if lookup_key == settings.stripe_price_lookup_300k:
        return BillingPlan.PHOTOS_300K
    return None


# --- The SDK calls, each the single place a test stubs ---------------------------
#
# Every function below is ONE SDK call (or a short fixed sequence) with no
# decision in it, run on a worker thread. The decisions — the lock, the
# absent-object rule, the upsert — live in the functions after them, so a
# test that stubs these exercises the decisions against the real code.


def _list_active_prices(lookup_key: str) -> list:
    """The active prices carrying this lookup key — zero or one."""
    return list(client().v1.prices.list({"lookup_keys": [lookup_key], "active": True}).data)


def _create_customer(email: Optional[str], account_id: UUID) -> str:
    """One customer at Stripe; returns its id. The idempotency key is
    derived from the account id, so two creates for one account — a race
    the lock in ensure_customer did not serialise — yield ONE customer at
    Stripe within the key's window. The email rides so receipts reach the
    person (record, DATA-HANDLING); the account id rides as metadata so a
    person reading the Stripe dashboard can find the account."""
    params: dict = {"metadata": {"account_id": str(account_id)}}
    if email:
        params["email"] = email
    customer = client().v1.customers.create(
        params, {"idempotency_key": f"covey-keep-customer-{account_id}"}
    )
    return customer.id


def _create_checkout_session(params: dict) -> str:
    """A hosted Checkout Session; returns its URL — a bearer credential for
    a payment surface, returned and never logged."""
    return client().v1.checkout.sessions.create(params).url


def _create_portal_session(params: dict) -> str:
    """A Customer Portal session; returns its URL — likewise."""
    return client().v1.billing_portal.sessions.create(params).url


def _retrieve_subscription(subscription_id: str) -> stripe.Subscription:
    """The subscription BY ID, as Stripe holds it now — the nudge's
    counterpart (the module docstring) — with its schedule expanded down to
    each phase item's price (`SUBSCRIPTION_EXPAND`, CK-73.2), so the
    scheduled change rides the same object as the current item."""
    return client().v1.subscriptions.retrieve(
        subscription_id, params={"expand": list(SUBSCRIPTION_EXPAND)}
    )


def _delete_customer(customer_id: str) -> None:
    """Permanently delete the customer — which, per the SDK's own
    documentation, also immediately cancels its active subscriptions."""
    client().v1.customers.delete(customer_id)


# --- The functions the routers call --------------------------------------------


async def price_for(plan: BillingPlan) -> str:
    """The active price id for a plan, by its lookup key. A lookup key that
    resolves to no active price is `PriceUnavailable` (a 503 for Checkout)
    and an ERROR line naming the plan — the sandbox's products are not set
    up as the record says, which is a configuration finding and never a
    500."""
    prices = await asyncio.to_thread(_list_active_prices, _lookup_key(plan))
    if not prices:
        log.error(
            "billing: the lookup key configured for plan %s resolves to no active price",
            plan.value,
        )
        raise PriceUnavailable(plan)
    return prices[0].id


async def ensure_customer(db: AsyncSession, account: Account, email: Optional[str]) -> BillingCustomer:
    """The account's `billing_customers` row — the existing one, or a new
    customer created at Stripe and recorded, UNDER THE ACCOUNT ROW LOCKED
    `FOR UPDATE` so that two clicks make one customer: the second click
    waits on the lock, then finds the row the first wrote. The idempotency
    key in `_create_customer` is the belt on top of these braces (one
    customer at Stripe even if the lock were lost). The caller commits —
    and should commit PROMPTLY, because the lock is the same row the
    upload gate locks for this account's gatherings
    (api/media.py::_enforce_limits): an intent on a gathering this account
    keeps waits behind the create, bounded by the SDK timeout, on the
    first Checkout click an account ever makes and never after (the fast
    path below reads the row without the lock)."""
    existing = await db.scalar(
        select(BillingCustomer).where(BillingCustomer.account_id == account.id)
    )
    if existing is not None:
        return existing
    # Serialise the create per account: lock the row, re-read under it.
    await db.execute(select(Account.id).where(Account.id == account.id).with_for_update())
    existing = await db.scalar(
        select(BillingCustomer).where(BillingCustomer.account_id == account.id)
    )
    if existing is not None:
        return existing
    customer_id = await asyncio.to_thread(_create_customer, email, account.id)
    row = BillingCustomer(
        account_id=account.id, provider=PROVIDER, provider_customer_id=customer_id
    )
    db.add(row)
    await db.flush()
    return row


async def checkout_url(customer_id: str, price_id: str, account_id: UUID) -> str:
    """A Checkout Session to buy ONE plan (record §11): subscription mode,
    one line item, the account id as `client_reference_id` AND as the
    subscription's metadata, the two return URLs on the frontend's `/plan`
    (CK-74). No promotion codes and no automatic tax — tax is undecided
    (record §13) and a default here would decide it.

    CARDS ONLY, AND LINK HIDDEN — two parameters, two decisions (CK-74.1,
    CK-74.2).

    `allowed_payment_method_types: ["card"]` is Steven's decision of
    2026-10-22, standing on its own: cards, with Apple Pay and Google Pay
    riding them, cover nearly everyone; the list is fixed in code, so the
    sandbox and live match; and for a $4.99 monthly plan, bank payments
    and buy-now-pay-later add ways for a payment to fail without adding
    buyers. On the deploy the filter removed Cash App Pay, Klarna and
    Amazon Pay (check `(jh)`, 2026-10-22; a *Bank* option remained beside
    *Card*, probably Link's own bank payment — `(jk)` notes whether it is
    still offered once Link is hidden).

    `wallet_options: {"link": {"display": "never"}}` is what hides Link.
    CK-74.1 sent the filter alone to turn Link off, and `(jh)` showed the
    filter leaves Link's pre-ticked "Save my information with Link" box,
    the phone-number field beneath it, its terms line and its button in
    the wallet row all in place: Checkout's Link is not a payment method
    the filter governs but a wallet with a setting of its own — the SDK
    documents `display` as "Specifies whether Checkout should display Link
    as a payment option", `auto` (the default: every wallet the session
    supports) or `never`. Link stays OFF by Steven's decision of
    2026-10-21: the box comes pre-ticked, and ticking it adds a
    phone-number field and opens a Link account under Stripe's own terms,
    while this product makes people opt in themselves (the notice checkbox
    starts unticked on purpose) — a pre-ticked box is not a choice the
    product made. Both are decided HERE, in code, so the sandbox and the
    live setup cannot drift: nothing in either Dashboard needs setting for
    them.

    Why the `allowed_` key and not the other, still: the installed SDK
    (`stripe` 16.0.0, API `2026-09-30.endive`) has no
    `payment_method_types` on `SessionCreateParams`;
    `allowed_payment_method_types` is "a filter on the dynamically
    computed set of eligible payment methods", whose literals include both
    `card` and `link`; `excluded_payment_method_types` cannot name `link`
    at all. Apple Pay and Google Pay are wallets that ride `card` — neither
    list names them — and they stay. The notice's "your card never reaches
    CoveyKeep" is true either way.

    A parameter's documentation says what a session ACCEPTS, not what
    Checkout SHOWS: the filter's docstring was quoted at CK-74.1 and Link
    stayed. Only a look at the sandbox's Checkout page proves a change
    here, which is why `(jk)` exists."""
    params = {
        "mode": "subscription",
        "customer": customer_id,
        "line_items": [{"price": price_id, "quantity": 1}],
        "client_reference_id": str(account_id),
        "subscription_data": {"metadata": {"account_id": str(account_id)}},
        "success_url": f"{settings.app_base_url}/plan?checkout=complete",
        "cancel_url": f"{settings.app_base_url}/plan?checkout=cancelled",
        "allowed_payment_method_types": ["card"],
        "wallet_options": {"link": {"display": "never"}},
    }
    return await asyncio.to_thread(_create_checkout_session, params)


async def portal_url(customer_id: str) -> str:
    """A Customer Portal session — the card, switching, cancelling and the
    invoices are all Stripe's surfaces (record §7); returns to `/plan`."""
    params = {"customer": customer_id, "return_url": f"{settings.app_base_url}/plan"}
    return await asyncio.to_thread(_create_portal_session, params)


async def fetch_subscription(subscription_id: str) -> Optional[stripe.Subscription]:
    """The subscription as Stripe holds it now, by id — or None when Stripe
    answers `resource_missing`: a subscription that no longer exists, or
    never did. An event naming one is a finding a retry cannot fix, so the
    router acknowledges it with a 200 and an ERROR line naming both ids
    rather than the 503 that would have Stripe retry it for days (CK-73.1;
    the absent-object rule, `close_customer`'s shape). Every other provider
    error propagates — the router's 503 is for those."""
    try:
        return await asyncio.to_thread(_retrieve_subscription, subscription_id)
    except stripe.InvalidRequestError as exc:
        if exc.code == "resource_missing":
            return None
        raise


async def close_customer(customer_id: str) -> bool:
    """Delete the customer at Stripe, which cancels its subscriptions at
    once (the module docstring's citation). Returns True when this call
    deleted it, False when it was ALREADY GONE — `resource_missing`, the
    absent-object rule, so a deletion retried after a half-done first
    attempt goes through. Every other provider error propagates: the
    caller refuses the deletion rather than leaving a person deleted here
    and billed there (record §8)."""
    try:
        await asyncio.to_thread(_delete_customer, customer_id)
    except stripe.InvalidRequestError as exc:
        if exc.code == "resource_missing":
            return False
        raise
    return True


def verify_event(payload: bytes, signature: Optional[str]) -> stripe.Event:
    """The event, after the SDK verifies the signature over the RAW body
    with the webhook secret. Raises `SignatureError` on a missing or bad
    signature and `ValueError` on a body that is not JSON; the router
    answers both with a 400 and does nothing. Pure computation — no
    network, no thread."""
    return stripe.Webhook.construct_event(payload, signature, settings.stripe_webhook_secret)


def subscription_id_of(event: stripe.Event) -> Optional[str]:
    """The subscription an event is about, or None for an event type the
    webhook does not handle (acknowledged and ignored). A
    `checkout.session.completed` names its subscription on the session; a
    `customer.subscription.*` IS the subscription; a
    `subscription_schedule.*` (CK-73.2) names it on the schedule —
    `subscription`, else `released_subscription` (set once a schedule is
    released), else None: a schedule attached to no subscription is
    acknowledged with nothing done, and no "handled" line."""
    if event.type not in HANDLED_EVENT_TYPES:
        return None
    obj = event.data.object
    if event.type == "checkout.session.completed":
        return _id_of(_field(obj, "subscription"))
    if event.type in SCHEDULE_EVENT_TYPES:
        return _id_of(_field(obj, "subscription")) or _id_of(_field(obj, "released_subscription"))
    return _field(obj, "id")


def _id_of(value) -> Optional[str]:
    """An id from a field that Stripe sends as an id string or, expanded, as
    the object itself; None when absent."""
    if value is None:
        return None
    return value if isinstance(value, str) else value.id


def _field(obj, name: str):
    """One field of a StripeObject, or None when it is absent. SUBSCRIPT,
    never `.get`: a StripeObject is NOT a dict in this SDK, and it raises
    on the dict-method names (`get`, `items`) to say so — `sub["items"]`
    is the one spelling for the field that shares a name with a dict
    method. Measured against the pinned SDK, 16.0.0."""
    try:
        return obj[name]
    except (KeyError, TypeError):
        return None


def _customer_id_of(sub: stripe.Subscription) -> Optional[str]:
    customer = _field(sub, "customer")
    if customer is None:
        return None
    return customer if isinstance(customer, str) else customer.id


def _first_item(sub: stripe.Subscription):
    items = _field(sub, "items")
    data = list(getattr(items, "data", None) or []) if items is not None else []
    return data[0] if data else None


def _scheduled_change(
    sub: stripe.Subscription, current_plan: BillingPlan, period_end_raw, *, event_id: Optional[str]
) -> tuple[Optional[BillingPlan], Optional[datetime]]:
    """The change waiting for renewal, as (plan, instant) — or (None, None)
    when nothing is scheduled (0031, CK-73.2; the module docstring). From
    the subscription's `schedule`, EXPANDED by the fetch: when its status
    is `active` or `not_started`, the first phase whose `start_date` is at
    or after the current phase's `end_date` (or, with no current phase,
    the item's period end) is the next phase; its one item's price names
    the plan by lookup key. Null when there is no schedule, no such phase,
    that phase's plan is the current plan, or the schedule is in any other
    status. A next phase that cannot be read as a configured plan — an
    unknown lookup key, or a schedule or a price that came back unexpanded
    — is ONE ERROR line naming the event and subscription ids and (None,
    None): a finding, never a crash, and never a reason to drop the
    current plan's upsert. Everything read through `_field`."""
    subscription_id = sub.id
    schedule = _field(sub, "schedule")
    if schedule is None:
        return None, None

    def unreadable() -> tuple[None, None]:
        log.error(
            "billing: event %s: subscription %s carries a schedule whose next phase could not be "
            "read as a configured plan; the scheduled change is not recorded",
            event_id,
            subscription_id,
        )
        return None, None

    if isinstance(schedule, str):
        # An id where the fetch asked for the object: the expansion was not
        # honoured. Visible as a finding rather than silently unscheduled.
        return unreadable()
    if _field(schedule, "status") not in SCHEDULE_STATUSES_PENDING:
        return None, None
    current = _field(schedule, "current_phase")
    boundary = _field(current, "end_date") if current is not None else period_end_raw
    if boundary is None:
        return None, None
    next_phase = next(
        (
            phase
            for phase in list(_field(schedule, "phases") or [])
            if _field(phase, "start_date") is not None and int(_field(phase, "start_date")) >= int(boundary)
        ),
        None,
    )
    if next_phase is None:
        return None, None
    items = list(_field(next_phase, "items") or [])
    price = _field(items[0], "price") if items else None
    plan = _plan_for_lookup_key(getattr(price, "lookup_key", None))
    if plan is None:
        return unreadable()
    if plan == current_plan:
        return None, None
    return plan, datetime.fromtimestamp(int(_field(next_phase, "start_date")), tz=timezone.utc)


async def _other_paid_subscription(
    db: AsyncSession, account_id: UUID, subscription_id: str
) -> Optional[Subscription]:
    return await db.scalar(
        select(Subscription).where(
            Subscription.account_id == account_id,
            Subscription.status.in_(PAID_STATUSES),
            Subscription.provider_subscription_id != subscription_id,
        )
    )


async def sync_subscription(
    db: AsyncSession, sub: stripe.Subscription, *, event_id: Optional[str] = None
) -> Optional[Subscription]:
    """The upsert, keyed on (provider, provider_subscription_id), from a
    subscription FETCHED by id (the module docstring: what is trusted and
    what is not). Returns the row written, or None when nothing was — an
    unknown customer, an unknown lookup key, or a second paid subscription
    for one account, each logged with ids only. The caller commits."""
    subscription_id = sub.id
    customer_id = _customer_id_of(sub)
    customer = (
        await db.scalar(
            select(BillingCustomer).where(
                BillingCustomer.provider == PROVIDER,
                BillingCustomer.provider_customer_id == customer_id,
            )
        )
        if customer_id is not None
        else None
    )
    if customer is None:
        # A webhook for a customer this product does not hold — after the
        # account's deletion, most likely (record §8). Acknowledged and
        # dropped; the type and id are the router's INFO line.
        log.info(
            "billing: event %s names subscription %s on a customer with no account here; dropped",
            event_id,
            subscription_id,
        )
        return None
    # The account id as a plain value (CK-77.1): the flush below can roll
    # back, a rollback expires every object this session holds — `customer`
    # included — and reading an expired object on an async session raises
    # MissingGreenlet; the backstop's re-read uses this and nothing loaded.
    account_id = customer.account_id

    item = _first_item(sub)
    plan = _plan_for_lookup_key(getattr(getattr(item, "price", None), "lookup_key", None))
    if plan is None:
        log.error(
            "billing: event %s: subscription %s carries a price whose lookup key names no "
            "configured plan; nothing written",
            event_id,
            subscription_id,
        )
        return None

    status = str(sub.status)
    if status not in KNOWN_STATUSES:
        log.warning(
            "billing: event %s: subscription %s has status %r, which this product does not sell; "
            "stored verbatim, and the allowance reads it as unpaid",
            event_id,
            subscription_id,
            status,
        )
    period_end_raw = getattr(item, "current_period_end", None)
    current_period_end = (
        datetime.fromtimestamp(int(period_end_raw), tz=timezone.utc)
        if period_end_raw is not None
        else None
    )
    cancel_at_period_end = bool(_field(sub, "cancel_at_period_end") or False)
    # WHEN it is set to end — Stripe's `cancel_at`, epoch seconds or null
    # (0030, CK-73.1). Under 2026-09-30.endive the Customer Portal cancels
    # "at the end of the period" by setting THIS and leaving the boolean
    # false (CK-73's check (ir)); both are stored verbatim and
    # api/billing.py derives the one fact the surface needs. A "don't
    # cancel" in the portal sets it back to null, written like any value.
    cancel_at_raw = _field(sub, "cancel_at")
    cancel_at = (
        datetime.fromtimestamp(int(cancel_at_raw), tz=timezone.utc)
        if cancel_at_raw is not None
        else None
    )
    # THE SCHEDULED CHANGE (0031, CK-73.2): two more Stripe facts, from the
    # expanded schedule — the next phase's plan and its start — both null
    # when nothing is scheduled; never read by the allowance. An unreadable
    # next phase is an ERROR line and null, and the upsert goes on.
    scheduled_plan, scheduled_plan_at = _scheduled_change(sub, plan, period_end_raw, event_id=event_id)

    if status in PAID_STATUSES:
        other = await _other_paid_subscription(db, account_id, subscription_id)
        if other is not None:
            log.error(
                "billing: event %s: subscription %s would be a second paid subscription for the "
                "account that already holds %s; nothing written — cancel the duplicate by hand",
                event_id,
                subscription_id,
                other.provider_subscription_id,
            )
            return None

    row = await db.scalar(
        select(Subscription).where(
            Subscription.provider == PROVIDER,
            Subscription.provider_subscription_id == subscription_id,
        )
    )
    if row is None:
        row = Subscription(
            account_id=account_id,
            provider=PROVIDER,
            provider_subscription_id=subscription_id,
            plan=plan,
            status=status,
            current_period_end=current_period_end,
            cancel_at_period_end=cancel_at_period_end,
            cancel_at=cancel_at,
            scheduled_plan=scheduled_plan,
            scheduled_plan_at=scheduled_plan_at,
        )
        db.add(row)
    else:
        row.plan = plan
        row.status = status
        row.current_period_end = current_period_end
        row.cancel_at_period_end = cancel_at_period_end
        row.cancel_at = cancel_at
        row.scheduled_plan = scheduled_plan
        row.scheduled_plan_at = scheduled_plan_at
        row.updated_at = datetime.now(timezone.utc)
    try:
        await db.flush()
    except IntegrityError:
        # The race the pre-check cannot see: two events for two paid
        # subscriptions on one account, flushed at once. The partial unique
        # is the backstop; this one is dropped and logged like the other —
        # from the account id captured above, because `customer` is expired
        # once the session has rolled back (CK-77.1).
        await db.rollback()
        other = await _other_paid_subscription(db, account_id, subscription_id)
        log.error(
            "billing: event %s: subscription %s would be a second paid subscription for the "
            "account that already holds %s; nothing written — cancel the duplicate by hand",
            event_id,
            subscription_id,
            other.provider_subscription_id if other is not None else "another",
        )
        return None
    return row
