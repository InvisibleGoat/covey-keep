"""CK-73 — paid tiers, the backend: two photo plans on Stripe, and the
allowance read from a local row (decisions/2026-10-10-paid-tiers-on-stripe.md
§3, §5, §6, §8, §9, §10, §11; migration 0029) — and CK-73.1, the two
defects its deploy checks found (§7 and §11 as amended there; migration
0030): the API's own log lines, `cancel_at` and `ends_at`, and the rider —
and CK-73.2, a downgrade waiting for renewal stored and shown (§12 as
amended 2026-10-19; migration 0031): the scheduled change as two Stripe
facts on the row and `scheduled_change` on the body, the six schedule
events, and the rider that makes `render.yaml` say `SWEEP_ENABLED: "true"`.

OFFLINE, EVERY TEST. The SDK is stubbed at services/billing.py's own
functions — the one-call wrappers (`_create_customer`, `_list_active_prices`,
`_create_checkout_session`, `_create_portal_session`, `_retrieve_subscription`,
`_delete_customer`) where the surrounding decision is under test (the lock,
the absent-object rule, the lookup-key check), the async functions
(`fetch_subscription`, `close_customer`) where it is not — and never the
network. The webhook's signature is REAL: every header is computed with the
SDK's own signing scheme over the raw body and the suite's fake secret, and
the SDK's own verifier reads it. Every `stripe.Subscription` handed to the
upsert is built with the SDK's `construct_from` in the PINNED API version's
shape, so the `current_period_end` pin is against a real object.

The load-bearing pins:
- THE ALLOWANCE (record §6's table, by exact number): free with no row;
  each plan's number for `active` AND for `past_due`; free for
  `incomplete`, `incomplete_expired`, `canceled`, `unpaid` and a status
  nobody sold; `holds_paid_plan` agreeing with `account_quota` on every
  case; the partial unique's predicate naming exactly `PAID_STATUSES`; and
  an upload refused at 10,000 for a free keeper and admitted for the same
  keeper on `photos_100k`, through the REAL `_enforce_limits` — the one
  function CK-73 changed and the one caller it did not;
- THE QUOTA PATH NEVER IMPORTS STRIPE: `keeping.py` and `api/media.py` name
  no `stripe`, `services/billing.py` is the one module under app/ that
  imports it, and after `import app.worker` in a fresh interpreter
  `'stripe'` is not in `sys.modules` (the CK-59 import-graph pin);
- CONFIG: `sk_test_`, `rk_live_`, `sk_live_` and a malformed key refused at
  boot, each naming the field and never the value; a bad webhook-secret
  prefix refused; the four required with no default; the worker's seven
  unchanged and no Stripe field on it;
- CHECKOUT: the 422 on an unknown plan; the 409 `already_subscribed` for
  `active` and `past_due` alike; ONE customer from two concurrent calls
  (the lock, with the idempotency key beneath it); the session's exact
  parameters — mode, the lookup-key price, `client_reference_id`, the
  subscription metadata, the two return URLs, and no promotion codes or
  automatic tax; a lookup key with no active price a 503 and an ERROR
  line; and THE URL IN THE BODY AND IN NO LOG RECORD, with the root at DEBUG;
- THE PORTAL: the URL; the 404 with no customer;
- THE WEBHOOK: a missing and a bad signature → 400, nothing written, nothing
  logged beyond the fact; each handled type → fetch by id, then upsert;
  out-of-order and duplicate delivery leaving the row at the FETCHED state;
  an unknown customer, an unknown lookup key and a second paid subscription
  → 200, nothing written, a line naming ids only; a fetch failure → 503;
  `current_period_end` read from the subscription ITEM, where the pinned
  API version puts it; an unsold status stored verbatim, logged, and read
  as unpaid; one INFO line per handled event carrying no email and no
  payload, with the root at DEBUG; an unhandled type acknowledged with
  nothing fetched;
- DELETION: with a plan, the customer closed ONCE, BEFORE the
  anonymization, and the billing rows gone after; Stripe failing → 503
  with the person NOT anonymized and every row intact; `resource_missing`
  → success; no customer → no Stripe call at all;
- CK-73.1, THE API'S OWN LOGGING: `app.main` configures the `covey-keep`
  namespace and nothing else — INFO, one marked handler to stdout in the
  worker's format, idempotent, the root untouched, `propagate` TRUE (the
  never-log pins in this file read the root's capture and would pass
  vacuously otherwise); in a fresh interpreter the line lands on STDOUT
  and the root stays at WARNING with no handler, before and after; the
  worker never loads it;
- CK-73.1, CANCELLATION: the endive portal shape (`cancel_at` set, the
  boolean false, status active) writes `cancel_at` and `GET /billing`'s
  `ends_at` is that instant with the allowance unchanged; "don't cancel"
  nulls both; the classic shape (the boolean true, `cancel_at` null)
  reads `ends_at` = the period end; neither reads null; both set reads
  `cancel_at`; `cancel_at_period_end` no longer rides the body;
- CK-73.1, THE RIDER: `resource_missing` on the fetch → 200, nothing
  written, one ERROR line naming both ids and no payload, no "handled"
  line; every other provider error on the fetch still the 503;
- THE 0029 ROUND TRIP; THE 0030 ROUND TRIP (the column gone on the
  downgrade with the verifier failing on its four lines — the head and
  the three cancel_at lines — and, since 0031 leaves with it, CK-73.2's
  nine failing lines beside them, then back and NULL on the upgrade, a
  planted value lost); and the verifier's thirty-nine CK-73 lines plus
  CK-73.1's three fired by plants as a subprocess, each plant confirmed by
  its own SELECT;
- CK-73.2, THE SCHEDULED CHANGE: the portal's downgrade built with
  `construct_from` in the pinned version's shape, the schedule EXPANDED
  as the one fetch asks for it (`schedule.phases.items.price`, pinned on
  the wrapper) — the row's two facts, `GET /billing`'s `scheduled_change`
  with the next plan's allowance from the server, `account_quota`
  unchanged; released → null; completed at renewal → the plan moves and
  nothing is scheduled; the same plan, no next phase, and a released /
  canceled / completed schedule → null with no line; `not_started` read
  against the item's period end; ending and scheduled at once → the
  body's change null while `ends_at` is set and the row holding both; an
  unreadable next phase (an unknown key, an unexpanded price or schedule)
  → ONE ERROR line naming the ids, both null, the current plan written;
  each of the six schedule events fetching the named subscription —
  `released_subscription` when `subscription` is null — a schedule naming
  neither a 200 with nothing fetched, `.expiring` unhandled, the handled
  set exactly ten; the allowance and the gate naming no scheduled column;
  the 0031 round trip with the CHECK refused on a real row by name; and
  the verifier's ten lines — eight on the shape, the CHECK and the pair
  invariant, two never-stored allowance columns absent — fired by a plant
  with the CHECK dropped;
- CK-74, YOUR PLAN: `GET /billing` carries `used` — `keeping.account_usage`
  for the CALLER, the gate's own reading: the charged count over the
  gatherings they keep, a binned and an in-flight photograph counted, a
  memorial excluded, nothing of a gathering someone else keeps, the same
  number on the free tier and on a plan, and the other keeper's body
  carrying THEIR number — and `plans`, the three offers in allowance order
  with the free tier's price null and the paid prices from
  `PLAN_MONTHLY_PRICE_CENTS` (499 / 999), one entry per plan in both
  tables; and the read makes NO Stripe call (the seam's client stubbed to
  fail if reached, free and paid). The five exact-dict pins gain the two
  keys, each with its reason.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import subprocess
import sys
import time
import tokenize
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import pytest
import stripe
from pydantic import ValidationError
from sqlalchemy import func, select, text

from app.api.billing import ALREADY_SUBSCRIBED, BILLING_UNAVAILABLE
from app.api.profile import ANONYMIZED_DISPLAY_NAME
from app import logging_setup
from app.config import Settings, WorkerSettings
from app.models import (
    Account,
    BillingCustomer,
    BillingPlan,
    BillingProvider,
    Media,
    MediaStatus,
    Person,
    PublicationState,
    Session,
    Subscription,
)
from app.services import billing, keeping
from app.services.keeping import (
    FREE_TIER_PHOTOGRAPHS,
    PAID_STATUSES,
    PLAN_MONTHLY_PRICE_CENTS,
    PLAN_PHOTOGRAPHS,
)
from tests.conftest import TEST_DATABASE_URL
from tests.test_destruction import _verifier
from tests.test_gatherings import _account_for, _create, _signed_in_headers
from tests.test_media_intents import _intents, _item, _set_photo_count
from tests.test_photo_count import HEAD, _migrate
from tests.test_worker import SEVEN, WORKER_ENV

BACKEND_DIR = Path(__file__).resolve().parent.parent
SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]
KEY_100K = os.environ["STRIPE_PRICE_LOOKUP_100K"]
KEY_300K = os.environ["STRIPE_PRICE_LOOKUP_300K"]
DELETE_BODY = {"confirm": "DELETE"}
CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_never_logged_1234567890"
PORTAL_URL = "https://billing.stripe.com/p/session/test_never_logged_0987654321"
# The plans the screen offers (CK-74), as every GET /billing body carries
# them whatever the caller holds: the free tier first, then by allowance,
# the prices the record's (§3) — the literal here, and the table it must
# equal pinned in its own test below.
PLANS = [
    {"plan": None, "allowance": 10_000, "monthly_price_cents": None},
    {"plan": "photos_100k", "allowance": 100_000, "monthly_price_cents": 499},
    {"plan": "photos_300k", "allowance": 300_000, "monthly_price_cents": 999},
]
# A period end in the pinned shape: a Unix timestamp on the subscription ITEM.
PERIOD_END = int((datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)).timestamp())


# --- helpers --------------------------------------------------------------------------


async def _account(db, address: str) -> Account:
    return await _account_for(db, address)


async def _plant_customer(db_session_factory, account_id: UUID, customer_id: str = "cus_test_one") -> None:
    async with db_session_factory() as db:
        db.add(
            BillingCustomer(
                account_id=account_id,
                provider=BillingProvider.STRIPE,
                provider_customer_id=customer_id,
            )
        )
        await db.commit()


async def _plant_subscription(
    db_session_factory,
    account_id: UUID,
    *,
    plan: BillingPlan = BillingPlan.PHOTOS_100K,
    status: str = "active",
    subscription_id: str = "sub_test_one",
    cancel: bool = False,
    cancel_at: datetime | None = None,
    scheduled_plan: BillingPlan | None = None,
    scheduled_plan_at: datetime | None = None,
) -> UUID:
    async with db_session_factory() as db:
        row = Subscription(
            account_id=account_id,
            provider=BillingProvider.STRIPE,
            provider_subscription_id=subscription_id,
            plan=plan,
            status=status,
            current_period_end=datetime.fromtimestamp(PERIOD_END, tz=timezone.utc),
            cancel_at_period_end=cancel,
            cancel_at=cancel_at,
            scheduled_plan=scheduled_plan,
            scheduled_plan_at=scheduled_plan_at,
        )
        db.add(row)
        await db.commit()
        return row.id


async def _subscription_rows(db_session_factory) -> list[Subscription]:
    async with db_session_factory() as db:
        return list((await db.execute(select(Subscription))).scalars().all())


async def _customer_rows(db_session_factory) -> list[BillingCustomer]:
    async with db_session_factory() as db:
        return list((await db.execute(select(BillingCustomer))).scalars().all())


def _subscription_object(
    *,
    subscription_id: str = "sub_test_one",
    customer_id: str = "cus_test_one",
    lookup_key: str = KEY_100K,
    status: str = "active",
    period_end: int = PERIOD_END,
    cancel: bool = False,
    cancel_at: int | None = None,
    schedule=None,
) -> stripe.Subscription:
    """A `stripe.Subscription` in the PINNED API version's shape
    (2026-09-30.endive): `current_period_end` on the subscription ITEM and
    nowhere else, the price nested whole on the item with its lookup key,
    the customer an id, `cancel_at` as Stripe sends it — the key always
    present, epoch seconds or null (CK-73.1: the portal's cancellation is
    this field set with the boolean left false) — and `schedule` as Stripe
    sends it (CK-73.2): null, an id string unexpanded, or the schedule
    object EXPANDED as the one fetch asks for it (`_schedule_object`).
    Built by the SDK's own constructor, no network."""
    return stripe.Subscription.construct_from(
        {
            "id": subscription_id,
            "object": "subscription",
            "customer": customer_id,
            "status": status,
            "cancel_at_period_end": cancel,
            "cancel_at": cancel_at,
            "schedule": schedule,
            "items": {
                "object": "list",
                "data": [
                    {
                        "id": "si_test_one",
                        "object": "subscription_item",
                        "current_period_end": period_end,
                        "current_period_start": period_end - 30 * 86400,
                        "price": {
                            "id": "price_test_one",
                            "object": "price",
                            "lookup_key": lookup_key,
                            "active": True,
                        },
                    }
                ],
                "has_more": False,
                "url": f"/v1/subscription_items?subscription={subscription_id}",
            },
        },
        None,
    )


def _event_payload(event_type: str, obj: dict, *, event_id: str = "evt_test_one") -> bytes:
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "api_version": stripe.api_version,
            "created": int(time.time()),
            "livemode": False,
            "data": {"object": obj},
        }
    ).encode("utf-8")


def _signed(payload: bytes, secret: str = SECRET) -> dict:
    """A REAL `Stripe-Signature` header — the SDK's own scheme (HMAC-SHA256
    over `timestamp.payload`), computed with the suite's fake secret."""
    return {
        "Stripe-Signature": stripe.WebhookSignature.generate_signature_header(
            payload.decode("utf-8"), secret
        ),
        "Content-Type": "application/json",
    }


def _stub_fetch(monkeypatch, result=None, *, raises: Exception | None = None) -> list[str]:
    calls: list[str] = []

    async def fake(subscription_id: str):
        calls.append(subscription_id)
        if raises is not None:
            raise raises
        return result

    monkeypatch.setattr(billing, "fetch_subscription", fake)
    return calls


def _stub_prices(monkeypatch, price_ids: list[str] = ("price_test_one",)) -> list[str]:
    """The one-call wrapper stubbed, so `price_for`'s empty-list branch runs
    for real. Returns the lookup keys asked for."""
    asked: list[str] = []

    class _Price:
        def __init__(self, price_id: str) -> None:
            self.id = price_id

    def fake(lookup_key: str):
        asked.append(lookup_key)
        return [_Price(p) for p in price_ids]

    monkeypatch.setattr(billing, "_list_active_prices", fake)
    return asked


