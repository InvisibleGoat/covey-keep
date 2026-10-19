"""CK-71 — a photograph that cannot be kept says why, and can be dismissed
(decisions/2026-09-06-media-pipeline-architecture.md §6.5, as amended;
migration 0028 — `media.failure_reason`, nullable, no default, with the
one-time backfill from `last_error`'s stable prefixes).

Three defects, one subject — what a person is told when a photograph
cannot be kept — and the pins below are the phase:

- THE REASON IS WRITTEN AT THE DEAD-LETTER, BESIDE `last_error` AND NEVER
  DERIVED FROM IT: all four dead-letter paths through the real worker (the
  object missing → `upload_incomplete`; the renamed .mov and the 50.4 MP
  PNG through the REAL decoder → `unreadable` and `too_large`; the
  transient ladder spent → `interrupted`; three abandonments at reclaim →
  `interrupted`), each writing `status = 'failed'` and the reason in ONE
  statement (counted at the cursor); the retry rung writes no reason and a
  row that reaches `ready` after a transient failure carries NULL; the
  Undecodable's kind comes from the branch that raised it, never its text;
- THE BODY CARRIES THE REASON AND NEVER `last_error` — the list body and
  the intent body alike (every body is `_media_body`);
- A `failed` ROW IS THE UPLOADER'S ALONE (§6.5: failure belongs to the
  uploader): listed, with its reason, and openable to a 409 `not_ready`
  for the uploader; ABSENT from the host's list, and the media 404
  byte-identical to a missing id for the host on `/url` and on every act
  — publish, decline, remove, destroy, restore, dismiss; the same for a
  keeper, an invitee and a stranger, who saw nothing before either; the
  host's OWN failed row still listed for them; a guest upload's failed row
  (no uploader person) visible to nobody — recorded, the guest flow is
  unbuilt; the queue never held a failed row and still does not;
- DISMISS IS A HARD DELETE, THE UPLOADER'S: 204 with no body; the row and
  its tags gone (the CASCADE); a second dismiss the 404; a row that has not
  failed 409 `not_failed` carrying the rung with nothing written — never
  `not_ready`, which means "wait"; every other seat the 404 with the row
  intact; no count moved (`photo_count`, `total_bytes`, the keeper's
  usage); nothing logged at DEBUG; no store call, and the router still
  imports neither `ingest` nor a storage delete;
- THE 0028 ROUND TRIP against planted rows — one per text STEP 0 found a
  `failed` row could carry since CK-35, a `ready` row, and one failed row
  with a text the code never wrote, so the INFO line's "left NULL" count is
  shown to count — down, up, down, up to the same values, the type and the
  column genuinely gone in between;
- THE VERIFIER's eight new lines on a clean baseline, and its invariant
  fired by both plants (a failed row with no reason; a ready row with one),
  each plant confirmed by its own SELECT before the verifier reads it.
"""

import inspect
import io
import logging
from datetime import timedelta
from uuid import UUID

import pytest
from PIL import Image
from sqlalchemy import event, func, select, text

import app.api.media as media_api
from app.api.media import NOT_FAILED, NOT_READY
from app.db import engine
from app.models import (
    Media,
    MediaFailureReason,
    MediaStatus,
    MediaTag,
    PublicationState,
)
from app.services import ingest, keeping
from app.services.ingest import (
    ERROR_ABANDONED,
    ERROR_OBJECT_MISSING,
    ERROR_UNDECODABLE,
    MAX_ATTEMPTS,
    RECLAIM_AFTER,
    claim_next,
)
from app.services.processing import Undecodable, render_layers
from app.services.storage import quarantine_key
from app.worker import Poll, poll_once
from tests.test_co_hosts import _co_hosted
from tests.test_destruction import _counts, _resync_counts, _verifier
from tests.test_gatherings import _account_for
from tests.test_keeping import _mk_gathering
from tests.test_media_reads import KEEPER, MISSING_ID, _cast, _ids, _list, _photograph, _url
from tests.test_media_schema import _enum_labels
from tests.test_media_words import _patch
from tests.test_photo_count import HEAD, _migrate
from tests.test_review import _decline, _hosts_own_photograph, _publish
from tests.test_worker import (
    GPS_PHOTO,
    FakeStore,
    _client_error,
    _media,
    _now,
    _row,
    _stub_head,
    _uploaded_row,
    worker,  # noqa: F401 — the fixture
    worker_settings,  # noqa: F401 — the fixture
)

