"""Cover ingest — the worker's SECOND LADDER: an uploaded cover picture,
processed and made its subject's cover, or destroyed (CK-83b;
decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3).

WORKER-ONLY, AND THE API NEVER IMPORTS IT — nor `ingest`, nor `processing`
(the CK-59 boundary, re-asserted by `import app.main` in the suite). What
both sides call lives in services/covers.py, which imports the models and
SQLAlchemy alone.

THE ROW IS THE JOB (`cover_images`, migration 0036), and this ladder MIRRORS
THE MEDIA LADDER'S OUTCOMES AND RULES (services/ingest.py, whose module
docstring is the long form of every rule below; it is not repeated here):

CLAIM. `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over rows that are
  `uploaded` and available, `processing` with a claim older than
  RECLAIM_AFTER (a stall — the abandoned attempt counted, MAX_ATTEMPTS
  abandonments dead-lettered at reclaim), or `destroying` with attempts
  left (claimed in place — the rung is both the queue and the claim),
  oldest `created_at` first. A `pending_upload` row is never claimable.
RETRY. The store not answering is TRANSIENT: back to `uploaded` down
  RETRY_BACKOFF; the MAX_ATTEMPTS-th failure dead-letters.
PERMANENT. A missing original, an undecodable upload and an oversized one
  dead-letter on the FIRST attempt — `failed`, `last_error` in operator
  terms, `failure_reason` for the person, in one guarded statement — and
  THE SUBJECT'S COVER IS UNTOUCHED: the old cover, or none, stands.
A REJECTED CREDENTIAL releases the row unpenalised — `attempts` and
  `available_at` untouched, ERROR_CREDENTIAL_REJECTED written to
  `last_error` (CK-57) — through `ingest._is_credential_rejected`, the ONE
  place that knows botocore's two shapes (the CK-61 Gotcha: a HEAD's error
  is the bare status). The loop backs off exactly as for a photograph.
GUARDED OUTCOMES. Every outcome is written `WHERE status = <the claimed
  rung> AND claimed_at = <this claim>`, so a worker reclaimed after a stall
  writes nothing.

WHAT IS NEW: THE LATEST ACT WINS. On one subject an upload intent, a set
from a photograph and a clear each supersede every upload still in flight
(services/covers.py). A `processing` row — one THIS worker may hold — is
never moved by the API: it is only flagged with `superseded_at`, because
THE WORKER NEVER DELETES AN OBJECT IT MAY STILL WRITE. So every outcome
here from `processing` is guarded on `superseded_at IS NULL` as well, and a
row found flagged is SETTLED TO `destroying` INSTEAD — after this worker's
writes, never before them (CK-54's publish-then-destroy order) — whatever
the outcome would have been: a ready render, a dead-letter, a retry or a
release. A flagged row therefore never becomes `ready`, never becomes the
cover, and never sits at `failed` or `uploaded` carrying the flag; its
objects are deleted by the destruction step below, from the same queue.

READY — ONE TRANSACTION, THE LOCK ORDER THE API TAKES (services/covers.py):
  1. THE SUBJECT'S ROW LOCK (`lock_subject`, `SELECT … FOR UPDATE` on the
     gathering or the group) — where every cover writer takes turns. An act
     that holds it first has already flagged this row, and the guard below
     sees it; an act that comes after waits, then sees this cover and
     retires it.
  2. THIS ROW: the guarded UPDATE to `ready` with the two layers' facts,
     only if still `processing` under this claim AND not superseded.
  3. THE SUBJECT'S COVER SET TO THIS IMAGE — `cover_media_id` NULL,
     `cover_image_id` this row, `cover_set_at` now (the cover's version),
     `cover_set_by_person_id` the uploader — and THE IMAGE IT REPLACES
     RETIRED (`ready` → `destroying`, `retire_cover_image`): the subject,
     then its own row, then the retired row.
  The caller commits, and only then deletes the quarantine original (the
  publish order: a crash between costs a lingering original the 24-hour
  rule collects, never the cover).

DESTROY — `destroying` → `destroyed`, CK-54's order: BOTH PUBLISHED OBJECTS,
THEN THE QUARANTINE ORIGINAL, deleted FIRST (an absent object is a success,
so the retry is idempotent by construction), then `destroyed` committed with
the layers' facts cleared — a tombstone carries no image, and the row is
kept as provenance. A spent destruction stays at `destroying` with its
`last_error` (never `failed`). Every destruction here is owed by a person's
act — a later upload, a set, a clear — or by a flagged row's settle: there is
no sweep on this ladder and no clock.

TWO LAYERS, NOT THREE: `processing.render_cover_layers` — the photographs'
own decode, orientation, stripping and derivation through one shared code
path, without encoding the archival layer (a cover is never printed). The
keys are `storage.cover_quarantine_key` and `storage.cover_published_key` —
`covers/<id>`, `covers/<id>/web`, `covers/<id>/thumbnail` — never `media/…`,
so an uploaded cover's URL names no photograph.

NOTHING HERE IS COUNTED: not `photo_count`, not `total_bytes`, not the
quota. A cover image is not a photograph (the record §1.3).

DATA-HANDLING: this module names no person beyond copying the uploader's id
from the row onto the subject as the cover's setter (provenance, in no
body). It reads a picture's bytes into memory for one call and retains
nothing; the renditions are re-encoded from pixels with no metadata carried.
It logs nothing itself — the worker logs a cover image's id and outcome, as
it logs a photograph's — and `last_error` carries a stage name, an exception
class and an S3 error code at most.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from enum import Enum
from typing import Optional

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CoverImage, Gathering, Group, MediaFailureReason, MediaLayer, MediaStatus
from app.services import processing
from app.services.covers import lock_subject, retire_cover_image
from app.services.ingest import (
    MAX_ATTEMPTS,
    RECLAIM_AFTER,
    RETRY_BACKOFF,
    _ABSENT_CODES,
    _error_code,
    _is_credential_rejected,
)
from app.services.processing import Rendition, Undecodable
from app.services.storage import (
    WorkerClient,
    cover_published_key,
    cover_quarantine_key,
    delete_published_object,
    delete_quarantine_object,
    head_quarantine_object,
    put_published_object,
    read_quarantine_object,
)

# The two layers a cover has, in the order they are written and destroyed.
COVER_LAYERS = (MediaLayer.WEB, MediaLayer.THUMBNAIL)

# last_error texts — operator terms, the outcome and never the file. The
# media ladder's own texts say "photograph"; these say what this is.
ERROR_OBJECT_MISSING = (
    "quarantine object missing: the cover upload never completed, or the 24-hour "
    "quarantine ceiling removed it before the worker ran (permanent)"
)
ERROR_ABANDONED = (
    f"claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt"
)
ERROR_UNDECODABLE = "could not process the upload as a cover picture: {reason} (permanent)"
ERROR_DESTROY_ABANDONED = (
    f"destruction claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt; the stored objects may still exist"
)
ERROR_DESTROY_FAILED = (
    "destruction could not delete the stored objects after {attempts} attempts "
    "(last: {cause}); the objects may still exist"
)
ERROR_CREDENTIAL_REJECTED = (
    "the store rejected the worker's credential: a fact about the worker's "
    "configuration, not about the cover picture; the row is queued and untouched, "
    "and runs as soon as the credential is fixed"
)


class Outcome(str, Enum):
    """What a handler did with the cover image it was given."""

    # The two layers are written, the row is `ready`, and it is the
    # subject's cover. The caller deletes the original after committing.
    READY = "ready"
    # The row had been superseded by a later act: it was settled to
    # `destroying` after this worker's writes, and the destruction step
    # deletes its objects. The subject's cover is the later act's.
    SUPERSEDED = "superseded"
    DESTROYED = "destroyed"
    DESTROY_ABANDONED = "destroy_abandoned"
    DEAD_LETTERED = "dead_lettered"
    RETRY_SCHEDULED = "retry_scheduled"
    MISCONFIGURED = "misconfigured"
    LOST_CLAIM = "lost_claim"


# The blocking calls, each run off the event loop — this module's OWN names,
# so a test of this ladder stubs these and a test of the media ladder stubs
# ingest's, and neither reaches the other.


async def _head(client: WorkerClient, key: str) -> Optional[tuple[int, str]]:
    return await asyncio.to_thread(head_quarantine_object, client, key=key)


async def _read(client: WorkerClient, key: str) -> bytes:
    return await asyncio.to_thread(read_quarantine_object, client, key=key)


async def _render(data: bytes) -> tuple[Rendition, Rendition]:
    return await asyncio.to_thread(processing.render_cover_layers, data)


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


async def _delete_published(client: WorkerClient, key: str) -> None:
    await asyncio.to_thread(delete_published_object, client, key=key)


def _claimable(now: datetime):
    stale_before = now - RECLAIM_AFTER
    return or_(
        and_(
            CoverImage.status == MediaStatus.UPLOADED,
            or_(CoverImage.available_at.is_(None), CoverImage.available_at <= now),
        ),
        and_(
            CoverImage.status == MediaStatus.PROCESSING,
            or_(CoverImage.claimed_at.is_(None), CoverImage.claimed_at < stale_before),
        ),
        # The destruction rung, claimed in place — the media ladder's
        # predicate, and for its reasons: `claimed_at` NULL means "marked,
        # never claimed"; `attempts < MAX_ATTEMPTS` is what stops a spent
        # destruction being claimed forever, since it keeps its rung.
        and_(
            CoverImage.status == MediaStatus.DESTROYING,
            CoverImage.attempts < MAX_ATTEMPTS,
            or_(CoverImage.available_at.is_(None), CoverImage.available_at <= now),
            or_(CoverImage.claimed_at.is_(None), CoverImage.claimed_at < stale_before),
        ),
    )


def _destroying_values() -> dict:
    """A row settled to `destroying` with fresh job columns — the marking
    statement's reset (CK-54), so a destruction gets its own three attempts
    whatever the upload spent."""
    return dict(
        status=MediaStatus.DESTROYING,
        attempts=0,
        available_at=None,
        claimed_at=None,
        last_error=None,
    )


async def claim_next(db: AsyncSession, now: datetime) -> Optional[CoverImage]:
    """Claim the oldest claimable cover image, or None — ingest.claim_next's
    rules exactly (see the module docstring), with one addition: a stalled
    `processing` row abandoned MAX_ATTEMPTS times that a later act had
    SUPERSEDED goes to `destroying`, not `failed` — a flagged row never
    rests at `failed` — and is returned unclaimed like any dead-letter at
    reclaim. The caller tells a claim from a dead-letter by `claimed_at`,
    as on the media ladders. The caller commits, promptly."""
    row = (
        await db.execute(
            select(CoverImage)
            .where(_claimable(now))
            .order_by(CoverImage.created_at, CoverImage.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    destroying = row.status == MediaStatus.DESTROYING
    abandoned = row.status == MediaStatus.PROCESSING or (destroying and row.claimed_at is not None)
    if abandoned:
        row.attempts += 1
        if row.attempts >= MAX_ATTEMPTS:
            if destroying:
                row.last_error = ERROR_DESTROY_ABANDONED
                row.claimed_at = None
                row.available_at = None
            elif row.superseded_at is not None:
                for name, value in _destroying_values().items():
                    setattr(row, name, value)
            else:
                row.status = MediaStatus.FAILED
                row.last_error = ERROR_ABANDONED
                row.failure_reason = MediaFailureReason.INTERRUPTED
                row.claimed_at = None
                row.available_at = None
            await db.flush()
            return row
    if not destroying:
        row.status = MediaStatus.PROCESSING
    row.claimed_at = now
    await db.flush()
    return row


async def _settle(db: AsyncSession, row: CoverImage, **values) -> bool:
    """Write an outcome for THIS claim only, on a row this claim holds and
    that NO LATER ACT HAS SUPERSEDED: guarded on the claimed rung, this
    claim's `claimed_at`, and — on the upload's own rung — `superseded_at IS
    NULL`. False when either guard fails; the caller then asks
    `_settle_superseded` which one it was."""
    guards = [
        CoverImage.id == row.id,
        CoverImage.status == row.status,
        CoverImage.claimed_at == row.claimed_at,
    ]
    if row.status == MediaStatus.PROCESSING:
        guards.append(CoverImage.superseded_at.is_(None))
    result = await db.execute(
        update(CoverImage)
        .where(*guards)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return False
    await db.refresh(row)
    return True


async def _settle_superseded(db: AsyncSession, row: CoverImage) -> bool:
    """THE FLAGGED ROW'S SETTLE: a `processing` row this claim still holds
    that a later act has flagged goes to `destroying` — after this worker's
    writes, which is why the API only ever flags it — and the destruction
    step deletes what was written. False when the claim was lost instead."""
    if row.status != MediaStatus.PROCESSING:
        return False
    result = await db.execute(
        update(CoverImage)
        .where(
            CoverImage.id == row.id,
            CoverImage.status == MediaStatus.PROCESSING,
            CoverImage.claimed_at == row.claimed_at,
            CoverImage.superseded_at.is_not(None),
        )
        .values(**_destroying_values())
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return False
    await db.refresh(row)
    return True


async def _outcome(db: AsyncSession, row: CoverImage, outcome: Outcome, **values) -> Outcome:
    """Every outcome from a claim goes through here: the guarded write, else
    the flagged row's settle, else a lost claim."""
    if await _settle(db, row, **values):
        return outcome
    if await _settle_superseded(db, row):
        return Outcome.SUPERSEDED
    return Outcome.LOST_CLAIM