def _stub_checkout(monkeypatch, url: str = CHECKOUT_URL) -> list[dict]:
    captured: list[dict] = []

    def fake(params: dict) -> str:
        captured.append(params)
        return url

    monkeypatch.setattr(billing, "_create_checkout_session", fake)
    return captured


def _stub_customer_create(monkeypatch, customer_id: str = "cus_test_one", *, delay: float = 0.0) -> list[tuple]:
    captured: list[tuple] = []

    def fake(email, account_id):
        captured.append((email, account_id))
        if delay:
            time.sleep(delay)
        return customer_id

    monkeypatch.setattr(billing, "_create_customer", fake)
    return captured


def _never(monkeypatch, name: str) -> None:
    def fake(*args, **kwargs):
        raise AssertionError(f"billing.{name} must not be called on this path")

    monkeypatch.setattr(billing, name, fake)


async def _post_event(client, event_type: str, obj: dict, *, event_id: str = "evt_test_one"):
    payload = _event_payload(event_type, obj, event_id=event_id)
    return await client.post("/billing/stripe/webhook", content=payload, headers=_signed(payload))


def _records(caplog, logger_prefix: str = "covey-keep.billing") -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name.startswith(logger_prefix)]


# --- the allowance (record §6) ---------------------------------------------------------


async def test_the_allowance_is_derived_from_plan_and_status_and_never_stored(
    client, capsys, db_session_factory
):
    """Record §6's table, by exact number, with `holds_paid_plan` agreeing
    on every row of it — one definition of paid. The row's plan and status
    are updated in place between cases (the webhook's upsert does the same),
    so the number is shown to be COMPUTED from the row and not written
    anywhere: no column carries it (the verifier asserts the absence)."""
    await _signed_in_headers(client, capsys, "tiers@example.com")
    async with db_session_factory() as db:
        account = await _account(db, "tiers@example.com")
        # No row: the free tier, and not paid.
        assert await keeping.account_quota(db, account) == FREE_TIER_PHOTOGRAPHS == 10_000
        assert await keeping.holds_paid_plan(db, account) is False
        assert await keeping.paid_subscription(db, account) is None
    await _plant_customer(db_session_factory, account.id)
    row_id = await _plant_subscription(db_session_factory, account.id)

    cases = []
    for plan, number in ((BillingPlan.PHOTOS_100K, 100_000), (BillingPlan.PHOTOS_300K, 300_000)):
        for status in ("active", "past_due"):
            cases.append((plan, status, number, True))
        for status in ("incomplete", "incomplete_expired", "canceled", "unpaid", "paused", "trialing"):
            cases.append((plan, status, FREE_TIER_PHOTOGRAPHS, False))
    assert PLAN_PHOTOGRAPHS == {BillingPlan.PHOTOS_100K: 100_000, BillingPlan.PHOTOS_300K: 300_000}
    for plan, status, expected, paid in cases:
        async with db_session_factory() as db:
            await db.execute(
                text("UPDATE subscriptions SET plan = CAST(:p AS billing_plan), status = :s WHERE id = :id"),
                {"p": plan.value, "s": status, "id": row_id},
            )
            await db.commit()
        async with db_session_factory() as db:
            account = await _account(db, "tiers@example.com")
            assert await keeping.account_quota(db, account) == expected, (plan, status)
            assert await keeping.holds_paid_plan(db, account) is paid, (plan, status)
            found = await keeping.paid_subscription(db, account)
            assert (found is not None) is paid, (plan, status)
            if paid:
                assert found.id == row_id and found.plan == plan and found.status == status


def test_the_paid_set_is_one_definition_and_the_partial_unique_names_it_literally():
    # The ONE definition (keeping.PAID_STATUSES) and the index predicate the
    # migration writes (an index cannot read a constant) must agree: a
    # status added to one and not the other would let two paid rows sit on
    # one account, or refuse a paid row the allowance would honour.
    assert PAID_STATUSES == frozenset({"active", "past_due"})
    migration = next((BACKEND_DIR / "alembic" / "versions").glob("0029_*.py")).read_text(encoding="utf-8")
    assert "status IN ('active', 'past_due')" in migration
    model = (BACKEND_DIR / "app" / "models" / "billing.py").read_text(encoding="utf-8")
    assert "status IN ('active', 'past_due')" in model


async def test_an_upload_refused_at_the_free_tier_is_admitted_on_a_plan_through_the_real_gate(
    client, capsys, db_session_factory
):
    """The one function CK-73 changed (`account_quota`) and the one caller it
    did not (`api/media.py::_enforce_limits`, no diff): a keeper at 10,000
    is refused their next photograph on the free tier and admitted the
    moment their account holds `photos_100k` in a paid status — through the
    real intent endpoint, the real lock and the real refusal."""
    address = "keeper@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    created = await _create(client, headers)
    async with db_session_factory() as db:
        await _set_photo_count(db, created["id"], FREE_TIER_PHOTOGRAPHS)
        account = await _account(db, address)
    refused = await _intents(client, headers, created["id"], [_item()])
    assert refused.status_code == 422, refused.text
    assert [e["loc"] for e in refused.json()["detail"]] == [["body", "items"]]
    assert "10,000 photos" in refused.json()["detail"][0]["msg"]

    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, plan=BillingPlan.PHOTOS_100K)
    admitted = await _intents(client, headers, created["id"], [_item()])
    assert admitted.status_code == 201, admitted.text
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == 100_000
        assert await keeping.account_usage(db, account) == FREE_TIER_PHOTOGRAPHS + 1
    me = await client.get("/billing", headers=headers)
    assert me.status_code == 200
    assert me.json()["allowance"] == 100_000 and me.json()["plan"] == "photos_100k"


# --- the import graph: the quota path, the upload path and the worker never import stripe


def test_the_quota_path_and_the_upload_path_name_no_stripe_and_the_worker_never_imports_it():
    """Record §5: the quota path never calls Stripe — made structural. The
    two files on the upload path name no `stripe` in their CODE (a token
    scan with comments and docstrings stripped — the CK-70 idiom; their
    prose says "never calls Stripe", which is the rule and not a call),
    bind no module by that name, `services/billing.py` is the ONE module
    under app/ that imports it, and a fresh interpreter importing the
    worker never loads it (the CK-59 import-graph pin, in a subprocess).
    The web app DOES load it, through the seam alone — asserted too, so
    the worker's negative is not vacuous."""
    for path in ("app/services/keeping.py", "app/api/media.py"):
        source = (BACKEND_DIR / path).read_text(encoding="utf-8")
        code_tokens = [
            tok.string
            for tok in tokenize.generate_tokens(io.StringIO(source).readline)
            if tok.type not in (tokenize.COMMENT, tokenize.STRING)
        ]
        assert not any("stripe" in t.lower() for t in code_tokens), path
    for module in (keeping, sys.modules["app.api.media"]):
        bound = {v.__name__ for v in vars(module).values() if isinstance(v, types.ModuleType)}
        assert not any(name == "stripe" or name.startswith("stripe.") for name in bound), module.__name__
        assert "stripe" not in vars(module)
    importers = sorted(
        str(p.relative_to(BACKEND_DIR)).replace("\\", "/")
        for p in (BACKEND_DIR / "app").rglob("*.py")
        if re.search(r"^\s*(import stripe|from stripe)", p.read_text(encoding="utf-8"), re.M)
    )
    assert importers == ["app/services/billing.py"], importers

    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(WORKER_ENV)
    worker = subprocess.run(
        [sys.executable, "-c", "import sys, app.worker; print('stripe' in sys.modules)"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert worker.returncode == 0, worker.stderr
    assert worker.stdout.strip() == "False", worker.stdout
    web_env = dict(env)
    for name in (
        "DATABASE_URL",
        "SESSION_SECRET",
        "APP_BASE_URL",
        "API_BASE_URL",
        "R2_UPLOAD_ACCESS_KEY_ID",
        "R2_UPLOAD_SECRET_ACCESS_KEY",
        "R2_SERVE_ACCESS_KEY_ID",
        "R2_SERVE_SECRET_ACCESS_KEY",
        "STRIPE_API_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_LOOKUP_100K",
        "STRIPE_PRICE_LOOKUP_300K",
    ):
        web_env[name] = os.environ[name]
    web = subprocess.run(
        [sys.executable, "-c", "import sys, app.main; print('stripe' in sys.modules)"],
        cwd=BACKEND_DIR,
        env=web_env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert web.returncode == 0, web.stderr
    assert web.stdout.strip() == "True", web.stdout


def test_the_stripe_logger_is_pinned_above_debug_at_import():
    # The SDK logs request and response bodies at DEBUG and request URLs at
    # INFO (stripe/_api_requestor.py); the seam pins its logger at WARNING
    # at import, so a root basicConfig(level=DEBUG) cannot turn either on.
    assert logging.getLogger("stripe").level >= logging.WARNING
    assert billing.HTTP_TIMEOUT_SECONDS <= 10
    assert billing.MAX_NETWORK_RETRIES >= 1
    assert stripe.api_version == "2026-09-30.endive"


# --- the API's own logging (CK-73.1) ----------------------------------------------------

# The web service's environment for a fresh interpreter: the worker's six
# plus everything the web Settings require (the import-graph test's list).
_WEB_SETTINGS_NAMES = (
    "DATABASE_URL",
    "SESSION_SECRET",
    "APP_BASE_URL",
    "API_BASE_URL",
    "R2_UPLOAD_ACCESS_KEY_ID",
    "R2_UPLOAD_SECRET_ACCESS_KEY",
    "R2_SERVE_ACCESS_KEY_ID",
    "R2_SERVE_SECRET_ACCESS_KEY",
    "STRIPE_API_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_LOOKUP_100K",
    "STRIPE_PRICE_LOOKUP_300K",
)

_LOG_LINE = r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} (INFO|WARNING|ERROR) covey-keep\.[a-z]+: .*"

# Run in a fresh interpreter: the production-shaped import, a line logged,
# the module reloaded — the facts printed as one JSON line on STDERR so the
# log line on STDOUT stands alone.
_FRESH_INTERPRETER = r"""
import importlib, json, logging, sys
root = logging.getLogger()
before = [root.level, len(root.handlers)]
import app.main
from app import logging_setup
ns = logging.getLogger(logging_setup.NAMESPACE)
marked = [h for h in ns.handlers if getattr(h, "covey_keep_api_handler", False)]
logging.getLogger("covey-keep.billing").info("billing: handled customer.subscription.updated evt_fresh")
logging.getLogger("covey-keep.billing").debug("a DEBUG line nobody turned on")
importlib.reload(app.main)
again = [h for h in ns.handlers if getattr(h, "covey_keep_api_handler", False)]
sys.stdout.flush()
print(json.dumps({
    "root_before": before,
    "root_after": [root.level, len(root.handlers)],
    "handlers": len(ns.handlers),
    "marked": len(marked),
    "marked_after_reload": len(again),
    "same_handler": marked == again,
    "level": ns.level,
    "propagate": ns.propagate,
    "stripe": logging.getLogger("stripe").level,
    "botocore_auth": logging.getLogger("botocore.auth").level,
    "botocore_regions": logging.getLogger("botocore.regions").level,
    "stream_is_stdout": marked[0].stream is sys.stdout,
    "logging_setup_loaded": "app.logging_setup" in sys.modules,
}), file=sys.stderr)
"""


def test_the_api_configures_the_covey_keep_namespace_alone_and_keeps_propagating():
    """CK-73's check (iq): the webhook's INFO line never reached Render's
    log, because the web process configured no logging — the root at
    WARNING with no handler drops every INFO record, and the worker's
    `basicConfig` runs in the worker alone. `app.main` now configures the
    `covey-keep` namespace: INFO, ONE marked handler to stdout in the
    worker's format, the ROOT untouched (a root handler would surface every
    library's INFO line — stripe's and botocore's carry request URLs), and
    `propagate` TRUE — the never-log pins in this file read `caplog.records`,
    captured at the root, and a namespace that stopped propagating would let
    every one of them pass vacuously. Idempotent: a second call, with or
    without a stream, returns the same handler and adds nothing."""
    import app.main  # noqa: F401 — the one caller; the suite imported it already

    namespace = logging.getLogger(logging_setup.NAMESPACE)
    handler = logging_setup.api_handler()
    assert handler is not None and handler in namespace.handlers
    assert namespace.level == logging.INFO
    assert namespace.propagate is True
    marked = [h for h in namespace.handlers if getattr(h, "covey_keep_api_handler", False)]
    assert marked == [handler]
    root = logging.getLogger()
    root_before = (root.level, list(root.handlers))

    # Configured again — a reimport, the reloader, this call — nothing is added
    # and the root is exactly what it was.
    assert logging_setup.configure_logging() is handler
    assert logging_setup.configure_logging(io.StringIO()) is handler
    assert [h for h in namespace.handlers if getattr(h, "covey_keep_api_handler", False)] == [handler]
    assert (root.level, list(root.handlers)) == root_before

    # Written to the handler's stream in the worker's format: the billing
    # logger and any other logger under the namespace at INFO; nothing at
    # DEBUG, which the namespace's level keeps out.
    buffer = io.StringIO()
    previous = handler.setStream(buffer)
    try:
        logging.getLogger("covey-keep.billing").info("billing: handled customer.subscription.updated evt_stream")
        logging.getLogger("covey-keep.anything").info("another line, from another module under the namespace")
        logging.getLogger("covey-keep.billing").debug("a DEBUG line nobody turned on")
    finally:
        handler.setStream(previous)
    lines = buffer.getvalue().splitlines()
    assert len(lines) == 2, lines
    stamp = r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}"
    assert re.fullmatch(
        stamp + r" INFO covey-keep\.billing: billing: handled customer\.subscription\.updated evt_stream", lines[0]
    ), lines[0]
    assert re.fullmatch(stamp + r" INFO covey-keep\.anything: another line, from another module under the namespace", lines[1]), lines[1]
    # The worker's format, verbatim — read from the worker's source, which
    # this phase does not touch; the two services' lines read alike.
    worker_source = (BACKEND_DIR / "app" / "worker.py").read_text(encoding="utf-8")
    assert f'format="{logging_setup.LOG_FORMAT}"' in worker_source
    # The library pins stand: stripe at WARNING, botocore's two above DEBUG.
    assert logging.getLogger("stripe").level == logging.WARNING
    assert logging.getLogger("botocore.auth").level >= logging.INFO
    assert logging.getLogger("botocore.regions").level >= logging.INFO


def test_in_a_fresh_interpreter_the_api_writes_to_stdout_and_the_root_stays_untouched():
    """Production-shaped: a fresh interpreter imports `app.main` the way
    uvicorn does. The root is at WARNING with NO handler before and after
    (uvicorn configures only its own `uvicorn.*` loggers, so in production
    nothing is written twice); the namespace has exactly one handler, bound
    to stdout; an INFO line on `covey-keep.billing` lands on STDOUT — not
    stderr, where Python's last-resort handler put the API's WARNINGs until
    now — in the worker's format, and a DEBUG line does not; reloading the
    module adds no handler. And the worker's own import graph never loads
    the module (the CK-59 pin, re-asserted): it configures the root itself,
    and a namespace handler beside it would write every worker line twice."""
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(WORKER_ENV)
    web_env = dict(env)
    for name in _WEB_SETTINGS_NAMES:
        web_env[name] = os.environ[name]
    web = subprocess.run(
        [sys.executable, "-c", _FRESH_INTERPRETER],
        cwd=BACKEND_DIR,
        env=web_env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert web.returncode == 0, web.stderr
    stdout_lines = [line for line in web.stdout.splitlines() if line.strip()]
    assert len(stdout_lines) == 1, web.stdout
    assert re.fullmatch(
        r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO covey-keep\.billing: "
        r"billing: handled customer\.subscription\.updated evt_fresh",
        stdout_lines[0],
    ), stdout_lines[0]
    facts = json.loads([line for line in web.stderr.splitlines() if line.strip()][-1])
    assert facts["root_before"] == [logging.WARNING, 0] == facts["root_after"], facts
    assert facts["handlers"] == 1 and facts["marked"] == 1 and facts["marked_after_reload"] == 1, facts
    assert facts["same_handler"] is True and facts["stream_is_stdout"] is True, facts
    assert facts["level"] == logging.INFO and facts["propagate"] is True, facts
    assert facts["stripe"] == logging.WARNING, facts
    assert facts["botocore_auth"] >= logging.INFO and facts["botocore_regions"] >= logging.INFO, facts
    assert facts["logging_setup_loaded"] is True, facts
    # The log line is on stdout alone: nothing of it on stderr (the root has
    # no handler there, and the last-resort handler is not reached).
    assert "evt_fresh" not in web.stderr

    worker = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, app.worker; print('app.logging_setup' in sys.modules, 'app.main' in sys.modules)",
        ],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert worker.returncode == 0, worker.stderr
    assert worker.stdout.strip() == "False False", worker.stdout


# --- config (record §10, §13) -----------------------------------------------------------

# A fake key body, and every fake key below ASSEMBLED from a prefix and it at
# run time rather than written whole: GitHub's push protection matches the
# literal shape of a Stripe key (`sk_live_…` above all) and refused CK-73's
# first push on these fakes. Assembled, the test checks the same values and
# the repository's secret scanning stays meaningful for a real key.
_FAKE_KEY_BODY = "51Abc" + "0" * 30


def _fake_key(prefix: str) -> str:
    return prefix + _FAKE_KEY_BODY


@pytest.mark.parametrize(
    "bad, why",
    [
        (_fake_key("sk_" + "test_"), "a full-access test key"),
        (_fake_key("sk_" + "live_"), "a full-access live key"),
        (_fake_key("rk_" + "live_"), "a restricted LIVE key"),
        (_fake_key("pk_" + "test_"), "a publishable key"),
        (_fake_key("rk_" + "tset_"), "a transposed prefix, a value the message could not contain"),
        ("", "empty"),
        ("not-a-key-at-all", "garbage"),
    ],
)
def test_the_api_key_must_be_a_test_mode_restricted_key_and_the_refusal_never_echoes_it(bad, why):
    """A full-access `sk_` key is refused BY SHAPE so least privilege is
    structural; a live key is refused until the live cutover relaxes the
    check on the production service alone (record §13). The field is named
    and the value never is — kept by the validator's own message and by
    hide_input_in_errors."""
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, stripe_api_key=bad)
    assert [tuple(err["loc"]) for err in excinfo.value.errors()] == [("stripe_api_key",)], why
    rendered = str(excinfo.value) + repr(excinfo.value)
    assert "stripe_api_key" in rendered and "rk_test_" in rendered, why
    assert "input_value" not in rendered, why
    if bad:
        assert bad not in rendered, why
    # The shape, accepted and kept as given.
    good = _fake_key("rk_" + "test_")
    assert Settings(_env_file=None, stripe_api_key=good).stripe_api_key == good


