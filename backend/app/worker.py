"""The ingest worker — the second Render service (CK-35), processing
photographs since CK-36.

    python -m app.worker            # poll forever (the Render start command)
    python -m app.worker --once     # drain what is claimable now, then exit

This process holds the WORKER credential and nothing else (media pipeline
record §8, §11.1): its configuration is `WorkerSettings` — six values — and
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

`publication_state` is never touched: processing is not publishing
(record §5); the host's gate is unbuilt.

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
uploaded photograph, and the order above is the whole of its discipline —
derivatives committed before the original is deleted, never the reverse.
Log lines carry media ids, outcomes and byte counts — a row id is not
personal data and a key is a function of it. Never a URL, never a key id,
never a person, never the contents of anything. Uploads on the dev deploy
remain Steven's own test images (private-alpha scope).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
import signal
import sys
from datetime import datetime, timezone
from enum import Enum
from typing import Awaitable, Callable, Optional

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import WorkerSettings
from app.models import MediaStatus
from app.services import ingest
from app.services.storage import WorkerClient, worker_client

# Five seconds when idle, jittered (record §6.2): a fleet of workers restarted
# together must not poll in lockstep.
IDLE_POLL = 5.0
IDLE_JITTER = 1.0

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
    outcome has committed, the deletion of the quarantine original."""
    now = now or datetime.now(timezone.utc)
    try:
        async with session_factory() as db:
            row = await ingest.claim_next(db, now)
            await db.commit()
            if row is None:
                return Poll.IDLE
            if row.status == MediaStatus.FAILED:
                # Dead-lettered at reclaim: abandoned MAX_ATTEMPTS times. The
                # terminal state is committed; now the original goes.
                log.warning("media %s dead-lettered at reclaim: %s", row.id, row.last_error)
                await _delete_original(client, row)
                return Poll.PROCESSED
            outcome = await ingest.handle_claimed(db, client, row, now)
            await db.commit()
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
        # now may the original go (ingest.py, PUBLISH step 5).
        log.info("media %s: ready — three layers written (attempt %d)", row.id, row.attempts + 1)
        await _delete_original(client, row)
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


async def run(
    session_factory: async_sessionmaker[AsyncSession],
    client: WorkerClient,
    *,
    stop: asyncio.Event,
    once: bool = False,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """The loop. Drains while work remains; sleeps when idle; never exits on
    a failed poll. With `once`, returns after the first non-PROCESSED poll —
    0 if the queue was drained to idle, 1 if the database or the credential
    was not ready. `sleep` is injectable so tests drive it without waiting."""
    while not stop.is_set():
        try:
            outcome = await poll_once(session_factory, client)
        except Exception:  # noqa: BLE001 — a worker that dies takes every upload with it
            log.exception("poll raised unexpectedly; the worker keeps polling")
            outcome = Poll.NOT_READY
        if outcome is Poll.PROCESSED:
            continue
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
        "ingest worker starting: quarantine=%s published=%s once=%s",
        client.quarantine_bucket,
        client.published_bucket,
        once,
    )
    try:
        return await run(session_factory, client, stop=stop, once=once)
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
