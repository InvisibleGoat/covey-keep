"""CK-34 — the upload intent and the confirm step: deciding whether to
accept a photograph, and issuing the credential if so.

No network anywhere in this file. botocore presigns locally, so every URL
asserted on is one the signing configuration genuinely produced; the confirm
step's HEAD is stubbed at `app.api.media._head` (the conftest points the
endpoint at a reserved TLD, so nothing could connect even by accident).

The load-bearing pins:
- the batch refusals — video (the Live Photo MOV first among them), the size
  bounds, more than fifty items, a foreign date — are each a field-level 422
  landing on the offending entry, and each leaves NO row (the batch is
  refused whole);
- the audience is the read audience and is NEVER keeping: an invitee with
  no kept row uploads; a stranger's 404 is byte-identical to a missing id;
- the quota is a RESERVATION on the resolved KEEPER's account (CK-50; the
  host's until then), IN PHOTOGRAPHS since CK-51b (the currency record §3:
  a photograph is 1 whatever it weighed, the reservation is the batch's
  item count, `photo_count` plus the in-flight rows is the usage) — a
  batch that would exceed it is refused, the reservation survives confirm,
  releases at `failed`, and is released by the reap; the uploader may be
  over their own quota; a refusal never states anyone's usage figure,
  WHOSE storage it is, or a byte unit; a gathering with no keeper refuses
  (a memorial too), a hostless one with a keeper does not; CK-50's PROOF
  — host and keeper two accounts, the keeper's headroom deciding in both
  directions and the reservation landing on the keeper; a group gathering
  charging the GROUP's keeper (the resolver's first rung at the gate) and
  refusing once the group's keeper is gone;
- CK-51b's own pins: 10,000 photographs admitted and the 10,001st refused
  whatever it weighs; a 24 MB photograph and a 40 KB one each costing
  exactly 1, with the byte columns unread; THE TWO REFUSALS by their exact
  copy — the bin empty (no bin named) and the bin not empty (the bin
  named, emptying offered; bin record §5) — neither naming a usage figure,
  whose storage it is, or a byte unit; `account_bin_count` reached from
  the refusal path alone; no quota or ceiling refusal spelling GB or MB;
- CK-51b.1's own pins — WHO IS ASKING (the currency record 2.6.0 §3, the
  bin record 1.1.0 §5): CK-51b's two forms are THE KEEPER'S, asking about
  their own space — the room left, and the bin where it is not empty,
  disclosed because only they can act on either; everyone else reads ONE
  withheld form, the limit and the batch — no room figure (usage in
  disguise: CK-50's pin, restored), no bin count (a fact about another
  person's deletions), no `host`, no `keeper`, no byte unit; the four
  cases keeper / non-keeper × bin empty / bin not empty by exact copy; a
  host who is not the keeper reads the withheld form in both bin states;
  `account_bin_count` stubbed to raise and never reached on the
  non-keeper refusal, the accepted path, the memorial refusal or the
  keeperless refusal;
- a memorial is exempt from the account quota and refused above its own
  ceiling — 5,000 photographs, one unit across every gathering type — with
  in-flight rows counting toward it;
- confirm verifies rather than trusts: a missing object and a size mismatch
  each refuse and change nothing; success flips exactly one rung, stamps
  uploaded_at (NULL until then — 0017) and available_at, and moves nothing
  else (publication_state, total_bytes, derivatives); a second confirm is
  refused; only the uploader may confirm;
- THE REAP deletes a stale pending_upload row and leaves a stale READY
  photograph untouched (retention.py's second invariant — the trap);
- a presigned URL appears in the response body and nowhere else, on the
  success path and on a failure path after presigning.
"""

import inspect
import logging
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update

from app.api import media as media_api
from app.api.media import INTENT_REAP_AFTER, MAX_INTENTS_PER_REQUEST, MAX_UPLOAD_BYTES
from app.config import settings
from app.main import app
from app.models import (
    Gathering,
    Group,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    Person,
    PublicationState,
)
from app.services import keeping
from app.services.storage import PRESIGN_TTL, quarantine_key
from tests.test_gatherings import _account_for, _create, _field_errors, _signed_in_headers
from tests.test_invitations import _accept, _invite_token
from tests.test_keeper_shape import _mk_group

MISSING_ID = "00000000-0000-0000-0000-000000000000"
MB = 1_000_000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _item(size: int = 4 * MB, content_type: str = "image/jpeg", occurrence_id=None) -> dict:
    item = {"content_type": content_type, "size_bytes": size}
    if occurrence_id is not None:
        item["occurrence_id"] = occurrence_id
    return item


async def _intents(client, headers, gathering_id: str, items: list[dict]):
    return await client.post(
        f"/gatherings/{gathering_id}/media/intents", json={"items": items}, headers=headers
    )


async def _confirm(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/confirm", headers=headers)


def _locs(response) -> list[list]:
    return [err["loc"] for err in response.json()["detail"]]


async def _media_count(db) -> int:
    return await db.scalar(select(func.count()).select_from(Media))


async def _media_rows(db) -> dict:
    return {str(m.id): m for m in (await db.execute(select(Media))).scalars()}


def _stub_head(monkeypatch, result=None, *, raises: Exception | None = None):
    async def fake_head(upload, key):
        fake_head.keys.append(key)
        if raises is not None:
            raise raises
        return result

    fake_head.keys = []
    monkeypatch.setattr(media_api, "_head", fake_head)
    return fake_head


async def _set_total_bytes(db, gathering_id: str, total: int) -> None:
    await db.execute(
        update(Gathering).where(Gathering.id == gathering_id).values(total_bytes=total)
    )
    await db.commit()


async def _set_photo_count(db, gathering_id: str, count: int) -> None:
    # The quota's unit since CK-51b: the gathering's committed photographs,
    # planted directly (the worker is the only writer; test_photo_count.py
    # pins its increment).
    await db.execute(
        update(Gathering).where(Gathering.id == gathering_id).values(photo_count=count)
    )
    await db.commit()


def _names_no_byte_unit(message: str) -> None:
    # A quota or ceiling refusal is in photographs, never bytes: none of
    # the units _human_bytes can spell, and not the word itself.
    for unit in ("GB", "MB", "KB", "byte"):
        assert unit not in message, message


async def _host_and_invitee(client, capsys, host_addr: str, invitee_addr: str):
    """A host with a two-date gathering and an accepted invitee — the CK-25
    audience with both arms populated (the test_rsvps shape)."""
    headers_host = await _signed_in_headers(client, capsys, host_addr)
    created = await _create(
        client,
        headers_host,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-09-08T18:00:00+00:00"},
        ],
    )
    token = await _invite_token(client, capsys, headers_host, created["id"], invitee_addr)
    headers_invitee = await _signed_in_headers(client, capsys, invitee_addr)
    await _accept(client, headers_invitee, token)
    return headers_host, headers_invitee, created


# --- auth ----------------------------------------------------------------------


async def test_media_endpoints_require_auth(client):
    assert (
        await client.post(f"/gatherings/{MISSING_ID}/media/intents", json={"items": [_item()]})
    ).status_code == 401
    assert (await client.post(f"/media/{MISSING_ID}/confirm")).status_code == 401


# --- the intent: a row at pending_upload and a presigned PUT ---------------


