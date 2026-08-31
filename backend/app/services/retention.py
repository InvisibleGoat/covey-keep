"""Retention — the ephemeral-data reaper (CK-24).

Some rows exist only to carry a short-lived secret or a short-lived request:
magic-link tokens (15 minutes), email-change requests (1 hour), WebAuthn
challenges (5 minutes). Each is single-use, and each carries personal data —
an email address, an IP address, an address typed by someone who may not
control it — that has no reason to outlive the thing it was minted for.
Until CK-24 only the challenges were reaped; the other two tables grew
without bound, so every sign-in ever requested persisted as an address in
the clear bound to an IP (counsel review pack, Finding 1).

ONE mechanism, generic over model and timestamp column, so every customer is
the same one-line call and no table grows a private copy. Customers:

- `magic_link_tokens` and `email_change_requests` (this phase) — keyed off
  `expires_at`, called at the top of the request endpoint that writes each
  table.
- `webauthn_challenges` — passkeys.py's pre-existing opportunistic purge,
  migrated here; same semantics, same grace.
- Dietary requests after their occurrence passes, and guest→host RSVP notes
  with their contact details (both decided 2026-08-29; neither feature
  exists yet). Future callers — which is why `column` is a parameter: they
  will key off an occurrence date, not an expiry.

THE INVARIANT — read before tuning PURGE_GRACE:

    The purge keys off `expires_at`, NEVER `consumed_at`, and PURGE_GRACE
    must be strictly greater than auth.RATE_WINDOW.

The rate limits in auth.request_link (per email, per IP) and
profile.request_email_change (per person) count rows by `created_at` over
RATE_WINDOW (15 minutes) REGARDLESS of whether the row was consumed or
superseded — the row IS the tally. Deleting rows on consumption, or deleting
expired rows with a grace shorter than the window, silently disables those
limits: an attacker consumes (or merely supersedes — a new request forces
the previous row's `expires_at` to now, no inbox access needed) each token,
and the counter never accumulates. The arithmetic behind the constant:

    magic-link row:   created t, expires t+15m, purgeable from t+1h15m
    email-change row: created t, expires t+1h,  purgeable from t+2h
    superseded row:   expires_at forced to t',  purgeable from t'+1h
    rate window:      t .. t+15m — every row above outlives it

so the tally over any 15-minute window is complete whenever it is read.
Pinned by tests/test_retention.py: PURGE_GRACE > RATE_WINDOW asserted
directly, the limit tripping across a purge, and the counter-example (a
grace inside the window erases the tally).

Opportunistic, not scheduled — deliberately. Each customer calls purge_stale
at the top of the endpoint that writes its table, so the purge rides a
transaction that already exists and needs no worker, cron, or Render
service. The trade, recorded rather than hidden: rows linger on an idle
deployment until the next request arrives, so no verify_schema.py assertion
can count them (it would flap on an idle database for a legitimate reason),
and the privacy copy says the record is cleared when the next link is
requested, not "within an hour". Revisit only if a customer arrives whose
table is written far more often than its reaping endpoint is called.

DATA-HANDLING: this module deletes personal data and must never log, echo,
or count-by-value what it removes. A row count is the only thing that leaves
purge_stale.
"""

from datetime import datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

# One hour past expiry. Bounded BELOW by auth.RATE_WINDOW (15 minutes) — see
# the module docstring: shortening this past the window disables the rate
# limits silently. Deliberately not imported from auth (auth imports this
# module); the relation is pinned by test instead.
PURGE_GRACE = timedelta(hours=1)


async def purge_stale(
    db: AsyncSession,
    model,
    column,
    now: datetime,
    *,
    grace: timedelta = PURGE_GRACE,
) -> int:
    """Delete every `model` row whose `column` is older than `now - grace`.
    Returns the row count — never the rows. The caller commits: the purge
    rides whatever transaction the calling endpoint already has open, and a
    request that fails afterwards simply leaves the reaping to the next one."""
    result = await db.execute(delete(model).where(column < now - grace))
    return result.rowcount
