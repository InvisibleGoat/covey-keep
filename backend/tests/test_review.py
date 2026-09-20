"""CK-43 — the host's review: what a host does with a photograph nobody has
published (decisions/2026-09-13-the-hosts-review.md).

The rows are written directly in the CK-37 style (the worker's output,
without the worker), so every state can be put in front of every caller;
no network anywhere. The cast is test_media_reads' — host, uploader (an
accepted invitee), keeper, bystander (a second accepted invitee), stranger
— because the review acts inside CK-37's audience rule and must not widen
it.

The load-bearing pins:
- the host publishes and the row goes `live` with BOTH stamps — and no
  byte moves (total_bytes and account_usage exactly where `ready` left
  them);
- a keeper, an accepted invitee, the uploader on their own photograph,
  and a stranger each draw the media 404 — byte-identical to a missing id
  — on both acts, and nothing moves;
- a `failed` row and an in-flight row refuse with `not_ready`;
- a `removed` row is never resurrected by approval (404 for a host who
  cannot see it; 409 `not_pending` for a host who uploaded it);
- an already-`live` row refuses with `already_live` and is NOT re-stamped;
- the batch refuses whole on any bad item and leaves nothing changed;
- the queue is the host's alone and runs inside `_visible_media` (a
  `removed` row is in nobody's queue; `q` composes);
- a decline lands `removed` with `removed_at`, `published_at` stays NULL,
  the uploader keeps the 30-day bin (CK-37, unchanged), and a `live` row
  is refused;
- the acts log nothing with the root logger at DEBUG.
"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select

from app.api.media import ALREADY_LIVE, MAX_PUBLISH_PER_REQUEST, NOT_PENDING, NOT_READY
from app.models import Gathering, Media, MediaDerivative, MediaStatus, Person, PublicationState
from app.services import keeping
from app.services.storage import published_key
from tests.test_gatherings import _account_for, _create, _signed_in_headers
from tests.test_media_reads import (
    HOST,
    LAYER_SPECS,
    MISSING_ID,
    Cast,
    _cast,
    _ids,
    _list,
    _photograph,
    _url,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _host_person_id(db_session_factory) -> UUID:
    async with db_session_factory() as db:
        return (await db.execute(select(Person.id).where(Person.email == HOST))).scalar_one()


async def _hosts_own_photograph(
    db_session_factory,
    cast: Cast,
    *,
    publication_state: PublicationState = PublicationState.PENDING,
    removed_at: datetime | None = None,
) -> str:
    """A `ready` row the HOST uploaded — the one configuration in which a
    host can see a `removed` row (the bin is the uploader's)."""
    async with db_session_factory() as db:
        row = Media(
            gathering_id=cast.gathering_id,
            uploader_person_id=await _host_person_id(db_session_factory),
            upload_content_type="image/jpeg",
            upload_size_bytes=900_000,
            status=MediaStatus.READY,
            publication_state=publication_state,
            removed_at=removed_at,
            created_at=_now(),
            uploaded_at=_now(),
        )
        db.add(row)
        await db.flush()
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


async def _state(db_session_factory, media_id: str) -> tuple:
    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        return (
            row.status,
            row.publication_state,
            row.published_at,
            row.published_by_person_id,
            row.removed_at,
        )


async def _publish(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/publish", headers=headers)


async def _decline(client, headers, media_id: str):
    return await client.post(f"/media/{media_id}/decline", headers=headers)


async def _batch(client, headers, gathering_id: str, media_ids: list[str]):
    return await client.post(
        f"/gatherings/{gathering_id}/media/publish",
        json={"media_ids": media_ids},
        headers=headers,
    )


async def _queue(client, headers, gathering_id: str, **params):
    return await client.get(
        f"/gatherings/{gathering_id}/media",
        params={"awaiting_review": "true", **params},
        headers=headers,
    )


async def _bytes(db_session_factory, cast: Cast) -> tuple[int, int, int]:
    """(total_bytes of the gathering, its photo_count, account_usage of its
    host) - the three numbers the review must never move. photo_count
    joined at CK-51a: a decline is `removed`, and removal decrements
    neither column (the bin holds the layers; the sweep is unbuilt)."""
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, cast.gathering_id)
        host = await _account_for(db, HOST)
        return (
            gathering.total_bytes,
            gathering.photo_count,
            await keeping.account_usage(db, host),
        )


# --- auth ----------------------------------------------------------------------


async def test_review_requires_auth(client):
    assert (await client.post(f"/media/{MISSING_ID}/publish")).status_code == 401
    assert (await client.post(f"/media/{MISSING_ID}/decline")).status_code == 401
    assert (
        await client.post(f"/gatherings/{MISSING_ID}/media/publish", json={"media_ids": [MISSING_ID]})
    ).status_code == 401
    assert (
        await client.get(f"/gatherings/{MISSING_ID}/media", params={"awaiting_review": "true"})
    ).status_code == 401


# --- publish: the phase --------------------------------------------------------


async def test_the_host_publishes_and_the_row_goes_live_with_both_stamps(
    client, capsys, db_session_factory
):
    """THE ACT (record §1, §7): the host publishes a `ready` + `pending`
    photograph; it is `live`, `published_at` is set, and
    `published_by_person_id` is the host — the first non-NULL publisher.
    The read audience now sees it (CK-37's `live` branch, unchanged). And
    no byte moves: `total_bytes` and the host's `account_usage` are exactly
    where `ready` left them (record §6)."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    # The worker's output, without the worker: the derivative rows exist,
    # so total_bytes (and photo_count, since CK-51a) would already have
    # moved — give the gathering real numbers to hold still.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, cast.gathering_id)
        gathering.total_bytes = sum(size for _, size, _ in LAYER_SPECS.values())
        gathering.photo_count = 1
        await db.commit()
    before = await _bytes(db_session_factory, cast)
    # Before: the read audience cannot see it (the rule this phase acts
    # inside), and the body carries no stamp.
    assert _ids(await _list(client, cast.keeper, cast.gathering_id)) == []
    assert (await _list(client, cast.host, cast.gathering_id)).json()["media"][0]["published_at"] is None

    response = await _publish(client, cast.host, media_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == media_id
    assert body["publication_state"] == "live" and body["status"] == "ready"
    assert body["published_at"] is not None
    assert "published_by_person_id" not in body  # never a person id in a body
    assert "@" not in response.text

    status, state, published_at, publisher, removed_at = await _state(db_session_factory, media_id)
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert published_at is not None and removed_at is None
    assert publisher == await _host_person_id(db_session_factory)
    assert datetime.fromisoformat(body["published_at"]) == published_at

    # The whole read audience sees it now — the CK-37 `live` branch, unchanged.
    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [media_id]
        assert (await _url(client, headers, media_id)).status_code == 200
    assert (await _list(client, cast.stranger, cast.gathering_id)).status_code == 404

    # Publication is not a byte.
    assert await _bytes(db_session_factory, cast) == before
    assert before[0] > 0


async def test_only_the_host_may_publish_or_decline(client, capsys, db_session_factory):
    """Reserved to the host and never delegable (the-book-model §10,
    co-hosts §4): a keeper, an accepted invitee who uploaded nothing, THE
    UPLOADER ON THEIR OWN PHOTOGRAPH, and a stranger each draw the media
    404 byte-identical to a missing id — on publish and on decline — and
    nothing moves."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    missing_publish = await _publish(client, cast.host, MISSING_ID)
    missing_decline = await _decline(client, cast.host, MISSING_ID)
    assert missing_publish.status_code == missing_decline.status_code == 404

    # The uploader can SEE the row (CK-37) and still may not decide on it.
    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [media_id]
    for headers in (cast.uploader, cast.keeper, cast.bystander, cast.stranger):
        refused = await _publish(client, headers, media_id)
        assert refused.status_code == 404
        assert refused.json() == missing_publish.json()
        refused = await _decline(client, headers, media_id)
        assert refused.status_code == 404
        assert refused.json() == missing_decline.json()
    status, state, published_at, publisher, removed_at = await _state(db_session_factory, media_id)
    assert (status, state, published_at, publisher, removed_at) == (
        MediaStatus.READY,
        PublicationState.PENDING,
        None,
        None,
        None,
    )

    # A hostless gathering has no acts: unkeeping relinquishes the host,
    # and the one party who could have decided is gone.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, cast.gathering_id)
        gathering.host_account_id = None
        await db.commit()
    assert (await _publish(client, cast.host, media_id)).status_code == 404
    assert (await _decline(client, cast.host, media_id)).status_code == 404


async def test_a_failed_row_and_an_unprocessed_row_refuse_with_not_ready(
    client, capsys, db_session_factory
):
    """A `failed` row has nothing to publish (no layers exist and none ever
    will); an in-flight row has nothing to look at (no URL exists for it,
    CK-37). Both refuse with `not_ready` carrying the rung, on both acts,
    and neither moves — a decline is a decision about a photograph the
    host has looked at."""
    cast = await _cast(client, capsys, db_session_factory)
    for status in (MediaStatus.FAILED, MediaStatus.UPLOADED, MediaStatus.PROCESSING, MediaStatus.PENDING_UPLOAD):
        media_id = await _photograph(db_session_factory, cast, status=status)
        for act in (_publish, _decline):
            refused = await act(client, cast.host, media_id)
            assert refused.status_code == 409, (status, refused.text)
            detail = refused.json()["detail"]
            assert detail["code"] == NOT_READY
            assert detail["status"] == status.value
            assert detail["publication_state"] == "pending"
        assert (await _state(db_session_factory, media_id))[:4] == (
            status,
            PublicationState.PENDING,
            None,
            None,
        )


async def test_a_removed_row_is_never_resurrected_by_approval(client, capsys, db_session_factory):
    """A takedown is not undone by a queue action — the worker's `CASE`
    (live only over pending) and the host's guard agree. Two shapes: a
    removed row the host did not upload is INVISIBLE to the host (the bin
    is the uploader's, CK-37) — 404, byte-identical to a missing id; a
    removed row the host uploaded is visible to them and refuses with
    `not_pending` carrying `removed`. Neither moves, and neither is
    stamped."""
    cast = await _cast(client, capsys, db_session_factory)
    theirs = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=1),
    )
    missing = await _publish(client, cast.host, MISSING_ID)
    refused = await _publish(client, cast.host, theirs)
    assert refused.status_code == 404 and refused.json() == missing.json()
    assert (await _decline(client, cast.host, theirs)).json() == missing.json()

    own = await _hosts_own_photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=1),
    )
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == [own]  # visible, as its uploader
    for act in (_publish, _decline):
        refused = await act(client, cast.host, own)
        assert refused.status_code == 409, refused.text
        detail = refused.json()["detail"]
        assert detail["code"] == NOT_PENDING
        assert detail["publication_state"] == "removed"
    for media_id in (theirs, own):
        status, state, published_at, publisher, removed_at = await _state(db_session_factory, media_id)
        assert (state, published_at, publisher) == (PublicationState.REMOVED, None, None)
        assert removed_at is not None


