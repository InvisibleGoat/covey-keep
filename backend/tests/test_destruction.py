"""CK-54 — the bin arc, Phase A: the two removal paths, and the first code
in this product that destroys a photograph's stored bytes
(decisions/2026-09-20-the-bin-counts-and-empties.md §6, §7.1, §7.2).

The cast and the row-planting are test_media_reads' — host, uploader (an
accepted invitee), keeper, bystander (a second accepted invitee), stranger
— because both acts run inside CK-37's audience rule and then narrow it,
and because the KEEPER'S REFUSAL is the pin this phase turns on: a keeper
holds a reference, never a right to publish or destroy. No network
anywhere; the worker's storage calls are stubbed at the same names
test_worker.py uses.

The load-bearing pins:
- the host destroys a `live` photograph: the row goes `destroying`, and
  `photo_count` AND `total_bytes` drop TOGETHER in the marking transaction
  — the mirror of CK-51a's single-statement increment — with the row
  invisible to everyone from that instant;
- THE VERIFIER'S TWO INVARIANTS STILL HOLD after the mark, asserted here
  as SQL rather than trusted: the row left `ready` in the same transaction
  that decremented, so the count and the sum both still match their rows;
- the uploader destroys their own; THE KEEPER IS REFUSED with the media
  404, byte-identical to a missing id, and nothing moves;
- `remove` sends a `live` photograph to the bin and destroys NOTHING: the
  layers stay, the row stays `ready`, and it goes on counting (bin record
  §3);
- `destroy` reaches a `removed` row — the per-photograph "empty the bin" —
  and `remove` refuses one with `already_removed`;
- `decline` is UNCHANGED: a `live` row still draws 409 `not_pending`;
- the worker deletes the three published objects BEFORE it commits
  `destroyed` — observed from a second session at the moment of the
  delete, the mirror of CK-36's ordering pin — and the retry over absent
  objects succeeds rather than erroring;
- a destroyed row keeps its words (bin record §7.2) and is reachable by
  no list, no search and no act;
- the quota frees: the keeper's usage drops by one photograph at the mark.
"""

import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from botocore.exceptions import ClientError
from sqlalchemy import func, select, text

from app.api.media import ALREADY_REMOVED, NOT_PENDING, NOT_READY
from app.config import WorkerSettings, settings
from app.models import (
    Gathering,
    GatheringType,
    Media,
    MediaDerivative,
    MediaStatus,
    MediaTag,
    PublicationState,
)
from app.services import destruction, ingest, keeping
from app.services.retention import REMOVED_BIN
from app.services.storage import (
    WorkerClient,
    delete_published_object,
    serve_client,
    upload_client,
    worker_client,
)
from app.worker import Poll, poll_once
from tests.test_gatherings import _account_for
from tests.test_keeping import _mk_gathering
from tests.test_media_reads import (
    KEEPER,
    LAYER_SPECS,
    MISSING_ID,
    _cast,
    _ids,
    _list,
    _photograph,
    _url,
)
from tests.conftest import TEST_DATABASE_URL
from tests.test_worker import (
    BACKEND_DIR,
    WORKER_ENV,
    FakeStore,
    _botocore_error,
    _client_error,
    _media,
)

LAYER_BYTES = sum(size for _, size, _ in LAYER_SPECS.values())


@pytest.fixture
def worker_settings() -> WorkerSettings:
    # test_worker.py's six, on a reserved TLD — nothing here could ever
    # reach a real endpoint, and the storage calls are stubbed besides.
    return WorkerSettings(_env_file=None, **{k.lower(): v for k, v in WORKER_ENV.items()})


@pytest.fixture
def worker(worker_settings) -> WorkerClient:
    return worker_client(worker_settings)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _resync_counts(db_session_factory, gathering_id) -> tuple[int, int]:
    """Make the gathering's two maintained columns agree with its rows, the
    way the publish transaction would have left them. `_photograph` plants
    the worker's OUTPUT without the worker, so the counters were never
    incremented; every decrement assertion below is against a true
    starting point rather than against zero."""
    async with db_session_factory() as db:
        await db.execute(
            text(
                "UPDATE gatherings g SET "
                "  photo_count = (SELECT count(*) FROM media m "
                "                  WHERE m.gathering_id = g.id AND m.status = 'ready'), "
                "  total_bytes = (SELECT coalesce(sum(d.size_bytes), 0) "
                "                   FROM media_derivatives d JOIN media m ON m.id = d.media_id "
                "                  WHERE m.gathering_id = g.id AND m.status = 'ready') "
                "WHERE g.id = :gid"
            ),
            {"gid": str(gathering_id)},
        )
        await db.commit()
    return await _counts(db_session_factory, gathering_id)


async def _counts(db_session_factory, gathering_id) -> tuple[int, int]:
    async with db_session_factory() as db:
        row = (
            await db.execute(
                select(Gathering.photo_count, Gathering.total_bytes).where(
                    Gathering.id == gathering_id
                )
            )
        ).one()
        return int(row[0]), int(row[1])


async def _invariants_hold(db_session_factory, gathering_id) -> None:
    """The verifier's two publish invariants, run here as the SQL the
    verifier runs (scripts/verify_schema.py, CK-36/CK-51a). CK-54's whole
    argument for putting the decrement in the marking statement is that
    NEITHER NEEDS CHANGING — a destruction that needed a new invariant
    would be a destruction with a new way to be wrong — so they are
    asserted after every mark below rather than reasoned about."""
    async with db_session_factory() as db:
        miscounted = await db.scalar(
            text(
                "SELECT count(*) FROM gatherings g WHERE g.id = :gid AND g.photo_count <> "
                "(SELECT count(*) FROM media m WHERE m.gathering_id = g.id AND m.status = 'ready')"
            ),
            {"gid": str(gathering_id)},
        )
        drifted = await db.scalar(
            text(
                "SELECT count(*) FROM gatherings g WHERE g.id = :gid AND g.total_bytes <> "
                "(SELECT coalesce(sum(d.size_bytes), 0) FROM media_derivatives d "
                "  JOIN media m ON m.id = d.media_id "
                " WHERE m.gathering_id = g.id AND m.status = 'ready')"
            ),
            {"gid": str(gathering_id)},
        )
    assert miscounted == 0, "photo_count no longer equals the count of ready rows"
    assert drifted == 0, "total_bytes no longer equals the sum over ready rows' layers"


async def _row(db_session_factory, media_id) -> Media:
    async with db_session_factory() as db:
        return await db.get(Media, UUID(media_id))


async def _layer_keys(db_session_factory, media_id) -> list[str]:
    async with db_session_factory() as db:
        return list(
            (
                await db.execute(
                    select(MediaDerivative.storage_key).where(
                        MediaDerivative.media_id == UUID(media_id)
                    )
                )
            ).scalars()
        )


