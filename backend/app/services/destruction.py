"""Destruction — the entry to the destruction ladder (CK-54's marking
statement, extracted from the API at CK-58 and homed here at CK-59).

WHY THIS MODULE EXISTS, AND WHY ITS BOUNDARY IS WHERE IT IS. The module
boundary follows the CALLER SET, which is the honest reason for it.
`mark_for_destruction` is called by the web service
(`api/media.py::destroy_media` — a person's choice) and, from CK-59, by
the worker (the 30-day sweep — the clock); `handle_destroying`, the
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

DATA-HANDLING: this module names no person and reads no word. The one
statement it carries marks a `ready` photograph — photographs of
children among them — for destruction and uncounts it; every mark today
is one a person chose through `api/media.py` (the host, or the uploader
for their own). The row survives with its provenance and its words (bin
record §7.2), invisible from the moment the caller commits. Nothing is
logged.
"""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Gathering, Media, MediaDerivative, MediaStatus


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
    endpoint commits per request, the sweep will choose its own per row —
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
