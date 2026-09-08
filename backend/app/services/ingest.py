"""Ingest — the worker's claim service (CK-35): claim, reclaim, retry, and the
permanent failure. NO image processing lives here yet: no decode, no EXIF
stripping, no derivative row, no publish — those are CK-36, and §3 below
says what this phase does with a claimed row instead.

The media row IS the job (media pipeline record §6.1) — there is no jobs
table, and everything a worker needs to know rides the row: `status` (the
rung), `attempts`, `available_at` (not claimable before), `claimed_at` (the
reclaim clock), `last_error`. The mechanics (record §6.2), as built:

CLAIM. `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over rows that are either
  - `uploaded` with `available_at` NULL or in the past, or
  - `processing` with `claimed_at` older than RECLAIM_AFTER (a stall),
oldest `created_at` first; stamp `claimed_at`, move to `processing`. A
`pending_upload` row is NEVER claimable: nothing was confirmed, and the
intent reap owns it. SKIP LOCKED is what lets two workers drain one queue
without ever taking the same row — pinned by test with two sessions.

RECLAIM. A deploy kills the worker mid-job as a matter of course (record
§8). The stalled row is RE-CLAIMED — never deleted and recreated, which would
lose its provenance — and the abandoned attempt is COUNTED: `attempts`
increments at reclaim, because a row that kills the worker (a decompression
bomb, until CK-36's pixel guard) would otherwise be reclaimed forever, which
is a crash loop by another name. A row abandoned MAX_ATTEMPTS times is
dead-lettered at reclaim rather than given a fourth run.

RETRY. A TRANSIENT failure — the store did not answer, or answered with
something other than present/absent — increments `attempts` and returns the
row to `uploaded` with `available_at` pushed down the backoff ladder
(RETRY_BACKOFF); the MAX_ATTEMPTS-th failure dead-letters instead. With three
attempts the third failure is terminal, so the ladder's last rung is reached
only if MAX_ATTEMPTS is ever raised; the record's "twenty-one minutes" is the
ladder's sum, and the quarantine time actually spent on a certainty at three
attempts is six minutes plus the polls — which is still six minutes more
than a permanent failure deserves, hence:

PERMANENT. A MISSING quarantine object is permanent and dead-letters on the
FIRST attempt (`attempts` = 1, never 3). The object cannot reappear: either
the upload never completed, or the bucket's 24-hour lifecycle rule removed
it before a worker ran — which is exactly the state CK-34's verification
left two deployed rows in, and the case this phase exists to handle
(`decisions/2026-09-08-upload-intent-limits-and-quota.md` §8). Transient and
permanent are different and must never be collapsed (record §6.2).

DEAD-LETTER. `status = 'failed'`, `last_error` naming the cause in operator
terms — the OUTCOME, never the file's contents (record §6.5), never a URL,
never a key id. Marking a row `failed` RELEASES its quota reservation: that
is already how `keeping.account_usage` reads the ladder (in-flight is
`pending_upload | uploaded | processing`), and this phase adds no second
mechanism — pinned by test (usage drops when a row dead-letters). The
record's "delete the quarantine object at that moment" is NOT built here:
this worker deletes nothing (module-level pin: no delete function is even
imported), and the deletion of a live original — at publish and at
dead-letter alike — lands with CK-36. Until then the lifecycle rule bounds
a dead-lettered row's object exactly as it bounds every other.

A THIRD CLASS the record did not name: a REJECTED CREDENTIAL. A HEAD that
fails with AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch is a
fact about the worker's configuration, not about the photograph. Treating
it as transient would dead-letter every photograph in the queue within
minutes of a mistyped dashboard value; treating it as permanent would be
worse. So the claim is RELEASED untouched — `attempts` unchanged,
`available_at` unchanged — and the loop backs off with a loud log line.

§3 — WHAT THIS PHASE DOES WITH A CLAIMED ROW WHOSE OBJECT IS PRESENT:
release it. Back to `uploaded`, `claimed_at` cleared, `attempts` NOT
incremented (nothing failed — nothing was attempted), `available_at`
pushed forward by NO_PROCESSOR_RECHECK so the row is not re-claimed on the
very next poll (a hot loop of HEADs against one row), and a log line saying
no processor exists yet. Not `processing` — that would be a stuck row the
reclaim timeout rescues every fifteen minutes forever. Not dead-lettered —
between this phase and CK-36 an upload can still arrive, and a worker that
dead-lettered a healthy photograph would destroy it. Releasing is the only
behaviour honest about the missing half and harmless to real rows. THIS
BRANCH IS SCAFFOLDING WITH A STATED EXPIRY: CK-36 deletes it and puts the
decode in its place.

Every function that writes leaves the commit to the caller (the worker
commits after the claim and again after the outcome, so the row lock is
held for the claim alone and never across a network call). Outcomes are
written with a GUARDED update — `WHERE status = 'processing' AND claimed_at
= <this claim's stamp>` — so a worker that stalled past RECLAIM_AFTER and
was reclaimed by another cannot overwrite the other's result.

DATA-HANDLING: this module names no person and reads no photograph. It logs
nothing itself (the worker logs media ids and outcomes — a row id is not
personal data; a key is a function of the id). `last_error` carries an
exception class and an S3 error code at most.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Media, MediaStatus
from app.services.storage import QuarantineClient, head_quarantine_object, quarantine_key

# A `processing` row whose claim is older than this is a stall — the worker
# that held it was killed (record §6.2, §8) — and is claimable again.
RECLAIM_AFTER = timedelta(minutes=15)

# Three attempts, then dead-letter (record §6.2). Counted on transient
# failures AND on abandoned claims (see RECLAIM in the module docstring).
MAX_ATTEMPTS = 3

# Backoff through `available_at` after the Nth failed attempt (record §6.2:
# 1m, 5m, 15m). Indexed by the number of failures so far; with MAX_ATTEMPTS
# at three the third failure is terminal and the 15-minute rung waits for a
# raised limit.
RETRY_BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=15))

# §3 scaffolding: how long a released row (object present, no processor)
# waits before the worker looks at it again. An hour means a row whose
# object the lifecycle rule takes is dead-lettered — and its reservation
# released — within the hour, without a hot loop of HEADs meanwhile.
# DELETED IN CK-36 with the branch that uses it.
NO_PROCESSOR_RECHECK = timedelta(hours=1)

# The store rejected the CREDENTIAL, not the request — the worker is
# misconfigured, and no row is at fault (the verifier script's own
# classification, CK-33).
CREDENTIAL_REJECTED_CODES = frozenset(
    {
        "AccessDenied",
        "Forbidden",
        "AllAccessDisabled",
        "InvalidAccessKeyId",
        "SignatureDoesNotMatch",
        "Unauthorized",
        "InvalidSignature",
        "AuthorizationHeaderMalformed",
        "InvalidToken",
        "ExpiredToken",
    }
)

# last_error texts — operator terms, the outcome and never the file.
ERROR_OBJECT_MISSING = (
    "quarantine object missing: the upload never completed, or the 24-hour "
    "quarantine ceiling removed it before the worker ran (permanent)"
)
ERROR_ABANDONED = (
    f"claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt"
)


class Outcome(str, Enum):
    """What handle_claimed did with the row it was given."""

    # §3 scaffolding: the object is there and nothing can process it yet.
    RELEASED = "released"
    DEAD_LETTERED = "dead_lettered"
    RETRY_SCHEDULED = "retry_scheduled"
    # The worker's credential was rejected: the row is untouched, the loop
    # must back off.
    MISCONFIGURED = "misconfigured"
    # Another worker reclaimed this row after a stall; this outcome is void.
    LOST_CLAIM = "lost_claim"


async def _head(client: QuarantineClient, key: str) -> Optional[tuple[int, str]]:
    """The worker's question — is the object still there? — run off the
    event loop (botocore blocks on the network). Tests stub this name."""
    return await asyncio.to_thread(head_quarantine_object, client, key=key)


def _claimable(now: datetime):
    stale_before = now - RECLAIM_AFTER
    return or_(
        and_(
            Media.status == MediaStatus.UPLOADED,
            or_(Media.available_at.is_(None), Media.available_at <= now),
        ),
        and_(
            Media.status == MediaStatus.PROCESSING,
            # A processing row with no claim stamp is malformed; treating it
            # as stale is the direction that rescues it rather than the one
            # that strands it.
            or_(Media.claimed_at.is_(None), Media.claimed_at < stale_before),
        ),
    )


async def claim_next(db: AsyncSession, now: datetime) -> Optional[Media]:
    """Claim the oldest claimable row, or None when there is nothing to do.

    On a fresh `uploaded` row: stamp `claimed_at`, move to `processing`,
    `attempts` unchanged. On a stalled `processing` row: the abandoned
    attempt is counted first — and if that reaches MAX_ATTEMPTS the row is
    dead-lettered here and returned at `failed` (the caller checks the rung)
    rather than run a fourth time. The caller commits, promptly: the row
    lock lasts for the claim alone."""
    row = (
        await db.execute(
            select(Media)
            .where(_claimable(now))
            .order_by(Media.created_at, Media.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    if row.status == MediaStatus.PROCESSING:
        row.attempts += 1
        if row.attempts >= MAX_ATTEMPTS:
            row.status = MediaStatus.FAILED
            row.claimed_at = None
            row.last_error = ERROR_ABANDONED
            await db.flush()
            return row
    row.status = MediaStatus.PROCESSING
    row.claimed_at = now
    await db.flush()
    return row


async def _settle(db: AsyncSession, row: Media, **values) -> bool:
    """Write an outcome for THIS claim only: the update is guarded on the
    row still being `processing` under this claim's `claimed_at`. Returns
    False when another worker has reclaimed the row meanwhile (the stall
    case) — the caller's outcome is then void and nothing is written."""
    result = await db.execute(
        update(Media)
        .where(
            Media.id == row.id,
            Media.status == MediaStatus.PROCESSING,
            Media.claimed_at == row.claimed_at,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return False
    await db.refresh(row)
    return True


async def handle_claimed(
    db: AsyncSession, client: QuarantineClient, row: Media, now: datetime
) -> Outcome:
    """What this phase does with a claimed row — see the module docstring.
    The caller commits."""
    key = quarantine_key(row.id)
    try:
        found = await _head(client, key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in CREDENTIAL_REJECTED_CODES:
            # The worker, not the row, is at fault: release untouched.
            applied = await _settle(db, row, status=MediaStatus.UPLOADED, claimed_at=None)
            return Outcome.MISCONFIGURED if applied else Outcome.LOST_CLAIM
        return await _transient_failure(db, row, now, f"{exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, exc.__class__.__name__)

    if found is None:
        # PERMANENT, on the first attempt: the object cannot reappear.
        applied = await _settle(
            db,
            row,
            status=MediaStatus.FAILED,
            claimed_at=None,
            attempts=row.attempts + 1,
            last_error=ERROR_OBJECT_MISSING,
        )
        return Outcome.DEAD_LETTERED if applied else Outcome.LOST_CLAIM

    # §3 scaffolding — the object is present and no processor exists yet.
    # Back to `uploaded`, nothing counted, looked at again in an hour.
    # CK-36 replaces this branch with the decode.
    applied = await _settle(
        db,
        row,
        status=MediaStatus.UPLOADED,
        claimed_at=None,
        available_at=now + NO_PROCESSOR_RECHECK,
    )
    return Outcome.RELEASED if applied else Outcome.LOST_CLAIM


async def _transient_failure(db: AsyncSession, row: Media, now: datetime, cause: str) -> Outcome:
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        applied = await _settle(
            db,
            row,
            status=MediaStatus.FAILED,
            claimed_at=None,
            attempts=attempts,
            last_error=f"storage did not answer after {attempts} attempts (last: {cause})",
        )
        return Outcome.DEAD_LETTERED if applied else Outcome.LOST_CLAIM
    backoff = RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
    applied = await _settle(
        db,
        row,
        status=MediaStatus.UPLOADED,
        claimed_at=None,
        attempts=attempts,
        available_at=now + backoff,
        # The cause of the LAST failure, kept while the row retries so an
        # operator can see why a row is climbing the ladder; overwritten by
        # the dead-letter text if it gets there.
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: storage did not answer ({cause})",
    )
    return Outcome.RETRY_SCHEDULED if applied else Outcome.LOST_CLAIM
