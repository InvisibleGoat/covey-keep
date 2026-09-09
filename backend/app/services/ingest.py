"""Ingest — the worker's claim service (CK-35) and, since CK-36, the whole
of what it does with a claimed photograph: read the original, decode it,
strip it, render the three layers, write them, and make the row `ready`
in ONE transaction, and only then delete the original.

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
increments at reclaim, because a row that kills the worker would otherwise
be reclaimed forever, which is a crash loop by another name. A row
abandoned MAX_ATTEMPTS times is dead-lettered at reclaim rather than given
a fourth run. (With processing measured in seconds and a reclaim at 15
minutes, three deploys landing on one photograph is the implausible case
and the safe direction.)

RETRY. A TRANSIENT failure — the store did not answer, or answered with
something other than present/absent, on the HEAD, the read, or a write —
increments `attempts` and returns the row to `uploaded` with `available_at`
pushed down the backoff ladder (RETRY_BACKOFF); the MAX_ATTEMPTS-th failure
dead-letters instead. With three attempts the third failure is terminal, so
the ladder's last rung is reached only if MAX_ATTEMPTS is ever raised.

PERMANENT — three shapes, and every one dead-letters on the FIRST attempt
(`attempts` = 1, never 3), because a certainty does not deserve the ladder
and quarantine time is the one resource this architecture spends on purpose:
  - a MISSING quarantine object (the upload never completed, or the 24-hour
    lifecycle rule removed it before a worker ran — the state CK-34's two
    deployed orphans were in); a GET that finds the object gone after the
    HEAD found it present is the same case, raced by the rule;
  - an UNDECODABLE upload — not an image, not a supported format (a renamed
    .mov, a GIF), truncated or corrupt (processing.Undecodable);
  - an OVERSIZED image — more than ~50 megapixels (record §6.6: worker memory
    tracks pixels, not bytes; the decode is refused from the header before
    a pixel exists). A row that kept killing the worker would otherwise be
    the crash loop RECLAIM counts its way out of; this refuses it at once.
Transient and permanent are different and must never be collapsed (§6.2).

DEAD-LETTER. `status = 'failed'`, `last_error` naming the cause in operator
terms — the OUTCOME, never the file's contents (record §6.5), never a URL,
never a key id. Marking a row `failed` RELEASES its quota reservation: that
is already how `keeping.account_usage` reads the ladder (in-flight is
`pending_upload | uploaded | processing`), and no second mechanism exists —
pinned by test. THEN the quarantine object is deleted (record §6.2, "at
that moment") — after the terminal state has committed, never before it,
by the worker through `delete_original` (see PUBLISH for the ordering rule
both paths share).

TERMINAL ROWS CARRY NO JOB STATE (CK-37). `ready` and `failed` are the two
rungs nothing ever claims again, so both clear `claimed_at` (CK-35) AND
`available_at`: the deferral CK-36's two dead-letters kept from the CK-35
release was harmless only because the claim predicate happens to read
`uploaded`/`processing`, and stale state nobody nulls is how a later
predicate change acquires a surprise. And `attempts` counts EVERY attempt,
the one that ended the row included — a `ready` row reads `attempts = 1`
after a clean run, `2` after one abandoned claim — which is exactly the
number the worker's log line prints. Until CK-37 the success path left the
count where it was while the log said one more: two surfaces disagreeing
silently, which is worse than either number.

A THIRD CLASS the record did not name: a REJECTED CREDENTIAL. A request that
fails with AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch is a
fact about the worker's configuration, not about the photograph. Treating
it as transient would dead-letter every photograph in the queue within
minutes of a mistyped dashboard value; treating it as permanent would be
worse. So the claim is RELEASED untouched — `attempts` unchanged,
`available_at` unchanged — and the loop backs off with a loud log line.

PUBLISH — THE CRUX (record §8: "publish is the last step and is atomic,
never a sequence a restart can leave half-done"; the record's word for the
worker's `ready` step — everywhere else in this corpus "publish" is the
host's `pending → live` gate, which this module never touches). The order,
and each step's failure mode, deliberately:

  1. READ the original from quarantine (a missing object here is permanent;
     the store not answering is transient; a rejected credential releases).
  2. DECODE, TRANSPOSE, STRIP, RENDER the three layers in memory
     (processing.render_layers — Undecodable is permanent; anything else it
     raises is a worker bug, left to the loop's catch-all so the row stalls
     in `processing` and the reclaim rule counts the attempt).
  3. WRITE all three objects to the published bucket, keyed by
     storage.published_key(media_id, layer) — a pure function, so the
     writes are IDEMPOTENT BY CONSTRUCTION: a retry overwrites the same
     keys and can never leave a second set behind. A write failing is
     transient (the retry rewrites all three); a rejected credential
     releases the row.
  4. ONE TRANSACTION: the guarded update that moves the row to `ready`
     (claimed_at NULL, available_at NULL, last_error NULL, attempts counting
     this one) — FIRST, so a claim lost to a
     reclaim writes nothing at all; then any derivative rows the media id
     already has are deleted and the three fresh rows inserted, so a
     retry never trips `uq_media_derivatives_media_id_layer` (a row that
     reaches step 4 with rows already present is not this transaction's
     failure mode — step 4 either commits whole or not at all — but a
     re-queued photograph would be, and an IntegrityError dead-letter would
     read as a decode bug); then `gatherings.total_bytes` is incremented
     by the sum of the three layers' ACTUAL stored sizes in one UPDATE.
     The caller commits. The reservation releases in the same instant
     through the one quota path (`ready` is outside IN_FLIGHT_STATUSES —
     the baton keeping.py already holds; verified by test, not rebuilt):
     the reserved bytes were the declared upload size, the committed bytes
     are the derivatives' sum, and the two differ on purpose — the
     reservation over-counts in the safe direction (schema-shape record §4).
  5. ONLY AFTER THAT COMMIT the worker deletes the quarantine original
     (`delete_original`), and a failure there is NOT a failure of the row:
     the photograph is `ready`, the original lingers, and the 24-hour
     lifecycle rule collects it. A crash between 4 and 5 costs a lingering
     original the rule takes; a crash in the other order would cost the
     photograph permanently — which is why the order is not negotiable.
     Deleting an already-absent object is a SUCCESS (storage.py says why:
     Render runs two workers for ~61 seconds on every deploy).

`publication_state` is not touched on any path. Processing is not
publishing (record §5); the host's gate is unbuilt.

Every function that writes leaves the commit to the caller (the worker
commits after the claim and again after the outcome, so the row lock is
held for the claim alone and never across a network call). Outcomes are
written with a GUARDED update — `WHERE status = 'processing' AND claimed_at
= <this claim's stamp>` — so a worker that stalled past RECLAIM_AFTER and
was reclaimed by another cannot overwrite the other's result.

DATA-HANDLING: this module names no person. It reads the photograph's bytes
into memory for the length of one call and retains nothing; every rendition
is re-encoded from pixels with no metadata carried (processing.py — the
EXIF promise, made true here and pinned against real fixtures). It logs
nothing itself (the worker logs media ids and outcomes — a row id is not
personal data; a key is a function of it). `last_error` carries a stage
name, an exception class and an S3 error code at most.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Gathering, Media, MediaDerivative, MediaStatus
from app.services import processing
from app.services.processing import Rendition, Undecodable
from app.services.storage import (
    WorkerClient,
    delete_quarantine_object,
    head_quarantine_object,
    published_key,
    put_published_object,
    quarantine_key,
    read_quarantine_object,
)

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

# What botocore reports when the object is not there — on a HEAD the bare
# status, on a GET the S3 code.
_ABSENT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})

# last_error texts — operator terms, the outcome and never the file.
ERROR_OBJECT_MISSING = (
    "quarantine object missing: the upload never completed, or the 24-hour "
    "quarantine ceiling removed it before the worker ran (permanent)"
)
ERROR_ABANDONED = (
    f"claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt"
)
ERROR_UNDECODABLE = "could not process the upload as a photograph: {reason} (permanent)"


class Outcome(str, Enum):
    """What handle_claimed did with the row it was given."""

    # The three layers are written and the row is `ready` (the worker's
    # step — not the host's publication). The caller deletes the original
    # after committing.
    READY = "ready"
    DEAD_LETTERED = "dead_lettered"
    RETRY_SCHEDULED = "retry_scheduled"
    # The worker's credential was rejected: the row is untouched, the loop
    # must back off.
    MISCONFIGURED = "misconfigured"
    # Another worker reclaimed this row after a stall; this outcome is void.
    LOST_CLAIM = "lost_claim"


# The four blocking calls, each run off the event loop (botocore blocks on
# the network; Pillow on the CPU). Tests stub these names.


async def _head(client: WorkerClient, key: str) -> Optional[tuple[int, str]]:
    return await asyncio.to_thread(head_quarantine_object, client, key=key)


async def _read(client: WorkerClient, key: str) -> bytes:
    return await asyncio.to_thread(read_quarantine_object, client, key=key)


async def _render(data: bytes) -> tuple[Rendition, Rendition, Rendition]:
    return await asyncio.to_thread(processing.render_layers, data)


async def _put(client: WorkerClient, key: str, rendition: Rendition) -> None:
    await asyncio.to_thread(
        put_published_object,
        client,
        key=key,
        body=rendition.data,
        content_type=rendition.content_type,
        storage_class=rendition.storage_class,
    )


async def _delete(client: WorkerClient, key: str) -> None:
    await asyncio.to_thread(delete_quarantine_object, client, key=key)


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
    dead-lettered here and returned at `failed` (the caller checks the rung
    and deletes the original after committing) rather than run a fourth
    time. The caller commits, promptly: the row lock lasts for the claim
    alone."""
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
            row.available_at = None  # terminal: no deferral survives (CK-37)
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


