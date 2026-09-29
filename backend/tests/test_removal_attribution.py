"""CK-63 — who removed it: removal attribution, the uploader's view narrowed
to their own removals, and restore from your own bin
(decisions/2026-09-27-two-bins.md §1–§4; migration 0026).

The cast and the row-planting are test_media_reads' — host, uploader (an
accepted invitee), keeper, bystander (a second accepted invitee), stranger —
because every act here runs inside CK-37's audience rule and then narrows
it. No network anywhere.

The load-bearing pins:
- `remove` writes the caller's person id and `decline` writes the host's,
  each in the SAME statement as `removed_at` — never a second one;
- the uploader lists and opens a photograph THEY removed; the uploader of a
  photograph the HOST removed, and of one the host DECLINED, gets it absent
  from the list and a 404 byte-identical to a missing id on `/url`,
  `/restore` and `/destroy` — the gathering's bin is the HOST's to read
  (CK-66; test_gathering_bin.py), never the uploader's;
- a removed row with NO recorded remover (every removal before 0026) is
  invisible to its uploader — and the sweep still takes it at the window;
- restore in an OPEN gathering → `live`, an existing publication stamp
  kept, a never-published row stamped now with a NULL publisher;
- restore in a GATED gathering → `pending`, both stamps cleared, the row
  back in the host's queue;
- restore by the host, a keeper, a stranger, and the uploader of a
  host-removed row → 404, byte-identical; the host's OWN removal stays in
  their own bin and they restore it;
- restore of a `live` or `pending` row → 409 `not_removed`; of a `failed`
  row → 409 `not_ready`; past REMOVED_BIN → 404;
- `photo_count`, `total_bytes` and the keeper's usage are IDENTICAL before
  and after a remove-then-restore — a binned photograph was never uncounted;
- the guarded UPDATE's lost race — the row marked `destroying` between the
  read and the write → 409, and nothing changed;
- remove → restore → remove again stamps a fresh `removed_at` and remover;
- the verifier's two new invariants fire on the plants that violate them
  and on nothing else, run as the operator runs it.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import event, text

from app.api import media as media_api
from app.api.media import NOT_PENDING, NOT_READY, NOT_REMOVED
from app.db import engine
from app.models import Gathering, Media, MediaStatus, PublicationState
from app.services import destruction, keeping
from app.services.retention import REMOVED_BIN
from tests.test_destruction import (
    _counts,
    _destroy,
    _invariants_hold,
    _remove,
    _resync_counts,
    _row,
    _verifier,
)
from tests.test_gatherings import _account_for
from tests.test_media_reads import (
    KEEPER,
    MISSING_ID,
    Cast,
    _cast,
    _ids,
    _list,
    _photograph,
    _url,
)
from tests.test_review import _decline, _host_person_id, _hosts_own_photograph, _publish, _queue


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _restore(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/restore", headers=headers)


async def _state(db_session_factory, media_id: str) -> tuple:
    """(status, publication_state, removed_at, removed_by_person_id,
    published_at, published_by_person_id) — the six columns this phase
    moves or must not move."""
    row = await _row(db_session_factory, media_id)
    return (
        row.status,
        row.publication_state,
        row.removed_at,
        row.removed_by_person_id,
        row.published_at,
        row.published_by_person_id,
    )


async def _gate(db_session_factory, cast: Cast, requires_approval: bool | None) -> None:
    """The host's own setting, written directly (CK-44's PATCH writes the
    same column): True gates, None inherits — and every gathering here
    inherits OPEN (groupless, person-hosted, privately joined)."""
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, cast.gathering_id)
        gathering.requires_approval = requires_approval
        await db.commit()


async def _stamp_published(db_session_factory, media_id: str, at: datetime, by: UUID | None) -> None:
    """The publication stamp as the host's publish (or the worker) would
    have left it — planted, because `_photograph` writes the state and not
    the stamp."""
    async with db_session_factory() as db:
        row = await db.get(Media, UUID(media_id))
        row.published_at = at
        row.published_by_person_id = by
        await db.commit()


async def _usage(db_session_factory) -> tuple[int, int]:
    """(the keeper's usage, the keeper's bin count) — the two numbers a
    restore must and must not move."""
    async with db_session_factory() as db:
        keeper = await _account_for(db, KEEPER)
        return (
            await keeping.account_usage(db, keeper),
            await keeping.account_bin_count(db, keeper),
        )


# --- the attribution -----------------------------------------------------------


async def test_remove_and_decline_record_who_removed_it_in_the_same_statement_as_when(
    client, capsys, db_session_factory
):
    """`removed_by_person_id` is the caller's id on `remove` and the host's
    on `decline`, and each is written in the ONE guarded UPDATE that
    stamps `removed_at` — pinned at the cursor: exactly one UPDATE on
    media per act names the remover, and that statement names the stamp
    too. Two columns that move together or not at all is what makes the
    verifier's "a remover is always dated" an invariant rather than a
    hope."""
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    waiting = await _photograph(db_session_factory, cast)  # ready + pending: the queue
    host_person = await _host_person_id(db_session_factory)

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    def remover_updates() -> list[str]:
        return [
            s
            for s in statements
            if s.lstrip().upper().startswith("UPDATE media".upper()) and "removed_by_person_id" in s
        ]

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        # The uploader takes their own back.
        statements.clear()
        assert (await _remove(client, cast.uploader, mine)).status_code == 200
        updates = remover_updates()
        assert len(updates) == 1 and "removed_at" in updates[0], statements
        # The host removes someone else's.
        statements.clear()
        assert (await _remove(client, cast.host, theirs)).status_code == 200
        updates = remover_updates()
        assert len(updates) == 1 and "removed_at" in updates[0], statements
        # The host declines.
        statements.clear()
        assert (await _decline(client, cast.host, waiting)).status_code == 200
        updates = remover_updates()
        assert len(updates) == 1 and "removed_at" in updates[0], statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    for media_id, remover in ((mine, cast.uploader_person_id), (theirs, host_person), (waiting, host_person)):
        status, state, removed_at, removed_by, published_at, publisher = await _state(
            db_session_factory, media_id
        )
        assert (status, state) == (MediaStatus.READY, PublicationState.REMOVED)
        assert removed_at is not None
        assert removed_by == remover
    # The remover rides no body (the publisher's rule).
    body = (await _list(client, cast.uploader, cast.gathering_id)).json()["media"]
    assert body and all("removed_by_person_id" not in item for item in body)


async def test_the_uploader_sees_what_they_removed_and_nothing_the_host_removed_or_declined(
    client, capsys, db_session_factory
):
    """TWO BINS (two-bins record §1–§3). The uploader's own removal is in
    their bin: listed with the clock, a URL mints. A photograph the host
    removed, and one the host declined, are in the GATHERING's bin — the
    uploader gets them absent from the list and the media 404
    byte-identical to a missing id on `/url`, `/restore` and `/destroy`;
    a keeper and an accepted invitee get exactly the same nothing. THE
    HOST reads that bin since CK-66 (until then they got the same nothing
    too): the two rows they removed open for them, while their DEFAULT
    list stays clean — the bin is a view (`removed=true`,
    test_gathering_bin.py), not a mixture — and the uploader's own bin is
    still not theirs to see into."""
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    host_removed = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    declined = await _photograph(db_session_factory, cast)
    assert (await _remove(client, cast.uploader, mine)).status_code == 200
    assert (await _remove(client, cast.host, host_removed)).status_code == 200
    assert (await _decline(client, cast.host, declined)).status_code == 200

    # Your bin.
    listed = await _list(client, cast.uploader, cast.gathering_id)
    assert _ids(listed) == [mine]
    item = listed.json()["media"][0]
    assert item["is_own"] is True and item["removed_at"] is not None
    assert (await _url(client, cast.uploader, mine)).status_code == 200

    # The gathering's bin, from the uploader's seat: gone, and not a hint
    # that it exists — each endpoint's 404 compared with its own missing-id
    # 404, per caller.
    for media_id in (host_removed, declined):
        for act in (_url, _restore, _destroy):
            refused = await act(client, cast.uploader, media_id)
            missing = await act(client, cast.uploader, MISSING_ID)
            assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__
    # And from a keeper's and a second invitee's: neither bin admits them.
    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        for media_id in (mine, host_removed, declined):
            assert (await _url(client, headers, media_id)).status_code == 404
    # The HOST (CHANGED at CK-66 — until then this loop included them):
    # their default list stays clean, the uploader's own bin is still not
    # theirs, and the two gathering-bin rows open for them.
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == []
    assert (await _url(client, cast.host, mine)).status_code == 404
    for media_id in (host_removed, declined):
        assert (await _url(client, cast.host, media_id)).status_code == 200
    # Nothing moved: all three still `ready` and `removed`, layers intact.
    for media_id in (mine, host_removed, declined):
        status, state, removed_at, *_ = await _state(db_session_factory, media_id)
        assert (status, state) == (MediaStatus.READY, PublicationState.REMOVED) and removed_at is not None


async def test_a_removed_row_with_no_recorded_remover_is_visible_to_nobody_and_still_sweeps(
    client, capsys, db_session_factory
):
    """Every row removed before 0026 — the two 2026-09-14 declines among
    them. NULL means no recorded remover, and the read rule shows such a
    row to NOBODY rather than guess: a self-removal and a decline cannot be
    told apart after the fact, and showing a declined photograph to its
    uploader is the harm the record exists to prevent. The sweep does not
    read the column: both bins clear at the window (two-bins §1.5), so an
    unattributed row goes on 2026-10-14 exactly as it would have."""
    cast = await _cast(client, capsys, db_session_factory)
    legacy = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=1),
    )
    expired = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - REMOVED_BIN - timedelta(days=1),
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _row(db_session_factory, legacy)).removed_by_person_id is None

    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        for act in (_url, _restore, _destroy):
            refused = await act(client, headers, legacy)
            missing = await act(client, headers, MISSING_ID)
            assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__
    # Untouched by all of that.
    status, state, removed_at, removed_by, *_ = await _state(db_session_factory, legacy)
    assert (status, state, removed_by) == (MediaStatus.READY, PublicationState.REMOVED, None)
    assert removed_at is not None

    # The sweep takes the expired unattributed row and leaves the one still
    # inside the window — who removed it never enters into it.
    async with db_session_factory() as db:
        assert await destruction.sweep_expired_bin(db, _now(), limit=10) == 1
    assert (await _row(db_session_factory, expired)).status is MediaStatus.DESTROYING
    assert (await _row(db_session_factory, legacy)).status is MediaStatus.READY
    await _invariants_hold(db_session_factory, cast.gathering_id)


# --- restore -------------------------------------------------------------------


async def test_restore_in_an_open_gathering_goes_live_and_keeps_an_existing_publication_stamp(
    client, capsys, db_session_factory
):
    """THE WAY BACK FROM YOUR OWN BIN (two-bins §4). The gathering resolves
    open, so the restored photograph is `live` again for the whole read
    audience; its publication stamp — WHEN and WHO — is exactly what it was
    before the removal (going to the bin and back does not re-date a
    publication); both removal columns are cleared; and nothing about the
    charge moves."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    host_person = await _host_person_id(db_session_factory)
    published = _now() - timedelta(days=3)
    await _stamp_published(db_session_factory, media_id, published, host_person)
    before = await _resync_counts(db_session_factory, cast.gathering_id)

    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    assert (await _state(db_session_factory, media_id))[1] is PublicationState.REMOVED

    response = await _restore(client, cast.uploader, media_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["publication_state"]) == ("ready", "live")
    assert body["published_at"] is not None
    assert "removed_by_person_id" not in body

    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, media_id)
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert (removed_at, removed_by) == (None, None)
    assert (published_at, publisher) == (published, host_person)  # kept, not re-dated
    # Live again for everyone in the read audience; the stranger still 404.
    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]
        assert (await _url(client, headers, media_id)).status_code == 200
    assert (await _url(client, cast.stranger, media_id)).status_code == 404
    # No count moved.
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_restore_of_a_never_published_row_into_an_open_gathering_stamps_now_with_no_publisher(
    client, capsys, db_session_factory
):
    """The strand's shape: a `ready` + `pending` row (never published — the
    host turned review off while it waited), which the uploader removed
    and now puts back into a gathering that resolves open. It goes `live`
    and the stamp is written by the rule — the transaction's now(), and a
    NULL publisher, the worker's convention — because a `live` row written
    after 0020 is always dated."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)  # ready + pending, unstamped
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, media_id)).status_code == 200

    t0 = _now()
    response = await _restore(client, cast.uploader, media_id)
    assert response.status_code == 200, response.text
    assert response.json()["publication_state"] == "live"

    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, media_id)
    assert (status, state, removed_at, removed_by) == (MediaStatus.READY, PublicationState.LIVE, None, None)
    assert published_at is not None and abs((published_at - t0).total_seconds()) < 60
    assert publisher is None  # the rule published it, not a person
    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]


async def test_restore_in_a_gated_gathering_goes_pending_with_both_stamps_cleared(
    client, capsys, db_session_factory
):
    """A RESTORE NEVER BYPASSES THE HOST'S REVIEW (two-bins §4). The
    gathering resolves gated, so a photograph that was PUBLISHED, removed
    and put back waits for the host again: `pending`, in the queue, with
    `published_at` AND `published_by_person_id` both cleared ("no pending
    row carries a published_at" is a verifier invariant; the host's publish
    stamps the pair afresh). The restorer did not choose this and could
    not: the gate did. Visible to the uploader and the host and nobody
    else — CK-37's `pending` audience, unchanged."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    host_person = await _host_person_id(db_session_factory)
    await _stamp_published(db_session_factory, media_id, _now() - timedelta(days=3), host_person)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    # The host turns review on AFTER the removal: the gate is read at
    # restore time, never from what the row was before.
    await _gate(db_session_factory, cast, True)

    response = await _restore(client, cast.uploader, media_id)
    assert response.status_code == 200, response.text
    assert (response.json()["publication_state"], response.json()["published_at"]) == ("pending", None)

    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, media_id)
    assert (status, state) == (MediaStatus.READY, PublicationState.PENDING)
    assert (removed_at, removed_by, published_at, publisher) == (None, None, None, None)
    # Back in the host's queue; the uploader and the host see it; a keeper
    # and a second invitee do not.
    assert _ids(await _queue(client, cast.host, cast.gathering_id)) == [media_id]
    for headers in (cast.uploader, cast.host):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]
    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        assert (await _url(client, headers, media_id)).status_code == 404
    assert await _counts(db_session_factory, cast.gathering_id) == before
    # And the host's publish stamps it afresh, as any pending row.
    assert (await _publish(client, cast.host, media_id)).status_code == 200
    *_, published_at, publisher = await _state(db_session_factory, media_id)
    assert published_at is not None and publisher == host_person