async def test_intent_creates_pending_rows_and_presigns_a_put_with_the_size_signed(
    client, capsys, db_session_factory
):
    address = "uploader@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    created = await _create(client, headers)
    date_id = created["occurrences"][0]["id"]

    response = await _intents(
        client,
        headers,
        created["id"],
        [_item(3 * MB, "image/jpeg", date_id), _item(7 * MB, "image/heic")],
    )
    assert response.status_code == 201, response.text
    intents = response.json()["intents"]
    assert len(intents) == 2

    labelled, unlabelled = intents
    assert labelled["media"]["occurrence_id"] == date_id
    assert unlabelled["media"]["occurrence_id"] is None
    for intent, size, content_type in ((labelled, 3 * MB, "image/jpeg"), (unlabelled, 7 * MB, "image/heic")):
        media = intent["media"]
        assert media["gathering_id"] == created["id"]
        assert media["status"] == "pending_upload"
        assert media["publication_state"] == "pending"
        assert media["upload_content_type"] == content_type
        assert media["upload_size_bytes"] == size
        # 0017: NULL until confirm — the row is born at intent, and that
        # instant is created_at.
        assert media["uploaded_at"] is None
        assert "@" not in response.text  # no email address in any body

        upload = intent["upload"]
        assert upload["method"] == "PUT"
        assert upload["headers"] == {"Content-Length": str(size), "Content-Type": content_type}
        assert upload["expires_in"] == int(PRESIGN_TTL.total_seconds())
        parts = urllib.parse.urlsplit(upload["url"])
        query = dict(urllib.parse.parse_qsl(parts.query))
        # Into QUARANTINE, under the key derived from the row id, signed by
        # the upload credential with the size in the signed headers.
        assert parts.path == f"/{settings.r2_bucket_quarantine}/{quarantine_key(media['id'])}"
        assert settings.r2_bucket_published not in upload["url"]
        assert query["X-Amz-Credential"].startswith(settings.r2_upload_access_key_id + "/")
        assert "content-length" in query["X-Amz-SignedHeaders"].split(";")

    async with db_session_factory() as db:
        rows = await _media_rows(db)
        assert set(rows) == {labelled["media"]["id"], unlabelled["media"]["id"]}
        person = (await db.execute(select(Person).where(Person.email == address))).scalars().one()
        for row in rows.values():
            assert row.status == MediaStatus.PENDING_UPLOAD
            assert row.publication_state == PublicationState.PENDING
            assert row.uploader_person_id == person.id
            assert row.guest_name is None
            assert row.uploaded_at is None
            assert row.available_at is None
        # Nothing else moved: the bytes are reserved, not committed.
        gathering = await db.get(Gathering, created["id"])
        assert gathering.total_bytes == 0
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 0


async def test_max_size_and_a_full_batch_are_accepted(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "edge@example.com")
    created = await _create(client, headers)
    # Exactly the cap, and exactly the batch bound: both are the last
    # accepted values, not the first refused ones.
    items = [_item(MAX_UPLOAD_BYTES)] + [_item(MB)] * (MAX_INTENTS_PER_REQUEST - 1)
    response = await _intents(client, headers, created["id"], items)
    assert response.status_code == 201, response.text
    assert len(response.json()["intents"]) == MAX_INTENTS_PER_REQUEST
    async with db_session_factory() as db:
        assert await _media_count(db) == MAX_INTENTS_PER_REQUEST


# --- the batch refusals: each a field-level 422, each leaving no row --------


async def test_video_is_refused_explicitly_including_the_live_photo_half(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "iphone@example.com")
    created = await _create(client, headers)
    # An iPhone share sheet hands over a paired HEIC and MOV from one
    # gesture: the HEIC is fine, the MOV must draw a usable refusal — and
    # the whole batch is refused with it.
    response = await _intents(
        client,
        headers,
        created["id"],
        [_item(3 * MB, "image/heic"), _item(9 * MB, "video/quicktime")],
    )
    assert response.status_code == 422
    assert _locs(response) == [["body", "items", 1, "content_type"]]
    assert "video" in response.json()["detail"][0]["msg"].lower()
    for content_type in ("video/mp4", "application/pdf", "image/gif", "image/jpeg; charset=x", ""):
        refused = await _intents(client, headers, created["id"], [_item(MB, content_type)])
        assert refused.status_code == 422, content_type
        assert _locs(refused) == [["body", "items", 0, "content_type"]], content_type
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def test_size_must_be_present_positive_and_at_most_the_cap(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "sizes@example.com")
    created = await _create(client, headers)
    for bad in (0, -1, MAX_UPLOAD_BYTES + 1):
        response = await _intents(client, headers, created["id"], [_item(MB), _item(bad)])
        assert response.status_code == 422, bad
        assert _locs(response) == [["body", "items", 1, "size_bytes"]], bad
    absent = await client.post(
        f"/gatherings/{created['id']}/media/intents",
        json={"items": [{"content_type": "image/jpeg"}]},
        headers=headers,
    )
    assert absent.status_code == 422
    assert _locs(absent) == [["body", "items", 0, "size_bytes"]]
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def test_batch_bounds_and_unknown_fields(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "batch@example.com")
    created = await _create(client, headers)
    too_many = await _intents(client, headers, created["id"], [_item(MB)] * (MAX_INTENTS_PER_REQUEST + 1))
    assert too_many.status_code == 422
    assert _locs(too_many) == [["body", "items"]]
    empty = await _intents(client, headers, created["id"], [])
    assert empty.status_code == 422
    assert _locs(empty) == [["body", "items"]]
    extra = await client.post(
        f"/gatherings/{created['id']}/media/intents",
        json={"items": [{**_item(MB), "storage_key": "x"}]},
        headers=headers,
    )
    assert extra.status_code == 422
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def test_a_date_label_must_belong_to_this_gathering(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "labeller@example.com")
    mine = await _create(client, headers)
    other = await _create(client, headers, title="Another one")
    foreign_date = other["occurrences"][0]["id"]
    response = await _intents(
        client, headers, mine["id"], [_item(MB), _item(MB, occurrence_id=foreign_date)]
    )
    assert response.status_code == 422
    assert _locs(response) == [["body", "items", 1, "occurrence_id"]]
    unknown = await _intents(client, headers, mine["id"], [_item(MB, occurrence_id=MISSING_ID)])
    assert unknown.status_code == 422
    assert _locs(unknown) == [["body", "items", 0, "occurrence_id"]]
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


# --- the audience: the read audience, and never keeping -------------------


async def test_audience_is_the_read_audience_and_never_keeping(
    client, capsys, db_session_factory
):
    headers_host, headers_invitee, created = await _host_and_invitee(
        client, capsys, "host@example.com", "cousin@example.com"
    )
    headers_stranger = await _signed_in_headers(client, capsys, "stranger@example.com")

    # The invitee keeps nothing — the gathering's keeper is the host's
    # account, never the invitee's (the column, since CK-49b) — and uploads
    # regardless: contribution is never gated on keeping (terminology
    # record §5).
    async with db_session_factory() as db:
        invitee_account = await _account_for(db, "cousin@example.com")
        gathering = await db.get(Gathering, created["id"])
        assert gathering.keeper_account_id is not None
        assert gathering.keeper_account_id != invitee_account.id
    assert (await _intents(client, headers_invitee, created["id"], [_item()])).status_code == 201
    assert (await _intents(client, headers_host, created["id"], [_item()])).status_code == 201

    # A stranger's 404 is byte-identical to a missing gathering's.
    refused = await _intents(client, headers_stranger, created["id"], [_item()])
    missing = await _intents(client, headers_stranger, MISSING_ID, [_item()])
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()
    async with db_session_factory() as db:
        assert await _media_count(db) == 2


# --- the quota: a reservation on the resolved KEEPER's account (CK-50) -------
# CK-34 charged the gathering's host. Since CK-50 the subject is the resolved
# keeper (keeper record v2 §6) — one lookup through the resolver, that
# account's row locked, the same mechanism otherwise. Under one keeper the
# creator is keeper and host at once, so every test that reads "the host"
# below was true then and is true now; the ones that separate the two
# facts (host ≠ keeper — the sponsorship shape, made by MOVING the column,
# since transfer has no surface) are the phase's proof.