def _subject_of(row: CoverImage):
    return (Gathering, row.gathering_id) if row.gathering_id is not None else (Group, row.group_id)


async def handle_claimed(
    db: AsyncSession, client: WorkerClient, row: CoverImage, now: datetime
) -> Outcome:
    """Everything between the claim and the outcome for an upload — read,
    render, write, and the READY transaction (the module docstring). The
    caller commits, and after a READY or DEAD_LETTERED commit calls
    delete_original."""
    key = cover_quarantine_key(row.id)

    # 1. Is the object there, and then: the bytes.
    try:
        found = await _head(client, key)
        if found is None:
            return await _permanent_failure(
                db, row, ERROR_OBJECT_MISSING, MediaFailureReason.UPLOAD_INCOMPLETE
            )
        try:
            data = await _read(client, key)
        except ClientError as exc:
            # The same GET-after-HEAD race the media ladder names; the absent
            # codes are ingest's set, imported and never copied.
            if _error_code(exc) in _ABSENT_CODES:
                return await _permanent_failure(
                    db, row, ERROR_OBJECT_MISSING, MediaFailureReason.UPLOAD_INCOMPLETE
                )
            raise
    except ClientError as exc:
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__} ({_error_code(exc)})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__}")

    # 2. Decode, transpose, strip, render — the photographs' own path.
    try:
        renditions = await _render(data)
    except Undecodable as exc:
        return await _permanent_failure(db, row, ERROR_UNDECODABLE.format(reason=exc.reason), exc.kind)
    del data

    # 3. The two objects, keyed deterministically — idempotent writes.
    try:
        for rendition in renditions:
            await _put(client, cover_published_key(row.id, rendition.layer), rendition)
    except ClientError as exc:
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__} ({_error_code(exc)})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__}")

    # 4. ONE TRANSACTION, in the lock order every cover writer takes: the
    # subject, then this row, then the image this one replaces.
    subject, subject_id = _subject_of(row)
    replaced = await lock_subject(db, subject, subject_id)
    web, thumbnail = renditions
    outcome = await _outcome(
        db,
        row,
        Outcome.READY,
        status=MediaStatus.READY,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=None,
        web_content_type=web.content_type,
        web_size_bytes=web.size_bytes,
        thumbnail_content_type=thumbnail.content_type,
        thumbnail_size_bytes=thumbnail.size_bytes,
    )
    if outcome is not Outcome.READY:
        # Superseded meanwhile (the latest act's cover stands, and this row
        # is now owed a destruction), or the claim was lost: the subject is
        # not written.
        return outcome
    await db.execute(
        update(subject)
        .where(subject.id == subject_id)
        .values(
            cover_media_id=None,
            cover_image_id=row.id,
            # The transaction's clock — the cover's version.
            cover_set_at=func.now(),
            cover_set_by_person_id=row.uploaded_by_person_id,
        )
        .execution_options(synchronize_session=False)
    )
    if replaced is not None and replaced != row.id:
        await retire_cover_image(db, replaced)
    await db.flush()
    return Outcome.READY