async def test_restore_is_the_uploaders_alone_on_their_own_removal(client, capsys, db_session_factory):
    """WHO MAY PUT IT BACK from the PERSONAL bin: the uploader, on a
    photograph they removed themselves. The host, a keeper, an accepted
    invitee and a stranger each draw the media 404 byte-identical to a
    missing id on the uploader's own removal, and nothing moves; the
    uploader of a photograph the HOST removed draws the same 404 — it is
    in the gathering's bin, not theirs. The host removing THEIR OWN upload
    is its remover and its uploader, so that row is in the host's own bin
    and the host restores it. The HOST's restore of a gathering-bin row
    succeeds since CK-66 (until then it drew the 404 — nothing read that
    bin); its semantics are test_gathering_bin.py's, and the pin kept here
    is that the uploader's monopoly is on THEIR bin, not the gathering's."""
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    host_removed = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    hosts_own = await _hosts_own_photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, mine)).status_code == 200
    assert (await _remove(client, cast.host, host_removed)).status_code == 200
    assert (await _remove(client, cast.host, hosts_own)).status_code == 200
    mine_before = await _state(db_session_factory, mine)

    for headers in (cast.host, cast.keeper, cast.bystander, cast.stranger):
        refused = await _restore(client, headers, mine)
        missing = await _restore(client, headers, MISSING_ID)
        assert (refused.status_code, refused.json()) == (404, missing.json())
    assert await _state(db_session_factory, mine) == mine_before
    # The uploader of a host-removed photograph: not their bin.
    refused = await _restore(client, cast.uploader, host_removed)
    assert (refused.status_code, refused.json()) == (404, (await _restore(client, cast.uploader, MISSING_ID)).json())
    # The host's own removal of their own upload: their bin, their restore
    # — and never the gathering's bin, so it sits in their DEFAULT list.
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == [hosts_own]
    restored = await _restore(client, cast.host, hosts_own)
    assert restored.status_code == 200, restored.text
    assert (await _state(db_session_factory, hosts_own))[1] is PublicationState.LIVE
    # And the uploader's own is still theirs to put back.
    assert (await _restore(client, cast.uploader, mine)).status_code == 200
    # The HOST's restore of the row THEY removed succeeds since CK-66 —
    # the gathering's bin is theirs to put back from (CHANGED: until
    # CK-66 this drew the 404 and the row stayed removed, because nothing
    # read that bin). The destination and stamps are test_gathering_bin's.
    assert (await _restore(client, cast.host, host_removed)).status_code == 200
    assert (await _state(db_session_factory, host_removed))[1] is PublicationState.LIVE


