"""CK-37 — reading a photograph back: who may see one that nobody has
approved, and the presigned read that follows from the answer.

No network anywhere in this file: botocore presigns locally, so every URL
asserted on is one the serve credential's signing configuration genuinely
produced, and the conftest points the settings at a reserved TLD. The rows
are written directly (the worker's output, without the worker), so every
rung and every publication state can be put in front of every caller.

The load-bearing pins — the first four ARE the phase:
- a `pending` photograph is visible to its uploader;
- visible to the host;
- 404 to a keeper who is neither;
- 404 to an accepted invitee who is neither;
plus:
- a `live` photograph is visible to the whole read audience (nothing is
  live today; the branch is pinned so the publication phase inherits it);
- a `removed` one is visible to its uploader alone, for thirty days, then
  to nobody; a removed row with no removed_at is visible to nobody;
- every rung appears in the list with its state, and only `ready` is ever
  issued a URL (409 `not_ready` otherwise, carrying the rung);
- the archival layer is never issued a URL (422 on the query parameter),
  and the visibility 404 comes BEFORE that refusal;
- the URL is a presigned GET from the PUBLISHED bucket, signed by the serve
  credential, for the derivative row's own key, expiring after PRESIGN_TTL;
- a presigned read with the root logger at DEBUG leaks no signature, URL,
  key or key id into any log record — on the success path and on every
  refusal path;
- the list carries a display name and the date label, never an email or a
  person id; reading moves nothing — `publication_state` stays `pending`.
"""

import logging
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select

from app.config import settings
from app.models import (
    Gathering,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    Person,
    PublicationState,
)
from app.services import keeping
from app.services.storage import PRESIGN_TTL, published_key
from tests.test_gatherings import _account_for, _create, _signed_in_headers
from tests.test_invitations import _accept, _invite_token

HOST = "host@example.com"
UPLOADER = "uploader@example.com"
KEEPER = "keeper@example.com"
BYSTANDER = "bystander@example.com"
STRANGER = "stranger@example.com"
MISSING_ID = "00000000-0000-0000-0000-000000000000"

# What the worker writes per layer (CK-36's shape), so a `ready` row here
# looks exactly like a deployed one.
LAYER_SPECS = {
    MediaLayer.ARCHIVAL: ("image/jpeg", 1_800_000, "STANDARD_IA"),
    MediaLayer.WEB: ("image/webp", 400_000, "STANDARD"),
    MediaLayer.THUMBNAIL: ("image/webp", 20_000, "STANDARD"),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Cast:
    """Every party the audience rule distinguishes, signed in."""

    gathering_id: str
    date_id: str
    host: dict
    uploader: dict  # an accepted invitee who uploads
    keeper: dict  # keeps the gathering; neither host nor uploader
    bystander: dict  # a second accepted invitee; uploads nothing
    stranger: dict
    uploader_person_id: UUID


async def _cast(client, capsys, db_session_factory) -> Cast:
    host = await _signed_in_headers(client, capsys, HOST)
    created = await _create(
        client,
        host,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-09-08T18:00:00+00:00"},
        ],
    )
    gathering_id = created["id"]
    invitee_headers = {}
    for address in (UPLOADER, BYSTANDER):
        token = await _invite_token(client, capsys, host, gathering_id, address)
        headers = await _signed_in_headers(client, capsys, address)
        await _accept(client, headers, token)
        invitee_headers[address] = headers
    # A keeper who is not the host: no keep endpoint exists yet, so the kept
    # row is written through the service — the same path creation uses.
    keeper = await _signed_in_headers(client, capsys, KEEPER)
    async with db_session_factory() as db:
        account = await _account_for(db, KEEPER)
        gathering = await db.get(Gathering, gathering_id)
        assert gathering.host_account_id != account.id
        await keeping.keep(db, account, gathering)
        await db.commit()
        uploader_person_id = (
            await db.execute(select(Person.id).where(Person.email == UPLOADER))
        ).scalar_one()
    stranger = await _signed_in_headers(client, capsys, STRANGER)
    cast = Cast(
        gathering_id=gathering_id,
        date_id=created["occurrences"][0]["id"],
        host=host,
        uploader=invitee_headers[UPLOADER],
        keeper=keeper,
        bystander=invitee_headers[BYSTANDER],
        stranger=stranger,
        uploader_person_id=uploader_person_id,
    )
    # The fixture is honest: the keeper and the bystander ARE in the
    # gathering's read audience (they read the detail), so a 404 below is
    # the rule and never a broken setup; the stranger is not.
    for headers in (cast.keeper, cast.bystander, cast.uploader, cast.host):
        assert (await client.get(f"/gatherings/{gathering_id}", headers=headers)).status_code == 200
    assert (await client.get(f"/gatherings/{gathering_id}", headers=cast.stranger)).status_code == 404
    return cast


