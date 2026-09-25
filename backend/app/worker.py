"""The ingest worker — the second Render service (CK-35), processing
photographs since CK-36.

    python -m app.worker            # poll forever (the Render start command)
    python -m app.worker --once     # drain what is claimable now, then exit

This process holds the WORKER credential and nothing else (media pipeline
record §8, §11.1): its configuration is `WorkerSettings` — seven values,
six of them required and one boolean switch (CK-59, below) — and
it never imports `app.db` or constructs the web `Settings`, so it boots with
no SESSION_SECRET and neither web credential in its environment (pinned by
test in a subprocess with exactly the six set). The web service, in turn,
has no field for this credential. Neither service holds the other's keys,
structurally.

WHAT IT DOES WITH A CLAIMED ROW (CK-36; services/ingest.py has the order
and every failure mode): reads the original from quarantine, decodes it,
applies its EXIF orientation, strips every byte of metadata, renders the
three derivative layers, writes them to the published bucket, moves the
row to `ready` with the derivative rows and the gathering's `total_bytes`
in ONE transaction — and only after that commit deletes the quarantine
original. A row that cannot be processed (missing object, not a
photograph, oversized) is dead-lettered on its first attempt, and its
original is deleted after THAT commit. Both deletions happen HERE, after
`db.commit()`, never inside the transaction: a crash between the commit
and the delete costs a lingering original the 24-hour lifecycle rule
collects; a crash in the other order would cost the photograph. Deleting
an already-absent object is a success — Render runs two workers for ~61
seconds on every deploy (CK-35's check (cw)), and `SKIP LOCKED` protects
the row, not a delete a slow-dying predecessor issues.

AND SINCE CK-54 IT DESTROYS ONE. A row the API has marked `destroying` is
claimed by the same mechanism and settled by services/ingest.py::
handle_destroying: the three published objects are deleted FIRST and
`destroyed` is committed only after — the inverse of the publish order,
and for the mirror-image reason (a row claiming destruction while its
bytes remain is the one promise this routine exists to keep). Nothing is
deleted from quarantine afterwards: that original went at `ready`. The
count moved when the API marked the row, never here.

AND SINCE CK-59 IT SWEEPS THE BIN — DARK UNTIL SWITCHED ON. The bin has
two clocks and only one of them moved (bin record §6.1): a removed
photograph stops being visible to its uploader after REMOVED_BIN and
went on occupying storage and charging the keeper forever, because
nothing destroyed one on a clock. The sweep is what makes the two clocks
coincide: from an IDLE poll, and only then — the queue always drains
first — once per SWEEP_INTERVAL, it asks services/destruction.py::
sweep_expired_bin to mark at most SWEEP_BATCH removed photographs whose
window has closed, row by row through the ONE marking statement, and
then drains the marks it made before it sleeps. IT MARKS; THE DESTROY
STEP ABOVE DESTROYS, exactly as it does for a row a person marked — one
destruction in the code, one decrement. It runs ONLY when
`WorkerSettings.sweep_enabled` is on, and that defaults to OFF: the
seventh worker variable, a boolean that grants no powers (the six-value
rule keeps a credential out of this process, and is untouched), and
buys an off-switch for the first automatic destruction path in the
product, reachable from the dashboard without a code deploy. One INFO
line per pass that marked anything, carrying the count and nothing
else; a pass that marked nothing logs nothing.

`publication_state` moves here only where the gathering resolves open
(CK-41 — `pending → live` inside the ready transaction, the ladder in
services/publication.py applied, never approval inferred from completion;
record §5) and never on a failure path; where it resolves gated the row
waits for the host's review (CK-43, api/media.py). Since CK-43 the same
statement stamps `published_at` and leaves the publisher NULL.

TWO SERVICES, ONE DATABASE — the rules that must hold from this service's
first deploy (record §8), each enforced here or in render.yaml:

1. ONLY THE WEB SERVICE RUNS MIGRATIONS. This worker has no pre-deploy step
   and no migration code path; a push to `develop` deploys both services,
   and two `alembic upgrade head` processes racing one database would fail
   on the first deploy after the worker exists.
2. THE WORKER TOLERATES A SCHEMA THE WEB SERVICE HAS NOT FINISHED MIGRATING.
   A poll that fails because a table or column is not there yet — or because
   the database is unreachable — is logged and retried after the idle
   interval. The worker never crash-loops on it (pinned by test against a
   real missing column).
3. A DEPLOY LANDS MID-JOB, and that is normal. The claim service's reclaim
   rule (services/ingest.py) makes a stalled row claimable again after
   RECLAIM_AFTER; SIGTERM sets the stop flag so the current poll finishes
   before the process exits.

The loop is thin on purpose (the claim and its outcomes are testable on
their own in services/ingest.py): claim one row, settle it, and repeat while
work remains — draining continuously — then sleep IDLE_POLL seconds,
jittered, when the queue is empty (record §6.2). A rejected credential
(ingest.Outcome.MISCONFIGURED) backs off like an empty queue instead of
draining, with a loud log line, so a mistyped dashboard value does not
hammer the store.

DATA-HANDLING: this process is the first component able to destroy an
uploaded photograph, and the order is the whole of its discipline — on the
ingest path derivatives are committed before the original is deleted,
never the reverse; on the destruction path the published objects are
deleted before `destroyed` is committed, never the reverse. The two orders
are opposite and both are deliberate (services/ingest.py says why each
way round). Since CK-54 the photographs it destroys include photographs of
children; until CK-59 every one of them was chosen by a person through
api/media.py, and with the sweep switched on this process also marks, on
a clock, the removed photographs whose retrieval window has closed — the
first destruction in the product nobody asked for, which is why the
switch ships off, why the sweep marks only (every destruction still
passes through the one audited routine), and why its one log line is a
count. Log lines carry media ids,
outcomes and byte counts — a row id is not personal data and a key is a
function of it. Never a URL, never a key id, never a person, never the
contents of anything, and never a filename, caption or tag: a destroyed
row keeps its words and this worker never reads them. Uploads on the dev
deploy remain Steven's own test images (private-alpha scope).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
import signal
import sys
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Awaitable, Callable, Optional

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import WorkerSettings
from app.models import MediaStatus, PublicationState
from app.services import destruction, ingest
from app.services.storage import WorkerClient, worker_client

# Five seconds when idle, jittered (record §6.2): a fleet of workers restarted
# together must not poll in lockstep.
IDLE_POLL = 5.0
IDLE_JITTER = 1.0

# THE SWEEP (CK-59; bin record §6) — off unless WorkerSettings.sweep_enabled,
# and when on, run only from an IDLE poll so the queue always drains first.
# The interval and the batch, and why each is what it is:
#
# SWEEP_INTERVAL. The clock being swept is thirty days, so the sweep's lag
# is invisible at any interval measured in minutes — a row's window closes
# at a known instant and nobody is waiting on the next quarter-hour. Fifteen
# minutes is short enough that an operator who turns the switch on sees the
# first INFO line at once (the first pass runs at the first idle poll after
# boot, and the service restarts on the change) and a backlog is visibly
# moving within the hour, and long enough that the pass is a rounding error
# on the database: one SELECT per quarter-hour when there is nothing to do.
#
# SWEEP_BATCH. Every mark becomes a destroy job on the same claim queue, and
# claim_next orders by created_at across BOTH ladders — a marked row is
# older than any fresh upload, so a pass's marks are all claimed before the
# next photograph someone adds. The batch therefore bounds the claim-to-ready
# latency a pass adds to a fresh upload: at roughly 0.55 s per destruction
# (the window CK-56 measured on the deploy), twenty is about 11 s, inside
# record §6.3's 60 s p95 with margin. The throughput that buys — 80 an hour,
# 1,920 a day — exceeds any plausible rate at which a bin ages out by orders
# of magnitude; a backlog of ten thousand (someone binned ten thousand and
# waited a month) drains in about five days, and the immediate path for
# that case is the bin surface's empty-the-bin (Phase C), not this clock.
SWEEP_INTERVAL = 15 * 60.0  # seconds, on the monotonic clock `run` is given
SWEEP_BATCH = 20

log = logging.getLogger("covey-keep.worker")


class Poll(str, Enum):
    PROCESSED = "processed"  # one row settled; poll again at once
    IDLE = "idle"  # nothing claimable; sleep
    NOT_READY = "not_ready"  # the database is unreachable or unmigrated; sleep, retry
    BACKOFF = "backoff"  # the worker is misconfigured; sleep, retry, shout


# The failures a poll survives: every SQLAlchemy/DBAPI error (an undefined
# table or column surfaces as ProgrammingError; a dropped connection as
# OperationalError/InterfaceError), the OS-level connection failures asyncpg
# raises unwrapped, and a connect timeout.
_NOT_READY_ERRORS = (SQLAlchemyError, OSError, TimeoutError)


async def poll_once(
    session_factory: async_sessionmaker[AsyncSession],
    client: WorkerClient,
    now: Optional[datetime] = None,
) -> Poll:
    """One claim and its outcome. Two commits: the claim (so the row lock
    is held for the claim alone) and the outcome — and after a terminal
    outcome has committed, the deletion of the quarantine original.

    The `ready` line carries the claim-to-ready time in milliseconds (CK-37):
    record §6.3 states its p95 target on claim-to-ready, and until CK-37
    nothing the worker emitted could measure it — `claimed_at` is cleared at
    the outcome, and the first live figure (4.712 s, CK-36) came from
    sampling the row at 50 ms. Measured on a monotonic clock from the start
    of the claim to the ready COMMIT; the original's deletion comes after
    and is not part of it."""
    now = now or datetime.now(timezone.utc)
    started = time.monotonic()
    try:
        async with session_factory() as db:
            row = await ingest.claim_next(db, now)
            await db.commit()
            if row is None:
                return Poll.IDLE
            if row.claimed_at is None:
                # Dead-lettered at reclaim: abandoned MAX_ATTEMPTS times.
                # EVERY real claim stamps `claimed_at` and every reclaim
                # dead-letter clears it, on both ladders — which is why the
                # test is the stamp and not the rung (CK-54: a destroy job
                # that gives up stays at `destroying`, so "the rung is
                # failed" is true on the ingest ladder alone). The terminal
                # state is committed; an upload's original goes now, and a
                # destruction has none to delete.
                log.warning("media %s dead-lettered at reclaim: %s", row.id, row.last_error)
                if row.status == MediaStatus.FAILED:
                    await _delete_original(client, row)
                return Poll.PROCESSED
            if row.status == MediaStatus.DESTROYING:
                outcome = await ingest.handle_destroying(db, client, row, now)
            else:
                outcome = await ingest.handle_claimed(db, client, row, now)
            await db.commit()
            elapsed_ms = round((time.monotonic() - started) * 1000)
    except _NOT_READY_ERRORS as exc:
        log.warning(
            "poll failed (%s): the database is unreachable or the schema is not "
            "migrated yet; retrying after the idle interval",
            exc.__class__.__name__,
        )
        return Poll.NOT_READY

    if outcome is ingest.Outcome.MISCONFIGURED:
        log.error(
            "media %s: the store rejected the worker credential — R2_WORKER_* is "
            "misconfigured; the row is untouched and the worker is backing off",
            row.id,
        )
        return Poll.BACKOFF
    if outcome is ingest.Outcome.READY:
        # Committed: three derivative rows, `ready`, total_bytes moved. Only
        # now may the original go (ingest.py, PUBLISH step 5). The attempt
        # number is the row's own, persisted by the ready transaction — the
        # log and the row say the same thing (CK-37).
        log.info(
            "media %s: ready — three layers written (attempt %d, %d ms claim-to-ready)",
            row.id,
            row.attempts,
            elapsed_ms,
        )
        # The gate's answer, applied in that same transaction (CK-41): the
        # gathering resolved open and the row went live, or it resolved
        # gated and the row waits for the host. A state, not a person.
        if row.publication_state is PublicationState.LIVE:
            log.info("media %s: live — the gathering resolves open; nothing waits for the host", row.id)
        else:
            log.info(
                "media %s: %s — the gathering resolves gated; publication is the host's",
                row.id,
                row.publication_state.value,
            )
        await _delete_original(client, row)
    elif outcome is ingest.Outcome.DESTROYED:
        # Committed: the three published objects are gone and their rows
        # with them (CK-54). Nothing follows — the quarantine original was
        # deleted at `ready`, one job earlier. The count moved when the API
        # marked the row, not here.
        log.info(
            "media %s: destroyed — the stored layers are gone (attempt %d, %d ms claim-to-destroyed)",
            row.id,
            row.attempts,
            elapsed_ms,
        )
    elif outcome is ingest.Outcome.DESTROY_ABANDONED:
        # The ladder is spent and the row stays at `destroying`: uncounted,
        # invisible, and owed a bucket operation somebody must do by hand.
        # Loud, because nothing will retry it.
        log.error("media %s: destruction gave up: %s", row.id, row.last_error)
    elif outcome is ingest.Outcome.DEAD_LETTERED:
        log.warning("media %s: dead-lettered (attempt %d): %s", row.id, row.attempts, row.last_error)
        await _delete_original(client, row)
    elif outcome is ingest.Outcome.RETRY_SCHEDULED:
        log.warning(
            "media %s: attempt %d failed transiently; next attempt at %s",
            row.id,
            row.attempts,
            row.available_at,
        )
    else:
        log.warning("media %s: claim lost to a reclaim; outcome discarded", row.id)
    return Poll.PROCESSED


async def _delete_original(client: WorkerClient, row) -> None:
    """After a terminal outcome has COMMITTED: delete the quarantine
    original. A failure is logged and is not a failure of the row — the
    lifecycle rule collects what lingers."""
    if await ingest.delete_original(client, row.id):
        log.info("media %s: quarantine original deleted", row.id)
    else:
        log.warning(
            "media %s: quarantine original could not be deleted; the 24-hour lifecycle "
            "rule will remove it",
            row.id,
        )


def _idle_delay() -> float:
    return random.uniform(IDLE_POLL - IDLE_JITTER, IDLE_POLL + IDLE_JITTER)


async def _sweep(session_factory: async_sessionmaker[AsyncSession]) -> int:
    """One pass of the bin sweep (CK-59), from an idle poll: at most
    SWEEP_BATCH removed photographs past their retrieval window, marked for
    destruction row by row through the one marking statement. Returns the
    count marked — 0 on a failed pass, which is logged and retried at the
    next interval and never kills the loop (the poll's own rule). One INFO
    line when anything was marked, carrying the count and nothing else —
    no id, no filename, no caption (media-pipeline §8's bans) — and
    silence when nothing was: a line every interval forever is a log
    nobody reads."""
    try:
        async with session_factory() as db:
            marked = await destruction.sweep_expired_bin(
                db, datetime.now(timezone.utc), limit=SWEEP_BATCH
            )
    except _NOT_READY_ERRORS as exc:
        log.warning(
            "bin sweep failed (%s): the database is unreachable or the schema is not "
            "migrated yet; retrying after the sweep interval",
            exc.__class__.__name__,
        )
        return 0
    except Exception:  # noqa: BLE001 — the loop's rule: nothing kills the worker
        log.exception("bin sweep raised unexpectedly; the worker keeps polling")
        return 0
    if marked:
        log.info(
            "bin sweep: %d photograph(s) marked for destruction; their retrieval window has closed",
            marked,
        )
    return marked


async def run(
    session_factory: async_sessionmaker[AsyncSession],
    client: WorkerClient,
    *,
    stop: asyncio.Event,
    once: bool = False,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    sweep_enabled: bool = False,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """The loop. Drains while work remains; sleeps when idle; never exits on
    a failed poll. With `once`, returns after the first non-PROCESSED poll —
    0 if the queue was drained to idle, 1 if the database or the credential
    was not ready. `sleep` is injectable so tests drive it without waiting.

    THE SWEEP (CK-59) rides the same loop and is OFF unless `sweep_enabled`
    — the seventh worker variable, defaulting to False at every layer. When
    on: from an IDLE poll and never between drains, once per SWEEP_INTERVAL
    on `clock` (monotonic; injectable for the same reason `sleep` is), the
    first pass at the first idle poll after boot. A pass that marked
    anything is followed by another poll, not a sleep, so the marks it
    made are drained at once — which also means `--once` with the switch
    on sweeps, drains the destructions, and exits at the next idle: the
    operator's sweep from a shell."""
    last_sweep: Optional[float] = None
    while not stop.is_set():
        try:
            outcome = await poll_once(session_factory, client)
        except Exception:  # noqa: BLE001 — a worker that dies takes every upload with it
            log.exception("poll raised unexpectedly; the worker keeps polling")
            outcome = Poll.NOT_READY
        if outcome is Poll.PROCESSED:
            continue
        if (
            outcome is Poll.IDLE
            and sweep_enabled
            and (last_sweep is None or clock() - last_sweep >= SWEEP_INTERVAL)
        ):
            # Stamped before the pass, so a slow or failed pass waits the
            # whole interval rather than running again on the next idle poll.
            last_sweep = clock()
            if await _sweep(session_factory) > 0:
                continue  # the marks are claimable now: drain them before sleeping
        if once:
            return 0 if outcome is Poll.IDLE else 1
        await sleep(_idle_delay())
    return 0


async def _serve(settings: WorkerSettings, *, once: bool) -> int:
    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    client = worker_client(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            # Windows: no signal handlers on the event loop; Ctrl-C still
            # raises KeyboardInterrupt into asyncio.run.
            pass
    log.info(
        "ingest worker starting: quarantine=%s published=%s once=%s sweep=%s",
        client.quarantine_bucket,
        client.published_bucket,
        once,
        "on" if settings.sweep_enabled else "off",
    )
    try:
        return await run(
            session_factory,
            client,
            stop=stop,
            once=once,
            sweep_enabled=settings.sweep_enabled,
        )
    finally:
        await engine.dispose()
        log.info("ingest worker stopped")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="CoveyKeep ingest worker")
    parser.add_argument(
        "--once",
        action="store_true",
        help="drain what is claimable now, then exit (0 = drained to idle, 1 = not ready)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    # Required with no default: a missing value fails HERE, at boot, naming
    # the field — in front of whoever deployed, never at the first claim.
    settings = WorkerSettings()
    return asyncio.run(_serve(settings, once=args.once))


if __name__ == "__main__":
    raise SystemExit(main())