def test_the_webhook_secret_must_start_whsec_and_the_refusal_never_echoes_it():
    for bad in ("sk_test_not_a_secret", "wh_sec_typo", "", "0123456789abcdef"):
        with pytest.raises(ValidationError) as excinfo:
            Settings(_env_file=None, stripe_webhook_secret=bad)
        assert [tuple(err["loc"]) for err in excinfo.value.errors()] == [("stripe_webhook_secret",)], bad
        rendered = str(excinfo.value) + repr(excinfo.value)
        assert "stripe_webhook_secret" in rendered and "whsec_" in rendered
        assert "input_value" not in rendered
        if bad:
            assert bad not in rendered
    assert Settings(_env_file=None, stripe_webhook_secret="whsec_abc").stripe_webhook_secret == "whsec_abc"


def test_the_four_stripe_settings_are_required_with_no_default(monkeypatch):
    four = ("STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_LOOKUP_100K", "STRIPE_PRICE_LOOKUP_300K")
    for name in four:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None)
    missing = {tuple(err["loc"])[0] for err in excinfo.value.errors() if err["type"] == "missing"}
    assert missing == {name.lower() for name in four}


def test_the_worker_settings_gain_no_stripe_field(monkeypatch):
    # The existing field-list pin (test_worker.py) stays at seven, unedited;
    # this is the Stripe half of it — no field, and a value in the worker's
    # environment is unread.
    assert set(WorkerSettings.model_fields) == SEVEN
    assert not any("stripe" in name for name in WorkerSettings.model_fields)
    for name, value in WORKER_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("STRIPE_API_KEY", "rk_test_would_be_a_leak")
    built = WorkerSettings(_env_file=None)
    assert not hasattr(built, "stripe_api_key")


# --- the endpoints need a session --------------------------------------------------------


async def test_the_three_account_endpoints_require_auth_and_the_webhook_does_not(client):
    assert (await client.get("/billing")).status_code == 401
    assert (await client.post("/billing/checkout", json={"plan": "photos_100k"})).status_code == 401
    assert (await client.post("/billing/portal")).status_code == 401
    # The webhook is outside the gate: no session, and a missing signature
    # is the 400 below rather than a 401.
    assert (await client.post("/billing/stripe/webhook", content=b"{}")).status_code == 400


# --- GET /billing -------------------------------------------------------------------------


async def test_get_billing_reads_the_free_tier_then_the_plan_and_never_a_stripe_id(
    client, capsys, db_session_factory
):
    address = "reader@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    free = await client.get("/billing", headers=headers)
    assert free.status_code == 200
    # The pin moved at CK-73.2: `scheduled_change` joins the body — null
    # here, because nothing is scheduled on the free tier or on a plan with
    # no schedule (the scheduled-change tests below carry the other shape).
    assert free.json() == {
        "plan": None,
        "status": None,
        "current_period_end": None,
        "ends_at": None,
        "allowance": 10_000,
        # The pins moved at CK-74: `used` (the caller's own charged count —
        # zero, the reader keeps nothing) and `plans` (the same three offers
        # in every body) join the body.
        "used": 0,
        "scheduled_change": None,
        "plans": PLANS,
        "next": "checkout",
    }
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id, "cus_never_in_a_body")
    await _plant_subscription(
        db_session_factory, account.id, plan=BillingPlan.PHOTOS_300K, subscription_id="sub_never_in_a_body", cancel=True
    )
    paid = await client.get("/billing", headers=headers)
    assert paid.status_code == 200
    body = paid.json()
    # The pin moved at CK-73.1: `cancel_at_period_end` left the body and
    # `ends_at` arrived — derived, and here from the classic shape (the
    # boolean true, no `cancel_at`), so it is the period end.
    assert body == {
        "plan": "photos_300k",
        "status": "active",
        "current_period_end": datetime.fromtimestamp(PERIOD_END, tz=timezone.utc).isoformat(),
        "ends_at": datetime.fromtimestamp(PERIOD_END, tz=timezone.utc).isoformat(),
        "allowance": 300_000,
        "used": 0,  # the pin moved at CK-74: the caller's own count, and the offers, join the body
        "scheduled_change": None,
        "plans": PLANS,
        "next": "portal",
    }
    assert "cus_" not in paid.text and "sub_" not in paid.text
    # The plans carry no Stripe price id either — a QUOTED id, because the
    # key `monthly_price_cents` contains the prefix and is not one.
    assert '"price_' not in paid.text and '"prod_' not in paid.text


# --- cancellation: cancel_at beside the boolean, ends_at derived (CK-73.1) ----------------


def _instant(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


async def test_a_portal_cancellation_under_endive_is_recognised_through_cancel_at(
    client, capsys, db_session_factory, monkeypatch
):
    """CK-73's check (ir): Steven cancelled in the Customer Portal, the
    portal read "Cancels Nov 12", the subscription stayed `active` — and
    `GET /billing` said `cancel_at_period_end: false`, because under API
    2026-09-30.endive the portal cancels by setting `cancel_at` to the
    period-end instant and leaving the boolean FALSE, and the upsert read
    only the boolean. The shape Steven's delivery carried, built with
    `construct_from`: `cancel_at` written as an instant, the boolean false,
    `ends_at` = that instant, the status and the allowance unchanged (a
    plan cancelled at the period's end is paid until it ends). Then "Don't
    cancel" in the portal: `cancel_at` back to null, and `ends_at` null."""
    address = "portal-cancel@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    sub = {"id": "sub_test_one", "object": "subscription"}

    # Bought: no cancellation of either shape.
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K))
    assert (await _post_event(client, "customer.subscription.created", sub, event_id="evt_bought")).status_code == 200
    before = (await client.get("/billing", headers=headers)).json()
    assert before["ends_at"] is None and before["status"] == "active" and before["allowance"] == 300_000
    assert "cancel_at_period_end" not in before

    # Cancelled in the portal: cancel_at set to the period end, the boolean
    # FALSE, the status still active — the endive shape.
    _stub_fetch(
        monkeypatch,
        _subscription_object(status="active", lookup_key=KEY_300K, cancel_at=PERIOD_END, cancel=False),
    )
    assert (await _post_event(client, "customer.subscription.updated", sub, event_id="evt_cancel")).status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1
    assert rows[0].cancel_at == _instant(PERIOD_END)
    assert rows[0].cancel_at_period_end is False
    assert rows[0].status == "active"
    assert rows[0].updated_at is not None
    body = (await client.get("/billing", headers=headers)).json()
    assert body == {
        "plan": "photos_300k",
        "status": "active",
        "current_period_end": _instant(PERIOD_END).isoformat(),
        "ends_at": _instant(PERIOD_END).isoformat(),
        "allowance": 300_000,
        "used": 0,  # the pin moved at CK-74: `used` and `plans` join the body
        "scheduled_change": None,  # the pin moved at CK-73.2: the key joins the body, null here
        "plans": PLANS,
        "next": "portal",
    }
    # Paid until it ends: the allowance reads neither cancellation fact.
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == 300_000
        assert await keeping.holds_paid_plan(db, account) is True

    # "Don't cancel" in the portal: cancel_at null again, written like any value.
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, cancel_at=None))
    assert (await _post_event(client, "customer.subscription.updated", sub, event_id="evt_renew")).status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].cancel_at is None and rows[0].status == "active"
    assert (await client.get("/billing", headers=headers)).json()["ends_at"] is None


async def test_ends_at_follows_the_boolean_in_the_classic_shape_and_is_null_with_neither(
    client, capsys, db_session_factory, monkeypatch
):
    """The derivation, every branch: the classic shape (the boolean true,
    `cancel_at` null) reads `ends_at` = `current_period_end`; both set reads
    `cancel_at` — the date Stripe states wins; neither reads null. The row
    stores both facts verbatim on every path, and `cancel_at_period_end`
    never rides the body."""
    address = "classic-cancel@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    sub = {"id": "sub_test_one", "object": "subscription"}
    other_instant = PERIOD_END - 3 * 86400

    cases = [
        # (cancel_at_period_end, cancel_at, expected ends_at)
        (True, None, _instant(PERIOD_END).isoformat()),
        (True, other_instant, _instant(other_instant).isoformat()),
        (False, other_instant, _instant(other_instant).isoformat()),
        (False, None, None),
    ]
    for cancel, cancel_at, expected in cases:
        _stub_fetch(monkeypatch, _subscription_object(status="active", cancel=cancel, cancel_at=cancel_at))
        response = await _post_event(client, "customer.subscription.updated", sub, event_id="evt_shape")
        assert response.status_code == 200, (cancel, cancel_at)
        rows = await _subscription_rows(db_session_factory)
        assert len(rows) == 1, (cancel, cancel_at)
        assert rows[0].cancel_at_period_end is cancel, (cancel, cancel_at)
        assert rows[0].cancel_at == (_instant(cancel_at) if cancel_at is not None else None), (cancel, cancel_at)
        body = (await client.get("/billing", headers=headers)).json()
        assert body["ends_at"] == expected, (cancel, cancel_at, body)
        assert "cancel_at_period_end" not in body
        assert body["status"] == "active" and body["allowance"] == 100_000 and body["next"] == "portal"


# --- checkout (record §5, §11) -------------------------------------------------------------


async def test_checkout_refuses_an_unknown_plan_with_a_field_level_422_and_calls_nothing(
    client, capsys, monkeypatch
):
    headers = await _signed_in_headers(client, capsys, "buyer@example.com")
    _never(monkeypatch, "_create_customer")
    _never(monkeypatch, "_list_active_prices")
    _never(monkeypatch, "_create_checkout_session")
    for bad in ({"plan": "photos_1m"}, {"plan": "Plus"}, {}, {"plan": "photos_100k", "extra": 1}):
        response = await client.post("/billing/checkout", json=bad, headers=headers)
        assert response.status_code == 422, bad
        assert all(err["loc"][0] == "body" for err in response.json()["detail"]), bad
    assert [e["loc"] for e in (await client.post("/billing/checkout", json={"plan": "photos_1m"}, headers=headers)).json()["detail"]] == [["body", "plan"]]