async def test_reservation_blocks_a_batch_that_would_exceed_the_keepers_quota(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    headers = await _signed_in_headers(client, capsys, "full@example.com")
    created = await _create(client, headers)

    # Exactly the quota, reserved by two pending intents — two photographs,
    # whatever they declared.
    first = await _intents(client, headers, created["id"], [_item(25 * MB), _item(25 * MB)])
    assert first.status_code == 201, first.text
    ids = [i["media"]["id"] for i in first.json()["intents"]]

    # One more photograph would exceed it: refused on the batch, no row, and
    # the message names the allowance and the batch — never the usage.
    refused = await _intents(client, headers, created["id"], [_item(1)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert "2 photos" in message
    _names_no_byte_unit(message)
    async with db_session_factory() as db:
        assert await _media_count(db) == 2
        account = await _account_for(db, "full@example.com")
        # The reservation IS the usage: nothing is committed yet.
        assert await keeping.account_usage(db, account) == 2
        gathering = await db.get(Gathering, created["id"])
        assert (gathering.total_bytes, gathering.photo_count) == (0, 0)

    # Confirming does not release the reservation — the bytes now sit in
    # quarantine, still against the keeper's quota until published.
    _stub_head(monkeypatch, (25 * MB, "image/jpeg"))
    for media_id in ids:
        assert (await _confirm(client, headers, media_id)).status_code == 200
    assert (await _intents(client, headers, created["id"], [_item(1)])).status_code == 422

    # `failed` releases it: nothing was stored.
    async with db_session_factory() as db:
        await db.execute(update(Media).values(status=MediaStatus.FAILED))
        await db.commit()
    assert (await _intents(client, headers, created["id"], [_item(1)])).status_code == 201


async def test_reservation_is_released_by_the_reap(
    client, capsys, db_session_factory, monkeypatch
):
    # An abandoned batch holds the whole quota — until the reap at the top
    # of the next intent request lets it go. Same request, one path.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 1)
    headers = await _signed_in_headers(client, capsys, "abandoned@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        person = (
            await db.execute(select(Person).where(Person.email == "abandoned@example.com"))
        ).scalars().one()
        db.add(
            Media(
                gathering_id=created["id"],
                uploader_person_id=person.id,
                upload_content_type="image/jpeg",
                upload_size_bytes=50 * MB,
                status=MediaStatus.PENDING_UPLOAD,
                publication_state=PublicationState.PENDING,
                created_at=_now() - INTENT_REAP_AFTER - timedelta(minutes=1),
            )
        )
        await db.commit()
        stale_id = str((await db.execute(select(Media.id))).scalar_one())

    response = await _intents(client, headers, created["id"], [_item(MB)])
    assert response.status_code == 201, response.text
    async with db_session_factory() as db:
        rows = await _media_rows(db)
        assert stale_id not in rows
        assert set(rows) == {response.json()["intents"][0]["media"]["id"]}


async def test_an_uploader_may_be_over_their_own_quota(
    client, capsys, db_session_factory, monkeypatch
):
    # The cousin keeps their own, over-full gathering; the grandmother's
    # gathering is fine. The cousin uploads to the grandmother's gathering
    # regardless — the check is the KEEPER's quota, never the uploader's
    # (blocking a grandmother's upload because a cousin is full turns one
    # person's spending decision into everyone else's outage).
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    headers_keeper, headers_cousin, created = await _host_and_invitee(
        client, capsys, "grandmother@example.com", "cousin@example.com"
    )
    own = await _create(client, headers_cousin, title="The cousin's own")
    async with db_session_factory() as db:
        await _set_photo_count(db, own["id"], 3)
        cousin = await _account_for(db, "cousin@example.com")
        assert await keeping.account_usage(db, cousin) > await keeping.account_quota(db, cousin)
    assert (await _intents(client, headers_cousin, created["id"], [_item(MB)])).status_code == 201
    # Control: the same cousin on the gathering they keep is refused.
    assert (await _intents(client, headers_cousin, own["id"], [_item(1)])).status_code == 422


async def test_a_quota_refusal_never_discloses_usage_or_whose_storage_it_is(
    client, capsys, db_session_factory, monkeypatch
):
    # CK-50's pin, RESTORED at CK-51b.1 for every caller who is not the
    # keeper. CK-50 decided that a refusal names the limit and what would
    # exceed it — never the host's usage — and called the room left "usage
    # in disguise". CK-51b's kickoff specified copy naming the room to
    # EVERY caller (the currency record §3 at 2.4.0: "something a person
    # can act on"); the phase moved this pin deliberately and reported it,
    # and the records were amended once the collision was seen (currency
    # 2.6.0 §3, bin 1.1.0 §5): only the KEEPER can act on the room or the
    # bin, so to anyone else both figures are unusable, and the room left
    # is exactly the usage CK-50 withheld. The invitee here is in the
    # upload audience and is not the keeper.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 50)
    _, headers_invitee, created = await _host_and_invitee(
        client, capsys, "host@example.com", "invitee@example.com"
    )
    async with db_session_factory() as db:
        await _set_photo_count(db, created["id"], 43)
    refused = await _intents(client, headers_invitee, created["id"], [_item(8 * MB)] * 8)
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    # The allowance and the batch are stated, and nothing else: not the
    # keeper's 43, not the 7 that would disclose it, not the bin.
    assert message == "this space is full — it holds 50 photos, and you're adding 8"
    assert "43" not in message  # the usage figure
    assert "7" not in message  # the room left — usage in disguise
    assert "room" not in message
    assert "bin" not in message
    _names_no_byte_unit(message)
    # And never WHOSE storage it is: the caller may be neither host nor
    # keeper, and "the keeper's storage is limited to X" tells a guest
    # about someone else's account. Neither word appears, and no direction
    # ("ask the keeper to make room") names whose space it is either.
    assert "host" not in message
    assert "keeper" not in message
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def test_the_keepers_headroom_decides_and_the_hosts_is_irrelevant(
    client, capsys, db_session_factory, monkeypatch
):
    # THE test that proves the phase (v2 §6, §7): the host and the keeper
    # are two accounts, and only the keeper's headroom is consulted — in
    # BOTH directions. The sponsorship shape: grandma keeps the family
    # home; her grandson hosts the barbecue. Each has a gathering of their
    # own to be full through.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 3)
    host_addr, keeper_addr = "grandson@example.com", "grandma@example.com"
    headers_host = await _signed_in_headers(client, capsys, host_addr)
    headers_keeper = await _signed_in_headers(client, capsys, keeper_addr)
    barbecue = await _create(client, headers_host, title="The barbecue")
    hosts_own = await _create(client, headers_host, title="The grandson's own")
    keepers_own = await _create(client, headers_keeper, title="Grandma's own")
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, keeper_addr)
        host_account = await _account_for(db, host_addr)
        gathering = await db.get(Gathering, barbecue["id"])
        assert gathering.host_account_id == host_account.id
        gathering.keeper_account_id = keeper_account.id  # moved: host ≠ keeper
        await db.commit()
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution.keeper_account_id == keeper_account.id

    # Direction 1: the KEEPER is full and the host is empty → refused. The
    # host's plentiful headroom is irrelevant, and no row is written.
    async with db_session_factory() as db:
        await _set_photo_count(db, keepers_own["id"], 4)
        assert await keeping.account_usage(db, await _account_for(db, keeper_addr)) == 4
        assert await keeping.account_usage(db, await _account_for(db, host_addr)) == 0
    refused = await _intents(client, headers_host, barbecue["id"], [_item(MB)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    async with db_session_factory() as db:
        assert await _media_count(db) == 0

    # Direction 2: the keeper is empty and the HOST is full → allowed, and
    # the reservation lands on the keeper's account and nowhere near the
    # host's. The host is over quota on their own gathering the whole time.
    async with db_session_factory() as db:
        await _set_photo_count(db, keepers_own["id"], 0)
        await _set_photo_count(db, hosts_own["id"], 4)
        assert await keeping.account_usage(db, await _account_for(db, host_addr)) == 4
    allowed = await _intents(client, headers_host, barbecue["id"], [_item(3 * MB)])
    assert allowed.status_code == 201, allowed.text
    async with db_session_factory() as db:
        assert await _media_count(db) == 1
        assert await keeping.account_usage(db, await _account_for(db, keeper_addr)) == 1
        assert await keeping.account_usage(db, await _account_for(db, host_addr)) == 4
    # Control: the same host on the gathering they keep THEMSELVES is
    # refused — there, their own headroom decides.
    assert (await _intents(client, headers_host, hosts_own["id"], [_item(1)])).status_code == 422
    # And the keeper, who is not the host here, uploads to the barbecue
    # against their own headroom like anyone else in the audience.
    assert (await _intents(client, headers_keeper, barbecue["id"], [_item(MB)])).status_code == 201


async def test_a_hostless_gathering_with_a_keeper_is_uploadable(
    client, capsys, db_session_factory
):
    # CK-34 refused a hostless gathering (no quota subject, under the host
    # gate). Under v2 §6 the subject is the keeper, and the claimable state
    # (host NULL — v2 §9.2) has one: the upload is accepted and the
    # reservation lands on the keeper. The CK-34 refusal is closed by the
    # gate, not by the claim flow.
    headers = await _signed_in_headers(client, capsys, "keeper@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        await db.execute(
            update(Gathering).where(Gathering.id == created["id"]).values(host_account_id=None)
        )
        await db.commit()
    response = await _intents(client, headers, created["id"], [_item(4 * MB)])
    assert response.status_code == 201, response.text
    async with db_session_factory() as db:
        assert await _media_count(db) == 1
        account = await _account_for(db, "keeper@example.com")
        assert await keeping.account_usage(db, account) == 1


async def test_a_keeperless_gathering_refuses_uploads(client, capsys, db_session_factory):
    # The Unkept rung (v2 §5): both keeper columns NULL. The host is still
    # set — a host does not rescue it; the subject is the keeper and there
    # is none, so there is nobody's quota to charge. A memorial refuses the
    # same way: its ceiling never needed an account, but an unkept
    # gathering is read-only whatever its type, and the memorial branch
    # sits after the subject check exactly as it did under the host gate.
    headers = await _signed_in_headers(client, capsys, "host@example.com")
    potluck = await _create(client, headers)
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    async with db_session_factory() as db:
        await db.execute(
            update(Gathering)
            .where(Gathering.id.in_([potluck["id"], memorial["id"]]))
            .values(keeper_account_id=None)
        )
        await db.commit()
        for gathering_id in (potluck["id"], memorial["id"]):
            gathering = await db.get(Gathering, gathering_id)
            assert gathering.host_account_id is not None
            assert (await keeping.resolved_keeper_of(db, gathering)).source is keeping.KeeperSource.UNKEPT
    for gathering_id in (potluck["id"], memorial["id"]):
        response = await _intents(client, headers, gathering_id, [_item()])
        assert response.status_code == 422
        assert _locs(response) == [["path", "gathering_id"]]
        message = response.json()["detail"][0]["msg"]
        # The copy names keeping, not hosting — and describes no way to come
        # to keep it: the claim surface is unbuilt, so it says what is true
        # and stops.
        assert "keep" in message
        assert "host" not in message
        for claim_flow_word in ("claim", "take it on", "takes it on", "become"):
            assert claim_flow_word not in message
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def test_a_group_gathering_charges_the_groups_keeper(
    client, capsys, db_session_factory, monkeypatch
):
    # The resolver's first rung reaching the quota gate for the first time.
    # A constructed subject, because `owning_group_id` still has no writer
    # (Arc B's): the creator's gathering is moved into a group whose keeper
    # is a second account, its own keeper column NULLed (the CHECK
    # insists), its host left as the creator so the creator still uploads
    # through the read audience. The GROUP's keeper's headroom decides.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 3)
    creator_addr, keeper_addr = "creator@example.com", "group-keeper@example.com"
    headers_creator = await _signed_in_headers(client, capsys, creator_addr)
    headers_keeper = await _signed_in_headers(client, capsys, keeper_addr)
    created = await _create(client, headers_creator, title="Belongs to a group")
    keepers_own = await _create(client, headers_keeper, title="The group keeper's own")
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, keeper_addr)
        group = await _mk_group(db)
        group.keeper_account_id = keeper_account.id
        gathering = await db.get(Gathering, created["id"])
        gathering.keeper_account_id = None
        gathering.owning_group_id = group.id
        await db.commit()
        group_id = group.id
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution.source is keeping.KeeperSource.GROUP
        assert resolution.keeper_account_id == keeper_account.id
        # The group's keeper is full, through a gathering of their own.
        await _set_photo_count(db, keepers_own["id"], 4)
    refused = await _intents(client, headers_creator, created["id"], [_item(MB)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    async with db_session_factory() as db:
        assert await _media_count(db) == 0
        # With headroom, the reservation lands on the group's keeper and on
        # nobody else — not the creator, who hosts it and keeps nothing.
        await _set_photo_count(db, keepers_own["id"], 0)
    allowed = await _intents(client, headers_creator, created["id"], [_item(3 * MB)])
    assert allowed.status_code == 201, allowed.text
    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await _account_for(db, keeper_addr)) == 1
        assert await keeping.account_usage(db, await _account_for(db, creator_addr)) == 0
        # The group's keeper going NULL leaves the gathering Unkept through
        # the first rung — refused as keeperless, though its host stands.
        group = await db.get(Group, group_id)
        group.keeper_account_id = None
        await db.commit()
    unkept = await _intents(client, headers_creator, created["id"], [_item(MB)])
    assert unkept.status_code == 422
    assert _locs(unkept) == [["path", "gathering_id"]]


# --- the memorial: exempt from the account quota, bounded by its own ceiling -


async def test_memorial_is_exempt_from_the_account_quota_and_refused_above_its_ceiling(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    monkeypatch.setattr(keeping, "MEMORIAL_CEILING_PHOTOGRAPHS", 3)
    headers = await _signed_in_headers(client, capsys, "mourner@example.com")
    potluck = await _create(client, headers)
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    # The keeper is over their account quota through the potluck...
    async with db_session_factory() as db:
        await _set_photo_count(db, potluck["id"], 3)
    # ...and the memorial accepts an upload regardless (the exemption).
    first = await _intents(client, headers, memorial["id"], [_item(25 * MB), _item(25 * MB)])
    assert first.status_code == 201, first.text
    # Control: the same keeper on the potluck is refused.
    assert (await _intents(client, headers, potluck["id"], [_item(1)])).status_code == 422

    # The ceiling: 2 in flight + 2 more > 3. The in-flight rows count — the
    # ceiling is a reservation too — and the unit is the photograph.
    second = await _intents(client, headers, memorial["id"], [_item(25 * MB), _item(MB)])
    assert second.status_code == 422
    assert _locs(second) == [["body", "items"]]
    message = second.json()["detail"][0]["msg"]
    assert "memorial" in message and "3 photos" in message
    _names_no_byte_unit(message)
    # Exactly up to the ceiling is fine.
    assert (await _intents(client, headers, memorial["id"], [_item(5 * MB)])).status_code == 201
    async with db_session_factory() as db:
        assert await _media_count(db) == 3
        assert await keeping.gathering_units(db, await db.get(Gathering, memorial["id"])) == 3
        # And none of it counts against the account (memorials are exempt).
        account = await _account_for(db, "mourner@example.com")
        assert await keeping.account_usage(db, account) == 3


async def test_a_memorial_ignores_its_keepers_quota_and_keeps_its_ceiling(
    client, capsys, db_session_factory, monkeypatch
):
    # The memorial branch, untouched at CK-50, seen from the new subject:
    # host ≠ keeper, the KEEPER over quota — and the memorial accepts an
    # upload regardless (exempt from the account quota, whoever's it is);
    # the ceiling still binds against the memorial's own bytes; and none of
    # it counts against the keeper's account.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    monkeypatch.setattr(keeping, "MEMORIAL_CEILING_PHOTOGRAPHS", 3)
    host_addr, keeper_addr = "host@example.com", "mourner@example.com"
    headers_host = await _signed_in_headers(client, capsys, host_addr)
    headers_keeper = await _signed_in_headers(client, capsys, keeper_addr)
    memorial = await _create(
        client, headers_host, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    keepers_potluck = await _create(client, headers_keeper)
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, keeper_addr)
        gathering = await db.get(Gathering, memorial["id"])
        gathering.keeper_account_id = keeper_account.id  # moved: host ≠ keeper
        await db.commit()
        await _set_photo_count(db, keepers_potluck["id"], 3)
        keeper_account = await _account_for(db, keeper_addr)
        assert await keeping.account_usage(db, keeper_account) > await keeping.account_quota(
            db, keeper_account
        )
    # Exempt: the host uploads to the memorial though its keeper is full.
    first = await _intents(client, headers_host, memorial["id"], [_item(25 * MB), _item(25 * MB)])
    assert first.status_code == 201, first.text
    # Control: the keeper on the potluck they keep is refused.
    assert (await _intents(client, headers_keeper, keepers_potluck["id"], [_item(1)])).status_code == 422
    # The ceiling still binds, on the memorial's own count.
    second = await _intents(client, headers_host, memorial["id"], [_item(25 * MB), _item(25 * MB)])
    assert second.status_code == 422
    assert _locs(second) == [["body", "items"]]
    assert "memorial" in second.json()["detail"][0]["msg"]
    async with db_session_factory() as db:
        assert await keeping.gathering_units(db, await db.get(Gathering, memorial["id"])) == 2
        assert await keeping.account_usage(db, await _account_for(db, keeper_addr)) == 3

# --- CK-51b: the quota counts photographs -------------------------------------
# The currency record §3 (a photograph is 1; the reservation is the batch's
# item count; `photo_count` plus the in-flight rows is the usage), §8 (the
# memorial ceiling in photographs), and the bin record §5 (the refusal names
# the bin where it is not empty). The constants below are the real ones
# except where a test says it narrows them.


async def test_ten_thousand_photographs_are_admitted_and_the_next_is_refused_whatever_it_weighs(
    client, capsys, db_session_factory
):
    # The REAL allowance. 9,999 committed; the 10,000th — at the 25 MB cap —
    # is admitted; the 10,001st — 40 KB — is refused. Size decides nothing.
    assert keeping.FREE_TIER_PHOTOGRAPHS == 10_000
    headers = await _signed_in_headers(client, capsys, "tenthousand@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        await _set_photo_count(db, created["id"], keeping.FREE_TIER_PHOTOGRAPHS - 1)
    admitted = await _intents(client, headers, created["id"], [_item(MAX_UPLOAD_BYTES)])
    assert admitted.status_code == 201, admitted.text
    async with db_session_factory() as db:
        account = await _account_for(db, "tenthousand@example.com")
        assert await keeping.account_usage(db, account) == 10_000
        assert await keeping.account_quota(db, account) == 10_000
    refused = await _intents(client, headers, created["id"], [_item(40_000)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert "10,000 photos" in message
    _names_no_byte_unit(message)
    async with db_session_factory() as db:
        assert await _media_count(db) == 1


async def test_a_photograph_costs_exactly_one_whatever_it_weighs_and_the_byte_columns_are_unread(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    headers = await _signed_in_headers(client, capsys, "weightless@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        # 50 GB of bytes on the row and zero photographs: the quota reads
        # the count, and only the count.
        await _set_total_bytes(db, created["id"], 50_000_000_000)
        account = await _account_for(db, "weightless@example.com")
        assert await keeping.account_usage(db, account) == 0
    heavy = await _intents(client, headers, created["id"], [_item(24 * MB)])
    assert heavy.status_code == 201, heavy.text
    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await _account_for(db, "weightless@example.com")) == 1
    light = await _intents(client, headers, created["id"], [_item(40_000)])
    assert light.status_code == 201, light.text
    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await _account_for(db, "weightless@example.com")) == 2
    # The third, of any size, is one photograph too many.
    for size in (1, 40_000, 24 * MB):
        assert (await _intents(client, headers, created["id"], [_item(size)])).status_code == 422, size
    async with db_session_factory() as db:
        assert await _media_count(db) == 2


async def test_the_refusal_when_the_bin_is_empty_names_no_bin(
    client, capsys, db_session_factory, monkeypatch
):
    # The ordinary refusal (currency record §3's copy): the allowance, the
    # room left, what is being added — and no bin, because the bin is
    # empty and copy must not name an affordance it cannot deliver (bin
    # record §5; the CK-50 discipline). THE KEEPER'S form (CK-51b.1): the
    # caller created the gathering and keeps it, so the room left is their
    # own allowance — disclosed because it is the caller's own space and
    # only they can act on it (currency 2.6.0 §3). Anyone else reads the
    # withheld form, pinned in the disclosure test above and the matrix
    # below.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 10)
    headers = await _signed_in_headers(client, capsys, "nobin@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        account = await _account_for(db, "nobin@example.com")
        assert (await db.get(Gathering, created["id"])).keeper_account_id == account.id
        await _set_photo_count(db, created["id"], 8)
    refused = await _intents(client, headers, created["id"], [_item(MB)] * 3)
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert message == "this space holds 10 photos and has room for 2 more, and you're adding 3"
    assert "bin" not in message
    assert "8" not in message  # the usage figure
    assert "host" not in message and "keeper" not in message
    _names_no_byte_unit(message)
    # No room at all: still no bin, and no "room for 0 more".
    async with db_session_factory() as db:
        await _set_photo_count(db, created["id"], 10)
    full = await _intents(client, headers, created["id"], [_item(MB)])
    assert full.status_code == 422
    assert full.json()["detail"][0]["msg"] == (
        "this space holds 10 photos and has no room left, and you're adding 1"
    )
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


async def _plant_bin(db, gathering_id: str, uploader_person_id, *, removed: int, other: int = 1):
    # `removed` photographs in the bin — `ready` AND `removed`, with the
    # stamp — beside `other` ready-and-live ones that are not. photo_count
    # is planted separately: it is the column, not a derivation (CK-51a).
    now = _now()
    for i in range(removed + other):
        db.add(
            Media(
                gathering_id=gathering_id,
                uploader_person_id=uploader_person_id,
                upload_content_type="image/jpeg",
                upload_size_bytes=MB,
                status=MediaStatus.READY,
                publication_state=PublicationState.REMOVED if i < removed else PublicationState.LIVE,
                removed_at=now if i < removed else None,
                created_at=now - timedelta(minutes=i),
                uploaded_at=now - timedelta(minutes=i),
            )
        )
    await db.commit()


async def test_the_refusal_when_the_bin_is_not_empty_names_it_and_offers_to_empty_it(
    client, capsys, db_session_factory, monkeypatch
):
    # Bin record §5, binding on this phase: where the space is full and
    # some of what fills it is in the bin (removed and still stored,
    # whatever its age — not the 30-day retrieval window; bin record
    # §6.1), the refusal says so and
    # offers the one thing a person can do about it. Charged, not visible:
    # the two binned photographs still count (bin record §3, §4). THE
    # KEEPER'S form (CK-51b.1): the bin is theirs to empty — the disclosure
    # is permitted because it is the caller's own space and only they can
    # act on it (bin 1.1.0 §5); anyone else reads the withheld form, with
    # no bin named and none counted (the matrix below).
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 10)
    address = "binned@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    created = await _create(client, headers)
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == address))).scalars().one()
        await _plant_bin(db, created["id"], person.id, removed=2, other=7)
        await _set_photo_count(db, created["id"], 9)
        account = await _account_for(db, address)
        assert (await db.get(Gathering, created["id"])).keeper_account_id == account.id
        assert await keeping.account_usage(db, account) == 9
        assert await keeping.account_bin_count(db, account) == 2
    refused = await _intents(client, headers, created["id"], [_item(MB)] * 3)
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert message == "this space is full — 10 photos, and 2 of them are in the bin. Empty the bin to make room."
    assert "9" not in message  # the usage figure
    assert "host" not in message and "keeper" not in message
    _names_no_byte_unit(message)
    async with db_session_factory() as db:
        assert await _media_count(db) == 9  # nothing added


async def test_the_bin_clause_agrees_with_itself_at_one_photograph(
    client, capsys, db_session_factory, monkeypatch
):
    # CK-54's rider. The clause had no singular branch, so ONE binned
    # photograph read "1 of them are in the bin" — the commonest small
    # number, and the one a person is most likely to see, because it is
    # what a single removal leaves behind. Both forms pinned so neither
    # can drift away from the other.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 10)
    address = "onebinned@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    created = await _create(client, headers)
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == address))).scalars().one()
        await _plant_bin(db, created["id"], person.id, removed=1, other=9)
        await _set_photo_count(db, created["id"], 10)
        account = await _account_for(db, address)
        assert await keeping.account_bin_count(db, account) == 1
    refused = await _intents(client, headers, created["id"], [_item(MB)])
    assert refused.status_code == 422
    message = refused.json()["detail"][0]["msg"]
    assert message == (
        "this space is full — 10 photos, and 1 of them is in the bin. "
        "Empty the bin to make room."
    )
    assert "are in the bin" not in message
    _names_no_byte_unit(message)


async def test_the_four_refusals_by_audience_and_bin_state(
    client, capsys, db_session_factory, monkeypatch
):
    # THE MATRIX (CK-51b.1; currency 2.6.0 §3, bin 1.1.0 §5): keeper /
    # non-keeper × bin empty / bin not empty, each by exact copy. Grandma
    # created the gathering and keeps it; the cousin is an accepted invitee
    # — in the upload audience, not the keeper. Same gathering, same
    # headroom, same batch; only WHO IS ASKING differs.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 10)
    keeper_addr, cousin_addr = "grandma@example.com", "cousin@example.com"
    headers_keeper, headers_cousin, created = await _host_and_invitee(
        client, capsys, keeper_addr, cousin_addr
    )
    async with db_session_factory() as db:
        keeper = await _account_for(db, keeper_addr)
        cousin = await _account_for(db, cousin_addr)
        gathering = await db.get(Gathering, created["id"])
        assert gathering.keeper_account_id == keeper.id != cousin.id
        await _set_photo_count(db, created["id"], 8)
        assert await keeping.account_bin_count(db, keeper) == 0

    withheld = "this space is full — it holds 10 photos, and you're adding 3"

    # Bin empty: the keeper reads the room left; the cousin reads the
    # withheld form.
    keeper_empty = await _intents(client, headers_keeper, created["id"], [_item(MB)] * 3)
    cousin_empty = await _intents(client, headers_cousin, created["id"], [_item(MB)] * 3)
    assert keeper_empty.status_code == cousin_empty.status_code == 422
    assert _locs(keeper_empty) == _locs(cousin_empty) == [["body", "items"]]
    assert keeper_empty.json()["detail"][0]["msg"] == (
        "this space holds 10 photos and has room for 2 more, and you're adding 3"
    )
    assert cousin_empty.json()["detail"][0]["msg"] == withheld

    # Bin not empty: the keeper reads the bin clause; the cousin reads the
    # SAME withheld form — the bin's state changes nothing for them.
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == keeper_addr))).scalars().one()
        await _plant_bin(db, created["id"], person.id, removed=2, other=8)
        await _set_photo_count(db, created["id"], 10)
        assert await keeping.account_bin_count(db, await _account_for(db, keeper_addr)) == 2
    keeper_binned = await _intents(client, headers_keeper, created["id"], [_item(MB)] * 3)
    cousin_binned = await _intents(client, headers_cousin, created["id"], [_item(MB)] * 3)
    assert keeper_binned.status_code == cousin_binned.status_code == 422
    assert keeper_binned.json()["detail"][0]["msg"] == (
        "this space is full — 10 photos, and 2 of them are in the bin. Empty the bin to make room."
    )
    assert cousin_binned.json()["detail"][0]["msg"] == withheld

    # Every form: no usage figure (the 8), no owner word, no byte unit. The
    # withheld form: no room figure, no bin — not the word, not the 2.
    for response in (keeper_empty, cousin_empty, keeper_binned, cousin_binned):
        message = response.json()["detail"][0]["msg"]
        assert "8" not in message and "host" not in message and "keeper" not in message
        _names_no_byte_unit(message)
    for response in (cousin_empty, cousin_binned):
        message = response.json()["detail"][0]["msg"]
        assert "room" not in message and "bin" not in message and "2" not in message
    async with db_session_factory() as db:
        assert await _media_count(db) == 10  # the planted rows; nothing added


