"""Billing — the eleventh router (CK-73;
decisions/2026-10-10-paid-tiers-on-stripe.md §5, §11).

Four endpoints. Three sit behind the standard auth gate and act on the
CALLER'S OWN ACCOUNT — there is no other account a person can read or buy
for; an anonymized account is already a 401 at the gate. The fourth is
Stripe's, unauthenticated and outside the gate, verified by signature.

- `GET /billing` — the plan and its facts, the DERIVED allowance (through
  `keeping.account_quota`, the same function the upload path reads, so
  the number here is the number the gate enforces), and what the next
  step is: Checkout with no paid subscription, the portal with one.
  NEVER A STRIPE ID: the customer and subscription ids are this process's
  keys, not the person's.
- `POST /billing/checkout` — creates or reuses the customer and creates a
  Checkout Session for one plan; `{"url"}`. **409 `already_subscribed`**
  for an account already holding a subscription in a paid status: a
  second would bill twice for one allowance (record §5), and switching is
  the portal's (record §7).
- `POST /billing/portal` — a Customer Portal session; `{"url"}`. 404 for
  an account with no customer, byte-for-byte the shape of the gathering
  and media not-found refusals.
- `POST /billing/stripe/webhook` — verifies the signature over the RAW
  body; for the four handled types fetches the subscription by id and
  upserts the local row (services/billing.py — the nudge, never the
  payload); every other type is acknowledged and ignored. ONE INFO LINE
  PER HANDLED EVENT, its type and id and nothing else. A bad signature is
  a 400 with nothing done; a Stripe error while fetching is a 503 so
  Stripe retries; a FINDING (an unknown customer, an unknown price, a
  second paid subscription) is a 200, because a retry cannot fix it.

A CHECKOUT OR PORTAL URL IS A BEARER CREDENTIAL FOR A PAYMENT SURFACE (the
presigned-URL rule, CK-34): it is never logged, and the response body is
the only place one appears — pinned with the root logger at DEBUG. This
router logs one line per handled webhook event and nothing on any other
path; a webhook payload carries the customer's email and billing details
and is never logged at any level.

Every Stripe error class the handlers name is re-exported by
services/billing.py: this module does not import `stripe` (the seam is
one module — its docstring).
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.models import Account, BillingCustomer, BillingPlan, Subscription
from app.services import billing, keeping

router = APIRouter(tags=["billing"])

log = logging.getLogger("covey-keep.billing")

# The stable codes (the CK-30 marker precedent): the frontend switches on
# these, never on wording.
ALREADY_SUBSCRIBED = "already_subscribed"
# The provider did not answer, or refused: try again. Carried by the
# checkout and portal 503s, by the webhook's 503 (so Stripe retries), and
# by the deletion leg's (api/profile.py) — one code for "Stripe is the
# reason", the storage_unavailable shape.
BILLING_UNAVAILABLE = "billing_unavailable"

# The next step GET /billing names.
NEXT_CHECKOUT = "checkout"
NEXT_PORTAL = "portal"


def _not_found() -> HTTPException:
    # The gathering/media posture: a plain 404, one body.
    return HTTPException(404, "No such plan.")


def _unavailable(what: str) -> HTTPException:
    return HTTPException(
        503,
        detail={
            "code": BILLING_UNAVAILABLE,
            "message": f"{what} isn't available right now; try again in a moment",
        },
    )


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


class CheckoutBody(BaseModel):
    # An unknown plan is FastAPI's own field-level 422 on ["body", "plan"];
    # an unknown field likewise.
    model_config = ConfigDict(extra="forbid")

    plan: BillingPlan


async def _account(db: AsyncSession, ctx: AuthContext) -> Account:
    account = await db.get(Account, ctx.person.account_id)
    assert account is not None  # a person always has one (/auth/verify)
    return account


@router.get("/billing")
async def read_billing(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The caller's plan: null on the free tier, else the plan held in a
    paid status, with Stripe's status, the period end and the cancel flag;
    the allowance DERIVED (never stored — record §6) by the same function
    the upload gate reads; and the next step. No Stripe id rides."""
    account = await _account(db, ctx)
    paid: Optional[Subscription] = await keeping.paid_subscription(db, account)
    allowance = await keeping.account_quota(db, account)
    return {
        "plan": paid.plan.value if paid is not None else None,
        "status": paid.status if paid is not None else None,
        "current_period_end": _iso(paid.current_period_end) if paid is not None else None,
        "cancel_at_period_end": paid.cancel_at_period_end if paid is not None else False,
        "allowance": allowance,
        "next": NEXT_PORTAL if paid is not None else NEXT_CHECKOUT,
    }


@router.post("/billing/checkout")
async def start_checkout(
    body: CheckoutBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Buy a plan: the customer created or reused (committed at once, so
    the account-row lock it takes is released before the next Stripe
    call), the plan's active price found by its lookup key, a Checkout
    Session created, its URL returned — and never logged."""
    account = await _account(db, ctx)
    if await keeping.holds_paid_plan(db, account):
        raise HTTPException(
            409,
            detail={
                "code": ALREADY_SUBSCRIBED,
                "message": "this account already has a plan — change or cancel it from the plan portal",
            },
        )
    try:
        customer = await billing.ensure_customer(db, account, ctx.person.email)
        await db.commit()
        price_id = await billing.price_for(body.plan)
        url = await billing.checkout_url(customer.provider_customer_id, price_id, account.id)
    except billing.PriceUnavailable:
        raise _unavailable("buying a plan")
    except billing.ProviderError:
        raise _unavailable("buying a plan")
    return {"url": url}


@router.post("/billing/portal")
async def open_portal(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Manage the plan: a Customer Portal session for the account's
    customer; its URL returned and never logged. 404 for an account that
    has never opened Checkout — there is no customer to open a portal for."""
    customer = await db.scalar(
        select(BillingCustomer).where(BillingCustomer.account_id == ctx.person.account_id)
    )
    if customer is None:
        raise _not_found()
    try:
        url = await billing.portal_url(customer.provider_customer_id)
    except billing.ProviderError:
        raise _unavailable("the plan portal")
    return {"url": url}


@router.post("/billing/stripe/webhook")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    """Stripe's nudge (record §5, §11): the signature verified over the RAW
    body, the subscription FETCHED by id for the handled types, the local
    row upserted, 200. Unauthenticated and outside the auth gate: the
    signature is the authentication."""
    payload = await request.body()
    try:
        event = billing.verify_event(payload, request.headers.get("stripe-signature"))
    except (billing.SignatureError, ValueError):
        # Nothing done, and nothing logged beyond the fact: the payload is
        # untrusted and may be anyone's.
        log.warning("billing: a webhook was refused — its signature or its body could not be verified")
        raise HTTPException(400, "Webhook signature verification failed.")
    subscription_id = billing.subscription_id_of(event)
    if subscription_id is None:
        # An event type this product does not handle: acknowledged, ignored.
        return {"received": True}
    try:
        subscription = await billing.fetch_subscription(subscription_id)
    except billing.ProviderError:
        # Stripe did not answer the fetch: a 503, so Stripe retries the event.
        raise _unavailable("billing")
    await billing.sync_subscription(db, subscription, event_id=event.id)
    await db.commit()
    log.info("billing: handled %s %s", event.type, event.id)
    return {"received": True}