async def test_restore_refuses_a_row_not_in_the_bin_and_a_bin_past_its_window_is_gone(
    client, capsys, db_session_factory
):
    """The refusals, in the order the endpoint applies them after the 404:
    409 `not_ready` carrying the rung for a `failed` row (visible to its
    uploader, nothing stored to put back); 409 `not_removed` for a `live`
    and a `pending` row (not in the bin); and a self-removed row past
    REMOVED_BIN is a 404 byte-identical to a missing id — the bin has
    closed. Nothing moves on any refusal."""
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    pending = await _photograph(db_session_factory, cast)
    failed = await _photograph(db_session_factory, cast, status=MediaStatus.FAILED)
    expired = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - REMOVED_BIN - timedelta(minutes=1),
        removed_by_person_id=cast.uploader_person_id,
    )
    await _resync_counts(db_session_factory, cast.gathering_id)
    before = {m: await _state(db_session_factory, m) for m in (live, pending, failed, expired)}

    for media_id, state in ((live, "live"), (pending, "pending")):
        refused = await _restore(client, cast.uploader, media_id)
        assert refused.status_code == 409, refused.text
        detail = refused.json()["detail"]
        assert (detail["code"], detail["publication_state"], detail["status"]) == (NOT_REMOVED, state, "ready")
    refused = await _restore(client, cast.uploader, failed)
    assert refused.status_code == 409
    assert (refused.json()["detail"]["code"], refused.json()["detail"]["status"]) == (NOT_READY, "failed")
    gone = await _restore(client, cast.uploader, expired)
    assert (gone.status_code, gone.json()) == (404, (await _restore(client, cast.uploader, MISSING_ID)).json())
    for media_id, was in before.items():
        assert await _state(db_session_factory, media_id) == was


