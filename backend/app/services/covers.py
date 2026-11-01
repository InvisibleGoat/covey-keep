"""Covers — the one statement pair that clears a cover when its photograph
stops being published (CK-83a), and, since CK-83b, the three statements by
which THE LATEST ACT WINS on an uploaded cover (decisions/2026-10-31-the-
design-and-how-it-is-merged.md §1.3).

A gathering and a group each carry a cover as a POINTER on their own row —
`cover_media_id`, `cover_set_at`, `cover_set_by_person_id`, all set or all
NULL (migration 0035's CHECK) — set by an organiser through api/covers.py
from a photograph that is `ready` and `live`. The rule this module keeps:
A COVER CHOSEN FROM A PHOTOGRAPH CLEARS WHEN THAT PHOTOGRAPH STOPS BEING
PUBLISHED — sent to a bin, removed, or deleted. A photograph its uploader
took back must not live on as a cover.

CLEARED, NEVER RESOLVED THROUGH LIVENESS. A pointer that outlived its
photograph and was filtered out at read time ("show the cover only while
the photograph is live") would be a second representation of "is this the
cover" — and a restore would quietly bring the cover back, which the rule
forbids. So the transaction that stops a photograph being published NULLs
every pointer to it, here, and nothing reads a cover through the
photograph's state.

THE CALLERS, and why only these: `api/media.py::remove_media` (to the bin,
the takedown) after its guarded removal statement, and
`services/destruction.py::mark_for_destruction` after its marking statement
and only when it marked the row — which reaches the destroy endpoint and
the 30-day sweep through that one copy. Nothing else stops a cover being
published: a cover is always `ready` and `live`, so decline (pending only),
dismiss (failed only) and restore (removed only) never meet one, and
RESTORE DOES NOT BRING A COVER BACK — the pointer is gone.

THE LOCK ORDER IS THE PHOTOGRAPH, THEN THE SUBJECT, on every path: removal
and destruction lock the media row (`FOR UPDATE`) before they reach these
UPDATEs, and the set path takes the media row `FOR SHARE` before it writes
the subject (api/covers.py). Under READ COMMITTED a clearing UPDATE cannot
see a cover set by a transaction that has not committed, so without that
order a cover set in the same instant as its photograph's removal could
commit pointing at a removed photograph; with it, whichever takes the
photograph's lock first wins — a set that wins is cleared by the removal
waiting behind it, and a removal that wins makes the set read a removed
photograph and refuse.

THE SECOND SOURCE (CK-83b): AN UPLOADED COVER, AND THE LATEST ACT WINS.
A cover can also be a picture an organiser uploaded — a `cover_images` row,
never a photograph — pointed at by the subject's `cover_image_id`. On one
subject three acts each make the newest choice the one that stands: an
upload intent, a set from a photograph, and a clear (api/covers.py); and the
worker's `ready` (services/cover_ingest.py) is where an upload becomes the
cover. Every one of them, in its own transaction:
  - takes THE SUBJECT'S ROW LOCK first (`lock_subject`) — the subject row
    is where cover writers take turns (the wholesale-replacement Gotcha's
    parent-row rule), and the SELECT … FOR UPDATE answers the uploaded cover
    the subject carries AFTER any writer ahead of it has committed;
  - an act SUPERSEDES every upload still in flight for the subject
    (`supersede_uploads`): a `pending_upload` or `uploaded` row — no worker
    holds it — moves straight to `destroying`; a `processing` row — a worker
    may hold it, and THE WORKER NEVER DELETES AN OBJECT IT MAY STILL WRITE —
    is only flagged with `superseded_at`, and the worker settles it to
    `destroying` after its writes. Every superseded row carries the stamp;
  - RETIRES the uploaded cover the subject carries when it is replaced
    (`retire_cover_image`: `ready` → `destroying`), in the transaction that
    writes the subject — a set from a photograph, a clear, or the worker's
    `ready` for a newer upload. An upload intent retires nothing: until an
    upload is `ready`, the old cover, or none, stands.
A superseded upload never becomes the cover, and every retired or
superseded row's objects are deleted by the worker's destruction step.

THE LOCK ORDER IS THE PHOTOGRAPH, THEN THE SUBJECT, THEN COVER IMAGES, on
every path. The CK-83a set path keeps its photograph `FOR SHARE` first; the
upload intent, the clear and the worker's `ready` lock no photograph and
begin at the subject; removal and destruction lock the photograph and then
UPDATE the subject (`clear_covers_of`) and never touch `cover_images`. The
confirm route touches its own `cover_images` row only, and the worker's claim
skips a locked row. NEVER TAKE A SUBJECT'S LOCK BEFORE A PHOTOGRAPH'S: that is
the order that deadlocks against a removal.

`clear_covers_of` IS UNCHANGED BY ANY OF THIS: it concerns photographs alone.
An uploaded cover is not published and cannot be unpublished; it changes
only by a later act.

THE BOUNDARY: this module imports the models and SQLAlchemy and nothing
else, because `services/destruction.py` calls it and must never import
`ingest`, `processing`, `storage` or botocore (the code-root CLAUDE.md
Gotcha) — and neither may this. Both sides call it: the API's cover routes
and the worker's cover ladder.

DATA-HANDLING: UPDATEs keyed on one media id, one subject, or one cover
image, writing NULL, a rung or the transaction's clock; one locking SELECT
that reads back an id. Nothing is logged.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CoverImage, Gathering, Group, MediaStatus

# The rungs on which an upload is in flight and NO WORKER HOLDS IT: a
# superseding act may move it straight to `destroying`. `processing` is held
# and is only flagged.
UNHELD_UPLOAD_STATUSES = (MediaStatus.PENDING_UPLOAD, MediaStatus.UPLOADED)


async def clear_covers_of(db: AsyncSession, media_id: UUID) -> None:
    """CLEAR EVERY COVER THAT IS THIS PHOTOGRAPH — on a gathering and on a
    group — in the caller's transaction: two UPDATEs that NULL all three
    cover columns `WHERE cover_media_id = :media_id` (the partial index on
    each table serves them). The three move together, so the all-or-none
    CHECK holds on every row either statement touches.

    Called AFTER the statement that stopped the photograph being published,
    and only when that statement changed the row (the caller's rowcount),
    so a lost race clears nothing. A photograph that is nobody's cover
    matches no row and both statements write nothing. DOES NOT COMMIT —
    the caller owns the transaction, as `mark_for_destruction`'s does — and
    never touches `updated_at`, which stays PATCH's."""
    for subject in (Gathering, Group):
        await db.execute(
            update(subject)
            .where(subject.cover_media_id == media_id)
            .values(cover_media_id=None, cover_set_at=None, cover_set_by_person_id=None)
            .execution_options(synchronize_session=False)
        )


async def lock_subject(db: AsyncSession, subject, subject_id: UUID) -> UUID | None:
    """THE SUBJECT'S ROW LOCK — `SELECT cover_image_id … FOR UPDATE` on the
    gathering or the group — taken by every cover writer before it touches
    `cover_images` (the module docstring). Answers the uploaded cover the
    subject carries, read AFTER the lock is granted, so a writer that waited
    sees what the writer ahead of it committed: an act that waited behind
    the worker's `ready` retires the image that `ready` made the cover.
    `subject` is the model, Gathering or Group. Never commits."""
    return (
        await db.execute(
            select(subject.cover_image_id).where(subject.id == subject_id).with_for_update()
        )
    ).scalar_one()


def _of_subject(subject, subject_id: UUID):
    column = CoverImage.gathering_id if subject is Gathering else CoverImage.group_id
    return column == subject_id


def _to_destroying() -> dict:
    """A row owed a destruction, with fresh job columns — the marking
    statement's reset (CK-54), so the destruction gets its own attempts."""
    return dict(
        status=MediaStatus.DESTROYING,
        attempts=0,
        available_at=None,
        claimed_at=None,
        last_error=None,
    )


async def supersede_uploads(db: AsyncSession, subject, subject_id: UUID) -> None:
    """SUPERSEDE EVERY UPLOAD STILL IN FLIGHT FOR THIS SUBJECT, under the
    subject's lock the caller holds (`lock_subject`). Two UPDATEs, in this
    order: the unheld rows (`pending_upload`, `uploaded`) to `destroying`
    with `superseded_at`, then the held ones (`processing`) flagged with
    `superseded_at` alone and left to the worker. The order matters under
    READ COMMITTED: a row the worker is claiming at that instant makes the
    first statement wait on its row lock and then re-check it — it is
    `processing` now, so the first skips it and the second, a new
    statement, flags it. `superseded_at` is the transaction's clock. Never
    commits."""
    await db.execute(
        update(CoverImage)
        .where(_of_subject(subject, subject_id), CoverImage.status.in_(UNHELD_UPLOAD_STATUSES))
        .values(superseded_at=func.now(), **_to_destroying())
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(CoverImage)
        .where(
            _of_subject(subject, subject_id),
            CoverImage.status == MediaStatus.PROCESSING,
            CoverImage.superseded_at.is_(None),
        )
        .values(superseded_at=func.now())
        .execution_options(synchronize_session=False)
    )


async def retire_cover_image(db: AsyncSession, cover_image_id: UUID) -> None:
    """RETIRE AN UPLOADED COVER THAT IS BEING REPLACED: `ready` →
    `destroying`, guarded on `ready`, in the transaction that writes the
    subject (the caller holds the subject's lock and is about to point it
    elsewhere, or nowhere). The worker's destruction step deletes its two
    objects and its original. Not superseded — a retired cover was the
    cover — so it carries no `superseded_at`. Never commits."""
    await db.execute(
        update(CoverImage)
        .where(CoverImage.id == cover_image_id, CoverImage.status == MediaStatus.READY)
        .values(**_to_destroying())
        .execution_options(synchronize_session=False)
    )