async def test_a_host_who_is_not_the_keeper_reads_the_withheld_form(
    client, capsys, db_session_factory, monkeypatch
):
    # The host is not special (currency 2.6.0 §3): a host who does not keep
    # the gathering can neither free room nor empty the bin, so they read
    # the withheld form in both bin states — while the keeper, uploading to
    # the same gathering, reads their own room and their own bin. The
    # sponsorship shape as CK-50's tests build it: grandma keeps the family
    # home, her grandson hosts the barbecue; the column is MOVED because
    # transfer has no surface.
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 4)
    host_addr, keeper_addr = "grandson@example.com", "grandma@example.com"
    headers_host = await _signed_in_headers(client, capsys, host_addr)
    headers_keeper = await _signed_in_headers(client, capsys, keeper_addr)
    barbecue = await _create(client, headers_host, title="The barbecue")
    keepers_own = await _create(client, headers_keeper, title="Grandma's own")
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, keeper_addr)
        host_account = await _account_for(db, host_addr)
        gathering = await db.get(Gathering, barbecue["id"])
        assert gathering.host_account_id == host_account.id
        gathering.keeper_account_id = keeper_account.id  # moved: host ≠ keeper
        await db.commit()
        # The keeper is full through a gathering of their own; the bin empty.
        await _set_photo_count(db, keepers_own["id"], 3)

    withheld = "this space is full — it holds 4 photos, and you're adding 2"
    host_refused = await _intents(client, headers_host, barbecue["id"], [_item(MB)] * 2)
    keeper_refused = await _intents(client, headers_keeper, barbecue["id"], [_item(MB)] * 2)
    assert host_refused.status_code == keeper_refused.status_code == 422
    assert host_refused.json()["detail"][0]["msg"] == withheld
    assert keeper_refused.json()["detail"][0]["msg"] == (
        "this space holds 4 photos and has room for 1 more, and you're adding 2"
    )

    # The bin fills — on the keeper's own gathering, because the bin is the
    # account's, over every gathering that resolves to it: the keeper reads
    # the bin clause; the host still reads the withheld form.
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == keeper_addr))).scalars().one()
        await _plant_bin(db, keepers_own["id"], person.id, removed=2, other=2)
        await _set_photo_count(db, keepers_own["id"], 4)
    host_binned = await _intents(client, headers_host, barbecue["id"], [_item(MB)] * 2)
    keeper_binned = await _intents(client, headers_keeper, barbecue["id"], [_item(MB)] * 2)
    assert host_binned.status_code == keeper_binned.status_code == 422
    assert host_binned.json()["detail"][0]["msg"] == withheld
    assert keeper_binned.json()["detail"][0]["msg"] == (
        "this space is full — 4 photos, and 2 of them are in the bin. Empty the bin to make room."
    )
    for response in (host_refused, host_binned):
        message = response.json()["detail"][0]["msg"]
        assert "host" not in message and "keeper" not in message and "bin" not in message
        assert "room" not in message and "3" not in message  # no room figure, no usage
        _names_no_byte_unit(message)
    async with db_session_factory() as db:
        assert await _media_count(db) == 4  # the planted rows; nothing added