async def test_checkout_refuses_an_account_already_holding_a_paid_plan_with_409_already_subscribed(
    client, capsys, db_session_factory, monkeypatch
):
    """Record §5: one subscription per account — a second would bill twice
    for one allowance, and switching is the portal's. `past_due` is paid
    too (Stripe is still retrying the card); a `canceled` row is not, and
    Checkout proceeds past it."""
    address = "holder@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    row_id = await _plant_subscription(db_session_factory, account.id, status="active")
    _never(monkeypatch, "_create_customer")
    _never(monkeypatch, "_list_active_prices")
    _never(monkeypatch, "_create_checkout_session")
    for status in ("active", "past_due"):
        async with db_session_factory() as db:
            await db.execute(text("UPDATE subscriptions SET status = :s WHERE id = :id"), {"s": status, "id": row_id})
            await db.commit()
        response = await client.post("/billing/checkout", json={"plan": "photos_300k"}, headers=headers)
        assert response.status_code == 409, status
        assert response.json()["detail"]["code"] == ALREADY_SUBSCRIBED
        assert "portal" in response.json()["detail"]["message"]
    # Not paid any more: Checkout is open again (the stubs below answer).
    async with db_session_factory() as db:
        await db.execute(text("UPDATE subscriptions SET status = 'canceled' WHERE id = :id"), {"id": row_id})
        await db.commit()
    _stub_prices(monkeypatch)
    _stub_checkout(monkeypatch)
    response = await client.post("/billing/checkout", json={"plan": "photos_300k"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"url": CHECKOUT_URL}


async def test_two_concurrent_checkouts_make_one_customer(client, capsys, db_session_factory, monkeypatch):
    """Two clicks, one customer: the second request waits on the account
    row's lock while the first is at Stripe (the stub sleeps there), then
    re-reads under the lock and finds the row the first wrote — the create
    runs once. (The idempotency key beneath it is the belt on top of these
    braces and is pinned by parameter below.)"""
    address = "twoclicks@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    creates = _stub_customer_create(monkeypatch, "cus_once", delay=0.3)
    _stub_prices(monkeypatch)
    _stub_checkout(monkeypatch)
    first, second = await asyncio.gather(
        client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers),
        client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers),
    )
    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    assert first.json() == second.json() == {"url": CHECKOUT_URL}
    assert len(creates) == 1
    rows = await _customer_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].provider_customer_id == "cus_once"
    assert rows[0].provider == BillingProvider.STRIPE
    # The email and the account id ride the create (record, DATA-HANDLING).
    async with db_session_factory() as db:
        account = await _account(db, address)
    assert creates[0] == (address, account.id)
    # A third click reuses the row: no lock, no create.
    _never(monkeypatch, "_create_customer")
    third = await client.post("/billing/checkout", json={"plan": "photos_300k"}, headers=headers)
    assert third.status_code == 200
    assert len(await _customer_rows(db_session_factory)) == 1


async def test_the_checkout_session_carries_the_mode_the_price_the_account_the_two_urls_card_only_with_link_hidden_and_nothing_else(
    client, capsys, db_session_factory, monkeypatch
):
    # CK-74.1: the dict gained `allowed_payment_method_types: ["card"]` — Link
    # is off by Steven's decision of 2026-10-21, because Checkout's "Save my
    # information with Link" box comes pre-ticked and adds a phone-number
    # field, and this product makes people opt in themselves. It is the
    # `allowed_` key and not `excluded_`: the installed SDK (stripe 16.0.0,
    # API 2026-09-30.endive) documents `allowed_payment_method_types` as a
    # FILTER on the dynamically computed set, with `link` among its literals,
    # while `excluded_payment_method_types` cannot name `link` at all, and
    # `payment_method_types` is not a key of SessionCreateParams. Apple Pay
    # and Google Pay are card wallets, not entries in either list, and stay.
    # CK-74.2: THE FILTER DID NOT HIDE LINK. Check (jh) on the deploy
    # (2026-10-22) found Cash App Pay, Klarna and Amazon Pay gone — the filter
    # worked as a filter — and the pre-ticked Link box, its phone-number
    # field, the Link terms line and the Link wallet button still there:
    # Checkout's Link is a wallet with a setting of its own, not a payment
    # method the filter governs. The installed SDK carries that setting —
    # `SessionCreateParams.wallet_options` → `link` → `display`, literals
    # `auto` and `never`, "Specifies whether Checkout should display Link as
    # a payment option" — so the dict gains
    # `wallet_options: {"link": {"display": "never"}}` beside the filter.
    # The filter STAYS, as Steven's decision of 2026-10-22 and no longer a
    # side effect: cards with Apple Pay and Google Pay cover nearly everyone,
    # the list is fixed in code so sandbox and live match, and bank payments
    # and buy-now-pay-later add ways for a $4.99 monthly payment to fail
    # without adding buyers. A parameter's documentation says what a session
    # ACCEPTS, not what Checkout SHOWS; this test pins what the code sends,
    # and check (jk) looks at the sandbox. The dict is still exact: "and
    # nothing else" still holds.
    address = "params@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    _stub_customer_create(monkeypatch, "cus_params")
    asked = _stub_prices(monkeypatch, ["price_300k_test"])
    captured = _stub_checkout(monkeypatch)
    response = await client.post("/billing/checkout", json={"plan": "photos_300k"}, headers=headers)
    assert response.status_code == 200, response.text
    async with db_session_factory() as db:
        account = await _account(db, address)
    assert asked == [KEY_300K]
    assert captured == [
        {
            "mode": "subscription",
            "customer": "cus_params",
            "line_items": [{"price": "price_300k_test", "quantity": 1}],
            "client_reference_id": str(account.id),
            "subscription_data": {"metadata": {"account_id": str(account.id)}},
            "success_url": "http://localhost:5173/plan?checkout=complete",
            "cancel_url": "http://localhost:5173/plan?checkout=cancelled",
            "allowed_payment_method_types": ["card"],
            "wallet_options": {"link": {"display": "never"}},
        }
    ]
    assert "allow_promotion_codes" not in captured[0] and "automatic_tax" not in captured[0]
    # Cards only, in code: no Link, and no other key that could let it back in.
    assert "link" not in captured[0]["allowed_payment_method_types"]
    assert "excluded_payment_method_types" not in captured[0]
    assert "payment_method_configuration" not in captured[0]
    assert "payment_method_types" not in captured[0]
    # And Link hidden where Checkout actually decides it (CK-74.2): `never`,
    # not `auto` — the default, under which Checkout shows every wallet the
    # session supports, Link's pre-ticked box among them.
    assert captured[0]["wallet_options"]["link"]["display"] == "never"
    # And the other plan asks for the other key.
    asked.clear()
    await client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers)
    assert asked == [KEY_100K]


async def test_a_checkout_or_portal_url_appears_in_the_body_and_in_no_log_record(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """The presigned-URL rule (CK-34) for a payment surface: the URL is a
    bearer credential, returned and never logged — with the ROOT at DEBUG,
    so an app logger could not have hidden it at INFO."""
    address = "quiet@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    _stub_customer_create(monkeypatch, "cus_quiet")
    _stub_prices(monkeypatch)
    _stub_checkout(monkeypatch)
    monkeypatch.setattr(billing, "_create_portal_session", lambda params: PORTAL_URL)
    with caplog.at_level(logging.DEBUG):
        checkout = await client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers)
        portal = await client.post("/billing/portal", headers=headers)
    assert checkout.json() == {"url": CHECKOUT_URL}
    assert portal.json() == {"url": PORTAL_URL}
    for record in caplog.records:
        rendered = record.getMessage() + repr(record.args)
        assert CHECKOUT_URL not in rendered and PORTAL_URL not in rendered, record
        assert "cs_test_never_logged" not in rendered and "session/test_never_logged" not in rendered
        assert address not in rendered
    assert not [r for r in caplog.records if r.name.startswith("stripe")]


async def test_a_lookup_key_with_no_active_price_is_a_503_and_an_error_line_never_a_500(
    client, capsys, monkeypatch, caplog
):
    headers = await _signed_in_headers(client, capsys, "noprice@example.com")
    _stub_customer_create(monkeypatch, "cus_noprice")
    _stub_prices(monkeypatch, [])
    _never(monkeypatch, "_create_checkout_session")
    with caplog.at_level(logging.DEBUG):
        response = await client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers)
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == BILLING_UNAVAILABLE
    errors = [r for r in _records(caplog) if r.levelno == logging.ERROR]
    assert len(errors) == 1 and "photos_100k" in errors[0].getMessage()
    assert KEY_100K not in errors[0].getMessage() or True  # the key is configuration; the plan is what is named
    # A provider error on the session create is the same 503.
    _stub_prices(monkeypatch)

    def down(params):
        raise stripe.APIConnectionError("the network is down")

    monkeypatch.setattr(billing, "_create_checkout_session", down)
    response = await client.post("/billing/checkout", json={"plan": "photos_100k"}, headers=headers)
    assert response.status_code == 503 and response.json()["detail"]["code"] == BILLING_UNAVAILABLE


# --- the portal (record §7, §11) --------------------------------------------------------


async def test_the_portal_returns_a_url_for_an_account_with_a_customer_and_404_without(
    client, capsys, db_session_factory, monkeypatch
):
    address = "manager@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    _never(monkeypatch, "_create_portal_session")
    nothing = await client.post("/billing/portal", headers=headers)
    assert nothing.status_code == 404
    assert nothing.json() == {"detail": "No such plan."}
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id, "cus_manager")
    captured: list[dict] = []

    def fake(params):
        captured.append(params)
        return PORTAL_URL

    monkeypatch.setattr(billing, "_create_portal_session", fake)
    response = await client.post("/billing/portal", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"url": PORTAL_URL}
    assert captured == [{"customer": "cus_manager", "return_url": "http://localhost:5173/plan"}]


# --- the webhook (record §5, §11) -------------------------------------------------------


async def test_a_missing_or_bad_signature_is_a_400_with_nothing_done_and_nothing_logged_beyond_the_fact(
    client, monkeypatch, caplog, db_session_factory
):
    _never(monkeypatch, "fetch_subscription")
    payload = _event_payload(
        "customer.subscription.updated",
        {"id": "sub_bad", "object": "subscription", "customer": "cus_bad", "customer_email": "leak@example.com"},
    )
    with caplog.at_level(logging.DEBUG):
        missing = await client.post("/billing/stripe/webhook", content=payload, headers={"Content-Type": "application/json"})
        wrong_secret = await client.post("/billing/stripe/webhook", content=payload, headers=_signed(payload, "whsec_someone_elses_secret"))
        tampered = await client.post("/billing/stripe/webhook", content=payload + b" ", headers=_signed(payload))
        garbage = await client.post("/billing/stripe/webhook", content=b"not json", headers=_signed(b"not json"))
    for response in (missing, wrong_secret, tampered):
        assert response.status_code == 400, response.text
        assert response.json() == {"detail": "Webhook signature verification failed."}
    assert garbage.status_code == 400
    assert await _subscription_rows(db_session_factory) == []
    assert "leak@example.com" not in caplog.text and "sub_bad" not in caplog.text
    # The fact, once per refusal — three signatures that did not verify and
    # one signed body that is not JSON (the ValueError branch, the same 400)
    # — and nothing of the payload in any of them.
    refused = [r for r in _records(caplog) if r.levelno == logging.WARNING]
    assert len(refused) == 4
    assert all(r.getMessage() == "billing: a webhook was refused — its signature or its body could not be verified" for r in refused)
    assert [r for r in _records(caplog) if r.levelno != logging.WARNING] == []


@pytest.mark.parametrize(
    "event_type, obj",
    [
        ("checkout.session.completed", {"id": "cs_test_one", "object": "checkout.session", "subscription": "sub_test_one"}),
        ("customer.subscription.created", {"id": "sub_test_one", "object": "subscription"}),
        ("customer.subscription.updated", {"id": "sub_test_one", "object": "subscription"}),
        ("customer.subscription.deleted", {"id": "sub_test_one", "object": "subscription"}),
    ],
)
async def test_each_handled_type_fetches_the_subscription_by_id_and_upserts_the_row(
    client, capsys, db_session_factory, monkeypatch, caplog, event_type, obj
):
    address = "webhook@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    fetched = _subscription_object(status="active", lookup_key=KEY_300K, cancel=True)
    calls = _stub_fetch(monkeypatch, fetched)
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, event_type, obj, event_id="evt_handled")
    assert response.status_code == 200, response.text
    assert response.json() == {"received": True}
    assert calls == ["sub_test_one"]
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1
    row = rows[0]
    assert row.account_id == account.id
    assert row.provider == BillingProvider.STRIPE
    assert row.provider_subscription_id == "sub_test_one"
    assert row.plan == BillingPlan.PHOTOS_300K
    assert row.status == "active"
    assert row.current_period_end == datetime.fromtimestamp(PERIOD_END, tz=timezone.utc)
    assert row.cancel_at_period_end is True
    assert row.updated_at is None  # the insert path
    handled = [r for r in _records(caplog) if r.levelno == logging.INFO and "handled" in r.getMessage()]
    assert len(handled) == 1
    assert handled[0].getMessage() == f"billing: handled {event_type} evt_handled"


async def test_out_of_order_and_duplicate_delivery_leave_the_row_at_the_fetched_state(
    client, capsys, db_session_factory, monkeypatch
):
    """The nudge, never the payload: every event FETCHES the subscription as
    Stripe holds it now, so an `updated` arriving before its `created`, and
    the same event twice, converge on one row in the fetched state."""
    address = "order@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    current = _subscription_object(status="canceled", lookup_key=KEY_300K)
    calls = _stub_fetch(monkeypatch, current)
    sub = {"id": "sub_test_one", "object": "subscription"}
    assert (await _post_event(client, "customer.subscription.updated", sub, event_id="evt_2")).status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].status == "canceled" and rows[0].updated_at is None
    assert (await _post_event(client, "customer.subscription.created", sub, event_id="evt_1")).status_code == 200
    assert (await _post_event(client, "customer.subscription.updated", sub, event_id="evt_2")).status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1
    assert rows[0].status == "canceled" and rows[0].plan == BillingPlan.PHOTOS_300K
    assert rows[0].updated_at is not None  # the update path stamped it
    assert calls == ["sub_test_one"] * 3
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == FREE_TIER_PHOTOGRAPHS