async def handle_destroying(
    db: AsyncSession, client: WorkerClient, row: CoverImage, now: datetime
) -> Outcome:
    """DESTROY A COVER IMAGE — CK-54's order: both published objects, then
    the quarantine original, deleted FIRST (absent is success), then
    `destroyed` committed with the layers' facts cleared. The caller
    commits; nothing is deleted afterwards. The keys are derived from the
    id — the row stores none — so a row that never reached `ready` (a
    superseded upload) is destroyed by the same three deletes, each of an
    object that may never have existed."""
    keys = [cover_published_key(row.id, layer) for layer in COVER_LAYERS]
    try:
        for key in keys:
            await _delete_published(client, key)
        await _delete(client, cover_quarantine_key(row.id))
    except ClientError as exc:
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _destroy_failure(db, row, now, f"delete: {exc.__class__.__name__} ({_error_code(exc)})")
    except BotoCoreError as exc:
        return await _destroy_failure(db, row, now, f"delete: {exc.__class__.__name__}")

    applied = await _settle(
        db,
        row,
        status=MediaStatus.DESTROYED,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=None,
        web_content_type=None,
        web_size_bytes=None,
        thumbnail_content_type=None,
        thumbnail_size_bytes=None,
    )
    if not applied:
        return Outcome.LOST_CLAIM
    await db.flush()
    return Outcome.DESTROYED