async def test_account_bin_count_is_reached_from_the_refusal_path_alone(
    client, capsys, db_session_factory, monkeypatch
):
    # The hot path pays for the quota's one statement and nothing more: the
    # bin is counted only once the quota has refused THE KEEPER (keeping.py
    # says why it is not folded into account_usage; CK-51b.1 says why it is
    # not run for anyone else — a query whose answer may not be shown is
    # not run). Structurally — the name appears in the media router once,
    # inside _enforce_limits, and nowhere else in the app but keeping.py
    # itself — and behaviourally: a counting stub that raises is never
    # reached by an accepted intent, by a memorial refusal (bin record
    # §7.4 — no bin clause on a memorial), by a NON-KEEPER's refusal, or by
    # the keeperless refusal.
    source = inspect.getsource(media_api)
    assert source.count("keeping.account_bin_count(") == 1
    assert "keeping.account_bin_count(" in inspect.getsource(media_api._enforce_limits)
    app_dir = Path(media_api.__file__).resolve().parent.parent
    callers = {
        path.relative_to(app_dir).as_posix()
        for path in app_dir.rglob("*.py")
        if "account_bin_count(" in path.read_text(encoding="utf-8")
    }
    assert callers == {"api/media.py", "services/keeping.py"}

    async def never(db, account):  # pragma: no cover — reaching it is the failure
        raise AssertionError("account_bin_count was called on a path that is not the quota refusal")

    monkeypatch.setattr(keeping, "account_bin_count", never)
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 2)
    monkeypatch.setattr(keeping, "MEMORIAL_CEILING_PHOTOGRAPHS", 1)
    headers = await _signed_in_headers(client, capsys, "hotpath@example.com")
    created = await _create(client, headers)
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    assert (await _intents(client, headers, created["id"], [_item(MB)])).status_code == 201
    assert (await _intents(client, headers, memorial["id"], [_item(MB)])).status_code == 201
    over = await _intents(client, headers, memorial["id"], [_item(MB)])
    assert over.status_code == 422 and "memorial" in over.json()["detail"][0]["msg"]
    # The NON-KEEPER's refusal (CK-51b.1): an accepted invitee, refused on
    # the same gathering once it is full, reads the withheld form and the
    # stub is never reached.
    token = await _invite_token(client, capsys, headers, created["id"], "cousin@example.com")
    headers_cousin = await _signed_in_headers(client, capsys, "cousin@example.com")
    await _accept(client, headers_cousin, token)
    async with db_session_factory() as db:
        await _set_photo_count(db, created["id"], 2)
    cousin = await _intents(client, headers_cousin, created["id"], [_item(MB)])
    assert cousin.status_code == 422
    assert cousin.json()["detail"][0]["msg"] == (
        "this space is full — it holds 2 photos, and you're adding 1"
    )
    async with db_session_factory() as db:
        await db.execute(update(Gathering).where(Gathering.id == created["id"]).values(keeper_account_id=None))
        await db.commit()
    assert (await _intents(client, headers, created["id"], [_item(MB)])).status_code == 422  # keeperless