async def _destroy(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/destroy", headers=headers)


async def _remove(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/remove", headers=headers)


# --- the marking statement ---------------------------------------------------


async def test_destroying_a_live_photograph_marks_it_and_drops_both_counts_together(
    client, capsys, db_session_factory
):
    # THE TEST THE PHASE'S SHAPE EXISTS FOR. `photo_count` and
    # `total_bytes` are decremented in ONE statement in the same
    # transaction that moves the row off `ready` — the mirror of CK-51a's
    # single-statement increment — so they cannot diverge, and the
    # verifier's two invariants stay true without being rewritten.
    cast = await _cast(client, capsys, db_session_factory)
    keep = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    count_before, bytes_before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (count_before, bytes_before) == (2, 2 * LAYER_BYTES)
    await _invariants_hold(db_session_factory, cast.gathering_id)

    response = await _destroy(client, cast.host, doomed)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "destroying"

    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    # The publication state is NOT touched: it records what was decided
    # about the photograph, and destruction is not a publication decision.
    assert row.publication_state is PublicationState.LIVE
    # The job columns are reset, so a photograph that took two attempts to
    # ingest still gets three to be destroyed.
    assert (row.attempts, row.available_at, row.claimed_at, row.last_error) == (0, None, None, None)

    assert await _counts(db_session_factory, cast.gathering_id) == (
        count_before - 1,
        bytes_before - LAYER_BYTES,
    )
    await _invariants_hold(db_session_factory, cast.gathering_id)
    # Nothing is destroyed yet — the bytes are the worker's to take.
    assert len(await _layer_keys(db_session_factory, doomed)) == 3
    # And the photograph that was not destroyed is untouched.
    assert (await _row(db_session_factory, keep)).status is MediaStatus.READY


async def test_a_destroyed_photograph_is_invisible_to_everyone_at_once(
    client, capsys, db_session_factory
):
    # §7.2's requirement, and the reason `_visible_media` consults `status`
    # for exactly this: the record says invisibility "follows from the row
    # leaving `ready`", and it does not follow on its own — every other
    # branch turns on `publication_state`, so a destroyed `live` row would
    # go on being listed. Immediate, before a byte has been deleted.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    for headers in (cast.host, cast.uploader, cast.keeper, cast.bystander):
        assert doomed in _ids(await _list(client, headers, cast.gathering_id))

    assert (await _destroy(client, cast.host, doomed)).status_code == 200

    missing = await client.get(f"/media/{MISSING_ID}/url", params={"layer": "web"}, headers=cast.host)
    for headers in (cast.host, cast.uploader, cast.keeper, cast.bystander):
        assert doomed not in _ids(await _list(client, headers, cast.gathering_id))
        gone = await _url(client, headers, doomed)
        # Byte-identical to a missing id — nobody learns it ever existed.
        assert (gone.status_code, gone.json()) == (404, missing.json())
    # And no act can reach it again: a second destroy is the same 404, not
    # a refusal. Gone is the honest answer.
    assert (await _destroy(client, cast.host, doomed)).status_code == 404
    assert (await _remove(client, cast.host, doomed)).status_code == 404
    assert (await client.post(f"/media/{doomed}/publish", headers=cast.host)).status_code == 404
    assert (await client.post(f"/media/{doomed}/decline", headers=cast.host)).status_code == 404
    patched = await client.patch(
        f"/media/{doomed}", json={"caption": "anything"}, headers=cast.uploader
    )
    assert patched.status_code == 404


async def test_a_destroyed_photograph_keeps_its_words_and_no_search_can_reach_them(
    client, capsys, db_session_factory
):
    # Bin record §7.2, as amended at 1.5.0: the row survives WITH its
    # filename, caption and tags — *a photograph captioned "Jenny at bat"
    # was deleted* is an audit trail where *something was deleted* is not
    # — and the property that makes that safe is that nothing can reach
    # them. Both halves asserted, because one without the other is a bug
    # in whichever direction.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    patched = await client.patch(
        f"/media/{doomed}",
        json={"caption": "Jenny at bat", "tags": ["jenny", "rounders"]},
        headers=cast.uploader,
    )
    assert patched.status_code == 200, patched.text
    assert doomed in _ids(
        await client.get(
            f"/gatherings/{cast.gathering_id}/media",
            params={"q": "Jenny"},
            headers=cast.uploader,
        )
    )

    assert (await _destroy(client, cast.uploader, doomed)).status_code == 200

    row = await _row(db_session_factory, doomed)
    assert row.caption == "Jenny at bat"
    assert row.filename is None or isinstance(row.filename, str)
    assert row.uploader_person_id == cast.uploader_person_id
    async with db_session_factory() as db:
        tags = sorted(
            (
                await db.execute(select(MediaTag.tag).where(MediaTag.media_id == UUID(doomed)))
            ).scalars()
        )
    assert tags == ["jenny", "rounders"]
    # And nobody can read any of it — the search runs inside the audience
    # rule (CK-39), and the audience rule now excludes the rung.
    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        for term in ("Jenny", "jenny", "rounders"):
            found = await client.get(
                f"/gatherings/{cast.gathering_id}/media",
                params={"q": term},
                headers=headers,
            )
            assert _ids(found) == []


# --- the marking statement, called directly (CK-58) --------------------------
# `ingest.mark_for_destruction` is the ONE copy of the mark-and-decrement,
# extracted from `destroy_media` so the 30-day sweep (CK-59) can be its
# second caller without re-typing the statement that keeps the two counts
# from diverging. The endpoint tests above prove it through its first
# caller; these three pin its contract on its own — and the third is the
# property CK-59's concurrency safety rests on, pinned here rather than
# there.


async def _mark(db_session_factory, media_id: str) -> bool:
    """Call the function the way a caller does: a freshly loaded row, one
    transaction, committed by the caller afterwards."""
    async with db_session_factory() as db:
        row = await db.get(Media, UUID(media_id))
        applied = await ingest.mark_for_destruction(db, row)
        await db.commit()
    return applied


async def _job_columns(db_session_factory, media_id: str) -> tuple:
    row = await _row(db_session_factory, media_id)
    return (row.attempts, row.available_at, row.claimed_at, row.last_error)


async def test_mark_for_destruction_refuses_a_row_that_is_not_ready_and_writes_nothing(
    client, capsys, db_session_factory
):
    # False, and NOTHING written: not the rung, not either count, and not
    # the job columns — the reset is part of the mark, so a refused mark
    # must leave a failed row's history where it was.
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    failed = await _photograph(db_session_factory, cast, status=MediaStatus.FAILED)
    in_flight = await _photograph(db_session_factory, cast, status=MediaStatus.UPLOADED)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE media SET attempts = 1, last_error = :why WHERE id = :id"),
            {"why": ingest.ERROR_OBJECT_MISSING, "id": UUID(failed)},
        )
        await db.commit()
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert before == (1, LAYER_BYTES)
    history = await _job_columns(db_session_factory, failed)
    assert history == (1, None, None, ingest.ERROR_OBJECT_MISSING)

    for media_id, rung in ((failed, MediaStatus.FAILED), (in_flight, MediaStatus.UPLOADED)):
        assert await _mark(db_session_factory, media_id) is False
        assert (await _row(db_session_factory, media_id)).status is rung
        assert await _counts(db_session_factory, cast.gathering_id) == before
    assert await _job_columns(db_session_factory, failed) == history
    await _invariants_hold(db_session_factory, cast.gathering_id)
    # And the `ready` row beside them is untouched — the guard is per row.
    assert (await _row(db_session_factory, live)).status is MediaStatus.READY