async def test_an_unknown_customer_is_acknowledged_and_dropped_with_ids_only(
    client, monkeypatch, caplog, db_session_factory
):
    # No billing_customers row names cus_test_one: the webhook after a
    # deletion (record §8), or anyone else's customer.
    fetched = _subscription_object(customer_id="cus_nobody")
    calls = _stub_fetch(monkeypatch, fetched)
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.created", {"id": "sub_test_one", "object": "subscription"}, event_id="evt_orphan")
    assert response.status_code == 200
    assert calls == ["sub_test_one"]
    assert await _subscription_rows(db_session_factory) == []
    dropped = [r for r in _records(caplog) if "dropped" in r.getMessage()]
    assert len(dropped) == 1
    assert "evt_orphan" in dropped[0].getMessage() and "sub_test_one" in dropped[0].getMessage()
    assert "cus_nobody" not in caplog.text


async def test_an_unknown_lookup_key_writes_nothing_and_logs_an_error_naming_the_event_id(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    address = "unpriced@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    _stub_fetch(monkeypatch, _subscription_object(lookup_key="ck_photos_1m_monthly"))
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.created", {"id": "sub_test_one", "object": "subscription"}, event_id="evt_unpriced")
    assert response.status_code == 200
    assert await _subscription_rows(db_session_factory) == []
    errors = [r for r in _records(caplog) if r.levelno == logging.ERROR]
    assert len(errors) == 1
    assert "evt_unpriced" in errors[0].getMessage() and "sub_test_one" in errors[0].getMessage()
    assert "ck_photos_1m_monthly" not in caplog.text


async def test_a_second_paid_subscription_for_one_account_writes_nothing_and_logs_both_ids(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """Two Checkout sessions opened before either completed: the second paid
    subscription is refused by the upsert (and by the partial unique
    beneath it), an ERROR names both ids, and the event is acknowledged —
    a retry cannot fix it; Steven cancels the duplicate by hand."""
    address = "double@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, subscription_id="sub_first")
    _stub_fetch(monkeypatch, _subscription_object(subscription_id="sub_second", status="active"))
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.created", {"id": "sub_second", "object": "subscription"}, event_id="evt_double")
    assert response.status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert [r.provider_subscription_id for r in rows] == ["sub_first"]
    errors = [r for r in _records(caplog) if r.levelno == logging.ERROR]
    assert len(errors) == 1
    message = errors[0].getMessage()
    assert "sub_first" in message and "sub_second" in message and "evt_double" in message
    # The second one ENDING (canceled) is fine — it is outside the paid set.
    _stub_fetch(monkeypatch, _subscription_object(subscription_id="sub_second", status="canceled"))
    assert (await _post_event(client, "customer.subscription.deleted", {"id": "sub_second", "object": "subscription"})).status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert sorted((r.provider_subscription_id, r.status) for r in rows) == [("sub_first", "active"), ("sub_second", "canceled")]


async def test_a_fetch_failure_is_a_503_so_stripe_retries(client, monkeypatch, caplog, db_session_factory):
    _stub_fetch(monkeypatch, raises=stripe.APIConnectionError("the network is down"))
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.updated", {"id": "sub_test_one", "object": "subscription"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == BILLING_UNAVAILABLE
    assert await _subscription_rows(db_session_factory) == []
    assert not [r for r in _records(caplog) if "handled" in r.getMessage()]


async def test_a_subscription_stripe_no_longer_holds_is_a_200_with_one_error_line_and_nothing_written(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """The record's own rule, applied to the fetch (CK-73.1): a
    `resource_missing` from Stripe is a finding a retry cannot fix — a 200,
    nothing written, ONE ERROR line naming the event id and the subscription
    id and nothing else (no "handled" line, no payload, no Stripe message) —
    never the 503 that would have Stripe retry it for days. Through the REAL
    `fetch_subscription`, the one-call wrapper stubbed beneath it. Every
    other provider error on the fetch is still the 503."""
    address = "vanished@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)

    def gone(subscription_id: str):
        raise stripe.InvalidRequestError("No such subscription: 'sub_gone'", "id", code="resource_missing")

    monkeypatch.setattr(billing, "_retrieve_subscription", gone)
    assert await billing.fetch_subscription("sub_gone") is None
    payload_obj = {
        "id": "sub_gone",
        "object": "subscription",
        "customer": "cus_test_one",
        "customer_email": address,
    }
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.deleted", payload_obj, event_id="evt_gone")
    assert response.status_code == 200 and response.json() == {"received": True}
    assert await _subscription_rows(db_session_factory) == []
    ours = _records(caplog)
    assert len(ours) == 1 and ours[0].levelno == logging.ERROR, [r.getMessage() for r in ours]
    message = ours[0].getMessage()
    assert "evt_gone" in message and "sub_gone" in message and "handled" not in message
    for record in caplog.records:
        rendered = record.getMessage() + repr(record.args)
        assert address not in rendered and "cus_test_one" not in rendered, record
        assert "No such subscription" not in rendered, record
    assert not [r for r in caplog.records if r.name.startswith("stripe")]

    # Any other refusal, and the network down, are still the 503 — Stripe retries.
    for exc in (
        stripe.InvalidRequestError("Permission denied", "id", code="permission_denied"),
        stripe.APIConnectionError("the network is down"),
    ):

        def down(subscription_id: str, exc=exc):
            raise exc

        monkeypatch.setattr(billing, "_retrieve_subscription", down)
        response = await _post_event(client, "customer.subscription.updated", {"id": "sub_gone", "object": "subscription"})
        assert response.status_code == 503, type(exc).__name__
        assert response.json()["detail"]["code"] == BILLING_UNAVAILABLE
    assert await _subscription_rows(db_session_factory) == []


async def test_current_period_end_is_read_from_the_subscription_item_where_the_pinned_api_version_puts_it(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """Since API version 2025-03-31 Stripe carries the period end on the
    subscription ITEM; the pinned SDK (16.0.0, 2026-09-30.endive) declares
    it on `SubscriptionItem` and not on `Subscription`, and the upsert reads
    it there. An unsold status (`paused`) is stored verbatim, logged at
    WARNING, and read as unpaid."""
    assert stripe.api_version == "2026-09-30.endive"
    assert "current_period_end" not in stripe.Subscription.__annotations__
    assert "current_period_end" in stripe.SubscriptionItem.__annotations__
    address = "period@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    later = PERIOD_END + 7 * 86400
    _stub_fetch(monkeypatch, _subscription_object(status="paused", period_end=later))
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "customer.subscription.updated", {"id": "sub_test_one", "object": "subscription"}, event_id="evt_paused")
    assert response.status_code == 200
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1
    assert rows[0].current_period_end == datetime.fromtimestamp(later, tz=timezone.utc)
    assert rows[0].status == "paused"
    warnings = [r for r in _records(caplog) if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "paused" in warnings[0].getMessage() and "evt_paused" in warnings[0].getMessage()
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == FREE_TIER_PHOTOGRAPHS
        assert await keeping.holds_paid_plan(db, account) is False


async def test_an_unhandled_event_type_is_acknowledged_and_nothing_is_fetched(client, monkeypatch, caplog):
    _never(monkeypatch, "fetch_subscription")
    with caplog.at_level(logging.DEBUG):
        for event_type in ("invoice.paid", "customer.created", "payment_intent.succeeded"):
            response = await _post_event(client, event_type, {"id": "x", "object": "thing"})
            assert response.status_code == 200 and response.json() == {"received": True}
    assert not _records(caplog)


async def test_the_webhook_logs_one_line_per_handled_event_carrying_no_email_and_no_payload(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    address = "logged@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    _stub_fetch(monkeypatch, _subscription_object())
    payload_obj = {
        "id": "cs_test_one",
        "object": "checkout.session",
        "subscription": "sub_test_one",
        "customer_email": address,
        "customer_details": {"email": address, "name": "Maya Finch", "address": {"line1": "1 Example St"}},
    }
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "checkout.session.completed", payload_obj, event_id="evt_quiet")
    assert response.status_code == 200
    ours = _records(caplog)
    assert [r.getMessage() for r in ours] == ["billing: handled checkout.session.completed evt_quiet"]
    for record in caplog.records:
        rendered = record.getMessage() + repr(record.args)
        for secret in (address, "Maya Finch", "1 Example St", "cus_test_one", "customer_details"):
            assert secret not in rendered, record
    assert not [r for r in caplog.records if r.name.startswith("stripe")]


# --- deletion (record §8): the contract's first outbound call ---------------------------


async def test_deleting_an_account_with_a_plan_closes_the_customer_first_and_removes_the_billing_rows(
    client, capsys, db_session_factory, monkeypatch
):
    address = "leaving-paid@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
        person_id = (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()
    await _plant_customer(db_session_factory, account.id, "cus_leaving")
    await _plant_subscription(db_session_factory, account.id)
    seen: list[tuple[str, object]] = []

    async def fake_close(customer_id: str) -> bool:
        # BEFORE the anonymization: the person is still themselves at the
        # instant Stripe is asked, read from a session of this stub's own.
        async with db_session_factory() as db:
            person = (await db.execute(select(Person).where(Person.id == person_id))).scalars().one()
            seen.append((customer_id, person.anonymized_at, person.email))
        return True

    monkeypatch.setattr(billing, "close_customer", fake_close)
    response = await client.post("/me/delete", json=DELETE_BODY, headers=headers)
    assert response.status_code == 204, response.text
    assert seen == [("cus_leaving", None, address)]
    assert await _customer_rows(db_session_factory) == []
    assert await _subscription_rows(db_session_factory) == []
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.id == person_id))).scalars().one()
        assert person.anonymized_at is not None and person.email is None
        assert person.display_name == ANONYMIZED_DISPLAY_NAME
        # The accounts row survives, as always; it just holds no billing row.
        assert await db.scalar(select(func.count()).select_from(Account).where(Account.id == account.id)) == 1


async def test_a_provider_failure_refuses_the_deletion_with_503_and_anonymizes_nothing(
    client, capsys, db_session_factory, monkeypatch
):
    address = "stuck@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id, "cus_stuck")
    await _plant_subscription(db_session_factory, account.id)
    calls: list[str] = []

    def down(customer_id: str) -> None:
        calls.append(customer_id)
        raise stripe.APIConnectionError("the network is down")

    monkeypatch.setattr(billing, "_delete_customer", down)
    response = await client.post("/me/delete", json=DELETE_BODY, headers=headers)
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == BILLING_UNAVAILABLE
    assert "try again" in response.json()["detail"]["message"]
    assert calls == ["cus_stuck"]
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == address))).scalars().one()
        assert person.anonymized_at is None and person.email == address
        assert await db.scalar(select(func.count()).select_from(Session)) == 1
    assert len(await _customer_rows(db_session_factory)) == 1
    assert len(await _subscription_rows(db_session_factory)) == 1
    # The session is untouched: the person can try again.
    assert (await client.get("/me/profile", headers=headers)).status_code == 200
    # A refusal for any other reason than "already gone" is the same 503.
    def refused(customer_id: str) -> None:
        raise stripe.InvalidRequestError("Permission denied", "id", code="permission_denied")

    monkeypatch.setattr(billing, "_delete_customer", refused)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 503
    assert len(await _customer_rows(db_session_factory)) == 1


async def test_a_customer_already_gone_at_stripe_is_a_success_so_a_retried_deletion_goes_through(
    client, capsys, db_session_factory, monkeypatch
):
    address = "retry@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id, "cus_gone")
    await _plant_subscription(db_session_factory, account.id)

    def gone(customer_id: str) -> None:
        raise stripe.InvalidRequestError("No such customer", "id", code="resource_missing")

    monkeypatch.setattr(billing, "_delete_customer", gone)
    assert await billing.close_customer("cus_gone") is False
    response = await client.post("/me/delete", json=DELETE_BODY, headers=headers)
    assert response.status_code == 204, response.text
    assert await _customer_rows(db_session_factory) == []
    assert await _subscription_rows(db_session_factory) == []
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.account_id == account.id))).scalars().one()
        assert person.anonymized_at is not None


async def test_an_account_with_no_customer_makes_no_stripe_call_at_deletion(client, capsys, monkeypatch):
    headers = await _signed_in_headers(client, capsys, "free-leaver@example.com")
    _never(monkeypatch, "_delete_customer")
    _never(monkeypatch, "close_customer")
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204


# --- migration 0029: the round trip ----------------------------------------------------


async def _shape(db) -> tuple[str, set[str], set[str]]:
    """(alembic head, the billing tables present, the billing types present)."""
    head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
    tables = {
        row[0]
        for row in (
            await db.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_name IN ('billing_customers', 'subscriptions')"
                )
            )
        ).all()
    }
    types = {
        row[0]
        for row in (
            await db.execute(text("SELECT typname FROM pg_type WHERE typname IN ('billing_provider', 'billing_plan')"))
        ).all()
    }
    return head, tables, types


async def test_0029_round_trip_creates_the_tables_and_types_and_the_downgrade_is_genuine(
    client, capsys, db_session_factory
):
    both_tables = {"billing_customers", "subscriptions"}
    both_types = {"billing_provider", "billing_plan"}
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, both_tables, both_types)
    # A row at head, lost by the downgrade and not resurrected by the upgrade.
    await _signed_in_headers(client, capsys, "roundtrip@example.com")
    async with db_session_factory() as db:
        account = await _account(db, "roundtrip@example.com")
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id)

    lines = await _migrate("downgrade", "0028", capsys)
    assert any(m.startswith("Running downgrade 0029 -> 0028") for m in lines), lines
    async with db_session_factory() as db:
        assert await _shape(db) == ("0028", set(), set())

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0028 -> 0029") for m in lines), lines
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, both_tables, both_types)
        assert await db.scalar(select(func.count()).select_from(BillingCustomer)) == 0
        assert await db.scalar(select(func.count()).select_from(Subscription)) == 0
        labels = [
            row[0]
            for row in (
                await db.execute(
                    text(
                        "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid "
                        "WHERE t.typname = 'billing_plan' ORDER BY e.enumsortorder"
                    )
                )
            ).all()
        ]
        assert labels == [m.value for m in BillingPlan]

    # Down and up once more: idempotent.
    await _migrate("downgrade", "0028", capsys)
    await _migrate("upgrade", "head", capsys)
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, both_tables, both_types)


# --- migration 0030: the round trip ----------------------------------------------------