# The Live Photo's MOV half, renamed: a QuickTime `ftyp` box (the
# test_worker/test_processing subject).
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  " + bytes(300)

REASONS = ("too_large", "unreadable", "upload_incomplete", "interrupted")


def _tiny_png_of(width: int, height: int) -> bytes:
    # A 1-bit PNG: a huge pixel count in a small file — the decompression
    # bomb shape the pixel guard exists for (bytes bound nothing; pixels do).
    buffer = io.BytesIO()
    Image.new("1", (width, height), 1).save(buffer, "PNG")
    return buffer.getvalue()


async def _dismiss(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/dismiss", headers=headers)


async def _remove(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/remove", headers=headers)


async def _destroy(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/destroy", headers=headers)


async def _restore(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/restore", headers=headers)


# Every per-object act a failed row could be the subject of, each taking
# (client, headers, media_id) — the shape the audience matrix loops over.
ACTS = (_url, _publish, _decline, _remove, _destroy, _restore, _dismiss)


async def _usage(db_session_factory) -> int:
    async with db_session_factory() as db:
        return await keeping.account_usage(db, await _account_for(db, KEEPER))


async def _reason_and_rung(db_session_factory, media_id) -> tuple:
    row = await _row(db_session_factory, media_id)
    return row.status, row.failure_reason


# --- the kind travels on the exception, from the branch that raised it ------------


def test_the_undecodable_kind_comes_from_the_branch_that_raised_it_never_from_its_text():
    """processing.Undecodable carries the PERSON's half of the fact beside
    the operator's text: TOO_LARGE from the two pixel-guard raises (and
    Pillow's own backstop past twice the limit — the same guard), UNREADABLE
    from every other — a renamed .mov, random bytes, nothing at all, an
    unsupported format, a truncated photograph. The default is UNREADABLE,
    the safe direction (a raise that forgets to say offers no retry that
    cannot succeed), and NOTHING parses the text: the pixel guard's own
    sentence handed to a bare Undecodable stays UNREADABLE. And the
    worker's `_permanent_failure` REQUIRES the reason — no default to
    forget — so a new dead-letter path cannot write `failed` without one."""
    with pytest.raises(Undecodable) as guard:
        render_layers(_tiny_png_of(7100, 7100))  # 50.41 MP in under 50 KB
    assert guard.value.kind is MediaFailureReason.TOO_LARGE
    assert guard.value.reason == "larger than the 50 megapixel limit"
    with pytest.raises(Undecodable) as backstop:
        render_layers(_tiny_png_of(10_100, 10_100))  # 102 MP: Pillow's own refusal
    assert backstop.value.kind is MediaFailureReason.TOO_LARGE

    for data in (MOV, b"this is not a photograph", b""):
        with pytest.raises(Undecodable) as exc:
            render_layers(data)
        assert exc.value.kind is MediaFailureReason.UNREADABLE, data[:8]
        assert exc.value.reason.startswith("not a decodable image (")
    gif = io.BytesIO()
    Image.new("RGB", (4, 4), (0, 0, 0)).save(gif, "GIF")
    with pytest.raises(Undecodable) as unsupported:
        render_layers(gif.getvalue())
    assert unsupported.value.kind is MediaFailureReason.UNREADABLE
    assert unsupported.value.reason == "GIF is not a supported photograph format"
    jpeg = io.BytesIO()
    Image.new("RGB", (3000, 2000), (200, 30, 30)).save(jpeg, "JPEG", quality=90)
    with pytest.raises(Undecodable) as truncated:
        render_layers(jpeg.getvalue()[:20_000])
    assert truncated.value.kind is MediaFailureReason.UNREADABLE

    # The default, and the never-parsed rule.
    assert Undecodable("x").kind is MediaFailureReason.UNREADABLE
    assert Undecodable("larger than the 50 megapixel limit").kind is MediaFailureReason.UNREADABLE
    reason = inspect.signature(ingest._permanent_failure).parameters["reason"]
    assert reason.default is inspect.Parameter.empty


# --- the four dead-letter paths, each writing the reason WITH `failed` --------------


async def test_every_dead_letter_path_writes_its_reason_in_the_statement_that_writes_failed(
    db_session_factory, worker, monkeypatch
):
    """All four paths through the real worker, each ending `failed` with its
    reason — and the reason lands in THE statement that writes `failed`,
    never a second one beside it: counted at the cursor, where the one
    UPDATE on media that names `failure_reason` is the one that names
    `status`. The retry rung writes no reason at all (a retry is not a
    failure the person is told about), and the two Undecodable kinds come
    through the REAL decoder."""
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("UPDATE MEDIA"):
            statements.append(" ".join(statement.split()))

    def reason_statements() -> list[str]:
        named = [s for s in statements if "failure_reason" in s]
        statements.clear()
        return named

    def one_statement_names_both() -> None:
        named = reason_statements()
        assert len(named) == 1, named
        assert "status=" in named[0].replace(" ", ""), named[0]

    t0 = _now()
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        # (a) The object missing → upload_incomplete, on the first attempt.
        missing = await _uploaded_row(db_session_factory, available_at=t0)
        _stub_head(monkeypatch, None)
        statements.clear()
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
        r = await _row(db_session_factory, missing.id)
        assert (r.status, r.failure_reason, r.attempts, r.last_error) == (
            MediaStatus.FAILED, MediaFailureReason.UPLOAD_INCOMPLETE, 1, ERROR_OBJECT_MISSING,
        )
        one_statement_names_both()

        # (b) Undecodable, through the real decoder: the renamed .mov →
        # unreadable; the 50.4 MP PNG → too_large.
        for data, kind, fragment in (
            (MOV, MediaFailureReason.UNREADABLE, "UnidentifiedImageError"),
            (_tiny_png_of(7100, 7100), MediaFailureReason.TOO_LARGE, "50 megapixel"),
        ):
            row = await _uploaded_row(db_session_factory, size=len(data), available_at=t0)
            FakeStore(monkeypatch, {quarantine_key(row.id): data})
            statements.clear()
            assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
            r = await _row(db_session_factory, row.id)
            assert (r.status, r.failure_reason, r.attempts) == (MediaStatus.FAILED, kind, 1)
            assert fragment in r.last_error and "(permanent)" in r.last_error
            one_statement_names_both()

        # (c) The transient ladder spent → interrupted; the two retries
        # before it write NO reason.
        flaky = await _uploaded_row(db_session_factory, available_at=t0)
        _stub_head(monkeypatch, raises=_client_error("InternalError", 500))
        t = t0
        statements.clear()
        for attempt in range(1, MAX_ATTEMPTS + 1):
            assert await poll_once(db_session_factory, worker, t) is Poll.PROCESSED
            r = await _row(db_session_factory, flaky.id)
            if attempt < MAX_ATTEMPTS:
                assert (r.status, r.failure_reason, r.attempts) == (MediaStatus.UPLOADED, None, attempt)
                assert reason_statements() == []
                t = r.available_at
        assert (r.status, r.failure_reason, r.attempts) == (
            MediaStatus.FAILED, MediaFailureReason.INTERRUPTED, MAX_ATTEMPTS,
        )
        assert "after 3 attempts" in r.last_error
        one_statement_names_both()

        # (d) Abandoned MAX_ATTEMPTS times at reclaim → interrupted, in the
        # claim's own flush.
        async with db_session_factory() as db:
            gathering = await _mk_gathering(db)
            stale = _media(
                gathering.id,
                status=MediaStatus.PROCESSING,
                claimed_at=t0 - RECLAIM_AFTER - timedelta(minutes=1),
                attempts=MAX_ATTEMPTS - 1,
            )
            db.add(stale)
            await db.commit()
            stale_id = stale.id
        statements.clear()
        async with db_session_factory() as db:
            claimed = await claim_next(db, t0)
            await db.commit()
        assert claimed.id == stale_id
        r = await _row(db_session_factory, stale_id)
        assert (r.status, r.failure_reason, r.last_error, r.attempts) == (
            MediaStatus.FAILED, MediaFailureReason.INTERRUPTED, ERROR_ABANDONED, MAX_ATTEMPTS,
        )
        one_statement_names_both()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def test_a_row_that_reaches_ready_after_a_transient_failure_carries_no_reason(
    db_session_factory, worker, monkeypatch
):
    """The transient rung writes no reason, and `ready` clears nothing
    because there is nothing to clear: a photograph that failed once on
    the store and then published carries NULL, like every `ready` row."""
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    store.raise_on["head"] = _client_error("InternalError", 500)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r = await _row(db_session_factory, row.id)
    assert (r.status, r.attempts, r.failure_reason) == (MediaStatus.UPLOADED, 1, None)
    assert r.last_error is not None  # the retry text, for the operator

    del store.raise_on["head"]
    assert await poll_once(db_session_factory, worker, r.available_at) is Poll.PROCESSED
    r = await _row(db_session_factory, row.id)
    assert (r.status, r.attempts, r.failure_reason, r.last_error) == (MediaStatus.READY, 2, None, None)


# --- the body --------------------------------------------------------------------


async def test_every_media_body_carries_the_reason_and_never_last_error(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UNREADABLE
    )
    ready = await _photograph(db_session_factory, cast)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE media SET last_error = :e WHERE id = :id"),
            {"e": ERROR_UNDECODABLE.format(reason="MPO is not a supported photograph format"), "id": UUID(failed)},
        )
        await db.commit()

    listed = await _list(client, cast.uploader, cast.gathering_id)
    rows = {r["id"]: r for r in listed.json()["media"]}
    assert rows[failed]["failure_reason"] == "unreadable"
    assert rows[ready]["failure_reason"] is None
    assert all("last_error" not in r for r in rows.values())
    # Not a word of the operator's text reaches the body.
    for never in ("permanent", "could not process", "MPO"):
        assert never not in listed.text

    # The intent body is the same body: the key rides it, null.
    intent = await client.post(
        f"/gatherings/{cast.gathering_id}/media/intents",
        json={"items": [{"content_type": "image/jpeg", "size_bytes": 1000}]},
        headers=cast.uploader,
    )
    assert intent.status_code == 201, intent.text
    body = intent.json()["intents"][0]["media"]
    assert body["failure_reason"] is None and "last_error" not in body


# --- the audience: failure belongs to the uploader ----------------------------------


async def test_a_failed_row_is_visible_to_its_uploader_alone(client, capsys, db_session_factory):
    """THE RULE (pipeline record §6.5, made true in `_visible_media`): the
    uploader lists their failed row, with its reason, and a URL for it is
    the 409 `not_ready` (visible; nothing stored). The HOST does not list
    it, and on `/url` and EVERY act — publish, decline, remove, destroy,
    restore, dismiss — draws the media 404 byte-identical to a missing id;
    until CK-71 the host read it beside a Try again that could do nothing
    for them. A keeper, an invitee and a stranger saw nothing before and
    see nothing now. The host's OWN failed row is still theirs, because
    they are its uploader. The queue never held a failed row and still
    does not. Nothing moves."""
    cast = await _cast(client, capsys, db_session_factory)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UNREADABLE
    )
    own = await _hosts_own_photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.INTERRUPTED
    )
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    missing = await _url(client, cast.host, MISSING_ID)
    assert missing.status_code == 404

    # The uploader.
    mine = await _list(client, cast.uploader, cast.gathering_id)
    assert set(_ids(mine)) == {failed, live}
    assert {r["id"]: r["failure_reason"] for r in mine.json()["media"]}[failed] == "unreadable"
    opened = await _url(client, cast.uploader, failed)
    assert opened.status_code == 409 and opened.json()["detail"]["code"] == NOT_READY

    # The host: their own failed row, yes; the uploader's, nowhere.
    hosts = await _list(client, cast.host, cast.gathering_id)
    assert set(_ids(hosts)) == {own, live}
    assert {r["id"]: r["failure_reason"] for r in hosts.json()["media"]}[own] == "interrupted"
    for act in ACTS:
        refused = await act(client, cast.host, failed)
        assert refused.status_code == 404, (act.__name__, refused.text)
        assert refused.json() == missing.json(), act.__name__

    # A keeper and a second accepted invitee: the gathering is theirs to
    # read, the failed row is not — before CK-71 and after.
    for headers in (cast.keeper, cast.bystander):
        assert failed not in _ids(await _list(client, headers, cast.gathering_id))
        for act in ACTS:
            refused = await act(client, headers, failed)
            assert refused.status_code == 404, act.__name__
            assert refused.json() == missing.json(), act.__name__
    # A stranger: the gathering 404 on the list, the media 404 on every act.
    assert (await _list(client, cast.stranger, cast.gathering_id)).status_code == 404
    for act in ACTS:
        assert (await act(client, cast.stranger, failed)).json() == missing.json(), act.__name__

    # The queue: never a failed row — the host's own included.
    queue = await client.get(
        f"/gatherings/{cast.gathering_id}/media",
        params={"awaiting_review": "true"},
        headers=cast.host,
    )
    assert _ids(queue) == []

    # Nothing moved.
    assert await _reason_and_rung(db_session_factory, failed) == (
        MediaStatus.FAILED, MediaFailureReason.UNREADABLE,
    )
    assert await _reason_and_rung(db_session_factory, own) == (
        MediaStatus.FAILED, MediaFailureReason.INTERRUPTED,
    )


async def test_a_co_host_sees_no_failed_row_and_cannot_dismiss_one(client, capsys, db_session_factory):
    """A co-host administers the gathering (CK-68) and is nobody here: the
    bystander made a co-host through the API lists no failed row of the
    uploader's, draws the media 404 byte-identical to a missing id on every
    act — dismiss included — and the row is intact. Failure belongs to the
    uploader, and the delegable set does not reach it."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.TOO_LARGE
    )
    missing = await _url(client, cast.bystander, MISSING_ID)
    assert missing.status_code == 404
    assert failed not in _ids(await _list(client, cast.bystander, cast.gathering_id))
    for act in ACTS:
        refused = await act(client, cast.bystander, failed)
        assert refused.status_code == 404, act.__name__
        assert refused.json() == missing.json(), act.__name__
    assert await _reason_and_rung(db_session_factory, failed) == (
        MediaStatus.FAILED, MediaFailureReason.TOO_LARGE,
    )
    # And the uploader still can.
    assert (await _dismiss(client, cast.uploader, failed)).status_code == 204


async def test_a_guest_uploads_failed_row_is_visible_to_nobody(client, capsys, db_session_factory):
    """A guest upload has no uploader person, so `is_uploader` is NULL and
    the failed row is in nobody's view — the host's included — and nobody
    can dismiss it. Recorded, not decided: the guest flow is unbuilt, and
    the row a future guest flow writes will decide its own audience."""
    cast = await _cast(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        row = Media(
            gathering_id=cast.gathering_id,
            uploader_person_id=None,
            guest_name="a guest",
            upload_content_type="image/jpeg",
            upload_size_bytes=1000,
            status=MediaStatus.FAILED,
            failure_reason=MediaFailureReason.UPLOAD_INCOMPLETE,
            last_error=ERROR_OBJECT_MISSING,
            publication_state=PublicationState.PENDING,
            created_at=_now(),
            uploaded_at=_now(),
        )
        db.add(row)
        await db.commit()
        guest = str(row.id)
    missing = await _url(client, cast.host, MISSING_ID)
    for headers in (cast.host, cast.uploader, cast.keeper, cast.bystander):
        assert guest not in _ids(await _list(client, headers, cast.gathering_id))
        for act in (_url, _dismiss):
            refused = await act(client, headers, guest)
            assert refused.status_code == 404
            assert refused.json() == missing.json()
    assert await _reason_and_rung(db_session_factory, guest) == (
        MediaStatus.FAILED, MediaFailureReason.UPLOAD_INCOMPLETE,
    )


# --- dismiss -----------------------------------------------------------------


async def test_dismiss_deletes_the_failed_row_and_its_tags_and_moves_no_count(
    client, capsys, db_session_factory, monkeypatch
):
    """204 with no body; the row is GONE and its tags with it (the CASCADE
    — the uploader may caption and tag a failed row, since it is visible
    and theirs, so a dismiss has tags to take); the gathering's two counts
    and the keeper's usage are identical across it (nothing counted the
    row); the live row beside it is untouched; a second dismiss is the 404
    byte-identical to a missing id; and NO STORE CALL — every route into
    storage this router holds is stubbed to fail, and the router imports
    neither `ingest` nor a storage delete."""
    for name in ("_head", "_upload_client", "_serve_client"):
        monkeypatch.setattr(media_api, name, lambda *a, **k: (_ for _ in ()).throw(AssertionError("no store call")))
    assert not hasattr(media_api, "ingest")
    assert not hasattr(media_api, "delete_quarantine_object")
    assert not hasattr(media_api, "delete_published_object")

    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UNREADABLE
    )
    tagged = await _patch(client, cast.uploader, failed, {"caption": "the blurry one", "tags": ["cake", "yard"]})
    assert tagged.status_code == 200, tagged.text
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    usage_before = await _usage(db_session_factory)
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaTag).where(MediaTag.media_id == UUID(failed))) == 2

    response = await _dismiss(client, cast.uploader, failed)
    assert response.status_code == 204, response.text
    assert response.content == b""

    async with db_session_factory() as db:
        assert await db.get(Media, UUID(failed)) is None
        assert await db.scalar(select(func.count()).select_from(MediaTag).where(MediaTag.media_id == UUID(failed))) == 0
        assert (await db.get(Media, UUID(live))).status is MediaStatus.READY
    assert await _counts(db_session_factory, cast.gathering_id) == before
    assert await _usage(db_session_factory) == usage_before
    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [live]

    again = await _dismiss(client, cast.uploader, failed)
    assert again.status_code == 404
    assert again.json() == (await _dismiss(client, cast.uploader, MISSING_ID)).json()


async def test_dismiss_refuses_a_row_that_has_not_failed_with_not_failed_and_writes_nothing(
    client, capsys, db_session_factory
):
    """`not_failed`, carrying the rung — NOT `not_ready`: that code means
    "wait", and a failed row is the opposite. On a waiting row, a live one,
    an in-flight one and a binned one alike; nothing moves on any."""
    cast = await _cast(client, capsys, db_session_factory)
    now = _now()
    subjects = {
        await _photograph(db_session_factory, cast): MediaStatus.READY,
        await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE): MediaStatus.READY,
        await _photograph(db_session_factory, cast, status=MediaStatus.UPLOADED): MediaStatus.UPLOADED,
        await _photograph(db_session_factory, cast, status=MediaStatus.PENDING_UPLOAD): MediaStatus.PENDING_UPLOAD,
        await _photograph(
            db_session_factory,
            cast,
            publication_state=PublicationState.REMOVED,
            removed_at=now,
            removed_by_person_id=cast.uploader_person_id,
        ): MediaStatus.READY,
    }
    before = {m: await _reason_and_rung(db_session_factory, m) for m in subjects}
    for media_id, status in subjects.items():
        refused = await _dismiss(client, cast.uploader, media_id)
        assert refused.status_code == 409, refused.text
        detail = refused.json()["detail"]
        assert detail["code"] == NOT_FAILED and detail["code"] != NOT_READY
        assert detail["status"] == status.value
        assert "publication_state" in detail
    for media_id, was in before.items():
        assert await _reason_and_rung(db_session_factory, media_id) == was
    assert len(_ids(await _list(client, cast.uploader, cast.gathering_id))) == len(subjects)


async def test_dismiss_logs_nothing_at_debug(client, capsys, db_session_factory, caplog):
    cast = await _cast(client, capsys, db_session_factory)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.INTERRUPTED
    )
    ready = await _photograph(db_session_factory, cast)
    caplog.set_level(logging.DEBUG)
    caplog.clear()
    assert (await _dismiss(client, cast.uploader, ready)).status_code == 409
    assert (await _dismiss(client, cast.host, failed)).status_code == 404
    assert (await _dismiss(client, cast.uploader, failed)).status_code == 204
    # Logger names, never words that ride the request line (the transport
    # logs every path at INFO).
    assert [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))] == []


# --- migration 0028: the round trip and the backfill ----------------------------------


async def _shape(db) -> tuple[str, bool, bool]:
    """(alembic head, the column present, the type present)."""
    head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
    column = (
        await db.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'media' AND column_name = 'failure_reason'"
            )
        )
    ).first()
    kind = (
        await db.execute(text("SELECT 1 FROM pg_type WHERE typname = 'media_failure_reason'"))
    ).first()
    return head, column is not None, kind is not None


async def test_0028_round_trip_backfills_the_reason_from_last_error_and_the_downgrade_is_genuine(
    db_session_factory, capsys
):
    """Down to 0027 — the column and the type gone. Rows planted THERE by raw
    SQL (the ORM maps the column): one `failed` row per text STEP 0 found a
    failed row could carry since CK-35 — the pixel guard's, both undecodable
    shapes, the object missing, the abandonment, the spent ladder — plus a
    `ready` row, and ONE failed row carrying a text the code never wrote,
    so the INFO line's "left NULL" count is shown to count. Up: each row
    classified by its prefix (too_large before the general unreadable),
    the line verbatim, `last_error` untouched. Down: gone again. Up: the
    same values — up / down / up is idempotent, because the reason is
    recomputed from `last_error` every time. The type is NEW in 0028, so
    its labels are usable in the same transaction (not the CK-32 trap) —
    which is exactly what the backfill running at all proves."""
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, True, True)

    await _migrate("downgrade", "0027", capsys)
    texts = {
        "too_large": ERROR_UNDECODABLE.format(reason="larger than the 50 megapixel limit"),
        "unreadable_format": ERROR_UNDECODABLE.format(reason="MPO is not a supported photograph format"),
        "unreadable_bytes": ERROR_UNDECODABLE.format(reason="not a decodable image (UnidentifiedImageError)"),
        "upload_incomplete": ERROR_OBJECT_MISSING,
        "interrupted_abandoned": ERROR_ABANDONED,
        "interrupted_storage": "storage did not answer after 3 attempts (last: read: ClientError (InternalError))",
        "unknown": "a text this code never wrote",
    }
    expected = {
        "too_large": "too_large",
        "unreadable_format": "unreadable",
        "unreadable_bytes": "unreadable",
        "upload_incomplete": "upload_incomplete",
        "interrupted_abandoned": "interrupted",
        "interrupted_storage": "interrupted",
        "unknown": None,
        "ready": None,
    }
    async with db_session_factory() as db:
        assert await _shape(db) == ("0027", False, False)
        account_id = (
            await db.execute(text("INSERT INTO accounts (kind) VALUES ('PERSON') RETURNING id"))
        ).scalar_one()
        gathering_id = (
            await db.execute(
                text(
                    "INSERT INTO gatherings (created_by_account_id, keeper_account_id, "
                    "gathering_type, title, publication_state) "
                    "VALUES (:a, :a, 'potluck', 'CK-71 round trip', 'live') RETURNING id"
                ),
                {"a": account_id},
            )
        ).scalar_one()
        ids: dict[str, UUID] = {}
        for key, why in texts.items():
            ids[key] = (
                await db.execute(
                    text(
                        "INSERT INTO media (gathering_id, guest_name, upload_content_type, "
                        "upload_size_bytes, status, publication_state, uploaded_at, last_error) "
                        "VALUES (:g, 'fixture', 'image/jpeg', 1000, 'failed', 'pending', now(), :why) "
                        "RETURNING id"
                    ),
                    {"g": gathering_id, "why": why},
                )
            ).scalar_one()
        ids["ready"] = (
            await db.execute(
                text(
                    "INSERT INTO media (gathering_id, guest_name, upload_content_type, "
                    "upload_size_bytes, status, publication_state, uploaded_at) "
                    "VALUES (:g, 'fixture', 'image/jpeg', 1000, 'ready', 'live', now()) RETURNING id"
                ),
                {"g": gathering_id},
            )
        ).scalar_one()
        await db.commit()

    async def reasons() -> dict[str, str | None]:
        async with db_session_factory() as db:
            rows = dict(
                (await db.execute(text("SELECT id, failure_reason::text FROM media"))).all()
            )
            return {key: rows[media_id] for key, media_id in ids.items()}

    async def last_errors() -> dict[str, str | None]:
        async with db_session_factory() as db:
            rows = dict((await db.execute(text("SELECT id, last_error FROM media"))).all())
            return {key: rows[media_id] for key, media_id in ids.items()}

    lines = await _migrate("upgrade", "head", capsys)
    backfill = [m for m in lines if m.startswith("0028 backfilled media.failure_reason")]
    assert len(backfill) == 1, lines
    assert (
        "1 too_large, 2 unreadable, 1 upload_incomplete, 2 interrupted; "
        "1 failed row(s) left NULL (zero expected - a non-zero count is a finding)"
    ) in backfill[0]
    assert backfill[0].isascii()
    assert any(m.startswith("Running upgrade 0027 -> 0028") for m in lines), lines
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, True, True)
    assert await reasons() == expected
    assert await last_errors() == {**texts, "ready": None}

    await _migrate("downgrade", "0027", capsys)
    async with db_session_factory() as db:
        assert await _shape(db) == ("0027", False, False)
    assert await last_errors() == {**texts, "ready": None}

    lines = await _migrate("upgrade", "head", capsys)
    assert len([m for m in lines if m.startswith("0028 backfilled")]) == 1
    async with db_session_factory() as db:
        assert await _shape(db) == (HEAD, True, True)
    assert await reasons() == expected


# --- the verifier -----------------------------------------------------------------


async def test_the_verifier_asserts_a_reason_iff_failed(client, capsys, db_session_factory):
    """scripts/verify_schema.py's eight CK-71 lines, run as the operator runs
    it — a fresh interpreter against the test database — on a clean baseline
    holding a real failed row with its reason, then on the two plants the
    invariant exists to catch: a failed row with NO reason (the pre-0028
    shape the backfill retires; also what the old worker would leave in the
    deploy window), and a ready row WITH one. The total is pinned as a
    number (the CK-57 convention: 211 → 219, 258 since CK-73's
    thirty-nine billing lines, 261 since CK-73.1's three — the shape
    of subscriptions.cancel_at — and 271 since CK-73.2's ten, the
    scheduled change's two columns, their CHECK, the pair invariant and
    two never-stored allowance columns asserted absent).
    A PLANT IS NOT EVIDENCE UNTIL
    SOMETHING INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's
    lesson), so each is counted by its own SELECT before the verifier reads
    it. And the enum's labels match the model label for label — Alembic
    never diffs enum labels."""
    label = "every failed media row says why, and no other row does"
    cast = await _cast(client, capsys, db_session_factory)
    failed = await _photograph(
        db_session_factory, cast, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UPLOAD_INCOMPLETE
    )
    ready = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    async with db_session_factory() as db:
        # A real dead-letter carries the operator's text too (the CK-35 line).
        await db.execute(
            text("UPDATE media SET last_error = :e, attempts = 1 WHERE id = :id"),
            {"e": ERROR_OBJECT_MISSING, "id": UUID(failed)},
        )
        await db.commit()
        assert await _enum_labels(db, "media_failure_reason") == list(REASONS)
        assert [m.value for m in MediaFailureReason] == list(REASONS)

    passed, failed_count, code, out = _verifier()
    assert (passed, failed_count, code) == (271, 0, 0), out
    for line in (
        "media.failure_reason is nullable",
        "media.failure_reason is of type media_failure_reason",
        "media.failure_reason has no server default (the dead-letter writes it, or nothing does)",
        *[f"media_failure_reason carries {reason!r}" for reason in REASONS],
        label,
    ):
        assert f"PASS  {line}" in out, line

    async def plant(media_id: str, sql: str, confirm: str) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), {"id": UUID(media_id)})
            await db.commit()
            assert await db.scalar(text(confirm), {"id": UUID(media_id)}) == 1, "the plant did not land"

    # (1) A failed row with no reason: fires the line, and only it.
    await plant(
        failed,
        "UPDATE media SET failure_reason = NULL WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND status = 'failed' AND failure_reason IS NULL",
    )
    passed, failed_count, code, out = _verifier()
    assert (passed, failed_count, code) == (270, 1, 1), out
    assert f"FAIL  {label}" in out and "1 media row(s) whose failure_reason disagrees with status" in out
    await plant(
        failed,
        "UPDATE media SET failure_reason = 'upload_incomplete' WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND failure_reason = 'upload_incomplete'",
    )
    assert _verifier()[:3] == (271, 0, 0)

    # (2) A ready row with a reason: the same line, and only it.
    await plant(
        ready,
        "UPDATE media SET failure_reason = 'interrupted' WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND status = 'ready' AND failure_reason IS NOT NULL",
    )
    passed, failed_count, code, out = _verifier()
    assert (passed, failed_count, code) == (270, 1, 1), out
    assert f"FAIL  {label}" in out
    await plant(
        ready,
        "UPDATE media SET failure_reason = NULL WHERE id = :id",
        "SELECT count(*) FROM media WHERE id = :id AND failure_reason IS NULL",
    )
    assert _verifier()[:3] == (271, 0, 0)