def test_no_quota_or_ceiling_refusal_names_a_byte_unit():
    # Grep-style, on the shipped source: the gate reads no byte column and
    # spells no byte unit; _human_bytes keeps exactly one caller, the 25 MB
    # per-file cap's message. The runtime half is _names_no_byte_unit on
    # every refusal the tests above provoke.
    gate = inspect.getsource(media_api._enforce_limits)
    for forbidden in ("GB", "MB", "KB", "_human_bytes", "upload_size_bytes", "total_bytes", "PHOTOGRAPH_BYTES"):
        assert forbidden not in gate, forbidden
    source = inspect.getsource(media_api)
    assert source.count("_human_bytes(") == 2  # the def, and the size validator
    assert "PHOTOGRAPH_BYTES" not in source
    for retired in ("FREE_TIER_BYTES", "MEMORIAL_CEILING_BYTES", "gathering_bytes", "_in_flight_bytes_of"):
        assert not hasattr(keeping, retired), retired
        assert retired not in source, retired


async def test_a_memorial_is_bounded_at_five_thousand_photographs_with_in_flight_rows_counting(
    client, capsys, db_session_factory
):
    # The REAL ceiling, in photographs (currency record §8: one unit across
    # every gathering type). 4,998 committed; two in flight reach 5,000;
    # one more is refused — the in-flight rows count toward it.
    assert keeping.MEMORIAL_CEILING_PHOTOGRAPHS == 5_000
    headers = await _signed_in_headers(client, capsys, "fivethousand@example.com")
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    async with db_session_factory() as db:
        await _set_photo_count(db, memorial["id"], keeping.MEMORIAL_CEILING_PHOTOGRAPHS - 2)
    admitted = await _intents(client, headers, memorial["id"], [_item(MAX_UPLOAD_BYTES), _item(40_000)])
    assert admitted.status_code == 201, admitted.text
    async with db_session_factory() as db:
        assert await keeping.gathering_units(db, await db.get(Gathering, memorial["id"])) == 5_000
    refused = await _intents(client, headers, memorial["id"], [_item(1)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert message == "a memorial holds up to 5,000 photos, and this one would go past it"
    _names_no_byte_unit(message)
    assert "bin" not in message
    async with db_session_factory() as db:
        assert await _media_count(db) == 2
        # And the account is charged none of it (memorials are exempt).
        assert await keeping.account_usage(db, await _account_for(db, "fivethousand@example.com")) == 0


# --- confirm: verifies, then flips one rung ---------------------------------


async def test_confirm_verifies_then_flips_to_uploaded_and_nothing_else_moves(
    client, capsys, db_session_factory, monkeypatch
):
    headers = await _signed_in_headers(client, capsys, "confirmer@example.com")
    created = await _create(client, headers)
    intent = (await _intents(client, headers, created["id"], [_item(3 * MB)])).json()["intents"][0]
    media_id = intent["media"]["id"]
    head = _stub_head(monkeypatch, (3 * MB, "image/jpeg"))

    before = _now()
    response = await _confirm(client, headers, media_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "uploaded"
    assert body["publication_state"] == "pending"
    assert body["uploaded_at"] is not None
    # HEAD asked about exactly the key the PUT was signed for.
    assert head.keys == [quarantine_key(media_id)]

    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        assert row.status == MediaStatus.UPLOADED
        assert row.uploaded_at is not None and row.uploaded_at >= before
        assert row.uploaded_at >= row.created_at
        assert row.available_at == row.uploaded_at
        assert row.claimed_at is None and row.attempts == 0 and row.last_error is None
        # Processing is not publishing, and neither is uploading.
        assert row.publication_state == PublicationState.PENDING
        assert (await db.get(Gathering, created["id"])).total_bytes == 0
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 0

    # A second confirm is refused, not absorbed — and changes nothing.
    again = await _confirm(client, headers, media_id)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == media_api.NOT_PENDING
    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        assert row.status == MediaStatus.UPLOADED
        assert row.uploaded_at.isoformat() == body["uploaded_at"]


async def test_confirm_refuses_a_missing_object_and_a_size_mismatch(
    client, capsys, db_session_factory, monkeypatch
):
    headers = await _signed_in_headers(client, capsys, "impatient@example.com")
    created = await _create(client, headers)
    media_id = (await _intents(client, headers, created["id"], [_item(3 * MB)])).json()["intents"][0]["media"]["id"]

    async def unchanged():
        async with db_session_factory() as db:
            row = await db.get(Media, media_id)
            assert row.status == MediaStatus.PENDING_UPLOAD
            assert row.uploaded_at is None and row.available_at is None

    # The client saying "done" is not evidence: nothing landed.
    _stub_head(monkeypatch, None)
    missing = await _confirm(client, headers, media_id)
    assert missing.status_code == 409
    assert missing.json()["detail"]["code"] == media_api.OBJECT_MISSING
    await unchanged()

    # Something landed, but not what was declared.
    _stub_head(monkeypatch, (3 * MB + 1, "image/jpeg"))
    mismatch = await _confirm(client, headers, media_id)
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == media_api.SIZE_MISMATCH
    await unchanged()

    # The store did not answer: a 503 with a code, never a 500 — and nothing
    # moved.
    _stub_head(
        monkeypatch,
        raises=ClientError(
            {"Error": {"Code": "InternalError", "Message": "boom"}, "ResponseMetadata": {"HTTPStatusCode": 500}},
            "HeadObject",
        ),
    )
    outage = await _confirm(client, headers, media_id)
    assert outage.status_code == 503
    assert outage.json()["detail"]["code"] == media_api.STORAGE_UNAVAILABLE
    await unchanged()

    # Then the real thing.
    _stub_head(monkeypatch, (3 * MB, "image/jpeg"))
    assert (await _confirm(client, headers, media_id)).status_code == 200


async def test_confirm_is_the_uploaders_alone(client, capsys, db_session_factory, monkeypatch):
    headers_host, headers_invitee, created = await _host_and_invitee(
        client, capsys, "host@example.com", "invitee@example.com"
    )
    media_id = (await _intents(client, headers_invitee, created["id"], [_item(3 * MB)])).json()["intents"][0]["media"]["id"]
    _stub_head(monkeypatch, (3 * MB, "image/jpeg"))
    # The host may read the gathering and still may not confirm someone
    # else's intent: 404, byte-identical to a missing id.
    refused = await _confirm(client, headers_host, media_id)
    missing = await _confirm(client, headers_host, MISSING_ID)
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()
    async with db_session_factory() as db:
        assert (await db.get(Media, media_id)).status == MediaStatus.PENDING_UPLOAD
    assert (await _confirm(client, headers_invitee, media_id)).status_code == 200


# --- the reap: stale intents go; photographs never do ----------------------


def test_intent_reap_after_is_the_quarantine_ceiling_and_clears_the_presign_ttl():
    # Two mechanisms, one number (record §6.3): the row leaves on the same
    # clock as the object. And CK-24's binding constraint: the grace must
    # clear any window a legitimate slow upload could occupy — the URL
    # itself dies at PRESIGN_TTL.
    assert INTENT_REAP_AFTER == timedelta(hours=24)
    assert INTENT_REAP_AFTER > PRESIGN_TTL * 10


async def test_reap_deletes_stale_pending_intents_and_never_a_ready_photograph(
    client, capsys, db_session_factory
):
    """THE TRAP. purge_stale as written at CK-24 is `delete(model).where(
    column < now - grace)` with no status filter; pointed at Media unchanged
    it would delete READY, PUBLISHED photographs. The `where` criterion is
    what keeps it to pending_upload — and this test is what keeps the
    criterion."""
    headers = await _signed_in_headers(client, capsys, "archivist@example.com")
    created = await _create(client, headers)
    long_ago = _now() - timedelta(days=30)
    stale = _now() - INTENT_REAP_AFTER - timedelta(minutes=1)
    fresh = _now() - timedelta(hours=1)

    def row(status, created_at, uploaded_at=None, publication_state=PublicationState.PENDING):
        return Media(
            gathering_id=created["id"],
            guest_name="fixture",
            upload_content_type="image/jpeg",
            upload_size_bytes=MB,
            status=status,
            publication_state=publication_state,
            created_at=created_at,
            uploaded_at=uploaded_at,
        )

    async with db_session_factory() as db:
        rows = {
            "stale_pending": row(MediaStatus.PENDING_UPLOAD, stale),
            "fresh_pending": row(MediaStatus.PENDING_UPLOAD, fresh),
            "stale_uploaded": row(MediaStatus.UPLOADED, long_ago, long_ago),
            "stale_processing": row(MediaStatus.PROCESSING, long_ago, long_ago),
            "stale_ready_published": row(
                MediaStatus.READY, long_ago, long_ago, PublicationState.LIVE
            ),
            "stale_failed": row(MediaStatus.FAILED, long_ago, long_ago),
        }
        db.add_all(rows.values())
        await db.flush()
        # The published photograph has its layers — they must survive too
        # (they would cascade with the row; that is the failure being pinned).
        db.add(
            MediaDerivative(
                media_id=rows["stale_ready_published"].id,
                layer=MediaLayer.THUMBNAIL,
                storage_key=f"test/{rows['stale_ready_published'].id}/thumb",
                content_type="image/webp",
                size_bytes=30_000,
                storage_class="standard",
            )
        )
        await db.commit()
        ids = {name: str(r.id) for name, r in rows.items()}

    # The reap rides the next intent request.
    response = await _intents(client, headers, created["id"], [_item(MB)])
    assert response.status_code == 201, response.text
    new_id = response.json()["intents"][0]["media"]["id"]

    async with db_session_factory() as db:
        remaining = set(await _media_rows(db))
        assert ids["stale_pending"] not in remaining
        assert remaining == {new_id} | {
            ids[name] for name in rows if name != "stale_pending"
        }
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 1


# --- the presigned URL appears in the response body and nowhere else -------


def _signature_and_url(intent: dict) -> tuple[str, str]:
    url = intent["upload"]["url"]
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["X-Amz-Signature"], url


async def test_presigned_url_appears_only_in_the_response_body(
    client, capsys, caplog, db_session_factory
):
    caplog.set_level(logging.DEBUG)
    headers = await _signed_in_headers(client, capsys, "quiet@example.com")
    created = await _create(client, headers)
    capsys.readouterr()  # drop the sign-in's console-mode email
    response = await _intents(client, headers, created["id"], [_item(MB)])
    assert response.status_code == 201
    signature, url = _signature_and_url(response.json()["intents"][0])
    captured = capsys.readouterr()
    for sink in (caplog.text, captured.out, captured.err):
        assert url not in sink
        assert signature not in sink
        assert settings.r2_upload_access_key_id not in sink


async def test_a_failure_after_presigning_logs_no_url_and_leaves_no_row(
    capsys, caplog, db_session_factory, monkeypatch
):
    """The error path is where a URL would actually get logged. Presign the
    first item, then fail on the second: the request 500s, the batch leaves
    no row (the commit never ran), and the URL that existed appears in no
    log and no stream."""
    caplog.set_level(logging.DEBUG)
    minted: list[str] = []
    real_presign = media_api.presign_upload

    def presign_then_fail(upload, **kwargs):
        if minted:
            raise RuntimeError("presign failed after the first item")
        presigned = real_presign(upload, **kwargs)
        minted.append(presigned.url)
        return presigned

    monkeypatch.setattr(media_api, "presign_upload", presign_then_fail)
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        headers = await _signed_in_headers(client, capsys, "unlucky@example.com")
        created = await _create(client, headers)
        capsys.readouterr()
        response = await _intents(client, headers, created["id"], [_item(MB), _item(MB)])
    assert response.status_code == 500
    assert len(minted) == 1
    captured = capsys.readouterr()
    signature = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(minted[0]).query))["X-Amz-Signature"]
    for sink in (caplog.text, captured.out, captured.err, response.text):
        assert minted[0] not in sink
        assert signature not in sink
    async with db_session_factory() as db:
        assert await _media_count(db) == 0
