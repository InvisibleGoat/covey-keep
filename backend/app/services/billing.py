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

# The event types the webhook handles (record §11): each carries, or names,
# one subscription, which is then FETCHED and upserted.
HANDLED_EVENT_TYPES = frozenset(
    {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }
)

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
    counterpart (the module docstring)."""
    return client().v1.subscriptions.retrieve(subscription_id)


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
    subscription's metadata, the two return URLs on the frontend (CK-74
    builds `/plan`; until then the return lands on the app's not-found
    screen). No promotion codes and no automatic tax — tax is undecided
    (record §13) and a default here would decide it."""
    params = {
        "mode": "subscription",
        "customer": customer_id,
        "line_items": [{"price": price_id, "quantity": 1}],
        "client_reference_id": str(account_id),
        "subscription_data": {"metadata": {"account_id": str(account_id)}},
        "success_url": f"{settings.app_base_url}/plan?checkout=complete",
        "cancel_url": f"{settings.app_base_url}/plan?checkout=cancelled",
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
    `customer.subscription.*` IS the subscription."""
    if event.type not in HANDLED_EVENT_TYPES:
        return None
    obj = event.data.object
    if event.type == "checkout.session.completed":
        subscription = _field(obj, "subscription")
        if subscription is None:
            return None
        return subscription if isinstance(subscription, str) else subscription.id
    return _field(obj, "id")


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

    if status in PAID_STATUSES:
        other = await _other_paid_subscription(db, customer.account_id, subscription_id)
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
            account_id=customer.account_id,
            provider=PROVIDER,
            provider_subscription_id=subscription_id,
            plan=plan,
            status=status,
            current_period_end=current_period_end,
            cancel_at_period_end=cancel_at_period_end,
            cancel_at=cancel_at,
        )
        db.add(row)
    else:
        row.plan = plan
        row.status = status
        row.current_period_end = current_period_end
        row.cancel_at_period_end = cancel_at_period_end
        row.cancel_at = cancel_at
        row.updated_at = datetime.now(timezone.utc)
    try:
        await db.flush()
    except IntegrityError:
        # The race the pre-check cannot see: two events for two paid
        # subscriptions on one account, flushed at once. The partial unique
        # is the backstop; this one is dropped and logged like the other.
        await db.rollback()
        other = await _other_paid_subscription(db, customer.account_id, subscription_id)
        log.error(
            "billing: event %s: subscription %s would be a second paid subscription for the "
            "account that already holds %s; nothing written — cancel the duplicate by hand",
            event_id,
            subscription_id,
            other.provider_subscription_id if other is not None else "another",
        )
        return None
    return row