async def test_an_already_live_row_refuses_and_is_not_restamped(client, capsys, db_session_factory):
    """A second publish is `already_live`, changes nothing, and does NOT
    re-write the stamp — the guarded update writes only over `pending`. A
    row 0019 or the worker published (stamp NULL) is refused the same way
    and is NOT retroactively stamped: nothing is backfilled, not even by a
    host's hand."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    assert (await _publish(client, cast.host, media_id)).status_code == 200
    first = await _state(db_session_factory, media_id)

    refused = await _publish(client, cast.host, media_id)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == ALREADY_LIVE
    assert refused.json()["detail"]["publication_state"] == "live"
    assert await _state(db_session_factory, media_id) == first

    pre_0020 = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    refused = await _publish(client, cast.host, pre_0020)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == ALREADY_LIVE
    assert (await _state(db_session_factory, pre_0020))[2:4] == (None, None)


# --- the batch ------------------------------------------------------------------


async def test_the_batch_refuses_whole_and_leaves_nothing_changed(client, capsys, db_session_factory):
    """One-tap bulk approve (record §5): refused WHOLE on any bad item —
    every refusal an item-level 422 on the entry, carrying the code the
    single act would have drawn — and nothing changes. A missing id,
    another gathering's id, and a row the caller may not see read
    identically; a duplicate is refused on the entry that repeats; the
    list is bounded. Then the good batch: every row `live`, every stamp
    the same instant, the same publisher."""
    cast = await _cast(client, capsys, db_session_factory)
    t0 = _now()
    good = [
        await _photograph(db_session_factory, cast, created_at=t0 + timedelta(seconds=i)) for i in range(3)
    ]
    failed = await _photograph(db_session_factory, cast, status=MediaStatus.FAILED)
    theirs_removed = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.REMOVED, removed_at=t0
    )
    # Another gathering the same host hosts — its row is not THIS batch's.
    other = await _create(client, cast.host, title="Another gathering")
    other_cast = Cast(**{**cast.__dict__, "gathering_id": other["id"]})
    elsewhere = await _photograph(db_session_factory, other_cast)

    def item(response, index, code):
        assert response.status_code == 422, response.text
        (error,) = response.json()["detail"]
        assert error["loc"] == ["body", "media_ids", index]
        assert error["code"] == code
        return error["msg"]

    item(await _batch(client, cast.host, cast.gathering_id, good + [failed]), 3, NOT_READY)
    missing_msg = item(await _batch(client, cast.host, cast.gathering_id, [good[0], MISSING_ID]), 1, "not_found")
    assert item(await _batch(client, cast.host, cast.gathering_id, [elsewhere, good[0]]), 0, "not_found") == missing_msg
    assert item(await _batch(client, cast.host, cast.gathering_id, [good[1], theirs_removed]), 1, "not_found") == missing_msg
    item(await _batch(client, cast.host, cast.gathering_id, [good[0], good[1], good[0]]), 2, NOT_PENDING)
    assert (await _batch(client, cast.host, cast.gathering_id, [])).status_code == 422
    assert (
        await _batch(client, cast.host, cast.gathering_id, [MISSING_ID] * (MAX_PUBLISH_PER_REQUEST + 1))
    ).status_code == 422
    # Not the host: the media 404 on the batch, for a keeper, the uploader,
    # and a stranger (a stranger draws the gathering 404 — the same
    # discipline one door earlier).
    for headers in (cast.keeper, cast.uploader, cast.bystander, cast.stranger):
        assert (await _batch(client, headers, cast.gathering_id, good)).status_code == 404
    # Nothing changed, anywhere.
    for media_id in good + [elsewhere]:
        assert (await _state(db_session_factory, media_id))[1:4] == (PublicationState.PENDING, None, None)
    assert (await _state(db_session_factory, failed))[:2] == (MediaStatus.FAILED, PublicationState.PENDING)
    assert (await _state(db_session_factory, theirs_removed))[1] == PublicationState.REMOVED

    # The good batch.
    response = await _batch(client, cast.host, cast.gathering_id, good)
    assert response.status_code == 200, response.text
    bodies = response.json()["media"]
    assert [b["id"] for b in bodies] == good
    assert {b["publication_state"] for b in bodies} == {"live"}
    assert len({b["published_at"] for b in bodies}) == 1  # one instant for the batch
    host_person = await _host_person_id(db_session_factory)
    stamps = {(await _state(db_session_factory, m))[2:4] for m in good}
    assert len(stamps) == 1 and next(iter(stamps))[1] == host_person
    assert (await _state(db_session_factory, elsewhere))[1] == PublicationState.PENDING
    # The keeper sees exactly the published three.
    assert set(_ids(await _list(client, cast.keeper, cast.gathering_id))) == set(good)
    # And a second batch of the same ids refuses whole: already live.
    item(await _batch(client, cast.host, cast.gathering_id, good), 0, ALREADY_LIVE)


# --- the queue ------------------------------------------------------------------


async def test_the_queue_is_the_hosts_alone_and_runs_inside_the_audience_rule(
    client, capsys, db_session_factory
):
    """`awaiting_review=true` lists the `ready` + `pending` rows and nothing
    else — not `failed`, not in-flight, not `live` — and it is a filter on
    `_visible_media`, never beside it: a `removed` row (the uploader's
    alone) is in nobody's queue, the host's included — THE LEAK PIN, the
    CK-39 shape. `q` composes. HOST-ONLY: the uploader, whose own pending
    row is in their ordinary list, draws the media 404 on the queue, as do
    a keeper and a second invitee; a stranger draws the gathering 404."""
    cast = await _cast(client, capsys, db_session_factory)
    t0 = _now()
    waiting = [
        await _photograph(db_session_factory, cast, created_at=t0 + timedelta(seconds=i)) for i in range(2)
    ]
    await _photograph(db_session_factory, cast, status=MediaStatus.FAILED)
    await _photograph(db_session_factory, cast, status=MediaStatus.UPLOADED)
    await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _photograph(
        db_session_factory, cast, publication_state=PublicationState.REMOVED, removed_at=t0
    )
    async with db_session_factory() as db:
        (await db.get(Media, waiting[0])).caption = "Grandma at the yard"
        await db.commit()

    queue = await _queue(client, cast.host, cast.gathering_id)
    assert set(_ids(queue)) == set(waiting)
    assert {r["status"] for r in queue.json()["media"]} == {"ready"}
    assert {r["publication_state"] for r in queue.json()["media"]} == {"pending"}
    # Composes with q — inside the same criterion.
    assert _ids(await _queue(client, cast.host, cast.gathering_id, q="yard")) == [waiting[0]]
    assert _ids(await _queue(client, cast.host, cast.gathering_id, q="nothing matches")) == []
    # The ordinary list is unchanged by the flag's existence.
    assert len(_ids(await _list(client, cast.host, cast.gathering_id))) == 5
    # Absent or false: not the queue.
    assert len(_ids(await client.get(
        f"/gatherings/{cast.gathering_id}/media", params={"awaiting_review": "false"}, headers=cast.host
    ))) == 5

    missing = await client.get(f"/media/{MISSING_ID}/url", params={"layer": "web"}, headers=cast.host)
    for headers in (cast.uploader, cast.keeper, cast.bystander):
        refused = await _queue(client, headers, cast.gathering_id)
        assert refused.status_code == 404
        assert refused.json() == missing.json()  # the media 404, not the gathering's
    # The uploader's own pending rows are in THEIR list — the queue is
    # not new visibility, it is the host's visibility given an action.
    assert set(_ids(await _list(client, cast.uploader, cast.gathering_id))) >= set(waiting)
    stranger = await _queue(client, cast.stranger, cast.gathering_id)
    assert stranger.status_code == 404
    assert stranger.json() == (await _list(client, cast.stranger, MISSING_ID)).json()

    # After the host acts, the queue empties.
    assert (await _publish(client, cast.host, waiting[0])).status_code == 200
    assert (await _decline(client, cast.host, waiting[1])).status_code == 200
    assert _ids(await _queue(client, cast.host, cast.gathering_id)) == []


# --- decline --------------------------------------------------------------------


async def test_a_decline_lands_removed_and_the_uploader_keeps_the_bin(
    client, capsys, db_session_factory
):
    """The queue's bottom (record §4): decline IS `removed`, with
    `removed_at` stamped and `published_at` left NULL (a declined
    photograph was never published — the NULL is what will tell a declined
    row from a taken-down one). The uploader keeps the contributor-visible
    bin for thirty days (CK-37, unchanged); the host does not see it again;
    nothing is destroyed. NOT a general removal: a `live` row is refused
    with `not_pending` carrying `live`."""
    cast = await _cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    # The worker's output, without the worker (the publish test's move):
    # real numbers on both columns, so "neither moved" is not vacuous.
    # THE REMOVAL PIN (CK-51a): a removed photograph leaves total_bytes AND
    # photo_count where `ready` left them - the layers stay for the bin.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, cast.gathering_id)
        gathering.total_bytes = sum(size for _, size, _ in LAYER_SPECS.values())
        gathering.photo_count = 1
        await db.commit()
    before = await _bytes(db_session_factory, cast)
    assert before[:2] == (sum(size for _, size, _ in LAYER_SPECS.values()), 1)

    response = await _decline(client, cast.host, media_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["publication_state"] == "removed" and body["status"] == "ready"
    assert body["removed_at"] is not None if "removed_at" in body else True
    assert body["published_at"] is None

    status, state, published_at, publisher, removed_at = await _state(db_session_factory, media_id)
    assert (status, state, published_at, publisher) == (MediaStatus.READY, PublicationState.REMOVED, None, None)
    assert removed_at is not None
    # The layers still exist (nothing is destroyed); no byte moved.
    async with db_session_factory() as db:
        layers = (await db.execute(select(MediaDerivative).where(MediaDerivative.media_id == media_id))).scalars().all()
        assert len(layers) == 3
    assert await _bytes(db_session_factory, cast) == before

    # The bin is the uploader's: listed, with the clock, and a URL mints.
    listed = await _list(client, cast.uploader, cast.gathering_id)
    assert _ids(listed) == [media_id]
    assert listed.json()["media"][0]["removed_at"] is not None
    assert (await _url(client, cast.uploader, media_id)).status_code == 200
    # The host does not see it again — and cannot act on it again.
    for headers in (cast.host, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        assert (await _url(client, headers, media_id)).status_code == 404
    assert (await _decline(client, cast.host, media_id)).status_code == 404
    assert (await _publish(client, cast.host, media_id)).status_code == 404

    # A `live` photograph is not declined: the takedown is unbuilt.
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    refused = await _decline(client, cast.host, live)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == NOT_PENDING
    assert refused.json()["detail"]["publication_state"] == "live"
    assert (await _state(db_session_factory, live))[1] == PublicationState.LIVE


# --- logging --------------------------------------------------------------------


async def test_the_acts_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """The router still has no logger. With the ROOT logger at DEBUG, a
    publish, a decline, a batch, the queue, and the refusals together put
    no person id and no act into any log record."""
    cast = await _cast(client, capsys, db_session_factory)
    a = await _photograph(db_session_factory, cast)
    b = await _photograph(db_session_factory, cast)
    c = await _photograph(db_session_factory, cast)
    host_person = str(await _host_person_id(db_session_factory))
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (await _queue(client, cast.host, cast.gathering_id)).status_code == 200
        assert (await _publish(client, cast.host, a)).status_code == 200
        assert (await _decline(client, cast.host, b)).status_code == 200
        assert (await _batch(client, cast.host, cast.gathering_id, [c])).status_code == 200
        assert (await _publish(client, cast.host, a)).status_code == 409
        assert (await _publish(client, cast.keeper, c)).status_code == 404
    text = caplog.text
    assert host_person not in text
    assert str(cast.uploader_person_id) not in text
    # No application logger spoke. (httpx — the TEST CLIENT — logs each
    # request line at INFO, path and all: that is the transport's, the same
    # thing uvicorn's access log carries on Render, and not the router's —
    # the CK-39 caveat, so it is not pinned away here.)
    assert not any(record.name.startswith(("app", "covey-keep")) for record in caplog.records)