async def _photograph(
    db_session_factory,
    cast: Cast,
    *,
    status: MediaStatus = MediaStatus.READY,
    publication_state: PublicationState = PublicationState.PENDING,
    removed_at: datetime | None = None,
    created_at: datetime | None = None,
    occurrence_id: str | None = None,
) -> str:
    """One media row by the uploader — `ready` and `pending` by default, the
    state every deployed row is in — with its three derivative rows when it
    is ready (the worker's output, without the worker)."""
    born = created_at or _now()
    async with db_session_factory() as db:
        row = Media(
            gathering_id=cast.gathering_id,
            occurrence_id=occurrence_id,
            uploader_person_id=cast.uploader_person_id,
            upload_content_type="image/heic",
            upload_size_bytes=1_300_000,
            status=status,
            publication_state=publication_state,
            removed_at=removed_at,
            created_at=born,
            uploaded_at=None if status == MediaStatus.PENDING_UPLOAD else born,
        )
        db.add(row)
        await db.flush()
        if status == MediaStatus.READY:
            for layer, (content_type, size, storage_class) in LAYER_SPECS.items():
                db.add(
                    MediaDerivative(
                        media_id=row.id,
                        layer=layer,
                        storage_key=published_key(row.id, layer),
                        content_type=content_type,
                        size_bytes=size,
                        storage_class=storage_class,
                    )
                )
        await db.commit()
        return str(row.id)


async def _list(client, headers, gathering_id: str):
    return await client.get(f"/gatherings/{gathering_id}/media", headers=headers)


async def _url(client, headers, media_id: str, layer: str = "web"):
    return await client.get(f"/media/{media_id}/url", params={"layer": layer}, headers=headers)


def _ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [m["id"] for m in response.json()["media"]]


def _query(url: str) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


# --- auth ----------------------------------------------------------------------


async def test_media_reads_require_auth(client):
    assert (await client.get(f"/gatherings/{MISSING_ID}/media")).status_code == 401
    assert (await client.get(f"/media/{MISSING_ID}/url", params={"layer": "web"})).status_code == 401


# --- the audience: the phase ------------------------------------------------------


async def test_a_pending_photograph_is_visible_to_its_uploader_and_the_host_and_nobody_else(
    client, capsys, db_session_factory
):
    """THE RULE (decisions/2026-09-09-who-may-see-an-unapproved-photograph.md):
    the machine finished, the person did not approve, so the uploader and
    the host see it and nobody else does — a keeper is not an approver and
    an invitation is visibility of the gathering, never of unreviewed
    media. This is the state every deployed row is in."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)

    # The uploader and the host: the row in the list, and a URL for it.
    for headers in (cast.uploader, cast.host):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]
        assert (await _url(client, headers, media_id)).status_code == 200

    # A keeper who is neither, and an accepted invitee who is neither: the
    # gathering is theirs to read (200 — an empty list), the photograph is
    # not — and the per-object 404 is byte-identical to a missing id, for
    # every layer, so nothing confirms the row exists.
    missing = await _url(client, cast.keeper, MISSING_ID)
    assert missing.status_code == 404
    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        for layer in ("web", "thumbnail", "archival"):
            refused = await _url(client, headers, media_id, layer)
            assert refused.status_code == 404, layer
            assert refused.json() == missing.json()

    # A stranger: the gathering 404 on the list, the media 404 on the URL,
    # each byte-identical to a missing id.
    listed = await _list(client, cast.stranger, cast.gathering_id)
    assert listed.status_code == 404
    assert listed.json() == (await _list(client, cast.stranger, MISSING_ID)).json()
    assert (await _url(client, cast.stranger, media_id)).json() == missing.json()

    # Reading moved nothing: still pending, still ready.
    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        assert row.publication_state == PublicationState.PENDING
        assert row.status == MediaStatus.READY


async def test_a_live_photograph_is_visible_to_the_whole_read_audience(
    client, capsys, db_session_factory
):
    """Nothing is `live` today; the branch is correct anyway so the
    publication phase never has to come back and widen an audience."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]
        assert (await _url(client, headers, media_id)).status_code == 200
    assert (await _list(client, cast.stranger, cast.gathering_id)).status_code == 404
    assert (await _url(client, cast.stranger, media_id)).status_code == 404


