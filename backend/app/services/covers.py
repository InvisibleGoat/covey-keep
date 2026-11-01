"""Covers — the one statement pair that clears a cover when its photograph
stops being published (CK-83a; decisions/2026-10-31-the-design-and-how-it-is-
merged.md §1.3).

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

THE BOUNDARY: this module imports the models and SQLAlchemy and nothing
else, because `services/destruction.py` calls it and must never import
`ingest`, `processing`, `storage` or botocore (the code-root CLAUDE.md
Gotcha) — and neither may this.

DATA-HANDLING: two UPDATEs keyed on one media id, writing NULL. Nothing is
read back and nothing is logged.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Gathering, Group


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
