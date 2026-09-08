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
- the quota is a RESERVATION on the HOST's account — a batch that would
  exceed it is refused, the reservation survives confirm, releases at
  `failed`, and is released by the reap; other keepers may be over their
  own quota; a refusal never states the host's usage; a hostless gathering
  refuses;
- a memorial is exempt from the account quota and refused above its own
  ceiling, with in-flight bytes counting toward it;
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

import logging
import urllib.parse
from datetime import datetime, timedelta, timezone

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
    KeptGathering,
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

    # The invitee keeps nothing — no kept row — and uploads regardless:
    # contribution is never gated on keeping (terminology record §5).
    async with db_session_factory() as db:
        invitee_account = await _account_for(db, "cousin@example.com")
        kept = await db.scalar(
            select(func.count())
            .select_from(KeptGathering)
            .where(KeptGathering.account_id == invitee_account.id)
        )
        assert kept == 0
    assert (await _intents(client, headers_invitee, created["id"], [_item()])).status_code == 201
    assert (await _intents(client, headers_host, created["id"], [_item()])).status_code == 201

    # A stranger's 404 is byte-identical to a missing gathering's.
    refused = await _intents(client, headers_stranger, created["id"], [_item()])
    missing = await _intents(client, headers_stranger, MISSING_ID, [_item()])
    assert refused.status_code == missing.status_code == 404
    assert refused.json() == missing.json()
    async with db_session_factory() as db:
        assert await _media_count(db) == 2


# --- the quota: a reservation on the host's account -------------------------


async def test_reservation_blocks_a_batch_that_would_exceed_the_hosts_quota(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_BYTES", 50 * MB)
    headers = await _signed_in_headers(client, capsys, "full@example.com")
    created = await _create(client, headers)

    # Exactly the quota, reserved by two pending intents.
    first = await _intents(client, headers, created["id"], [_item(25 * MB), _item(25 * MB)])
    assert first.status_code == 201, first.text
    ids = [i["media"]["id"] for i in first.json()["intents"]]

    # One more byte would exceed it: refused on the batch, no row, and the
    # message names the limit and the batch — never the usage.
    refused = await _intents(client, headers, created["id"], [_item(1)])
    assert refused.status_code == 422
    assert _locs(refused) == [["body", "items"]]
    message = refused.json()["detail"][0]["msg"]
    assert "50 MB" in message
    async with db_session_factory() as db:
        assert await _media_count(db) == 2
        account = await _account_for(db, "full@example.com")
        # The reservation IS the usage: nothing is committed yet.
        assert await keeping.account_usage(db, account) == 50 * MB
        assert (await db.get(Gathering, created["id"])).total_bytes == 0

    # Confirming does not release the reservation — the bytes now sit in
    # quarantine, still against the host's quota until published.
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
    monkeypatch.setattr(keeping, "FREE_TIER_BYTES", 50 * MB)
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


async def test_other_keepers_may_be_over_their_own_quota(
    client, capsys, db_session_factory, monkeypatch
):
    # The cousin hosts their own, over-full gathering; the grandmother's
    # gathering is fine. The cousin uploads to the grandmother's gathering
    # regardless — the check is the HOST's quota, never the uploader's.
    monkeypatch.setattr(keeping, "FREE_TIER_BYTES", 50 * MB)
    headers_host, headers_cousin, created = await _host_and_invitee(
        client, capsys, "grandmother@example.com", "cousin@example.com"
    )
    own = await _create(client, headers_cousin, title="The cousin's own")
    async with db_session_factory() as db:
        await _set_total_bytes(db, own["id"], 60 * MB)
        cousin = await _account_for(db, "cousin@example.com")
        assert await keeping.account_usage(db, cousin) > await keeping.account_quota(db, cousin)
    assert (await _intents(client, headers_cousin, created["id"], [_item(MB)])).status_code == 201
    # Control: the same cousin on their own gathering is refused.
    assert (await _intents(client, headers_cousin, own["id"], [_item(1)])).status_code == 422


async def test_a_quota_refusal_never_discloses_the_hosts_usage(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_BYTES", 50 * MB)
    _, headers_invitee, created = await _host_and_invitee(
        client, capsys, "host@example.com", "invitee@example.com"
    )
    async with db_session_factory() as db:
        await _set_total_bytes(db, created["id"], 43 * MB)
    refused = await _intents(client, headers_invitee, created["id"], [_item(8 * MB)])
    assert refused.status_code == 422
    message = refused.json()["detail"][0]["msg"]
    # The limit and the batch are stated; the host's 43 MB is not.
    assert "50 MB" in message
    assert "8" in message and "MB" in message
    assert "43" not in message
    assert "7" not in message  # nor the headroom, which is usage in disguise


async def test_a_hostless_gathering_refuses_uploads(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "keeper@example.com")
    created = await _create(client, headers)
    async with db_session_factory() as db:
        await db.execute(
            update(Gathering).where(Gathering.id == created["id"]).values(host_account_id=None)
        )
        await db.commit()
    # The caller still keeps it (the read audience admits them); there is
    # simply nobody's quota to charge.
    response = await _intents(client, headers, created["id"], [_item()])
    assert response.status_code == 422
    assert _locs(response) == [["path", "gathering_id"]]
    async with db_session_factory() as db:
        assert await _media_count(db) == 0


# --- the memorial: exempt from the account quota, bounded by its own ceiling -


async def test_memorial_is_exempt_from_the_account_quota_and_refused_above_its_ceiling(
    client, capsys, db_session_factory, monkeypatch
):
    monkeypatch.setattr(keeping, "FREE_TIER_BYTES", 50 * MB)
    monkeypatch.setattr(keeping, "MEMORIAL_CEILING_BYTES", 30 * MB)
    headers = await _signed_in_headers(client, capsys, "mourner@example.com")
    potluck = await _create(client, headers)
    memorial = await _create(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    # The host is over their account quota through the potluck...
    async with db_session_factory() as db:
        await _set_total_bytes(db, potluck["id"], 60 * MB)
    # ...and the memorial accepts an upload regardless (the exemption).
    first = await _intents(client, headers, memorial["id"], [_item(25 * MB)])
    assert first.status_code == 201, first.text
    # Control: the same host on the potluck is refused.
    assert (await _intents(client, headers, potluck["id"], [_item(1)])).status_code == 422

    # The ceiling: 25 MB in flight + 25 MB more > 30 MB. The in-flight
    # bytes count — the ceiling is a reservation too.
    second = await _intents(client, headers, memorial["id"], [_item(25 * MB)])
    assert second.status_code == 422
    assert _locs(second) == [["body", "items"]]
    message = second.json()["detail"][0]["msg"]
    assert "memorial" in message and "30 MB" in message
    # Exactly up to the ceiling is fine.
    assert (await _intents(client, headers, memorial["id"], [_item(5 * MB)])).status_code == 201
    async with db_session_factory() as db:
        assert await _media_count(db) == 2
        assert await keeping.gathering_bytes(db, await db.get(Gathering, memorial["id"])) == 30 * MB
        # And none of it counts against the account (memorials are exempt).
        account = await _account_for(db, "mourner@example.com")
        assert await keeping.account_usage(db, account) == 60 * MB


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
