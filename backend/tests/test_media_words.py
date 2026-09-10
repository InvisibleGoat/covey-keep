"""CK-39 — words on a photograph: the filename, a caption, tags, and finding
a photograph by any of them (migration 0018; `PATCH /media/{id}`; `q` on
`GET /gatherings/{id}/media`).

No network anywhere in this file — botocore presigns locally, the confirm
step's HEAD is stubbed at `app.api.media._head`, and the rows that need a
rung are written directly (the worker's output, without the worker), so
every party the audience rule distinguishes can be put in front of every
endpoint.

The load-bearing pins:
- a filename is stored TRIMMED at intent, rides every body, and NEVER
  reaches a storage key — the quarantine key is a function of the row id
  whatever the name says, a traversal-shaped name included; a blank is a
  422 that leaves no row; the rows without a name read NULL, never "";
- a blank caption draws a 422 and an explicit null CLEARS it (NULL, not
  ""); an absent field leaves the stored value alone; an empty patch is a
  patch with no fields provided;
- a tag list REPLACES rather than appends; the same tag twice on one
  photograph is refused — `Tommy` and `tommy` are the same tag — and the
  UNIQUE beneath the API refuses the exact pair too; `[]` removes every
  tag; `null` is refused;
- THE UPLOADER MAY EDIT, AND NOT THE HOST: the host, a keeper, an accepted
  invitee and a stranger each draw the media 404 byte-identical to a
  missing id, and nothing on the row moves;
- deleting a photograph deletes its tags (the cascade, observed);
- `q` matches across caption, tag and filename, case-insensitively, the
  term taken literally (`%` and `_` are characters, not wildcards);
- THE LEAK TEST: a term that matches a photograph the caller may not see
  returns nothing — the search runs inside the audience filter, never
  beside it — and a stranger's 404 is byte-identical to a missing gathering;
- the list stays ONE statement however many photographs or tags it carries;
- no caption, tag, filename or search term reaches an application log
  record with the root logger at DEBUG (the request line an access log
  records is the transport's, and carries `q` as it carries every path).
"""

import logging
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import IntegrityError

from app.api import media as media_api
from app.api.media import (
    MAX_CAPTION_LENGTH,
    MAX_FILENAME_LENGTH,
    MAX_SEARCH_LENGTH,
    MAX_TAG_LENGTH,
    MAX_TAGS_PER_MEDIA,
)
from app.config import settings
from app.db import engine
from app.models import Media, MediaStatus, MediaTag, PublicationState
from app.services.storage import quarantine_key
from tests.test_media_intents import _stub_head
from tests.test_media_reads import MISSING_ID, _cast, _list, _photograph

FILENAME = "IMG_0569.HEIC"
TRAVERSAL = "../../etc/passwd"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _intent(client, headers, gathering_id: str, **item):
    body = {"content_type": "image/heic", "size_bytes": 1_300_000, **item}
    return await client.post(
        f"/gatherings/{gathering_id}/media/intents", json={"items": [body]}, headers=headers
    )


async def _patch(client, headers, media_id: str, body: dict):
    return await client.patch(f"/media/{media_id}", json=body, headers=headers)


async def _search(client, headers, gathering_id: str, term):
    params = {} if term is None else {"q": term}
    return await client.get(f"/gatherings/{gathering_id}/media", params=params, headers=headers)


def _ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [m["id"] for m in response.json()["media"]]


def _locs(response) -> list[list]:
    assert response.status_code == 422, response.text
    return [e["loc"] for e in response.json()["detail"]]


async def _row(db_session_factory, media_id: str) -> Media:
    async with db_session_factory() as db:
        return await db.get(Media, media_id)


async def _stored_tags(db_session_factory, media_id: str) -> list[str]:
    async with db_session_factory() as db:
        return sorted(
            await db.scalars(select(MediaTag.tag).where(MediaTag.media_id == media_id))
        )


# --- auth ----------------------------------------------------------------------


async def test_media_words_require_auth(client):
    assert (await client.patch(f"/media/{MISSING_ID}", json={"caption": "x"})).status_code == 401


# --- the filename ---------------------------------------------------------------