async def test_mark_for_destruction_marks_a_ready_row_and_drops_both_counts_together(
    client, capsys, db_session_factory
):
    # True, the row `destroying` with its job columns reset, both counts
    # down in the same transaction, and nothing else touched: the
    # publication state (bin record §7.2 — destruction is not a publication
    # decision), the removal stamp, and the three derivative rows, which
    # are the worker's to take. A binned row, because that is the row the
    # sweep will hand it.
    cast = await _cast(client, capsys, db_session_factory)
    keep = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    binned_at = _now() - timedelta(days=31)
    doomed = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=binned_at,
    )
    # A `ready` row after one abandoned ingest claim reads attempts = 2
    # (CK-37); the mark must reset it, so the reset is observable.
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE media SET attempts = 2 WHERE id = :id"), {"id": UUID(doomed)}
        )
        await db.commit()
    count_before, bytes_before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (count_before, bytes_before) == (2, 2 * LAYER_BYTES)

    assert await _mark(db_session_factory, doomed) is True

    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    assert row.publication_state is PublicationState.REMOVED
    assert row.removed_at == binned_at
    assert await _job_columns(db_session_factory, doomed) == (0, None, None, None)
    assert await _counts(db_session_factory, cast.gathering_id) == (
        count_before - 1,
        bytes_before - LAYER_BYTES,
    )
    await _invariants_hold(db_session_factory, cast.gathering_id)
    assert len(await _layer_keys(db_session_factory, doomed)) == 3
    assert (await _row(db_session_factory, keep)).status is MediaStatus.READY
    # Marked, it is claimable by the worker exactly as the endpoint's mark
    # is: the same rung, the same reset columns, the same ladder.
    async with db_session_factory() as db:
        claimed = await ingest.claim_next(db, _now())
        claimed_id = None if claimed is None else claimed.id
        await db.rollback()  # look, don't take: the row stays marked and unclaimed
    assert claimed_id == UUID(doomed)


async def test_mark_for_destruction_called_twice_marks_once_and_the_counts_move_once(
    client, capsys, db_session_factory
):
    # THE PROPERTY CK-59'S CONCURRENCY SAFETY RESTS ON, pinned here rather
    # than there: the function's OWN `status = 'ready'` guard — not any
    # caller's check — is what makes a double mark impossible. Twice in
    # one transaction with the same row object (a caller asked twice; the
    # object's `status` is stale by then, and the guard must read the
    # database, not the object), then again from a fresh session after the
    # commit (a second caller — the sweep and a person reaching the same
    # row): one mark, one decrement.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    assert await _resync_counts(db_session_factory, cast.gathering_id) == (1, LAYER_BYTES)

    async with db_session_factory() as db:
        row = await db.get(Media, UUID(doomed))
        assert await ingest.mark_for_destruction(db, row) is True
        assert row.status is MediaStatus.READY  # the object is stale, on purpose
        assert await ingest.mark_for_destruction(db, row) is False
        await db.commit()
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)

    # A second caller, after the commit, with its own freshly loaded row.
    assert await _mark(db_session_factory, doomed) is False
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)
    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    assert len(await _layer_keys(db_session_factory, doomed)) == 3
    # And the endpoint, asked afterwards, draws the 404 `_visible_media`
    # gives a row in destruction — never a second decrement.
    assert (await _destroy(client, cast.host, doomed)).status_code == 404
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)


# --- who may (and may not) ---------------------------------------------------


async def test_the_uploader_destroys_their_own_and_the_host_destroys_anyones(
    client, capsys, db_session_factory
):
    # Bin record §7.1: available to the gathering's host and to the
    # uploader for their own.
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)

    assert (await _destroy(client, cast.uploader, mine)).status_code == 200
    assert (await _destroy(client, cast.host, theirs)).status_code == 200
    assert (await _row(db_session_factory, mine)).status is MediaStatus.DESTROYING
    assert (await _row(db_session_factory, theirs)).status is MediaStatus.DESTROYING
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_the_keeper_may_not_destroy_or_remove_a_photograph(
    client, capsys, db_session_factory
):
    # THE PIN THIS PHASE TURNS ON (bin record §7.1; the removal rule): a
    # keeper holds a REFERENCE, never a right to publish or destroy —
    # ownership governs provenance and retrieval, not an exclusive delete
    # right. The keeper here is in the gathering's read audience and CAN
    # see the photograph, so the 404 is the authorization rule and never a
    # broken fixture.
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert live in _ids(await _list(client, cast.keeper, cast.gathering_id))

    missing = await _destroy(client, cast.keeper, MISSING_ID)
    for act in (_destroy, _remove):
        refused = await act(client, cast.keeper, live)
        assert refused.status_code == 404
        assert refused.json() == missing.json()

    # And nothing moved: not the rung, not either column, not the layers.
    row = await _row(db_session_factory, live)
    assert (row.status, row.publication_state) == (MediaStatus.READY, PublicationState.LIVE)
    assert row.removed_at is None
    assert await _counts(db_session_factory, cast.gathering_id) == before
    assert len(await _layer_keys(db_session_factory, live)) == 3


async def test_an_invitee_and_a_stranger_may_not_destroy_or_remove(
    client, capsys, db_session_factory
):
    # The bystander is an accepted invitee who sees the photograph; the
    # stranger sees the gathering not at all. Both draw the media 404,
    # byte-identical to a missing id.
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert live in _ids(await _list(client, cast.bystander, cast.gathering_id))

    for headers in (cast.bystander, cast.stranger):
        missing = await _destroy(client, headers, MISSING_ID)
        for act in (_destroy, _remove):
            refused = await act(client, headers, live)
            assert refused.status_code == 404
            assert refused.json() == missing.json()
    assert (await _row(db_session_factory, live)).status is MediaStatus.READY
    assert await _counts(db_session_factory, cast.gathering_id) == before


# --- send to bin, and what it does not do ------------------------------------


async def test_remove_sends_a_live_photograph_to_the_bin_and_frees_nothing(
    client, capsys, db_session_factory
):
    # THE TAKEDOWN OF A PUBLISHED PHOTOGRAPH, which nothing offered until
    # now — and bin record §3's rule in the same breath: the layers stay,
    # so the photograph goes on counting. A `remove` that freed the count
    # would let an account remove ten thousand and add ten thousand more,
    # storing twenty while charged for ten.
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    before = await _resync_counts(db_session_factory, cast.gathering_id)

    response = await _remove(client, cast.host, live)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["publication_state"]) == ("ready", "removed")

    row = await _row(db_session_factory, live)
    assert row.status is MediaStatus.READY
    assert row.removed_at is not None
    # Nothing destroyed, nothing freed.
    assert len(await _layer_keys(db_session_factory, live)) == 3
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)
    # The bin is the uploader's, and the host does not see it again.
    assert live in _ids(await _list(client, cast.uploader, cast.gathering_id))
    assert live not in _ids(await _list(client, cast.host, cast.gathering_id))