def _error_code(exc: ClientError) -> Optional[str]:
    return exc.response.get("Error", {}).get("Code")


async def handle_claimed(
    db: AsyncSession, client: WorkerClient, row: Media, now: datetime
) -> Outcome:
    """Everything between the claim and the outcome — see PUBLISH in the
    module docstring for the order and why. The caller commits, and after
    a READY or DEAD_LETTERED commit calls delete_original."""
    key = quarantine_key(row.id)

    # 1. Is the object there, and then: the bytes.
    try:
        found = await _head(client, key)
        if found is None:
            return await _permanent_failure(db, row, ERROR_OBJECT_MISSING)
        try:
            data = await _read(client, key)
        except ClientError as exc:
            if _error_code(exc) in _ABSENT_CODES:
                # Raced by the lifecycle rule between the HEAD and the GET:
                # the same permanent case.
                return await _permanent_failure(db, row, ERROR_OBJECT_MISSING)
            raise
    except ClientError as exc:
        code = _error_code(exc)
        if code in CREDENTIAL_REJECTED_CODES:
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__}")

    # 2. Decode, transpose, strip, render — permanent when it cannot be done.
    try:
        renditions = await _render(data)
    except Undecodable as exc:
        return await _permanent_failure(db, row, ERROR_UNDECODABLE.format(reason=exc.reason))
    del data

    # 3. The three objects, keyed deterministically — idempotent writes.
    try:
        for rendition in renditions:
            await _put(client, published_key(row.id, rendition.layer), rendition)
    except ClientError as exc:
        code = _error_code(exc)
        if code in CREDENTIAL_REJECTED_CODES:
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__}")

    # 4. One transaction: the row to `ready`, the derivative rows, the
    # gathering's bytes. The guarded update goes first so a lost claim
    # writes nothing at all. The attempt that succeeded is counted and the
    # deferral cleared — a terminal row carries no job state (CK-37).
    applied = await _settle(
        db,
        row,
        status=MediaStatus.READY,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=None,
    )
    if not applied:
        return Outcome.LOST_CLAIM
    await db.execute(
        delete(MediaDerivative)
        .where(MediaDerivative.media_id == row.id)
        .execution_options(synchronize_session=False)
    )
    db.add_all(
        MediaDerivative(
            media_id=row.id,
            layer=rendition.layer,
            storage_key=published_key(row.id, rendition.layer),
            content_type=rendition.content_type,
            size_bytes=rendition.size_bytes,
            storage_class=rendition.storage_class,
        )
        for rendition in renditions
    )
    stored = sum(rendition.size_bytes for rendition in renditions)
    await db.execute(
        update(Gathering)
        .where(Gathering.id == row.gathering_id)
        .values(total_bytes=Gathering.total_bytes + stored)
        .execution_options(synchronize_session=False)
    )
    await db.flush()
    return Outcome.READY