async def test_filename_is_stored_trimmed_at_intent_and_never_reaches_a_key(
    client, capsys, db_session_factory, monkeypatch
):
    """The uploader's file name is a display string and nothing else: stored
    trimmed on the row, carried by the intent, confirm and list bodies, and
    absent from the presigned URL, whose key is `uploads/<id>` whatever the
    name says — a traversal-shaped name is stored as the text it is and
    reaches no path, no key, no header. No name → NULL, never ""."""
    cast = await _cast(client, capsys, db_session_factory)

    named = await _intent(client, cast.uploader, cast.gathering_id, filename=f"  {FILENAME}  ")
    assert named.status_code == 201, named.text
    (intent,) = named.json()["intents"]
    media_id = intent["media"]["id"]
    assert intent["media"]["filename"] == FILENAME
    assert intent["media"]["caption"] is None
    assert FILENAME not in intent["upload"]["url"]
    assert "IMG_0569" not in intent["upload"]["url"]
    assert quarantine_key(media_id) in intent["upload"]["url"]
    assert FILENAME not in str(intent["upload"]["headers"])
    row = await _row(db_session_factory, media_id)
    assert row.filename == FILENAME

    # The confirm body carries it too (the HEAD stubbed present at size).
    _stub_head(monkeypatch, (1_300_000, "image/heic"))
    confirmed = await client.post(f"/media/{media_id}/confirm", headers=cast.uploader)
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["filename"] == FILENAME
    assert "tags" not in confirmed.json()  # never a body that did not load them

    # A traversal-shaped name: text, stored verbatim (trimmed), and the key
    # is still a function of the id alone.
    hostile = await _intent(client, cast.uploader, cast.gathering_id, filename=TRAVERSAL)
    assert hostile.status_code == 201, hostile.text
    (intent,) = hostile.json()["intents"]
    assert intent["media"]["filename"] == TRAVERSAL
    assert "etc" not in intent["upload"]["url"] and ".." not in intent["upload"]["url"]
    assert intent["upload"]["url"].split("?", 1)[0].endswith(
        f"/{settings.r2_bucket_quarantine}/{quarantine_key(intent['media']['id'])}"
    )

    # No name given: NULL on the row, null in every body. An explicit null
    # on the create is the same as none.
    unnamed = await _intent(client, cast.uploader, cast.gathering_id)
    assert unnamed.json()["intents"][0]["media"]["filename"] is None
    explicit = await _intent(client, cast.uploader, cast.gathering_id, filename=None)
    assert explicit.status_code == 201
    assert explicit.json()["intents"][0]["media"]["filename"] is None
    row = await _row(db_session_factory, unnamed.json()["intents"][0]["media"]["id"])
    assert row.filename is None

    # The list carries the name for every row (the CK-38 finding, closed).
    listed = {m["id"]: m["filename"] for m in (await _list(client, cast.uploader, cast.gathering_id)).json()["media"]}
    assert listed[media_id] == FILENAME
    assert listed[unnamed.json()["intents"][0]["media"]["id"]] is None

    # A blank is refused on the offending entry and leaves NO row; so is an
    # over-long name.
    async with db_session_factory() as db:
        before = await db.scalar(select(func.count()).select_from(Media))
    for bad in ("", "   "):
        refused = await _intent(client, cast.uploader, cast.gathering_id, filename=bad)
        assert _locs(refused) == [["body", "items", 0, "filename"]]
    too_long = await _intent(
        client, cast.uploader, cast.gathering_id, filename="x" * (MAX_FILENAME_LENGTH + 1)
    )
    assert _locs(too_long) == [["body", "items", 0, "filename"]]
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(Media)) == before


# --- the caption ----------------------------------------------------------------