async def test_removing_a_photograph_already_in_the_bin_refuses_rather_than_restamping(
    client, capsys, db_session_factory
):
    # Re-stamping `removed_at` would quietly restart the contributor's
    # 30-day retrieval window, which is a worse answer than a refusal.
    cast = await _cast(client, capsys, db_session_factory)
    binned = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=3),
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    stamped_before = (await _row(db_session_factory, binned)).removed_at

    refused = await _remove(client, cast.uploader, binned)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == ALREADY_REMOVED
    assert (await _row(db_session_factory, binned)).removed_at == stamped_before


async def test_a_host_who_bins_a_photograph_cannot_then_destroy_it(
    client, capsys, db_session_factory
):
    # A CONSEQUENCE OF A DECIDED RULE, pinned so it is not discovered later
    # and read as a bug. CK-37 settled that a `removed` photograph is
    # visible to THE UPLOADER ALONE, the host excluded — "the bin's read
    # window defined before removal exists", and explicitly not interim. So
    # a host who chooses *Send to bin* has chosen the bin: they cannot then
    # reach the row to destroy it, and this phase does NOT widen that
    # audience to make the sequence work (widening a decided consent rule
    # to smooth a flow is how consent rules are lost).
    #
    # It costs the host nothing they were promised: bin record §7.1 offers
    # the two choices AT THE POINT OF REMOVAL, and *Delete permanently* is
    # reachable directly from a `live` row (the test above). What is NOT
    # built is emptying an account-level bin — the keeper's affordance in
    # the refusal copy — which is the bin surface's, with its own audience
    # to decide (§4's account-level scope binds it).
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)

    assert (await _remove(client, cast.host, live)).status_code == 200
    missing = await _destroy(client, cast.host, MISSING_ID)
    refused = await _destroy(client, cast.host, live)
    assert refused.status_code == 404
    assert refused.json() == missing.json()
    # The uploader, whose bin it is, still can.
    assert (await _destroy(client, cast.uploader, live)).status_code == 200


async def test_destroy_reaches_a_binned_photograph_and_frees_it(
    client, capsys, db_session_factory
):
    # The per-photograph "empty the bin" (bin record §6's manual path):
    # a removed row is still stored and still charged, and destroying it
    # is what makes the room available at once.
    cast = await _cast(client, capsys, db_session_factory)
    binned = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=3),
    )
    count_before, bytes_before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert count_before == 1  # charged while binned — bin record §3

    assert (await _destroy(client, cast.uploader, binned)).status_code == 200
    assert await _counts(db_session_factory, cast.gathering_id) == (0, bytes_before - LAYER_BYTES)
    await _invariants_hold(db_session_factory, cast.gathering_id)
    assert (await _row(db_session_factory, binned)).status is MediaStatus.DESTROYING


async def test_neither_act_touches_a_row_with_nothing_stored(
    client, capsys, db_session_factory
):
    # Only a `ready` row has layers — which is what `remove` promises to
    # keep and `destroy` promises to take. An in-flight row would race the
    # worker for the same id; a `failed` row has nothing stored at all.
    cast = await _cast(client, capsys, db_session_factory)
    failed = await _photograph(db_session_factory, cast, status=MediaStatus.FAILED)
    in_flight = await _photograph(db_session_factory, cast, status=MediaStatus.UPLOADED)
    before = await _resync_counts(db_session_factory, cast.gathering_id)

    for media_id in (failed, in_flight):
        for act in (_destroy, _remove):
            refused = await act(client, cast.uploader, media_id)
            assert refused.status_code == 409, refused.text
            detail = refused.json()["detail"]
            assert detail["code"] == NOT_READY
            assert detail["status"] == (await _row(db_session_factory, media_id)).status.value
    assert (await _row(db_session_factory, failed)).status is MediaStatus.FAILED
    assert (await _row(db_session_factory, in_flight)).status is MediaStatus.UPLOADED
    assert await _counts(db_session_factory, cast.gathering_id) == before


async def test_decline_is_unchanged_and_still_refuses_a_live_row(
    client, capsys, db_session_factory
):
    # CK-43's act is the REVIEW's bottom, for a photograph nobody has
    # published, and this phase does not touch it: `remove` is the takedown
    # and `decline` still refuses a `live` row with `not_pending`. Two acts
    # reaching `removed` from different places, neither borrowing the
    # other's rule.
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    pending = await _photograph(db_session_factory, cast)
    await _resync_counts(db_session_factory, cast.gathering_id)

    refused = await client.post(f"/media/{live}/decline", headers=cast.host)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == NOT_PENDING
    # And decline still works where it always did.
    declined = await client.post(f"/media/{pending}/decline", headers=cast.host)
    assert declined.status_code == 200, declined.text
    assert declined.json()["publication_state"] == "removed"


# --- the quota frees ---------------------------------------------------------


async def test_destroying_frees_the_keepers_allowance_at_the_mark(
    client, capsys, db_session_factory
):
    # The gap the bin record was written to close, closed: Steven's
    # question was "if someone has reached their 10k limit and they delete
    # an image, the count doesn't drop to 9,999?" — under `remove` it does
    # not, and under `destroy` it does, immediately.
    cast = await _cast(client, capsys, db_session_factory)
    for _ in range(3):
        await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)

    async with db_session_factory() as db:
        keeper_account = await _account_for(db, KEEPER)
        before = await keeping.account_usage(db, keeper_account)
    assert before == 4

    # Removal frees nothing...
    assert (await _remove(client, cast.uploader, doomed)).status_code == 200
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, KEEPER)
        assert await keeping.account_usage(db, keeper_account) == 4
        assert await keeping.account_bin_count(db, keeper_account) == 1

    # ...and destroying frees exactly one, at the mark.
    assert (await _destroy(client, cast.uploader, doomed)).status_code == 200
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, KEEPER)
        assert await keeping.account_usage(db, keeper_account) == 3
        # And it leaves the bin: it is no longer removed-and-still-stored.
        assert await keeping.account_bin_count(db, keeper_account) == 0


async def test_a_row_in_destruction_is_charged_to_nobody_and_sits_in_no_bin(
    client, capsys, db_session_factory
):
    # The residual failure mode, named rather than hidden: between the mark
    # and the worker's delete the photograph is charged to nobody while its
    # layers may still exist. Both destruction rungs are outside
    # IN_FLIGHT_STATUSES and are not `ready`, so neither the quota nor the
    # bin count sees them.
    assert MediaStatus.DESTROYING not in keeping.IN_FLIGHT_STATUSES
    assert MediaStatus.DESTROYED not in keeping.IN_FLIGHT_STATUSES
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.REMOVED, removed_at=_now()
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.uploader, doomed)).status_code == 200
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, KEEPER)
        assert await keeping.account_usage(db, keeper_account) == 0
        assert await keeping.account_bin_count(db, keeper_account) == 0


# --- the worker destroys -----------------------------------------------------