async def test_photo_count_total_bytes_and_usage_are_identical_across_a_remove_and_a_restore(
    client, capsys, db_session_factory
):
    """NO COUNT MOVES (two-bins §4; bin record §3). A binned photograph was
    never uncounted — it is still stored — so a restore cannot push an
    account over its allowance: `photo_count`, `total_bytes` and the
    keeper's usage read the same number before the removal, while the
    photograph is in the bin, and after the restore. Only the bin COUNT
    moves, and only because the row leaves `removed`."""
    cast = await _cast(client, capsys, db_session_factory)
    for _ in range(2):
        await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    counts_before = await _resync_counts(db_session_factory, cast.gathering_id)
    usage_before, bin_before = await _usage(db_session_factory)
    assert counts_before[0] == 3 and usage_before == 3 and bin_before == 0

    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    assert await _counts(db_session_factory, cast.gathering_id) == counts_before
    assert await _usage(db_session_factory) == (usage_before, 1)
    await _invariants_hold(db_session_factory, cast.gathering_id)

    assert (await _restore(client, cast.uploader, media_id)).status_code == 200
    assert await _counts(db_session_factory, cast.gathering_id) == counts_before
    assert await _usage(db_session_factory) == (usage_before, 0)
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_a_restore_that_loses_the_race_to_the_sweep_is_refused_and_changes_nothing(
    client, capsys, db_session_factory, monkeypatch
):
    """THE GUARDED UPDATE'S LOST RACE. The endpoint reads the row, and
    between that read and its write the sweep marks the row `destroying`
    (from its own session — the sweep's SELECT takes no lock, so at the
    window's own instant both can select the row). The guard — still
    `ready`, still `removed`, still removed by this caller — matches
    nothing, the transaction rolls back, and the caller reads the lost-race
    409. The row is exactly what the mark left: `destroying`, its removal
    columns intact as provenance, the counts where the mark put them.
    Never half-applied. The read is stubbed to skip the row lock, because
    under the lock the mark would wait for the restore rather than race it
    — the stub is the race, not a change to the endpoint."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    removed_at_before = (await _row(db_session_factory, media_id)).removed_at
    real_read = media_api._restorable_row

    async def raced(db, ctx, target, now):
        # The read, without the lock the real helper takes...
        row = await db.get(Media, target)
        gathering = await db.get(Gathering, row.gathering_id)
        # ...and the sweep's mark landing before the write, in its own
        # session through the real marking statement.
        async with db_session_factory() as other:
            marked = await destruction.mark_for_destruction(other, await other.get(Media, target))
            await other.commit()
        assert marked
        return row, gathering

    monkeypatch.setattr(media_api, "_restorable_row", raced)
    refused = await _restore(client, cast.uploader, media_id)
    monkeypatch.setattr(media_api, "_restorable_row", real_read)

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == media_api._CHANGED_WHILE_DECIDING
    assert refused.json()["detail"]["code"] == NOT_PENDING
    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, media_id)
    assert (status, state) == (MediaStatus.DESTROYING, PublicationState.REMOVED)
    assert (removed_at, removed_by) == (removed_at_before, cast.uploader_person_id)  # provenance kept
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)  # the mark's, untouched by the restore
    await _invariants_hold(db_session_factory, cast.gathering_id)
    # Gone from every surface, as a row in destruction is.
    assert (await _restore(client, cast.uploader, media_id)).status_code == 404


async def test_remove_restore_remove_again_stamps_a_fresh_removal(client, capsys, db_session_factory):
    """A second removal is a NEW removal: `removed_at` and the remover are
    written afresh, so the retrieval window restarts — correct, because the
    person removed it again, now. Between the two the row carried neither."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)

    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    _, _, first, remover, *_ = await _state(db_session_factory, media_id)
    assert first is not None and remover == cast.uploader_person_id
    assert (await _restore(client, cast.uploader, media_id)).status_code == 200
    assert (await _state(db_session_factory, media_id))[2:4] == (None, None)
    await asyncio.sleep(0.05)  # Windows' clock granularity can tie two stamps
    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    _, state, second, remover, *_ = await _state(db_session_factory, media_id)
    assert state is PublicationState.REMOVED
    assert second is not None and second > first
    assert remover == cast.uploader_person_id
    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [media_id]