async def delete_original(client: WorkerClient, media_id: UUID) -> bool:
    """Step 5, and the dead-letter's counterpart: delete the quarantine
    original AFTER the terminal state has committed. Returns False — and
    raises nothing — when the store would not do it: the row is already
    `ready` or `failed`, the original lingers, and the 24-hour lifecycle
    rule takes it. An absent object is a success (storage.py)."""
    try:
        await _delete(client, quarantine_key(media_id))
    except (ClientError, BotoCoreError):
        return False
    return True


async def _permanent_failure(db: AsyncSession, row: Media, last_error: str) -> Outcome:
    # On the first attempt, whatever the count was: the ladder is for
    # failures that a retry can change.
    applied = await _settle(
        db,
        row,
        status=MediaStatus.FAILED,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=last_error,
    )
    return Outcome.DEAD_LETTERED if applied else Outcome.LOST_CLAIM


async def _release_misconfigured(db: AsyncSession, row: Media) -> Outcome:
    # The worker, not the row, is at fault: release untouched.
    applied = await _settle(db, row, status=MediaStatus.UPLOADED, claimed_at=None)
    return Outcome.MISCONFIGURED if applied else Outcome.LOST_CLAIM


async def _transient_failure(db: AsyncSession, row: Media, now: datetime, cause: str) -> Outcome:
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        applied = await _settle(
            db,
            row,
            status=MediaStatus.FAILED,
            claimed_at=None,
            available_at=None,
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
        # the dead-letter text if it gets there, cleared at `ready`.
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: storage did not answer ({cause})",
    )
    return Outcome.RETRY_SCHEDULED if applied else Outcome.LOST_CLAIM