async def _seeded_store(monkeypatch, db_session_factory, media_id: str) -> FakeStore:
    store = FakeStore(monkeypatch)
    for key in await _layer_keys(db_session_factory, media_id):
        store.published[key] = (b"bytes", "image/webp", "STANDARD")
    return store


async def test_the_worker_deletes_the_objects_before_it_commits_destroyed(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # THE ORDERING PIN, and it is CK-36's run backwards. Publishing commits
    # the database BEFORE deleting the quarantine original, because a lost
    # original is cheaper than a lost photograph. Destruction cannot borrow
    # that argument: committing `destroyed` over bytes still in the bucket
    # would break the one promise this routine makes. Observed from a
    # SECOND SESSION at the instant of each delete — the row must still be
    # `destroying` and its derivative rows must still be there.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    keys = await _layer_keys(db_session_factory, doomed)
    assert len(keys) == 3
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)

    observed = []

    async def watch(key):
        async with db_session_factory() as other:
            row = await other.get(Media, UUID(doomed))
            layers = await other.scalar(
                select(func.count(MediaDerivative.id)).where(
                    MediaDerivative.media_id == UUID(doomed)
                )
            )
            observed.append((row.status, layers))

    store.on_delete_published = watch

    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    # Three deletes, and at every one the database still said `destroying`
    # with all three rows present.
    assert len(observed) == 3
    assert observed == [(MediaStatus.DESTROYING, 3)] * 3
    assert store.published == {}
    assert store.stages() == ["delete_published"] * 3  # no quarantine call at all

    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYED
    assert (row.claimed_at, row.available_at, row.last_error) == (None, None, None)
    assert row.attempts == 1
    assert await _layer_keys(db_session_factory, doomed) == []
    # The counts moved at the mark and do not move again here.
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_a_retry_over_objects_already_gone_succeeds(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # What delete-first buys: a crash between the deletes and the commit
    # leaves a `destroying` row whose objects are already absent, and the
    # next claim must SUCCEED rather than error. Deleting an absent object
    # is a success (storage.py), so the retry is idempotent for free.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    # An empty published bucket: the earlier attempt got that far.
    store = FakeStore(monkeypatch)
    assert store.published == {}

    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYED
    assert row.last_error is None
    assert await _layer_keys(db_session_factory, doomed) == []


async def test_a_destroying_row_is_claimable_and_a_destroyed_one_never_is(
    client, capsys, db_session_factory, worker, monkeypatch
):
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    await _seeded_store(monkeypatch, db_session_factory, doomed)

    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    assert (await _row(db_session_factory, doomed)).status is MediaStatus.DESTROYED
    # Terminal: the queue is empty, and stays empty.
    assert await poll_once(db_session_factory, worker) is Poll.IDLE
    assert await poll_once(db_session_factory, worker) is Poll.IDLE


async def test_a_destruction_that_cannot_reach_the_store_climbs_the_ladder_and_stays_destroying(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # The transient ladder, and the one place the destruction ladder does
    # NOT mirror the ingest one: a spent ladder does not become `failed`.
    # `failed` is the ingest terminal — it would claim the wrong job
    # failed, and it would make the row VISIBLE again to the person who
    # destroyed it.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)
    store.raise_on["delete_published"] = _client_error("InternalError", 500)

    for attempt, backoff in ((1, ingest.RETRY_BACKOFF[0]), (2, ingest.RETRY_BACKOFF[1])):
        assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
        row = await _row(db_session_factory, doomed)
        assert row.status is MediaStatus.DESTROYING
        assert row.attempts == attempt
        assert row.claimed_at is None
        assert row.available_at is not None
        assert f"attempt {attempt} of {ingest.MAX_ATTEMPTS}" in row.last_error
        # Deferred: not claimable until the backoff has passed.
        assert await poll_once(db_session_factory, worker) is Poll.IDLE
        async with db_session_factory() as db:
            await db.execute(
                text("UPDATE media SET available_at = :t WHERE id = :id"),
                {"t": _now() - timedelta(seconds=1), "id": UUID(doomed)},
            )
            await db.commit()

    # The third failure gives up — and the row STAYS at `destroying`.
    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    assert row.attempts == ingest.MAX_ATTEMPTS
    assert row.available_at is None
    assert "may still exist" in row.last_error
    # Never claimed again — the predicate, not the rung, is what stops it.
    assert await poll_once(db_session_factory, worker) is Poll.IDLE
    # Uncounted, and invisible to everyone, even now.
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    for headers in (cast.host, cast.uploader, cast.keeper):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []


async def test_a_rejected_credential_releases_a_destruction_unpenalized_and_says_why(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # The third class (CK-35): the worker is at fault, not the row. It must
    # not consume an attempt — a mistyped dashboard value would otherwise
    # exhaust the ladder of every queued destruction within minutes. Since
    # CK-57 the release also says why the row is waiting.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)
    store.raise_on["delete_published"] = _client_error("AccessDenied", 403)

    assert await poll_once(db_session_factory, worker) is Poll.BACKOFF
    row = await _row(db_session_factory, doomed)
    assert row.attempts == 0
    # CK-57: the release writes the reason (it wrote nothing until then).
    assert row.last_error == ingest.ERROR_CREDENTIAL_REJECTED
    # Released, and claimable again once the credential is fixed.
    assert row.status is MediaStatus.DESTROYING
    assert len(await _layer_keys(db_session_factory, doomed)) == 3


async def test_a_rejected_credential_in_the_heads_shape_releases_a_destruction_too(
    client, capsys, db_session_factory, worker, monkeypatch
):
    """The destroy branch's FIRST coverage on the numeric shape (CK-61): a
    bodiless 403 on the delete — Error.Code '403', no named code, what
    botocore reports for any response without an XML body — releases the
    destruction exactly as the named code does (the test above). (gv) could
    never reach this branch: the credential was tried on the ingest ladder,
    whose HEAD precedes everything and misclassified first. Until now it was
    untested rather than working. The same helper, the same one call, the
    rung it came from."""
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)
    store.raise_on["delete_published"] = _botocore_error(403, operation="DeleteObject")

    assert await poll_once(db_session_factory, worker) is Poll.BACKOFF
    row = await _row(db_session_factory, doomed)
    assert (row.status, row.attempts, row.claimed_at) == (MediaStatus.DESTROYING, 0, None)
    assert row.last_error == ingest.ERROR_CREDENTIAL_REJECTED
    assert "403" not in row.last_error
    # The first delete was refused and nothing after it was tried; the
    # three layers are still described, and claimable once the credential
    # is fixed.
    assert store.stages() == ["delete_published"]
    assert len(await _layer_keys(db_session_factory, doomed)) == 3


async def test_a_release_replaces_a_stale_reason_on_the_destruction_ladder_too(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # The same defect on the second ladder — the one CK-56 found it on: a
    # destruction that failed once (attempts 1, the retry text) and was then
    # released on a rejected credential sat at `destroying` / attempts 1 /
    # no stamp with a reason that named the STORE — or, released fresh, no
    # reason at all — and the verifier could not tell it from a dead-letter.
    # One call covers both ladders (_release_misconfigured picks the rung),
    # so the destroy row now carries the credential reason with the
    # transient failure's count and deferral exactly where they were, and
    # the destruction that follows clears it.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)

    store.raise_on["delete_published"] = _client_error("InternalError", 500)
    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    row = await _row(db_session_factory, doomed)
    stale = row.last_error
    assert f"attempt 1 of {ingest.MAX_ATTEMPTS}" in stale and row.attempts == 1
    # Claimable again for the release (the ladder test's idiom above).
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE media SET available_at = :t WHERE id = :id"),
            {"t": _now() - timedelta(seconds=1), "id": UUID(doomed)},
        )
        await db.commit()
    deferred = (await _row(db_session_factory, doomed)).available_at

    store.raise_on["delete_published"] = _client_error("InvalidAccessKeyId", 403)
    assert await poll_once(db_session_factory, worker) is Poll.BACKOFF
    row = await _row(db_session_factory, doomed)
    assert row.last_error == ingest.ERROR_CREDENTIAL_REJECTED
    assert row.last_error != stale
    # Unpenalized, on the rung it came from, its layers still described.
    assert (row.status, row.attempts, row.claimed_at, row.available_at) == (
        MediaStatus.DESTROYING, 1, None, deferred,
    )
    assert len(await _layer_keys(db_session_factory, doomed)) == 3
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)

    del store.raise_on["delete_published"]
    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    row = await _row(db_session_factory, doomed)
    assert (row.status, row.attempts, row.last_error) == (MediaStatus.DESTROYED, 2, None)
    assert await _layer_keys(db_session_factory, doomed) == []
    await _invariants_hold(db_session_factory, cast.gathering_id)


def _verifier() -> tuple[int, int, int, str]:
    """scripts/verify_schema.py, run the way an operator runs it — a fresh
    interpreter — against the test database. Returns (passed, failed, exit
    code, stdout)."""
    env = dict(os.environ)
    env["VERIFY_DATABASE_URL"] = TEST_DATABASE_URL
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, str(BACKEND_DIR / "scripts" / "verify_schema.py")],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    tally = re.search(r"(\d+) passed, (\d+) failed", proc.stdout)
    assert tally, proc.stdout + proc.stderr
    return int(tally.group(1)), int(tally.group(2)), proc.returncode, proc.stdout