async def test_restore_logs_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """The router still has no logger. With the ROOT logger at DEBUG a
    restore, a refused restore and a 404 together put no person id and no
    act into any application log record."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, media_id)).status_code == 200
    host_person = str(await _host_person_id(db_session_factory))
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (await _restore(client, cast.uploader, media_id)).status_code == 200
        assert (await _restore(client, cast.uploader, live)).status_code == 409  # not_removed
        # 409, not the 404 it was until CK-66: the host is a restorer now,
        # so on a row that is live again they reach the not_removed
        # refusal — a live row is one they can already see and remove.
        assert (await _restore(client, cast.host, media_id)).status_code == 409
        assert (await _restore(client, cast.keeper, live)).status_code == 404
    assert host_person not in caplog.text
    assert str(cast.uploader_person_id) not in caplog.text
    assert not any(record.name.startswith(("app", "covey-keep")) for record in caplog.records)


# --- the verifier's two invariants ---------------------------------------------


async def test_the_verifier_asserts_both_attribution_invariants(client, capsys, db_session_factory):
    """scripts/verify_schema.py's two CK-63 integrity lines, run as the
    operator runs it — a fresh interpreter against the test database — on
    a clean baseline that exercises every legitimate shape (a self-removal
    through the API, a NULL-remover row, a live row), then on plants that
    violate each line in turn. A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's lesson),
    so each is counted by its own SELECT before the verifier reads it."""
    dated = "every media row with a remover carries a removed_at"
    outside = "no live or pending media row carries a remover (restore clears it with removed_at)"
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    legacy = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=2),
    )
    subject = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.uploader, mine)).status_code == 200

    passed, failed, code, out = _verifier()
    assert (failed, code) == (0, 0), out
    assert f"PASS  {dated}" in out and f"PASS  {outside}" in out
    assert "no recorded remover (removed before 0026; must never grow): 1" in out
    clean = passed

    async def plant(media_id: str, sql: str, confirm: str) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), {"id": UUID(media_id), "p": cast.uploader_person_id})
            await db.commit()
            assert await db.scalar(text(confirm), {"id": UUID(media_id)}) == 1, "the plant did not land"

    # (1) A remover with no removed_at: fires the first line and only it.
    await plant(
        legacy,
        "UPDATE media SET removed_by_person_id = :p, removed_at = NULL WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND removed_by_person_id IS NOT NULL AND removed_at IS NULL",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (clean - 1, 1, 1), out
    assert f"FAIL  {dated}" in out and f"PASS  {outside}" in out
    await plant(
        legacy,
        "UPDATE media SET removed_by_person_id = NULL, removed_at = now() - interval '2 days' WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND removed_by_person_id IS NULL AND removed_at IS NOT NULL",
    )
    # (2) A `live` row carrying a remover: the second line, and only it.
    await plant(
        subject,
        "UPDATE media SET removed_by_person_id = :p, removed_at = now() WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND publication_state = 'live' AND removed_by_person_id IS NOT NULL",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (clean - 1, 1, 1), out
    assert f"FAIL  {outside}" in out and f"PASS  {dated}" in out
    # ...and a `pending` one, the same line.
    await plant(
        subject,
        "UPDATE media SET publication_state = 'pending' WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND publication_state = 'pending' AND removed_by_person_id IS NOT NULL",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (clean - 1, 1, 1), out
    assert f"FAIL  {outside}" in out
    # Every plant removed: clean again.
    await plant(
        subject,
        "UPDATE media SET publication_state = 'live', removed_by_person_id = NULL, removed_at = NULL WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND publication_state = 'live' AND removed_by_person_id IS NULL",
    )
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (clean, 0, 0), out