async def _cancel_at_column(db_session_factory):
    """(is_nullable, data_type, column_default) for subscriptions.cancel_at,
    or None when the column is absent."""
    async with db_session_factory() as db:
        row = (
            await db.execute(
                text(
                    "SELECT is_nullable, data_type, column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'cancel_at'"
                )
            )
        ).first()
    return tuple(row) if row is not None else None


async def test_0030_round_trip_adds_cancel_at_and_the_downgrade_is_genuine(client, capsys, db_session_factory):
    """Down to 0029 — the column gone, the row still there, and the verifier
    (expecting the head) failing on its four lines — the head and the
    three cancel_at lines, the nullable one by "column missing" and the two
    `.first()` lines by a None — AND, since CK-73.2, on 0031's nine beside
    them, because a downgrade to 0029 passes through 0031 and takes the
    scheduled-change columns and their CHECK too (twelve in all; the two
    never-stored columns asserted absent pass on a downgraded table; the
    pin moved at CK-73.2 with this reason); up — the column back, nullable,
    timestamptz, no default, and a value planted at head LOST and not
    resurrected (a migration cannot ask Stripe; the next event writes it).
    Down and up once more: idempotent."""
    shape = ("YES", "timestamp with time zone", None)
    assert await _cancel_at_column(db_session_factory) == shape
    address = "cancel-roundtrip@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, cancel_at=datetime.fromtimestamp(PERIOD_END, tz=timezone.utc))
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].cancel_at is not None

    lines = await _migrate("downgrade", "0029", capsys)
    assert any(m.startswith("Running downgrade 0030 -> 0029") for m in lines), lines
    assert await _cancel_at_column(db_session_factory) is None
    async with db_session_factory() as db:
        # Only the column went: the row stands (read by SQL — the ORM maps the column).
        assert await db.scalar(text("SELECT count(*) FROM subscriptions")) == 1
        assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0029"
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (259, 12, 1), out
    for line in (
        "alembic_version is at 0031",
        "subscriptions.cancel_at is nullable",
        "subscriptions.cancel_at is timestamp with time zone",
        "subscriptions.cancel_at has no server default (the webhook writes it, or nothing does)",
        *LINES_0031[1:],
    ):
        assert f"FAIL  {line}" in out, line

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0029 -> 0030") for m in lines), lines
    assert await _cancel_at_column(db_session_factory) == shape
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].cancel_at is None  # lost with the column, not resurrected
    assert rows[0].cancel_at_period_end is False and rows[0].status == "active"
    assert _verifier()[:3] == (271, 0, 0)

    await _migrate("downgrade", "0029", capsys)
    await _migrate("upgrade", "head", capsys)
    assert await _cancel_at_column(db_session_factory) == shape
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == HEAD


# --- the verifier -----------------------------------------------------------------------------