async def test_the_verifier_asserts_a_destroying_row_that_spent_an_attempt_and_is_not_held_says_why(
    client, capsys, db_session_factory
):
    # The assertion CK-56 declined and CK-57 writes (scripts/verify_schema.py,
    # media job integrity (3)), run as the operator runs it, on four plants.
    # The defect the constant-free criterion had at CK-56 was that a healthy
    # released row matched it; the plant it must fire on is the one the
    # release no longer leaves behind, and the two it must NOT fire on —
    # a fresh mark (attempts 0) and a held row — are what keep it from being
    # too wide. A PLANT IS NOT EVIDENCE UNTIL SOMETHING INDEPENDENT OF THE
    # ASSERTION CONFIRMS THE ROW EXISTS (CK-56's first plant inserted nothing
    # and every assertion passed vacuously), so each state is counted by its
    # own SELECT before the verifier reads it.
    label = "every destroying row that has spent an attempt and is not held carries a last_error"
    cast = await _cast(client, capsys, db_session_factory)
    planted = await _photograph(
        db_session_factory,
        cast,
        status=MediaStatus.DESTROYING,
        publication_state=PublicationState.LIVE,
    )
    await _resync_counts(db_session_factory, cast.gathering_id)

    async def plant(attempts: int, held: bool, reason: str | None) -> None:
        stamp = "now()" if held else "NULL"
        async with db_session_factory() as db:
            await db.execute(
                text(
                    f"UPDATE media SET attempts = :a, claimed_at = {stamp}, "
                    "last_error = :e WHERE id = :id"
                ),
                {"a": attempts, "e": reason, "id": UUID(planted)},
            )
            await db.commit()
            confirmed = await db.scalar(
                text(
                    "SELECT count(*) FROM media WHERE id = :id AND status = 'destroying' "
                    f"AND attempts = :a AND claimed_at IS {'NOT ' if held else ''}NULL "
                    f"AND last_error IS {'NOT ' if reason else ''}NULL"
                ),
                {"id": UUID(planted), "a": attempts},
            )
        assert confirmed == 1, "the plant did not land — nothing below would mean anything"

    # Fires: an attempt spent, not held, no reason — the state no reachable
    # path leaves any more, and the one the verifier exists to catch.
    await plant(1, False, None)
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (190, 1, 1), out
    assert f"FAIL  {label}" in out and "1 destroying media row(s)" in out

    # Passes with the reason present — what the release now writes.
    await plant(1, False, ingest.ERROR_CREDENTIAL_REJECTED)
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (191, 0, 0), out
    assert f"PASS  {label}" in out

    # Must NOT fire on a fresh mark (attempts 0, no reason: nothing is
    # wrong with it) ...
    await plant(0, False, None)
    assert _verifier()[:3] == (191, 0, 0)
    # ... nor on a held row: the claim writes no reason, the outcome will.
    await plant(1, True, None)
    assert _verifier()[:3] == (191, 0, 0)