async def _destroy_failure(db: AsyncSession, row: CoverImage, now: datetime, cause: str) -> Outcome:
    """The destruction ladder's transient rung — the media ladder's shape: the
    rung does not move, and a spent ladder stays `destroying` with its
    last_error, honest about owing a deletion."""
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        applied = await _settle(
            db,
            row,
            claimed_at=None,
            available_at=None,
            attempts=attempts,
            last_error=ERROR_DESTROY_FAILED.format(attempts=attempts, cause=cause),
        )
        return Outcome.DESTROY_ABANDONED if applied else Outcome.LOST_CLAIM
    backoff = RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
    applied = await _settle(
        db,
        row,
        claimed_at=None,
        attempts=attempts,
        available_at=now + backoff,
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: could not delete the stored objects ({cause})",
    )
    return Outcome.RETRY_SCHEDULED if applied else Outcome.LOST_CLAIM


async def delete_original(client: WorkerClient, row: CoverImage) -> bool:
    """After a terminal upload outcome has COMMITTED — `ready` or `failed` —
    delete the quarantine original; after `failed`, the two published keys
    too, since a dead-letter after a transient write failure can leave a
    layer written and nothing else would ever delete it (deleting an absent
    object is a success, so this costs nothing when none was). Returns False
    — and raises nothing — when the store would not; the 24-hour rule takes
    a lingering original."""
    try:
        if row.status == MediaStatus.FAILED:
            for layer in COVER_LAYERS:
                await _delete_published(client, cover_published_key(row.id, layer))
        await _delete(client, cover_quarantine_key(row.id))
    except (ClientError, BotoCoreError):
        return False
    return True