async def test_a_removed_photograph_is_visible_to_its_uploader_alone_for_thirty_days(
    client, capsys, db_session_factory
):
    """The contributor-visible bin (keeper record §2.8): the uploader for
    thirty days after removed_at, nobody else — the host included — ever.
    A removed row with no removed_at is malformed and visible to nobody."""
    cast = await _cast(client, capsys, db_session_factory)
    removed = PublicationState.REMOVED
    in_bin = await _photograph(
        db_session_factory, cast, publication_state=removed, removed_at=_now() - timedelta(days=29)
    )
    past_bin = await _photograph(
        db_session_factory, cast, publication_state=removed, removed_at=_now() - timedelta(days=31)
    )
    malformed = await _photograph(db_session_factory, cast, publication_state=removed)

    listed = await _list(client, cast.uploader, cast.gathering_id)
    assert _ids(listed) == [in_bin]
    assert listed.json()["media"][0]["removed_at"] is not None  # the bin's clock
    assert (await _url(client, cast.uploader, in_bin)).status_code == 200
    for gone in (past_bin, malformed):
        assert (await _url(client, cast.uploader, gone)).status_code == 404

    for headers in (cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        for media_id in (in_bin, past_bin, malformed):
            assert (await _url(client, headers, media_id)).status_code == 404


# --- the rungs and the layers ----------------------------------------------------


async def test_every_rung_appears_in_the_list_with_its_state_and_only_ready_has_a_url(
    client, capsys, db_session_factory
):
    """Pending is a real state, not a spinner (pipeline record §2), and the
    list is where it becomes visible: every rung is listed with its status
    and no link; a URL is minted for `ready` alone, and every other rung
    draws a 409 carrying a stable code and the rung."""
    cast = await _cast(client, capsys, db_session_factory)
    t0 = _now()
    ids = {}
    for i, status in enumerate(MediaStatus):
        ids[status] = await _photograph(
            db_session_factory, cast, status=status, created_at=t0 + timedelta(seconds=i)
        )

    listed = await _list(client, cast.uploader, cast.gathering_id)
    rows = listed.json()["media"]
    # Newest first, every rung present with its state, no URL in any row.
    assert [r["status"] for r in rows] == [s.value for s in reversed(list(MediaStatus))]
    assert all("url" not in r and "last_error" not in r for r in rows)
    assert "X-Amz" not in listed.text

    for status, media_id in ids.items():
        response = await _url(client, cast.uploader, media_id)
        if status is MediaStatus.READY:
            assert response.status_code == 200, response.text
        else:
            assert response.status_code == 409, status
            detail = response.json()["detail"]
            assert detail["code"] == "not_ready"
            assert detail["status"] == status.value
            assert "url" not in detail
    # The host sees the same rungs — pending rows are the host's to see too.
    assert len(_ids(await _list(client, cast.host, cast.gathering_id))) == len(MediaStatus)


async def test_the_archival_layer_is_never_issued_a_url(client, capsys, db_session_factory):
    """The archival layer is the print master on Infrequent Access — billed
    per retrieval, reached only by the book pipeline and the export. Refused
    on the query parameter; and visibility is decided BEFORE the layer, so
    asking for the wrong layer never confirms a row exists."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)

    refused = await _url(client, cast.uploader, media_id, "archival")
    assert refused.status_code == 422
    assert [e["loc"] for e in refused.json()["detail"]] == [["query", "layer"]]
    assert "archival" in refused.json()["detail"][0]["msg"]
    # Not a layer at all, and no layer: the same field.
    assert (await _url(client, cast.uploader, media_id, "original")).status_code == 422
    no_layer = await client.get(f"/media/{media_id}/url", headers=cast.uploader)
    assert no_layer.status_code == 422
    assert [e["loc"] for e in no_layer.json()["detail"]] == [["query", "layer"]]

    # Existence first: a caller who may not see the row learns nothing from
    # asking for the wrong layer — the 404 identical to a missing id.
    assert (await _url(client, cast.keeper, media_id, "archival")).json() == (
        await _url(client, cast.keeper, MISSING_ID, "archival")
    ).json()
    # And the layer refusal precedes the rung refusal: archival on an
    # unprocessed row is still the 422, never a hint about state.
    waiting = await _photograph(db_session_factory, cast, status=MediaStatus.UPLOADED)
    assert (await _url(client, cast.uploader, waiting, "archival")).status_code == 422

    # The two servable layers both work, on different objects.
    web = (await _url(client, cast.uploader, media_id, "web")).json()
    thumbnail = (await _url(client, cast.uploader, media_id, "thumbnail")).json()
    assert web["layer"] == "web" and thumbnail["layer"] == "thumbnail"
    assert web["url"] != thumbnail["url"]


async def test_the_url_is_a_presigned_get_from_published_signed_by_the_serve_credential(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    for layer in (MediaLayer.WEB, MediaLayer.THUMBNAIL):
        body = (await _url(client, cast.host, media_id, layer.value)).json()
        content_type, size, _ = LAYER_SPECS[layer]
        assert body["media_id"] == media_id and body["layer"] == layer.value
        assert body["content_type"] == content_type and body["size_bytes"] == size
        assert body["method"] == "GET"
        assert body["expires_in"] == int(PRESIGN_TTL.total_seconds())
        parts = urllib.parse.urlsplit(body["url"])
        query = _query(body["url"])
        # From PUBLISHED, for the derivative row's own key, signed by the
        # SERVE credential — never quarantine, never the upload credential.
        assert parts.path == f"/{settings.r2_bucket_published}/{published_key(UUID(media_id), layer)}"
        assert query["X-Amz-Credential"].startswith(settings.r2_serve_access_key_id + "/")
        assert query["X-Amz-Expires"] == str(int(PRESIGN_TTL.total_seconds()))
        assert "X-Amz-Signature" in query
        assert settings.r2_bucket_quarantine not in body["url"]
        assert settings.r2_upload_access_key_id not in body["url"]


async def test_a_presigned_read_leaks_nothing_to_the_log_even_at_debug(
    client, capsys, db_session_factory, caplog
):
    """Record §9 bites hardest here — the first endpoint that mints URLs at
    volume. With the ROOT logger at DEBUG (someone chasing a deploy), the
    success path and every refusal path together put no URL, no signature,
    no key and no key id into any log record."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    waiting = await _photograph(db_session_factory, cast, status=MediaStatus.PROCESSING)
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        urls = [
            (await _url(client, cast.uploader, media_id, layer)).json()["url"]
            for layer in ("web", "thumbnail")
        ]
        assert (await _url(client, cast.keeper, media_id)).status_code == 404
        assert (await _url(client, cast.uploader, waiting)).status_code == 409
        assert (await _url(client, cast.uploader, media_id, "archival")).status_code == 422
        assert (await _list(client, cast.host, cast.gathering_id)).status_code == 200
    text = caplog.text
    assert len(urls) == 2
    for url in urls:
        assert url not in text
        assert _query(url)["X-Amz-Signature"] not in text
    assert settings.r2_serve_access_key_id not in text
    assert settings.r2_upload_access_key_id not in text
    assert "Signature:" not in text
    assert "X-Amz" not in text
    for layer in MediaLayer:
        assert published_key(UUID(media_id), layer) not in text


# --- the list body ------------------------------------------------------------


async def test_the_list_carries_who_uploaded_it_and_the_date_label_and_never_an_email(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast, occurrence_id=cast.date_id)
    for headers, own in ((cast.uploader, True), (cast.host, False)):
        response = await _list(client, headers, cast.gathering_id)
        (row,) = response.json()["media"]
        assert row["id"] == media_id
        assert row["gathering_id"] == cast.gathering_id
        assert row["occurrence_id"] == cast.date_id
        # A display name (the sign-in default is the address's local part),
        # never the address, never a person id.
        assert row["uploader_display_name"] == UPLOADER.split("@", 1)[0]
        assert row["is_own"] is own
        assert row["status"] == "ready" and row["publication_state"] == "pending"
        assert row["uploaded_at"] is not None and row["removed_at"] is None
        assert "@" not in response.text
        assert str(cast.uploader_person_id) not in response.text