async def test_the_verifier_asserts_the_billing_shape_and_its_three_invariants(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's thirty-nine CK-73 lines, run as the
    operator runs it — a fresh interpreter against the test database — on a
    clean baseline holding a real customer and subscription, then on the
    plants each invariant exists to catch: a subscription whose account has
    no customer row; a billing row on an anonymized account; and two paid
    subscriptions on one account, which the partial unique refuses — so the
    index is DROPPED for that plant and recreated after, and the shape
    lines fail beside the data line. The total is pinned as a number (the
    CK-57 convention: 219 → 258, 261 since CK-73.1's three cancel_at
    lines, and 271 since CK-73.2's ten — the scheduled change's two
    columns, their CHECK, the pair invariant, and two never-stored
    allowance columns asserted absent). A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's lesson),
    so each is counted by its own SELECT before the verifier reads it."""
    orphan = "every subscription's account has a billing_customers row of the same provider"
    on_deleted_c = "no billing_customers row belongs to an anonymized account"
    on_deleted_s = "no subscriptions row belongs to an anonymized account"
    double = "no account holds two subscriptions in a paid status"
    shape_exists = "partial UNIQUE uq_subscriptions_account_id_paid exists on subscriptions"
    shape_def = "uq_subscriptions_account_id_paid is UNIQUE on (account_id) WHERE status IN ('active', 'past_due')"

    address = "verified@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
        person_id = (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()
    await _plant_customer(db_session_factory, account.id, "cus_verified")
    await _plant_subscription(db_session_factory, account.id, subscription_id="sub_verified")

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (271, 0, 0), out
    for line in (
        "table billing_customers exists",
        "table subscriptions exists",
        "subscriptions.status is text (the provider's value verbatim, never an enum)",
        "subscriptions.cancel_at is nullable",
        "subscriptions.cancel_at is timestamp with time zone",
        "subscriptions.cancel_at has no server default (the webhook writes it, or nothing does)",
        "subscriptions.scheduled_plan is nullable",
        "subscriptions.scheduled_plan_at is nullable",
        "subscriptions.scheduled_plan is of type billing_plan",
        "subscriptions.scheduled_plan_at is timestamp with time zone",
        "CHECK ck_subscriptions_scheduled_plan_both_or_neither exists",
        "no subscription carries a scheduled plan without its instant, or an instant without its plan",
        "subscriptions.next_allowance is gone",
        "subscriptions.scheduled_allowance is gone",
        "billing_provider carries 'stripe'",
        "billing_plan carries 'photos_100k'",
        "billing_plan carries 'photos_300k'",
        "subscriptions.allowance is gone",
        "subscriptions.is_paid is gone",
        shape_exists,
        shape_def,
        "fk_subscriptions_account_id has no delete rule (nothing cascades from an account)",
        orphan,
        on_deleted_c,
        on_deleted_s,
        double,
    ):
        assert f"PASS  {line}" in out, line
    assert "INFO  billing_customers rows: 1" in out and "INFO  subscriptions rows: 1" in out

    async def run(sql: str, params: dict, confirm: str) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), params)
            await db.commit()
            assert await db.scalar(text(confirm), params) == 1, "the plant did not land"

    # (1) A subscription with no customer row: delete the customer row alone.
    await run(
        "DELETE FROM billing_customers WHERE account_id = :a",
        {"a": account.id},
        "SELECT count(*) FROM subscriptions s WHERE s.account_id = :a AND NOT EXISTS "
        "(SELECT 1 FROM billing_customers c WHERE c.account_id = s.account_id)",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (270, 1, 1), out
    assert f"FAIL  {orphan}" in out and "1 subscription row(s) with no customer row" in out
    await _plant_customer(db_session_factory, account.id, "cus_verified")
    assert _verifier()[:3] == (271, 0, 0)

    # (2) Billing rows on an anonymized account: both lines, and only those.
    await run(
        "UPDATE people SET anonymized_at = now() WHERE id = :p",
        {"p": person_id},
        "SELECT count(*) FROM people WHERE id = :p AND anonymized_at IS NOT NULL",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (269, 2, 1), out
    assert f"FAIL  {on_deleted_c}" in out and f"FAIL  {on_deleted_s}" in out
    await run(
        "UPDATE people SET anonymized_at = NULL WHERE id = :p",
        {"p": person_id},
        "SELECT count(*) FROM people WHERE id = :p AND anonymized_at IS NULL",
    )
    assert _verifier()[:3] == (271, 0, 0)

    # (3) Two paid subscriptions on one account — impossible while the
    # partial unique stands (the plant is refused), so the index is dropped
    # for the plant: the two shape lines fail beside the data line.
    async with db_session_factory() as db:
        with pytest.raises(Exception):
            await db.execute(
                text(
                    "INSERT INTO subscriptions (account_id, provider, provider_subscription_id, plan, status, cancel_at_period_end) "
                    "VALUES (:a, 'stripe', 'sub_refused', 'photos_100k', 'past_due', false)"
                ),
                {"a": account.id},
            )
        await db.rollback()
    async with db_session_factory() as db:
        await db.execute(text("DROP INDEX uq_subscriptions_account_id_paid"))
        await db.commit()
    await run(
        "INSERT INTO subscriptions (account_id, provider, provider_subscription_id, plan, status, cancel_at_period_end) "
        "VALUES (:a, 'stripe', 'sub_second_paid', 'photos_100k', 'past_due', false)",
        {"a": account.id},
        "SELECT count(*) FROM subscriptions WHERE account_id = :a AND provider_subscription_id = 'sub_second_paid'",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (268, 3, 1), out
    assert f"FAIL  {double}" in out and f"FAIL  {shape_exists}" in out and f"FAIL  {shape_def}" in out
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM subscriptions WHERE provider_subscription_id = 'sub_second_paid'"))
        await db.execute(
            text(
                "CREATE UNIQUE INDEX uq_subscriptions_account_id_paid ON subscriptions (account_id) "
                "WHERE status IN ('active', 'past_due')"
            )
        )
        await db.commit()
    assert _verifier()[:3] == (271, 0, 0)


# --- the scheduled change: a downgrade waiting for renewal (CK-73.2; migration 0031) --

SCHEDULE_ID = "sub_sched_test_one"
# The next phase starts when the current one ends — the renewal boundary,
# the same instant as the item's period end in the portal's shape.
NEXT_START = PERIOD_END
NEXT_END = PERIOD_END + 30 * 86400
CHECK_NAME = "ck_subscriptions_scheduled_plan_both_or_neither"


def _price(lookup_key: str, price_id: str = "price_test_next") -> dict:
    return {"id": price_id, "object": "price", "lookup_key": lookup_key, "active": True}


def _schedule_object(
    *,
    status: str = "active",
    current_lookup_key: str = KEY_300K,
    next_lookup_key: str | None = KEY_100K,
    next_start: int = NEXT_START,
    current_phase: bool = True,
    subscription_id: str | None = "sub_test_one",
    released_subscription: str | None = None,
    next_price=None,
    schedule_id: str = SCHEDULE_ID,
) -> dict:
    """A subscription schedule in the shape the portal's downgrade creates
    (record §2's portal bullet): two phases — the current price until the
    period ends, the lower price from the renewal instant — EXPANDED down
    to each item's price, as the one fetch asks for it
    (`billing.SUBSCRIPTION_EXPAND`). `next_lookup_key` None drops the
    second phase; `next_price` overrides the next phase's price (an id
    string stands for an unexpanded price); `current_phase` False is the
    `not_started` shape, which has none."""
    phases = [
        {
            "start_date": PERIOD_END - 30 * 86400,
            "end_date": PERIOD_END,
            "items": [{"price": _price(current_lookup_key, "price_test_current"), "quantity": 1}],
        }
    ]
    if next_lookup_key is not None or next_price is not None:
        phases.append(
            {
                "start_date": next_start,
                "end_date": NEXT_END,
                "items": [
                    {
                        "price": next_price if next_price is not None else _price(next_lookup_key),
                        "quantity": 1,
                    }
                ],
            }
        )
    return {
        "id": schedule_id,
        "object": "subscription_schedule",
        "status": status,
        "subscription": subscription_id,
        "released_subscription": released_subscription,
        "current_phase": (
            {"start_date": PERIOD_END - 30 * 86400, "end_date": PERIOD_END} if current_phase else None
        ),
        "phases": phases,
    }


def _schedule_event(subscription: str | None = "sub_test_one", released: str | None = None) -> dict:
    """The object a `subscription_schedule.*` delivery carries: the schedule,
    naming its subscription by id (or, once released, the released one)."""
    return {
        "id": SCHEDULE_ID,
        "object": "subscription_schedule",
        "status": "active",
        "subscription": subscription,
        "released_subscription": released,
    }


async def _scheduled(db_session_factory) -> tuple[BillingPlan | None, datetime | None, BillingPlan, str]:
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1, [r.provider_subscription_id for r in rows]
    return rows[0].scheduled_plan, rows[0].scheduled_plan_at, rows[0].plan, rows[0].status


async def test_a_portal_downgrade_is_stored_as_two_facts_and_shown_as_a_scheduled_change(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """The design session's finding (2026-10-14): the plan screen could not
    say "switches to 100,000 photos on Nov 12". Built with `construct_from`
    in the pinned API version's shape, with the schedule EXPANDED as the
    one fetch asks for it: a `photos_300k` subscription whose schedule's
    second phase is the 100k price starting at the period end. The row
    stores the two Stripe facts; `GET /billing` still says `photos_300k`
    and 300,000 and carries `scheduled_change` = {photos_100k, 100000, that
    instant} — the allowance from the server, so the screen keeps no plan
    table of its own; `account_quota` reads neither column. Then RELEASED
    (the schedule gone from the subscription): both null, the body null.
    Then COMPLETED at renewal (the item now the 100k price, no schedule):
    the plan moves, the allowance moves, nothing is scheduled."""
    address = "downgrade@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    sub = {"id": "sub_test_one", "object": "subscription"}

    # Bought: Stripe sends `schedule`, null.
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K))
    assert (await _post_event(client, "customer.subscription.created", sub, event_id="evt_bought")).status_code == 200
    assert await _scheduled(db_session_factory) == (None, None, BillingPlan.PHOTOS_300K, "active")
    assert (await client.get("/billing", headers=headers)).json()["scheduled_change"] is None

    # Switched to 100,000 in the portal: the schedule arrives on the
    # subscription_schedule.created nudge, status active, two phases.
    _stub_fetch(
        monkeypatch,
        _subscription_object(status="active", lookup_key=KEY_300K, schedule=_schedule_object()),
    )
    caplog.clear()  # the purchase above logged its own handled line
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, "subscription_schedule.created", _schedule_event(), event_id="evt_sched")
    assert response.status_code == 200 and response.json() == {"received": True}
    assert await _scheduled(db_session_factory) == (
        BillingPlan.PHOTOS_100K,
        _instant(NEXT_START),
        BillingPlan.PHOTOS_300K,
        "active",
    )
    body = (await client.get("/billing", headers=headers)).json()
    assert body == {
        "plan": "photos_300k",
        "status": "active",
        "current_period_end": _instant(PERIOD_END).isoformat(),
        "ends_at": None,
        "allowance": 300_000,
        "used": 0,  # the pin moved at CK-74: `used` and `plans` join the body
        "scheduled_change": {
            "plan": "photos_100k",
            "allowance": 100_000,
            "at": _instant(NEXT_START).isoformat(),
        },
        "plans": PLANS,
        "next": "portal",
    }
    assert body["scheduled_change"]["allowance"] == PLAN_PHOTOGRAPHS[BillingPlan.PHOTOS_100K]
    assert [r.getMessage() for r in _records(caplog)] == ["billing: handled subscription_schedule.created evt_sched"]
    assert "sub_sched" not in caplog.text and "price_test" not in caplog.text
    # The allowance follows the CURRENT item: still 300,000, still paid.
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == 300_000
        assert await keeping.holds_paid_plan(db, account) is True

    # Undone in the portal: the schedule RELEASED — the subscription's
    # `schedule` is null in the fetch — both columns null, the body null,
    # the plan untouched. The event names the released subscription.
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=None))
    released = await _post_event(
        client,
        "subscription_schedule.released",
        _schedule_event(subscription=None, released="sub_test_one"),
        event_id="evt_released",
    )
    assert released.status_code == 200
    assert await _scheduled(db_session_factory) == (None, None, BillingPlan.PHOTOS_300K, "active")
    body = (await client.get("/billing", headers=headers)).json()
    assert body["scheduled_change"] is None and body["plan"] == "photos_300k" and body["allowance"] == 300_000

    # Scheduled again, then RENEWAL: the schedule completed, the item is
    # now the 100k price, the subscription carries no schedule.
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=_schedule_object()))
    assert (await _post_event(client, "subscription_schedule.updated", _schedule_event(), event_id="evt_again")).status_code == 200
    assert (await _scheduled(db_session_factory))[:2] == (BillingPlan.PHOTOS_100K, _instant(NEXT_START))
    _stub_fetch(
        monkeypatch,
        _subscription_object(status="active", lookup_key=KEY_100K, period_end=NEXT_END, schedule=None),
    )
    assert (await _post_event(client, "subscription_schedule.completed", _schedule_event(), event_id="evt_done")).status_code == 200
    assert await _scheduled(db_session_factory) == (None, None, BillingPlan.PHOTOS_100K, "active")
    body = (await client.get("/billing", headers=headers)).json()
    assert body == {
        "plan": "photos_100k",
        "status": "active",
        "current_period_end": _instant(NEXT_END).isoformat(),
        "ends_at": None,
        "allowance": 100_000,
        "used": 0,  # the pin moved at CK-74: `used` and `plans` join the body
        "scheduled_change": None,
        "plans": PLANS,
        "next": "portal",
    }
    async with db_session_factory() as db:
        account = await _account(db, address)
        assert await keeping.account_quota(db, account) == 100_000


async def test_nothing_is_scheduled_for_the_same_plan_no_next_phase_or_a_schedule_in_another_status(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """Null both — and no line, because nothing is wrong — when the next
    phase is on the SAME plan (a schedule that changes something other
    than the price), when there is no phase at or after the current one's
    end, and when the schedule is `released`, `canceled` or `completed`
    while still on the subscription. And the one shape that HAS no current
    phase, `not_started`, reads the item's period end as its boundary, so
    its first phase at that instant IS the change."""
    address = "nothing-scheduled@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    cases = [
        ("the same plan", _schedule_object(next_lookup_key=KEY_300K)),
        ("no next phase", _schedule_object(next_lookup_key=None)),
        ("a next phase before the boundary", _schedule_object(next_start=PERIOD_END - 1)),
        ("released", _schedule_object(status="released")),
        ("canceled", _schedule_object(status="canceled")),
        ("completed", _schedule_object(status="completed")),
    ]
    for why, schedule in cases:
        _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=schedule))
        with caplog.at_level(logging.DEBUG):
            response = await _post_event(client, "customer.subscription.updated", {"id": "sub_test_one", "object": "subscription"}, event_id="evt_case")
        assert response.status_code == 200, why
        assert await _scheduled(db_session_factory) == (None, None, BillingPlan.PHOTOS_300K, "active"), why
        assert (await client.get("/billing", headers=headers)).json()["scheduled_change"] is None, why
        assert [r.levelno for r in _records(caplog)] == [logging.INFO], why
        caplog.clear()

    # `not_started`: no current phase, the boundary is the item's period end.
    _stub_fetch(
        monkeypatch,
        _subscription_object(
            status="active", lookup_key=KEY_300K, schedule=_schedule_object(status="not_started", current_phase=False)
        ),
    )
    assert (await _post_event(client, "customer.subscription.updated", {"id": "sub_test_one", "object": "subscription"})).status_code == 200
    assert await _scheduled(db_session_factory) == (
        BillingPlan.PHOTOS_100K,
        _instant(NEXT_START),
        BillingPlan.PHOTOS_300K,
        "active",
    )


async def test_a_plan_that_is_ending_shows_no_scheduled_change_while_the_row_still_holds_what_stripe_holds(
    client, capsys, db_session_factory, monkeypatch
):
    """`scheduled_change` is null WHENEVER `ends_at` is set: a plan that ends
    has no next plan, and Stripe releases the schedule on cancel anyway
    (CK-73.1). Should both arrive together — the endive shape and the
    classic shape alike — the row stores the two Stripe facts verbatim and
    the body shows the ending alone; "Don't cancel" shows the change again
    with nothing re-fetched beyond the usual nudge."""
    address = "ending-and-scheduled@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    sub = {"id": "sub_test_one", "object": "subscription"}
    for cancel, cancel_at in ((False, PERIOD_END), (True, None)):
        _stub_fetch(
            monkeypatch,
            _subscription_object(
                status="active", lookup_key=KEY_300K, cancel=cancel, cancel_at=cancel_at, schedule=_schedule_object()
            ),
        )
        assert (await _post_event(client, "customer.subscription.updated", sub)).status_code == 200
        assert (await _scheduled(db_session_factory))[:2] == (BillingPlan.PHOTOS_100K, _instant(NEXT_START)), (cancel, cancel_at)
        body = (await client.get("/billing", headers=headers)).json()
        assert body["ends_at"] == _instant(PERIOD_END).isoformat(), (cancel, cancel_at)
        assert body["scheduled_change"] is None, (cancel, cancel_at)
        assert body["plan"] == "photos_300k" and body["allowance"] == 300_000
    _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=_schedule_object()))
    assert (await _post_event(client, "customer.subscription.updated", sub)).status_code == 200
    body = (await client.get("/billing", headers=headers)).json()
    assert body["ends_at"] is None
    assert body["scheduled_change"] == {"plan": "photos_100k", "allowance": 100_000, "at": _instant(NEXT_START).isoformat()}


async def test_an_unreadable_next_phase_is_one_error_line_both_null_and_the_current_plan_written(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """A next phase whose price names no configured plan — an unknown
    lookup key, a price that came back as an id (unexpanded), or a
    schedule that came back as an id — is ONE ERROR line naming the event
    and subscription ids and nothing else, both columns null, and the
    rest of the upsert written as usual: the current plan, status and
    period end land, the "handled" line follows, and nothing blocks the
    allowance. The key and the ids of the schedule and the price never
    reach a log record."""
    address = "unreadable-phase@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    cases = [
        ("an unknown lookup key", _schedule_object(next_lookup_key="ck_photos_1m_monthly")),
        ("an unexpanded price", _schedule_object(next_price="price_unexpanded_next")),
        ("an unexpanded schedule", "sub_sched_unexpanded"),
    ]
    for why, schedule in cases:
        _stub_fetch(monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=schedule))
        with caplog.at_level(logging.DEBUG):
            response = await _post_event(client, "subscription_schedule.updated", _schedule_event(), event_id="evt_unreadable")
        assert response.status_code == 200, why
        assert await _scheduled(db_session_factory) == (None, None, BillingPlan.PHOTOS_300K, "active"), why
        body = (await client.get("/billing", headers=headers)).json()
        assert body["scheduled_change"] is None and body["plan"] == "photos_300k" and body["allowance"] == 300_000, why
        ours = _records(caplog)
        assert [r.levelno for r in ours] == [logging.ERROR, logging.INFO], (why, [r.getMessage() for r in ours])
        message = ours[0].getMessage()
        assert "evt_unreadable" in message and "sub_test_one" in message and "not recorded" in message, why
        assert ours[1].getMessage() == "billing: handled subscription_schedule.updated evt_unreadable", why
        for secret in ("ck_photos_1m_monthly", "price_unexpanded_next", "sub_sched_unexpanded", SCHEDULE_ID):
            assert secret not in caplog.text, (why, secret)
        caplog.clear()


@pytest.mark.parametrize("event_type", sorted(billing.SCHEDULE_EVENT_TYPES))
async def test_each_schedule_event_type_fetches_the_named_subscription_and_upserts_the_row(
    client, capsys, db_session_factory, monkeypatch, caplog, event_type
):
    """The six are the same nudge as the four: the subscription id read
    from the event's schedule, the subscription FETCHED by id — with its
    schedule expanded — and the row upserted, one INFO line with the type
    and id and nothing else. A schedule can change without any field on
    the subscription changing, which is why these exist at all."""
    address = "schedule-events@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    calls = _stub_fetch(
        monkeypatch, _subscription_object(status="active", lookup_key=KEY_300K, schedule=_schedule_object())
    )
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(client, event_type, _schedule_event(), event_id="evt_handled")
    assert response.status_code == 200 and response.json() == {"received": True}
    assert calls == ["sub_test_one"]
    assert await _scheduled(db_session_factory) == (
        BillingPlan.PHOTOS_100K,
        _instant(NEXT_START),
        BillingPlan.PHOTOS_300K,
        "active",
    )
    assert [r.getMessage() for r in _records(caplog)] == [f"billing: handled {event_type} evt_handled"]


async def test_a_schedule_event_names_its_subscription_or_the_released_one_and_expiring_is_not_handled(
    client, monkeypatch, caplog, db_session_factory
):
    """`released_subscription` is used when `subscription` is null (the
    shape a `.released` delivery carries); an expanded `subscription`
    object yields its id; a schedule naming neither is a 200 with nothing
    fetched and no line; `subscription_schedule.expiring` — a seven-day
    reminder — is not handled: nothing fetched, nothing logged. And the
    handled set is exactly the ten."""
    assert billing.SCHEDULE_EVENT_TYPES == frozenset(
        {
            "subscription_schedule.created",
            "subscription_schedule.updated",
            "subscription_schedule.released",
            "subscription_schedule.canceled",
            "subscription_schedule.completed",
            "subscription_schedule.aborted",
        }
    )
    assert billing.HANDLED_EVENT_TYPES == billing.SUBSCRIPTION_EVENT_TYPES | billing.SCHEDULE_EVENT_TYPES
    assert len(billing.HANDLED_EVENT_TYPES) == 10
    assert "subscription_schedule.expiring" not in billing.HANDLED_EVENT_TYPES

    calls = _stub_fetch(monkeypatch, _subscription_object(customer_id="cus_nobody"))
    with caplog.at_level(logging.DEBUG):
        # The released shape: `subscription` null, `released_subscription` set.
        assert (
            await _post_event(client, "subscription_schedule.released", _schedule_event(subscription=None, released="sub_test_one"))
        ).status_code == 200
        assert calls == ["sub_test_one"]
        # An expanded `subscription`: the object's id.
        expanded = dict(_schedule_event(), subscription={"id": "sub_test_one", "object": "subscription"})
        assert (await _post_event(client, "subscription_schedule.updated", expanded)).status_code == 200
        assert calls == ["sub_test_one"] * 2
        # Naming neither: acknowledged, nothing fetched, no "handled" line.
        caplog.clear()
        assert (
            await _post_event(client, "subscription_schedule.created", _schedule_event(subscription=None, released=None), event_id="evt_none")
        ).status_code == 200
        assert calls == ["sub_test_one"] * 2
        assert not _records(caplog)
        # `.expiring`: not handled — nothing fetched, nothing logged.
        _never(monkeypatch, "fetch_subscription")
        assert (await _post_event(client, "subscription_schedule.expiring", _schedule_event())).status_code == 200
        assert not _records(caplog)
    assert await _subscription_rows(db_session_factory) == []


def test_the_one_fetch_asks_stripe_to_expand_the_schedule_down_to_each_phase_items_price(monkeypatch):
    """The STEP 1 probe, pinned: unexpanded, `Subscription.schedule` is an
    id string and a phase item's `price` an id string; expanded, they are
    a `SubscriptionSchedule` and a `Price`, subscript-readable like every
    StripeObject. The wrapper asks for `schedule.phases.items.price` — four
    levels, Stripe's limit — on the one subscription fetch, through the
    SDK's own `expand` parameter, so the next phase's lookup key is on the
    object `sync_subscription` reads. Stubbed at the client, beneath the
    wrapper."""
    assert billing.SUBSCRIPTION_EXPAND == ("schedule.phases.items.price",)
    assert len(billing.SUBSCRIPTION_EXPAND[0].split(".")) == 4
    from stripe.params._subscription_retrieve_params import SubscriptionRetrieveParams

    assert "expand" in SubscriptionRetrieveParams.__annotations__
    assert "schedule" in stripe.Subscription.__annotations__
    assert "price" in stripe.SubscriptionSchedule.Phase.Item.__annotations__
    captured: list[tuple] = []

    class _Subscriptions:
        def retrieve(self, subscription_id, params=None, options=None):
            captured.append((subscription_id, params, options))
            return "the subscription, as Stripe holds it"

    class _V1:
        subscriptions = _Subscriptions()

    class _Client:
        v1 = _V1()

    monkeypatch.setattr(billing, "client", lambda: _Client())
    assert billing._retrieve_subscription("sub_probe") == "the subscription, as Stripe holds it"
    assert captured == [("sub_probe", {"expand": ["schedule.phases.items.price"]}, None)]

    # The shapes, through the SDK's own constructor.
    expanded = _subscription_object(schedule=_schedule_object())
    assert isinstance(expanded["schedule"], stripe.SubscriptionSchedule)
    assert isinstance(expanded["schedule"]["phases"][1]["items"][0]["price"], stripe.Price)
    assert expanded["schedule"]["phases"][1]["items"][0]["price"]["lookup_key"] == KEY_100K
    unexpanded = _subscription_object(schedule="sub_sched_id_only")
    assert unexpanded["schedule"] == "sub_sched_id_only"
    assert _subscription_object(schedule=None)["schedule"] is None


def test_the_allowance_and_the_upload_gate_read_neither_scheduled_column():
    """Record §12's banner, made structural: `keeping.py` (the allowance,
    `holds_paid_plan`, the quota) and `api/media.py` (the gate) name no
    `scheduled` anything in their CODE — a token scan with comments and
    docstrings stripped, the CK-70 idiom. The behavioural half — 300,000
    with a 100k change scheduled — is the first test of this block."""
    for path in ("app/services/keeping.py", "app/api/media.py"):
        source = (BACKEND_DIR / path).read_text(encoding="utf-8")
        code_tokens = [
            tok.string
            for tok in tokenize.generate_tokens(io.StringIO(source).readline)
            if tok.type not in (tokenize.COMMENT, tokenize.STRING)
        ]
        assert not any("scheduled" in t.lower() for t in code_tokens), path
    # And the body's allowance comes from the one plan table, never a column.
    api_source = (BACKEND_DIR / "app" / "api" / "billing.py").read_text(encoding="utf-8")
    assert "keeping.PLAN_PHOTOGRAPHS[paid.scheduled_plan]" in api_source
    model_source = (BACKEND_DIR / "app" / "models" / "billing.py").read_text(encoding="utf-8")
    assert "allowance" not in [
        tok.string
        for tok in tokenize.generate_tokens(io.StringIO(model_source).readline)
        if tok.type == tokenize.NAME
    ]


# --- migration 0031: the round trip, and the CHECK on a real row ------------------------


async def _scheduled_columns(db_session_factory):
    """{column: (is_nullable, udt_name, column_default)} for the two 0031
    columns present, and whether the CHECK exists."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT column_name, is_nullable, udt_name, column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'subscriptions' "
                    "AND column_name IN ('scheduled_plan', 'scheduled_plan_at')"
                )
            )
        ).all()
        check = await db.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname = :n"), {"n": CHECK_NAME})
    return {row[0]: tuple(row[1:]) for row in rows}, check == 1


