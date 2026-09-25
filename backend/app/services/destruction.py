"""Destruction — the entry to the destruction ladder (CK-54's marking
statement, extracted from the API at CK-58 and homed here at CK-59), and
the sweep that walks the bin into it on a clock (CK-59; bin record §6).

WHY THIS MODULE EXISTS, AND WHY ITS BOUNDARY IS WHERE IT IS. The module
boundary follows the CALLER SET, which is the honest reason for it.
`mark_for_destruction` is called by the web service
(`api/media.py::destroy_media` — a person's choice) and by the worker
(`sweep_expired_bin` below — the 30-day sweep, the clock); `handle_destroying`, the
ladder's next step, which deletes the stored objects, is called by the
worker alone and STAYS in `services/ingest.py` beside the claim, the
store calls and the processing it genuinely needs. CK-58 put the marking
statement in `ingest.py`, and the consequence was not traced at the time:
`api/media.py` had never imported that module, and importing it pulls
`services/processing.py` — Pillow and pillow-heif, an image codec stack
the API never executes — into the web process. CK-58 measured the import
time (within run-to-run noise) but not the resident memory, which is the
cost that matters on a starter instance, and the coupling was accidental
rather than chosen.

This module needs the models and sqlalchemy and nothing else — every one
of them something `api/media.py` already imports — so the web service's
import graph is what it was before CK-58. NOTHING HERE MAY IMPORT
`ingest`, `processing`, `storage` or botocore: the moment it does, the
coupling is back, one import away and invisible until someone measures.
`ingest.py` imports THIS module (the ladder reads whole from the module
that runs it), never the reverse.

THE SWEEP (`sweep_expired_bin`) is the bin's automatic half: the removed
photographs whose retrieval window — `REMOVED_BIN`, the number
`_visible_media` reads — has closed, marked through the one statement
above, ROW BY ROW and never by a bulk UPDATE, at most a batch per pass.
It marks and never destroys: a swept row is claimed and taken through
CK-54's routine by the worker exactly as a row the API marked, so there
is one destruction in the code, one decrement, and this module adds
neither. The worker owns when it runs (app/worker.py: from an idle poll
only, on an interval, and ONLY when `WorkerSettings.sweep_enabled` is
on — it ships OFF).

DATA-HANDLING: this module names no person and reads no word. The one
statement it carries marks a `ready` photograph — photographs of
children among them — for destruction and uncounts it. A mark is one a
person chose through `api/media.py` (the host, or the uploader for their
own), or one the sweep made because a removed photograph's retrieval
window closed — THE FIRST PATH IN THE PRODUCT THAT DESTROYS A PHOTOGRAPH
WITHOUT A PERSON ASKING, which is why it ships dark behind a switch the
operator turns on deliberately, and why it only marks: every destruction
still passes through the one audited routine. The row survives with its
provenance and its words (bin record §7.2), invisible from the moment
the caller commits. Nothing is logged here; the worker logs a count.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Gathering, Media, MediaDerivative, MediaStatus, PublicationState
from app.services.retention import REMOVED_BIN


async def mark_for_destruction(db: AsyncSession, row: Media) -> bool:
    """THE ENTRY TO THE DESTRUCTION LADDER: mark a `ready` photograph
    `destroying` and uncount it, in the caller's transaction — CK-54's
    marking statement, extracted from `api/media.py::destroy_media` at
    CK-58 so that it has ONE COPY AND TWO CALLERS: the endpoint today (a
    person's choice — the host's, or the uploader's for their own) and the
    30-day sweep from CK-59 (the clock). CK-54's whole shape was chosen so
    that the decrement rides the marking statement and cannot drift from
    it; a second copy typed into the worker is exactly how the two counts
    would come to diverge. Returns True when the row was marked and
    uncounted, False when it was not `ready` at that instant — and then
    NOTHING was written.

    Two statements, in this order, and the second only if the first took:

      1. The guarded mark — `UPDATE media … WHERE id = :id AND status =
         'ready'` — to `destroying`, with the four job columns RESET.
      2. The one `UPDATE gatherings` that drops `photo_count` and
         `total_bytes` together.

    THE `status = 'ready'` GUARD IS THIS FUNCTION'S, NOT THE CALLER'S.
    The endpoint's `_removal_refusal` also tests the rung — for the 409
    and its copy, a policy check on the row it read. This guard is the
    CONCURRENCY guard: it is what makes a double mark impossible whichever
    two callers reach one row — the sweep and a person in the same
    second, or one caller asked twice — because it reads the database at
    the instant of the write, never the caller's copy of the row (which
    may be stale; only `row.id` and `row.gathering_id` are read here).
    Two checks on one column doing two different jobs: keep both. Pinned:
    called twice on one row it marks once, and the counters move once.

    DOES NOT COMMIT. The caller owns the transaction boundary — the
    endpoint commits per request, the sweep chooses its own per row —
    and the caller decides what a False means (the endpoint's lost-race
    409; the sweep's "someone got there first", which is not an error).
    Nothing here reads a gathering's setting, a quota or a publication
    state: `publication_state` keeps whatever it had (bin record §7.2),
    and the row survives, words and all — invisible from the moment the
    caller commits, because `api/media.py::_visible_media` excludes the
    rung."""
    # The guarded mark. The job columns are RESET, not carried: a
    # photograph that took two attempts to ingest still gets three to be
    # destroyed, and a stale `last_error` from an ingest retry would read
    # as a destruction failure the moment the row changed jobs.
    result = await db.execute(
        update(Media)
        .where(Media.id == row.id, Media.status == MediaStatus.READY)
        .values(
            status=MediaStatus.DESTROYING,
            attempts=0,
            available_at=None,
            claimed_at=None,
            last_error=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return False
    # ONE statement, both columns, in the same transaction as the mark
    # (CK-51a's increment, run backwards). The byte figure is the row's own
    # derivative rows — what was actually stored — summed inside the
    # statement so nothing can read one number and write another. NOT
    # clamped at zero: the invariant `photo_count` = the count of `ready`
    # rows is exact, so a negative here is a finding the verifier makes
    # loud, and a floor would only hide the one case where it happened to
    # come out right.
    stored = (
        select(func.coalesce(func.sum(MediaDerivative.size_bytes), 0))
        .where(MediaDerivative.media_id == row.id)
        .scalar_subquery()
    )
    await db.execute(
        update(Gathering)
        .where(Gathering.id == row.gathering_id)
        .values(
            total_bytes=Gathering.total_bytes - stored,
            photo_count=Gathering.photo_count - 1,
        )
        .execution_options(synchronize_session=False)
    )
    return True


async def sweep_expired_bin(db: AsyncSession, now: datetime, *, limit: int) -> int:
    """THE SWEEP — the bin's automatic half (CK-59; bin record §6, §6.1):
    find the removed photographs whose retrieval window has closed and
    mark each for destruction through `mark_for_destruction`, one row at a
    time, committing per row. Returns how many were marked. IT MARKS; IT
    DOES NOT DESTROY. The worker's claim loop takes a marked row through
    CK-54's routine (`ingest.handle_destroying`) exactly as it takes one
    the API marked, so there is one destruction in the code and one
    decrement, and this function adds neither — a second destruction here,
    or a second decrement, would be the defect the A/B split exists to
    prevent.

    THE CLOCK IS `REMOVED_BIN`, THE SAME NUMBER `_visible_media` READS
    (retention.py — one number, two readers). A removed photograph is
    visible to its uploader while `removed_at > now - REMOVED_BIN` and is
    swept once `removed_at <= now - REMOVED_BIN`: the two clocks meet at
    one instant with no gap and no overlap, so a photograph is never swept
    while someone could still see it, and never sits invisible-and-still-
    charged past the window (the hole §6.1 names, which nothing could
    reclaim until now). The candidates are `ready` (there are layers to
    destroy; every other rung has nothing stored or is already past the
    mark) AND `removed` AND stamped AND past the window, oldest
    `removed_at` first, at most `limit` of them.

    ROW BY ROW, NEVER A BULK UPDATE — this is the concurrency safety, and
    it only works per row. A bulk `UPDATE … WHERE removed_at < cutoff` that
    also decremented would decrement once per row PER WORKER, so two
    worker instances (`render.yaml` carries no `numInstances` today; it is
    one line away, and that block already warns about lines "helpfully"
    added) would double-decrement. `mark_for_destruction`'s own
    `status = 'ready'` guard makes the second marker's rowcount 0 and its
    return False — pinned at CK-58, called twice on one row it marks once
    — and that guard reads the database at the instant of each row's
    write. The SELECT here takes no lock for the same reason: a lock would
    be a second safety mechanism doing the guard's job, and one that reads
    as if it were the reason. A False from the mark is "someone got there
    first" — a person destroying the same photograph in the same second,
    or the other worker — which is not an error, so it is neither counted
    nor logged.

    COMMITTED PER ROW: `mark_for_destruction` never commits and its caller
    owns the boundary — the endpoint per request, this sweep per row — so
    each mark is durable the moment it lands, a crash mid-pass loses
    nothing already marked, and a row lock is held for one row's two
    statements and never across the pass. The loaded rows are expunged
    first so that no commit expires them: the mark reads `row.id` and
    `row.gathering_id` from the object, and an expired attribute on an
    async session is a lazy load that cannot run.

    NO MEMORIAL BRANCH, NO GATHERING-TYPE BRANCH, NO ACCOUNT BRANCH, AND NO
    FIXTURE EXEMPTION — each decided, none an oversight. A memorial's bin
    sweeps like any other (bin record §7.4, decided at CK-15 §2: permanence
    is a storage promise about the gathering, never a publication promise
    about a photograph in it). And there is no id allowlist and no date
    floor to spare any row (bin record §8, decided): a fixture-shaped
    branch in the one path that destroys people's photographs on a clock
    would outlive the fixtures. Record the evidence and let them go.

    `limit` bounds the batch because every mark becomes a destroy job on
    the same claim queue, and `claim_next` orders by `created_at` across
    BOTH ladders — a marked row is older than any fresh upload, so a
    pass's marks are all claimed before the next photograph someone adds.
    The worker chooses the number (`SWEEP_BATCH`) and says why there."""
    cutoff = now - REMOVED_BIN
    rows = (
        await db.execute(
            select(Media)
            .where(
                Media.status == MediaStatus.READY,
                Media.publication_state == PublicationState.REMOVED,
                Media.removed_at.is_not(None),
                Media.removed_at <= cutoff,
            )
            .order_by(Media.removed_at, Media.id)
            .limit(limit)
        )
    ).scalars().all()
    db.expunge_all()
    marked = 0
    for row in rows:
        # The mark reads the database, never this (possibly stale) row: a
        # False is the guard reporting that the row left `ready` since the
        # SELECT — a person, or another worker — and nothing was written.
        if await mark_for_destruction(db, row):
            marked += 1
        await db.commit()
    return marked