async def _permanent_failure(
    db: AsyncSession, row: CoverImage, last_error: str, reason: MediaFailureReason
) -> Outcome:
    """Dead-letter on the FIRST attempt; the subject's cover is not touched.
    A flagged row goes to `destroying` instead (`_outcome`)."""
    return await _outcome(
        db,
        row,
        Outcome.DEAD_LETTERED,
        status=MediaStatus.FAILED,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=last_error,
        failure_reason=reason,
    )


async def _release_misconfigured(db: AsyncSession, row: CoverImage) -> Outcome:
    """The worker, not the row, is at fault: release unpenalised to the rung
    it came from, with the reason written (CK-57) — `uploaded` for an
    upload, `destroying` (its own queue) for a destruction. A flagged upload
    goes to `destroying` instead: a superseded row never waits at
    `uploaded`."""
    released = (
        MediaStatus.DESTROYING if row.status == MediaStatus.DESTROYING else MediaStatus.UPLOADED
    )
    return await _outcome(
        db, row, Outcome.MISCONFIGURED, status=released, claimed_at=None, last_error=ERROR_CREDENTIAL_REJECTED
    )


async def _transient_failure(db: AsyncSession, row: CoverImage, now: datetime, cause: str) -> Outcome:
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        return await _outcome(
            db,
            row,
            Outcome.DEAD_LETTERED,
            status=MediaStatus.FAILED,
            claimed_at=None,
            available_at=None,
            attempts=attempts,
            last_error=f"storage did not answer after {attempts} attempts (last: {cause})",
            failure_reason=MediaFailureReason.INTERRUPTED,
        )
    backoff = RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
    return await _outcome(
        db,
        row,
        Outcome.RETRY_SCHEDULED,
        status=MediaStatus.UPLOADED,
        claimed_at=None,
        attempts=attempts,
        available_at=now + backoff,
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: storage did not answer ({cause})",
    )