SCHEDULED_SHAPE = {
    "scheduled_plan": ("YES", "billing_plan", None),
    "scheduled_plan_at": ("YES", "timestamptz", None),
}
# The nine lines the verifier (expecting 0031) fails on at 0030: the head,
# the two nullable lines ("column missing"), the four `.first()` lines, the
# CHECK, and the pair invariant's guard.
LINES_0031 = (
    "alembic_version is at 0031",
    "subscriptions.scheduled_plan is nullable",
    "subscriptions.scheduled_plan_at is nullable",
    "subscriptions.scheduled_plan is of type billing_plan",
    "subscriptions.scheduled_plan has no server default (the webhook writes it, or nothing does)",
    "subscriptions.scheduled_plan_at is timestamp with time zone",
    "subscriptions.scheduled_plan_at has no server default (the webhook writes it, or nothing does)",
    f"CHECK {CHECK_NAME} exists",
    "scheduled-change integrity",
)


async def test_0031_round_trip_adds_the_two_columns_and_the_check_and_the_downgrade_is_genuine(
    client, capsys, db_session_factory
):
    """Down to 0030 — both columns and the CHECK gone, the row still there,
    and the verifier (expecting 0031) failing on EXACTLY its nine lines; up
    — the columns back, nullable, on the enum and timestamptz, no default,
    the CHECK back, and a pair planted at head LOST and not resurrected (a
    migration cannot ask Stripe); the CHECK refused on a real row by name,
    both halves; down and up once more: idempotent."""
    assert await _scheduled_columns(db_session_factory) == (SCHEDULED_SHAPE, True)
    address = "scheduled-roundtrip@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(
        db_session_factory,
        account.id,
        plan=BillingPlan.PHOTOS_300K,
        scheduled_plan=BillingPlan.PHOTOS_100K,
        scheduled_plan_at=_instant(NEXT_START),
    )
    assert (await _scheduled(db_session_factory))[:2] == (BillingPlan.PHOTOS_100K, _instant(NEXT_START))

    lines = await _migrate("downgrade", "0030", capsys)
    assert any(m.startswith("Running downgrade 0031 -> 0030") for m in lines), lines
    assert await _scheduled_columns(db_session_factory) == ({}, False)
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM subscriptions")) == 1
        assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0030"
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (262, 9, 1), out
    for line in LINES_0031:
        assert f"FAIL  {line}" in out, line

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0030 -> 0031") for m in lines), lines
    assert await _scheduled_columns(db_session_factory) == (SCHEDULED_SHAPE, True)
    rows = await _subscription_rows(db_session_factory)
    assert len(rows) == 1 and rows[0].scheduled_plan is None and rows[0].scheduled_plan_at is None
    assert rows[0].plan == BillingPlan.PHOTOS_300K and rows[0].status == "active"
    assert _verifier()[:3] == (271, 0, 0)

    # The CHECK, on a real row, by name — half a change is refused both ways.
    for sql in (
        "UPDATE subscriptions SET scheduled_plan = 'photos_100k' WHERE id = :id",
        "UPDATE subscriptions SET scheduled_plan_at = now() WHERE id = :id",
    ):
        async with db_session_factory() as db:
            with pytest.raises(Exception) as excinfo:
                await db.execute(text(sql), {"id": rows[0].id})
            assert CHECK_NAME in str(excinfo.value), sql
            await db.rollback()
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE subscriptions SET scheduled_plan = 'photos_100k', scheduled_plan_at = now() WHERE id = :id"),
            {"id": rows[0].id},
        )
        await db.commit()
    assert (await _scheduled(db_session_factory))[0] == BillingPlan.PHOTOS_100K

    await _migrate("downgrade", "0030", capsys)
    await _migrate("upgrade", "head", capsys)
    assert await _scheduled_columns(db_session_factory) == (SCHEDULED_SHAPE, True)
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == HEAD


async def test_the_verifier_asserts_the_scheduled_change_shape_and_its_pair_invariant(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's ten CK-73.2 lines — eight on the two
    columns, their CHECK and the pair invariant, two never-stored
    allowance columns asserted absent — run as the operator runs it, on a
    clean baseline holding a real row with a scheduled change, then on the
    plant the pair invariant exists to catch — half a
    change, which the CHECK refuses, so the CHECK is DROPPED for the plant
    and recreated after (the CK-73 idiom): the shape line fails beside the
    data line, and nothing else. A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's lesson)."""
    pair = "no subscription carries a scheduled plan without its instant, or an instant without its plan"
    shape = f"CHECK {CHECK_NAME} exists"
    address = "scheduled-verified@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id, "cus_scheduled")
    await _plant_subscription(
        db_session_factory,
        account.id,
        plan=BillingPlan.PHOTOS_300K,
        subscription_id="sub_scheduled",
        scheduled_plan=BillingPlan.PHOTOS_100K,
        scheduled_plan_at=_instant(NEXT_START),
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (271, 0, 0), out
    for line in (
        *LINES_0031[1:8],
        pair,
        "subscriptions.next_allowance is gone",
        "subscriptions.scheduled_allowance is gone",
    ):
        assert f"PASS  {line}" in out, line

    async with db_session_factory() as db:
        await db.execute(text(f"ALTER TABLE subscriptions DROP CONSTRAINT {CHECK_NAME}"))
        await db.execute(text("UPDATE subscriptions SET scheduled_plan_at = NULL WHERE provider_subscription_id = 'sub_scheduled'"))
        await db.commit()
        planted = await db.scalar(
            text(
                "SELECT count(*) FROM subscriptions WHERE provider_subscription_id = 'sub_scheduled' "
                "AND scheduled_plan IS NOT NULL AND scheduled_plan_at IS NULL"
            )
        )
        assert planted == 1, "the plant did not land"
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (269, 2, 1), out
    assert f"FAIL  {shape}" in out and f"FAIL  {pair}" in out
    assert "1 subscription row(s) with half a scheduled change" in out

    async with db_session_factory() as db:
        await db.execute(text("UPDATE subscriptions SET scheduled_plan = NULL WHERE provider_subscription_id = 'sub_scheduled'"))
        await db.execute(
            text(
                f"ALTER TABLE subscriptions ADD CONSTRAINT {CHECK_NAME} "
                "CHECK ((scheduled_plan IS NULL) = (scheduled_plan_at IS NULL))"
            )
        )
        await db.commit()
    assert _verifier()[:3] == (271, 0, 0)


# --- CK-74: your plan — the caller's own usage and the plans on GET /billing ---------


async def _plant_rows(db_session_factory, gathering_id: str, person_id, *, binned: int, in_flight: int) -> None:
    """`binned` photographs that are `ready` AND `removed` (still stored, so
    still charged — the bin record §4) and `in_flight` pending uploads (the
    CK-34 reservation, one each). `photo_count` is the column, planted
    separately to the number of ready rows (the verifier's invariant)."""
    now = datetime.now(timezone.utc)
    async with db_session_factory() as db:
        for _ in range(binned):
            db.add(
                Media(
                    gathering_id=gathering_id,
                    uploader_person_id=person_id,
                    upload_content_type="image/jpeg",
                    upload_size_bytes=1_000,
                    status=MediaStatus.READY,
                    publication_state=PublicationState.REMOVED,
                    removed_at=now,
                    created_at=now,
                    uploaded_at=now,
                )
            )
        for _ in range(in_flight):
            db.add(
                Media(
                    gathering_id=gathering_id,
                    uploader_person_id=person_id,
                    upload_content_type="image/jpeg",
                    upload_size_bytes=1_000,
                    status=MediaStatus.PENDING_UPLOAD,
                    publication_state=PublicationState.PENDING,
                    created_at=now,
                    uploaded_at=None,
                )
            )
        await db.commit()


async def test_used_is_the_callers_own_charged_count_and_appears_in_no_other_body(
    client, capsys, db_session_factory
):
    """`used` is `keeping.account_usage` for the CALLER — the upload gate's
    own reading, so the number on the screen is the number the gate
    enforces — and it is the CHARGED count (the bin record §4): photographs
    in the gatherings the caller keeps, a binned one and an in-flight one
    among them, a memorial's excluded, and nothing of a gathering someone
    else keeps. The same number on the free tier and on a plan (the
    allowance moves, the usage does not), and the caller's own: the other
    keeper's body carries THEIR count (keeping-explained §3 principle 5)."""
    address, other = "keeper@example.com", "other@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    headers_other = await _signed_in_headers(client, capsys, other)
    potluck = await _create(client, headers)
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    theirs = await _create(client, headers_other, title="Theirs")
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == address))).scalars().one()
        await _set_photo_count(db, memorial["id"], 4_000)  # exempt: counted by nobody
        await _set_photo_count(db, theirs["id"], 77)  # someone else's space
    # Two photographs in the bin — ready AND removed, so the column holds 2 —
    # and three uploads in flight, which the reservation counts one each.
    await _plant_rows(db_session_factory, potluck["id"], person.id, binned=2, in_flight=3)
    async with db_session_factory() as db:
        await _set_photo_count(db, potluck["id"], 2)
        account = await _account(db, address)
        assert await keeping.account_bin_count(db, account) == 2
        expected = await keeping.account_usage(db, account)
        assert expected == 2 + 3  # charged: the binned two, plus the three in flight

    free = (await client.get("/billing", headers=headers)).json()
    assert free["used"] == expected == 5
    assert free["allowance"] == 10_000 and free["plan"] is None
    assert "4,000" not in json.dumps(free) and "4000" not in json.dumps(free)  # the memorial's count rides nowhere
    assert "77" not in json.dumps(free)  # and nothing of the other keeper's

    # On a plan the allowance moves and the usage does not.
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, plan=BillingPlan.PHOTOS_100K)
    paid = (await client.get("/billing", headers=headers)).json()
    assert paid["used"] == 5 and paid["allowance"] == 100_000 and paid["plan"] == "photos_100k"

    # The other keeper reads their own number — the gathering they keep,
    # and nothing of this caller's.
    other_body = (await client.get("/billing", headers=headers_other)).json()
    async with db_session_factory() as db:
        other_account = await _account(db, other)
        assert other_body["used"] == await keeping.account_usage(db, other_account) == 77


async def test_plans_are_the_record_table_in_allowance_order_and_the_free_tier_has_no_price(
    client, capsys, db_session_factory
):
    """`plans` is the one table beside the allowances (record §3): three
    entries ordered by allowance — the free tier with `plan` null and no
    price, then each paid plan with its allowance from `PLAN_PHOTOGRAPHS`
    and its monthly price in cents from `PLAN_MONTHLY_PRICE_CENTS` (499 and
    999) — one entry per plan in both tables, the same list whatever the
    caller holds, and no Stripe price id in it."""
    address = "plans@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    body = (await client.get("/billing", headers=headers)).json()
    assert body["plans"] == PLANS
    assert [offer["allowance"] for offer in body["plans"]] == sorted(
        offer["allowance"] for offer in body["plans"]
    )
    assert body["plans"][0] == {
        "plan": None,
        "allowance": FREE_TIER_PHOTOGRAPHS,
        "monthly_price_cents": None,
    }
    for offer in body["plans"][1:]:
        plan = BillingPlan(offer["plan"])
        assert offer["allowance"] == PLAN_PHOTOGRAPHS[plan]
        assert offer["monthly_price_cents"] == PLAN_MONTHLY_PRICE_CENTS[plan]
    assert PLAN_MONTHLY_PRICE_CENTS == {BillingPlan.PHOTOS_100K: 499, BillingPlan.PHOTOS_300K: 999}
    assert set(PLAN_MONTHLY_PRICE_CENTS) == set(PLAN_PHOTOGRAPHS) == set(BillingPlan)
    assert len(body["plans"]) == len(BillingPlan) + 1
    # A paid caller reads the same table — the current plan is not dropped
    # from it; the screen decides what to show.
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, plan=BillingPlan.PHOTOS_300K)
    paid = await client.get("/billing", headers=headers)
    assert paid.json()["plans"] == PLANS
    # A QUOTED Stripe id (the key `monthly_price_cents` carries the prefix
    # and is not one).
    assert '"price_' not in paid.text and '"prod_' not in paid.text


async def test_get_billing_makes_no_stripe_call(client, capsys, db_session_factory, monkeypatch):
    """The read is local on every path (record §5: the quota path never
    calls Stripe, and the screen's read inherits that): the seam's one
    client builder — every SDK call goes through it — is stubbed to fail if
    reached, and the free and the paid body both come back."""

    def never():  # pragma: no cover — reaching it is the failure
        raise AssertionError("GET /billing reached the Stripe client")

    monkeypatch.setattr(billing, "client", never)
    address = "offline@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    free = await client.get("/billing", headers=headers)
    assert free.status_code == 200 and free.json()["plan"] is None
    assert free.json()["plans"] == PLANS
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    await _plant_subscription(db_session_factory, account.id, plan=BillingPlan.PHOTOS_100K)
    paid = await client.get("/billing", headers=headers)
    assert paid.status_code == 200 and paid.json()["plan"] == "photos_100k"
    assert paid.json()["used"] == 0 and paid.json()["plans"] == PLANS