async def test_a_stalled_destruction_is_reclaimed_and_the_abandoned_attempt_counted(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # A deploy kills the worker mid-job as a matter of course. The row is
    # re-claimed, never re-created, and the abandoned attempt is counted —
    # a row that keeps killing the worker must exhaust its ladder. At
    # MAX_ATTEMPTS it gives up where it stands.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)

    async def _stall(attempts: int) -> None:
        async with db_session_factory() as db:
            await db.execute(
                text(
                    "UPDATE media SET claimed_at = :t, attempts = :n, available_at = NULL "
                    "WHERE id = :id"
                ),
                {
                    "t": _now() - ingest.RECLAIM_AFTER - timedelta(minutes=1),
                    "n": attempts,
                    "id": UUID(doomed),
                },
            )
            await db.commit()

    # Abandoned once: re-claimed, the attempt counted, and destroyed.
    await _stall(0)
    async with db_session_factory() as db:
        claimed = await ingest.claim_next(db, _now())
        await db.commit()
    assert claimed.status is MediaStatus.DESTROYING  # claimed IN PLACE
    assert claimed.attempts == 1
    assert claimed.claimed_at is not None

    # Abandoned for the third time: it gives up at reclaim, staying put.
    await _stall(ingest.MAX_ATTEMPTS - 1)
    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    assert row.attempts == ingest.MAX_ATTEMPTS
    assert row.claimed_at is None
    assert "never finished" in row.last_error
    # Nothing was deleted on that path, and no quarantine call was made.
    assert len(store.published) == 3
    assert store.calls == []


async def test_a_destruction_claim_lost_to_a_reclaim_writes_nothing(
    client, capsys, db_session_factory, worker, monkeypatch
):
    # The guarded update's whole job, on the new ladder: `_settle` guards on
    # the row's OWN rung and this claim's stamp, so a worker whose claim was
    # taken from it cannot write `destroyed` over the other's work.
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    store = await _seeded_store(monkeypatch, db_session_factory, doomed)

    async with db_session_factory() as db:
        row = await ingest.claim_next(db, _now())
        await db.commit()
        # Another worker reclaims it while this one is in the bucket.
        async with db_session_factory() as other:
            await other.execute(
                text("UPDATE media SET claimed_at = :t WHERE id = :id"),
                {"t": _now() + timedelta(seconds=5), "id": row.id},
            )
            await other.commit()
        outcome = await ingest.handle_destroying(db, worker, row, _now())
        await db.commit()

    assert outcome is ingest.Outcome.LOST_CLAIM
    after = await _row(db_session_factory, doomed)
    assert after.status is MediaStatus.DESTROYING
    # The objects ARE gone — the other worker will find them absent and
    # succeed, which is exactly what makes the retry safe.
    assert store.published == {}
    assert len(await _layer_keys(db_session_factory, doomed)) == 3


async def test_the_worker_logs_the_destruction_without_naming_a_key_or_a_word(
    client, capsys, db_session_factory, worker, monkeypatch, caplog
):
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    await client.patch(
        f"/media/{doomed}", json={"caption": "Jenny at bat"}, headers=cast.uploader
    )
    assert (await _destroy(client, cast.host, doomed)).status_code == 200
    keys = await _layer_keys(db_session_factory, doomed)
    await _seeded_store(monkeypatch, db_session_factory, doomed)

    with caplog.at_level(logging.DEBUG):
        assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    rendered = "\n".join(record.getMessage() for record in caplog.records)
    assert "destroyed" in rendered
    assert doomed in rendered  # a row id is not personal data
    for key in keys:
        assert key not in rendered
    assert "Jenny" not in rendered


# --- the storage function ----------------------------------------------------


def test_delete_published_takes_the_worker_client_and_nothing_else():
    # put_published_object's guard, for the same structural reason: the
    # published bucket's contents are the worker credential's alone. A
    # destruction the web service could perform would be one the credential
    # split no longer contains — the UploadClient cannot reach the bucket
    # at all and the ServeClient is read-only (CK-33's verifier proves the
    # second half against live R2).
    for wrong in (upload_client(settings), serve_client(settings), None, "not a client"):
        with pytest.raises(TypeError, match="delete_published_object"):
            delete_published_object(wrong, key="media/x/web")


def test_delete_published_treats_an_absent_object_as_a_success(worker):
    # What makes the retry idempotent (storage.py). NOT a nicety: the
    # destruction routine deletes before it commits, so an object already
    # gone is the ordinary retry path rather than an edge case.
    calls = []

    class _Absent:
        def delete_object(self, **kwargs):
            calls.append(kwargs)
            raise _client_error("NoSuchKey", 404)

    absent = WorkerClient(
        raw=_Absent(),
        quarantine_bucket=worker.quarantine_bucket,
        published_bucket=worker.published_bucket,
    )
    delete_published_object(absent, key="media/x/web")  # no raise
    assert calls == [{"Bucket": worker.published_bucket, "Key": "media/x/web"}]

    class _Denied:
        def delete_object(self, **kwargs):
            raise _client_error("AccessDenied", 403)

    denied = WorkerClient(
        raw=_Denied(),
        quarantine_bucket=worker.quarantine_bucket,
        published_bucket=worker.published_bucket,
    )
    # Everything else still raises — absent is the ONLY swallowed case, so
    # a credential or bucket problem can never read as a destruction.
    with pytest.raises(ClientError):
        delete_published_object(denied, key="media/x/web")


# --- the sweep (CK-59) --------------------------------------------------------
# `destruction.sweep_expired_bin` is the bin's automatic half: the removed
# photographs whose retrieval window (REMOVED_BIN) has closed, marked through
# the ONE marking statement, row by row. It marks and never destroys — the
# worker's claim loop takes a swept row through CK-54's routine exactly as it
# takes one the API marked. The loop's half (the switch, the interval, idle
# only, the INFO line) is pinned in test_worker.py; these pin the function's
# contract. No test here asserts on a filename or a caption.


async def _sweep(db_session_factory, now: datetime, *, limit: int = 10) -> int:
    async with db_session_factory() as db:
        return await destruction.sweep_expired_bin(db, now, limit=limit)


async def _statuses(db_session_factory, media_ids) -> list[MediaStatus]:
    return [(await _row(db_session_factory, media_id)).status for media_id in media_ids]


async def test_the_sweep_marks_at_the_window_and_not_a_second_before(client, capsys, db_session_factory):
    """THE BOUNDARY, driven by an injected `now`: one second inside the
    window is left alone; the window's own instant and one second past it
    are swept. What a mark leaves is what the endpoint's mark leaves — the
    publication state and the removal stamp untouched, the job columns
    reset, the three layers still there for the worker to take — and the
    counts drop by exactly the rows marked."""
    cast = await _cast(client, capsys, db_session_factory)
    now = _now()
    inside = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=now - REMOVED_BIN + timedelta(seconds=1),
    )
    at_the_window = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.REMOVED, removed_at=now - REMOVED_BIN
    )
    past = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=now - REMOVED_BIN - timedelta(seconds=1),
    )
    assert await _resync_counts(db_session_factory, cast.gathering_id) == (3, 3 * LAYER_BYTES)

    assert await _sweep(db_session_factory, now) == 2

    assert await _statuses(db_session_factory, [inside, at_the_window, past]) == [
        MediaStatus.READY,
        MediaStatus.DESTROYING,
        MediaStatus.DESTROYING,
    ]
    assert await _counts(db_session_factory, cast.gathering_id) == (1, LAYER_BYTES)
    await _invariants_hold(db_session_factory, cast.gathering_id)
    for media_id in (at_the_window, past):
        row = await _row(db_session_factory, media_id)
        assert row.publication_state is PublicationState.REMOVED  # destruction is not a publication decision
        assert row.removed_at is not None
        assert await _job_columns(db_session_factory, media_id) == (0, None, None, None)
        assert len(await _layer_keys(db_session_factory, media_id)) == 3  # the worker's to take
    # The same instant marks nothing more; a second later the third row's
    # window has closed too.
    assert await _sweep(db_session_factory, now) == 0
    assert await _sweep(db_session_factory, now + timedelta(seconds=1)) == 1
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_what_the_sweep_takes_is_exactly_what_the_uploader_has_stopped_seeing(
    client, capsys, db_session_factory
):
    # Bin record §6.1's two clocks meet at one instant: `_visible_media`
    # shows the uploader a removed photograph while
    # `removed_at > now - REMOVED_BIN`, and the sweep takes it once
    # `removed_at <= now - REMOVED_BIN`. One number (retention.py), two
    # readers, no gap and no overlap — nothing is swept while someone could
    # still see it, and nothing sits invisible-and-still-charged.
    cast = await _cast(client, capsys, db_session_factory)
    still_visible = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - REMOVED_BIN + timedelta(minutes=1),
    )
    gone = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - REMOVED_BIN - timedelta(minutes=1),
    )
    listed = _ids(await _list(client, cast.uploader, cast.gathering_id))
    assert still_visible in listed and gone not in listed

    assert await _sweep(db_session_factory, _now()) == 1

    assert await _statuses(db_session_factory, [still_visible, gone]) == [
        MediaStatus.READY,
        MediaStatus.DESTROYING,
    ]
    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [still_visible]