async def test_caption_blank_is_refused_explicit_null_clears_and_absent_leaves_alone(
    client, capsys, db_session_factory
):
    """The Patch-semantics convention (CK-22) on a photograph: a blank draws
    the field-level 422 and changes nothing; an explicit null writes NULL —
    never "" — and a caption-only patch leaves the tags alone (absent means
    leave alone); an empty patch is one with no fields provided."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    await _patch(client, cast.uploader, media_id, {"tags": ["cake"]})

    set_ = await _patch(client, cast.uploader, media_id, {"caption": "  Tommy's 5th birthday  "})
    assert set_.status_code == 200, set_.text
    assert set_.json()["caption"] == "Tommy's 5th birthday"
    assert set_.json()["tags"] == ["cake"]  # absent → left alone
    assert (await _row(db_session_factory, media_id)).caption == "Tommy's 5th birthday"

    for blank in ("", "   ", "\n\t"):
        refused = await _patch(client, cast.uploader, media_id, {"caption": blank})
        assert _locs(refused) == [["body", "caption"]]
    assert (await _row(db_session_factory, media_id)).caption == "Tommy's 5th birthday"
    too_long = await _patch(client, cast.uploader, media_id, {"caption": "x" * (MAX_CAPTION_LENGTH + 1)})
    assert _locs(too_long) == [["body", "caption"]]

    cleared = await _patch(client, cast.uploader, media_id, {"caption": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["caption"] is None
    row = await _row(db_session_factory, media_id)
    assert row.caption is None
    assert row.caption != ""
    assert await _stored_tags(db_session_factory, media_id) == ["cake"]

    # Empty patch (no field provided) and an unknown field: 422 each.
    empty = await _patch(client, cast.uploader, media_id, {})
    assert empty.status_code == 422
    unknown = await _patch(client, cast.uploader, media_id, {"filename": "renamed.jpg"})
    assert unknown.status_code == 422
    assert (await _row(db_session_factory, media_id)).filename is None


# --- the tags -------------------------------------------------------------------


async def test_tags_replace_rather_than_append_and_the_same_tag_twice_is_refused(
    client, capsys, db_session_factory
):
    """The list IS the value: a second write replaces the set wholesale —
    a caller expecting append and getting replace is the data-loss bug the
    api-reference warns about, so it is pinned here. The same tag twice is
    refused on the entry that repeats, and `Tommy`/`tommy` are the same
    tag (case preserved, equality case-insensitive). `[]` removes every
    tag; `null` is refused; blank, over-long and over-many are refused on
    their entry or on the list."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)

    first = await _patch(client, cast.uploader, media_id, {"tags": ["Tommy", " cake "]})
    assert first.status_code == 200, first.text
    assert first.json()["tags"] == ["cake", "Tommy"]  # deterministic, case-insensitive order
    assert await _stored_tags(db_session_factory, media_id) == ["Tommy", "cake"]

    second = await _patch(client, cast.uploader, media_id, {"tags": ["birthday"]})
    assert second.json()["tags"] == ["birthday"]
    assert await _stored_tags(db_session_factory, media_id) == ["birthday"]  # replaced, not appended
    listed = (await _list(client, cast.uploader, cast.gathering_id)).json()["media"]
    assert listed[0]["id"] == media_id and listed[0]["tags"] == ["birthday"]

    # The same tag twice — exactly, and differing only in case — lands on
    # the entry that repeats; the stored set is untouched.
    for pair in (["cake", "cake"], ["Tommy", "tommy"], ["a", "b", "A"]):
        refused = await _patch(client, cast.uploader, media_id, {"tags": pair})
        assert _locs(refused) == [["body", "tags", len(pair) - 1]], pair
    assert await _stored_tags(db_session_factory, media_id) == ["birthday"]

    blank = await _patch(client, cast.uploader, media_id, {"tags": ["ok", "  "]})
    assert _locs(blank) == [["body", "tags", 1]]
    too_long = await _patch(client, cast.uploader, media_id, {"tags": ["x" * (MAX_TAG_LENGTH + 1)]})
    assert _locs(too_long) == [["body", "tags", 0]]
    too_many = await _patch(
        client, cast.uploader, media_id, {"tags": [f"t{i}" for i in range(MAX_TAGS_PER_MEDIA + 1)]}
    )
    assert _locs(too_many) == [["body", "tags"]]
    null = await _patch(client, cast.uploader, media_id, {"tags": None})
    assert _locs(null) == [["body", "tags"]]
    assert await _stored_tags(db_session_factory, media_id) == ["birthday"]

    at_bound = await _patch(
        client, cast.uploader, media_id, {"tags": [f"t{i}" for i in range(MAX_TAGS_PER_MEDIA)]}
    )
    assert at_bound.status_code == 200
    cleared = await _patch(client, cast.uploader, media_id, {"tags": []})
    assert cleared.status_code == 200 and cleared.json()["tags"] == []
    assert await _stored_tags(db_session_factory, media_id) == []

    # Beneath the API: UNIQUE (media_id, tag) refuses the exact pair.
    async with db_session_factory() as db:
        db.add(MediaTag(media_id=media_id, tag="twice", added_by_person_id=cast.uploader_person_id))
        db.add(MediaTag(media_id=media_id, tag="twice", added_by_person_id=cast.uploader_person_id))
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_only_the_uploader_may_edit_and_not_the_host(client, capsys, db_session_factory):
    """A host may remove a photograph; re-captioning someone else's is a
    different power. The host, a keeper, an accepted invitee and a
    stranger each draw the media 404 byte-identical to a missing id — on a
    pending row the host can SEE — and nothing on the row moves."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    await _patch(client, cast.uploader, media_id, {"caption": "mine", "tags": ["cake"]})
    missing = await _patch(client, cast.uploader, MISSING_ID, {"caption": "x"})
    assert missing.status_code == 404

    # The host sees the row (pending → uploader and host)...
    assert media_id in _ids(await _list(client, cast.host, cast.gathering_id))
    # ...and may not caption it.
    for headers in (cast.host, cast.keeper, cast.bystander, cast.stranger):
        for body in ({"caption": "theirs"}, {"tags": ["theirs"]}, {"caption": None}):
            refused = await _patch(client, headers, media_id, body)
            assert refused.status_code == 404
            assert refused.json() == missing.json()
    row = await _row(db_session_factory, media_id)
    assert row.caption == "mine"
    assert await _stored_tags(db_session_factory, media_id) == ["cake"]

    # The uploader may — and the edit moves nothing else on the row.
    before = await _row(db_session_factory, media_id)
    ok = await _patch(client, cast.uploader, media_id, {"caption": "still mine"})
    assert ok.status_code == 200
    after = await _row(db_session_factory, media_id)
    assert after.status == MediaStatus.READY and after.publication_state == PublicationState.PENDING
    assert after.uploaded_at == before.uploaded_at and after.filename == before.filename

    # The edit follows the read rule: a removed row past its bin is
    # invisible to its uploader, and therefore not editable either.
    from datetime import timedelta

    gone = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=31),
    )
    assert (await _patch(client, cast.uploader, gone, {"caption": "x"})).json() == missing.json()


async def test_deleting_a_photograph_deletes_its_tags(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    await _patch(client, cast.uploader, media_id, {"tags": ["Tommy", "cake", "birthday"]})
    assert len(await _stored_tags(db_session_factory, media_id)) == 3
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
        await db.commit()
    assert await _stored_tags(db_session_factory, media_id) == []
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaTag)) == 0


# --- search ---------------------------------------------------------------------


async def test_search_matches_caption_tag_and_filename_case_insensitively(
    client, capsys, db_session_factory
):
    """Three photographs, each findable by a different field; the term is
    literal (`%` and `_` are characters); a blank or absent `q` is not a
    search; an over-long one is a 422 on the query parameter."""
    cast = await _cast(client, capsys, db_session_factory)
    by_caption = await _photograph(db_session_factory, cast)
    by_tag = await _photograph(db_session_factory, cast)
    by_name = (await _intent(client, cast.uploader, cast.gathering_id, filename=FILENAME)).json()[
        "intents"
    ][0]["media"]["id"]
    await _patch(client, cast.uploader, by_caption, {"caption": "Tommy's 5th birthday — 100% cake"})
    await _patch(client, cast.uploader, by_tag, {"tags": ["Grandma", "cake"]})

    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "tommy")) == [by_caption]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "GRANDMA")) == [by_tag]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "img_0569")) == [by_name]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, ".heic")) == [by_name]
    # A term across two fields on two rows: both, newest first.
    assert set(_ids(await _search(client, cast.uploader, cast.gathering_id, "cake"))) == {by_caption, by_tag}
    # Literal, not a pattern: "100%" matches the caption that has it and
    # "%" alone matches nothing (no photograph has a percent sign but one).
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "100% cake")) == [by_caption]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "100_cake")) == []
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "%")) == [by_caption]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "_")) == [by_name]
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "nothing here")) == []
    # Not a search: absent, blank, whitespace.
    everything = _ids(await _search(client, cast.uploader, cast.gathering_id, None))
    assert set(everything) == {by_caption, by_tag, by_name}
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "")) == everything
    assert _ids(await _search(client, cast.uploader, cast.gathering_id, "   ")) == everything
    too_long = await _search(client, cast.uploader, cast.gathering_id, "x" * (MAX_SEARCH_LENGTH + 1))
    assert _locs(too_long) == [["query", "q"]]


async def test_search_never_returns_a_photograph_the_caller_may_not_see(
    client, capsys, db_session_factory
):
    """THE LEAK TEST (the phase's §5): the search runs INSIDE the audience
    filter. A keeper and an accepted invitee who may not see a pending
    photograph get nothing for a term that matches its caption, its tag,
    and its file name — the same nothing a term matching no photograph
    returns — while the host, who may see it, finds it; a stranger draws
    the gathering 404 byte-identical to a missing gathering. And the search
    narrows without widening: a `live` photograph IS found by the keeper."""
    cast = await _cast(client, capsys, db_session_factory)
    pending = (await _intent(client, cast.uploader, cast.gathering_id, filename="Tommy-at-the-park.jpg")).json()[
        "intents"
    ][0]["media"]["id"]
    await _patch(client, cast.uploader, pending, {"caption": "Tommy on the swings", "tags": ["Tommy"]})

    for headers in (cast.keeper, cast.bystander):
        for term in ("Tommy", "swings", "park", "tommy-at-the"):
            found = await _search(client, headers, cast.gathering_id, term)
            assert found.status_code == 200, term
            assert found.json() == {"media": []}, term
            # Indistinguishable from a term that matches nothing at all.
            assert found.json() == (await _search(client, headers, cast.gathering_id, "zzz")).json()
    for headers in (cast.host, cast.uploader):
        assert _ids(await _search(client, headers, cast.gathering_id, "Tommy")) == [pending]

    stranger = await _search(client, cast.stranger, cast.gathering_id, "Tommy")
    assert stranger.status_code == 404
    assert stranger.json() == (await _search(client, cast.stranger, MISSING_ID, "Tommy")).json()

    # Narrows, never widens: the keeper finds a live photograph by its tag,
    # and still nothing of the pending one beside it.
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _patch(client, cast.uploader, live, {"tags": ["Tommy"]})
    assert _ids(await _search(client, cast.keeper, cast.gathering_id, "tommy")) == [live]
    assert set(_ids(await _search(client, cast.uploader, cast.gathering_id, "tommy"))) == {live, pending}


async def test_list_statement_count_does_not_scale_with_photographs_or_tags(
    client, capsys, db_session_factory
):
    """Tags ride the list as a correlated subquery in ONE statement (the
    CK-20 discipline): equal statement counts at one untagged photograph
    and at four tagged ones, with and without a search term, and exactly
    one statement in the request reads media."""
    cast = await _cast(client, capsys, db_session_factory)
    await _photograph(db_session_factory, cast)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert (await _list(client, cast.uploader, cast.gathering_id)).status_code == 200
        at_one = len(statements)
        for i in range(3):
            media_id = await _photograph(db_session_factory, cast)
            await _patch(client, cast.uploader, media_id, {"tags": [f"tag{i}", "shared"]})
        statements.clear()
        assert (await _list(client, cast.uploader, cast.gathering_id)).status_code == 200
        at_four = len(statements)
        reading_media = [s for s in statements if "FROM media" in s]
        statements.clear()
        assert (await _search(client, cast.uploader, cast.gathering_id, "shared")).status_code == 200
        searching = len(statements)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert at_four == at_one == searching
    assert len(reading_media) == 1


async def test_no_caption_tag_filename_or_search_term_reaches_the_log(
    client, capsys, db_session_factory, caplog
):
    """A caption is free text on a photograph of a child. With the root
    logger at DEBUG, the write, the list and a search together put none of
    the words into any APPLICATION log record — the module still has no
    logger, and the SQL layer and botocore emit none of them. The one
    place a search term does appear is the request line: `q` rides the
    query string, so an access log (uvicorn's on Render; httpx's own
    client logger here) records it the way it records every path — the
    media id in `/media/{id}/url` included. That is the transport, not
    this module, and it is stated in the api-reference rather than pinned
    away; the httpx client's records are excluded below for that reason."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = (await _intent(client, cast.uploader, cast.gathering_id, filename="secret-name-7f3a.heic")).json()[
        "intents"
    ][0]["media"]["id"]
    assert not hasattr(media_api, "logger")
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (
            await _patch(client, cast.uploader, media_id, {"caption": "caption-word-9c2e", "tags": ["tag-word-4b1d"]})
        ).status_code == 200
        assert (await _search(client, cast.uploader, cast.gathering_id, "search-term-e5a7")).status_code == 200
        assert (await _list(client, cast.host, cast.gathering_id)).status_code == 200
        assert (await _patch(client, cast.host, media_id, {"caption": "host-word-1d0f"})).status_code == 404
    application_log = "\n".join(
        record.getMessage() for record in caplog.records if not record.name.startswith("httpx")
    )
    # The client logger did record the request line (so the exclusion above
    # is doing real work, not hiding an empty log).
    assert any(record.name.startswith("httpx") for record in caplog.records)
    for word in ("secret-name-7f3a", "caption-word-9c2e", "tag-word-4b1d", "search-term-e5a7", "host-word-1d0f"):
        assert word not in application_log