async def test_the_sweep_respects_its_limit_and_takes_the_oldest_first(client, capsys, db_session_factory):
    # Five expired rows, a limit of two: the two whose windows closed first
    # go, the other three wait for the next pass — and the count returned
    # is the count marked, both times.
    cast = await _cast(client, capsys, db_session_factory)
    now = _now()
    ages = (40, 50, 35, 45, 60)  # days in the bin, in planting order
    rows = [
        await _photograph(
            db_session_factory,
            cast,
            publication_state=PublicationState.REMOVED,
            removed_at=now - timedelta(days=age),
        )
        for age in ages
    ]
    assert await _resync_counts(db_session_factory, cast.gathering_id) == (5, 5 * LAYER_BYTES)

    assert await _sweep(db_session_factory, now, limit=2) == 2

    marked = [status is MediaStatus.DESTROYING for status in await _statuses(db_session_factory, rows)]
    assert marked == [False, True, False, False, True]  # 50 and 60 days: the oldest two
    assert await _counts(db_session_factory, cast.gathering_id) == (3, 3 * LAYER_BYTES)
    await _invariants_hold(db_session_factory, cast.gathering_id)

    assert await _sweep(db_session_factory, now, limit=10) == 3
    assert all(status is MediaStatus.DESTROYING for status in await _statuses(db_session_factory, rows))
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_the_sweep_never_selects_a_removed_row_that_is_not_ready(client, capsys, db_session_factory):
    # `removed` and long past the window on every other rung: nothing is
    # stored on the in-flight and failed rungs, and the destruction rungs
    # are already past the mark. The sweep returns 0 and writes nothing —
    # statuses, job columns and counts exactly where they were — and a
    # `ready` row that is not removed is not a candidate either.
    cast = await _cast(client, capsys, db_session_factory)
    now = _now()
    aged = now - REMOVED_BIN - timedelta(days=5)
    planted: dict[MediaStatus, str] = {}
    for status in (
        MediaStatus.PENDING_UPLOAD,
        MediaStatus.UPLOADED,
        MediaStatus.PROCESSING,
        MediaStatus.FAILED,
        MediaStatus.DESTROYING,
        MediaStatus.DESTROYED,
    ):
        planted[status] = await _photograph(
            db_session_factory,
            cast,
            status=status,
            publication_state=PublicationState.REMOVED,
            removed_at=aged,
        )
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE media SET attempts = 1, last_error = :why WHERE id = :id"),
            {"why": ingest.ERROR_OBJECT_MISSING, "id": UUID(planted[MediaStatus.FAILED])},
        )
        await db.commit()
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert before == (1, LAYER_BYTES)  # the live row alone is ready
    history = await _job_columns(db_session_factory, planted[MediaStatus.FAILED])

    assert await _sweep(db_session_factory, now) == 0

    for status, media_id in planted.items():
        assert (await _row(db_session_factory, media_id)).status is status
    assert await _job_columns(db_session_factory, planted[MediaStatus.FAILED]) == history
    assert (await _row(db_session_factory, live)).status is MediaStatus.READY
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_a_memorials_bin_sweeps_like_any_other(db_session_factory):
    # Bin record §7.4 (decided at CK-15 §2): permanence is a storage promise
    # about the GATHERING, never a publication promise about a photograph in
    # it. No memorial branch, no type branch, no account branch: the
    # memorial's expired removed row goes at the window and its counters
    # drop, exactly as the potluck's beside it do.
    now = _now()
    aged = now - REMOVED_BIN - timedelta(days=1)
    async with db_session_factory() as db:
        memorial = await _mk_gathering(
            db, gathering_type=GatheringType.MEMORIAL, memorial_decedent_name="Test Decedent"
        )
        potluck = await _mk_gathering(db)
        rows = []
        for gathering in (memorial, potluck):
            row = _media(gathering.id, status=MediaStatus.READY)
            row.publication_state = PublicationState.REMOVED
            row.removed_at = aged
            db.add(row)
            rows.append(row)
        await db.commit()
        memorial_id, potluck_id = memorial.id, potluck.id
        media_ids = [str(row.id) for row in rows]
    async with db_session_factory() as db:
        subject = await db.get(Gathering, memorial_id)
        assert subject.gathering_type is GatheringType.MEMORIAL and subject.memorial_decedent_name
    # `_media` plants no layers: the count is the subject here, the bytes 0.
    assert await _resync_counts(db_session_factory, memorial_id) == (1, 0)
    assert await _resync_counts(db_session_factory, potluck_id) == (1, 0)

    assert await _sweep(db_session_factory, now) == 2

    assert await _statuses(db_session_factory, media_ids) == [MediaStatus.DESTROYING, MediaStatus.DESTROYING]
    for gathering_id in (memorial_id, potluck_id):
        assert await _counts(db_session_factory, gathering_id) == (0, 0)
        await _invariants_hold(db_session_factory, gathering_id)


async def test_two_sweeps_over_the_same_expired_row_mark_it_once(
    client, capsys, db_session_factory, monkeypatch
):
    """THE CONCURRENCY PROPERTY, through the real guard — CK-58's pin,
    exercised by the caller it was written for. Two sweeps (two worker
    instances, or a sweep and a person) both SELECT the same expired row;
    the first marks it and commits; the second's mark finds the row no
    longer `ready` and returns False with nothing written. One mark, one
    decrement, and the second pass counts 0 — "someone got there first"
    is not an error."""
    cast = await _cast(client, capsys, db_session_factory)
    now = _now()
    doomed = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=now - REMOVED_BIN - timedelta(days=1),
    )
    assert await _resync_counts(db_session_factory, cast.gathering_id) == (1, LAYER_BYTES)
    real_mark = destruction.mark_for_destruction
    inner: list[int] = []

    async def raced(db, row):
        # Between the outer sweep's SELECT and its mark, the other sweep
        # runs to completion on the same row in its own session.
        if not inner:
            monkeypatch.setattr(destruction, "mark_for_destruction", real_mark)
            async with db_session_factory() as other:
                inner.append(await destruction.sweep_expired_bin(other, now, limit=10))
        return await real_mark(db, row)

    monkeypatch.setattr(destruction, "mark_for_destruction", raced)
    outer = await _sweep(db_session_factory, now)

    assert (inner, outer) == ([1], 0)
    row = await _row(db_session_factory, doomed)
    assert row.status is MediaStatus.DESTROYING
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)
    assert len(await _layer_keys(db_session_factory, doomed)) == 3
    # And a person reaching for the same photograph afterwards draws the 404
    # `_visible_media` gives a row in destruction — never a second decrement.
    assert (await _destroy(client, cast.host, doomed)).status_code == 404
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)
