"""CK-88.1a — a group's photos in sections: `GET /groups/{id}/media`, each
gathering's count and its newest eight published photos, in one read
(decisions/2026-10-31-the-design-and-how-it-is-merged.md §3 item 8, its
second half; the surface is CK-88.1b's). The cast is
tests/test_group_membership.py's — an ADMIN who created the group (and so
KEEPS it), a CO-ADMIN, a MEMBER, a STRANGER — plus three members added per
world: an INVITEE, a SHARER (shared with) and an EXCLUDED member (left
out). The MEMBER hosts the gathering, the CO-ADMIN is its co-host, and the
ADMIN — the group's keeper — is left out of it, the surprise-party case.
The rows are written directly (the worker's output, without the worker), so
every rung and publication state can be put in front of every seat. No
network anywhere in this file.

The load-bearing pins:
- WHO: the group's read audience, then `_visible_media` and nothing beside
  it — the host, a co-host, an invitee and a member shared with each read
  the gathering's section; a member LEFT OUT, the keeper by keeping (left
  out, and with no place at all) read no section and no count, though the
  photographs are published; a non-member and a missing id draw the group's
  404 byte-identical to a random id's; a standalone gathering and another
  group's gathering are never sections, though the caller sees their photos;
- WHAT: only `ready` + `live` — the caller's own waiting photo, the host's
  queue, both bins, a failed row, every in-flight rung and both destruction
  rungs are in no section and no count, each first shown visible to some
  seat in the gathering's own list; a gathering with none has no section;
- THE COUNT AND THE PREVIEW: the full count of what the caller can see and
  the newest eight, in the list's order; never `gatherings.photo_count`,
  the keeper's charge, which counts a binned photograph — and binning a
  published photograph lowers the count by one while the charge stands;
- THE ORDER: by each section's newest photograph, most recent first — not
  the gatherings' dates or creation — ties by `gathering_id`;
- THE BODY: every item equal to the item `GET /gatherings/{id}/media`
  answers the same caller, in the invited tier and the memory tier; the
  keys exactly; no URL minted, no email, no person id;
- ONE STATEMENT after the group's read, at one section and at five;
- nothing logged.
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import event, select

from app.api import media as media_api
from app.db import engine
from app.models import (
    Gathering,
    Group,
    Media,
    MediaDerivative,
    MediaFailureReason,
    MediaStatus,
    MediaTag,
    Person,
    PublicationState,
)
from app.services import keeping
from app.services.storage import published_key
from tests.test_destruction import _remove
from tests.test_gatherings import _account_for, _signed_in_headers
from tests.test_gatherings import _create as _create_standalone
from tests.test_group_gatherings import _create_in_group, _invitation_id, _iso
from tests.test_group_membership import (
    ADMIN,
    CO_ADMIN,
    MEMBER,
    STRANGER,
    Cast,
    _add_member,
    _cast,
    _group_404,
    _person_id,
)
from tests.test_groups import _create as _create_group
from tests.test_media_intents import _set_photo_count
from tests.test_media_reads import LAYER_SPECS

# GROUP_MEDIA_PREVIEW, pinned as a number: the mockup's grid shows 6 on a
# phone and 8 from 640px, so the route answers the larger.
PREVIEW = 8
ANSWER_KEYS = {"sections"}
SECTION_KEYS = {"gathering_id", "published_count", "media"}

INVITEE = "invitee@example.com"
SHARER = "sharer@example.com"
EXCLUDED = "excluded@example.com"
PLACELESS_KEEPER = "placeless-keeper@example.com"
ADDRESSES = (ADMIN, CO_ADMIN, MEMBER, STRANGER, INVITEE, SHARER, EXCLUDED, PLACELESS_KEEPER)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class World:
    """The cast's group, one gathering in it — hosted by the MEMBER, the
    CO-ADMIN its co-host, the INVITEE invited, the SHARER shared with, the
    ADMIN (the group's keeper) and the EXCLUDED member left out."""

    cast: Cast
    gathering_id: str
    date_id: str
    invitee: dict
    sharer: dict
    excluded: dict
    member_person: UUID
    co_admin_person: UUID
    invitee_person: UUID

    @property
    def readers(self) -> dict[str, dict]:
        """The four seats that read the gathering's photographs."""
        return {
            "host": self.cast.member,
            "co-host": self.cast.co_admin,
            "invitee": self.invitee,
            "shared with": self.sharer,
        }


async def _new_member(client, capsys, db_session_factory, cast: Cast, address: str) -> tuple[dict, str]:
    headers = await _signed_in_headers(client, capsys, address)
    return headers, await _add_member(db_session_factory, cast.group_id, address)


async def _world(client, capsys, db_session_factory) -> World:
    cast = await _cast(client, capsys, db_session_factory)
    invitee, invitee_membership = await _new_member(client, capsys, db_session_factory, cast, INVITEE)
    sharer, _ = await _new_member(client, capsys, db_session_factory, cast, SHARER)
    excluded, excluded_membership = await _new_member(client, capsys, db_session_factory, cast, EXCLUDED)
    created = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        title="Lake weekend",
        invited=[cast.co_admin_membership, invitee_membership],
        left_out=[cast.admin_membership, excluded_membership],
    )
    gathering_id = created["id"]
    handle = await _invitation_id(db_session_factory, gathering_id, CO_ADMIN)
    made = await client.post(
        f"/gatherings/{gathering_id}/co-hosts", json={"invitation_id": handle}, headers=cast.member
    )
    assert made.status_code == 201, made.text
    world = World(
        cast=cast,
        gathering_id=gathering_id,
        date_id=created["occurrences"][0]["id"],
        invitee=invitee,
        sharer=sharer,
        excluded=excluded,
        member_person=await _person_id(db_session_factory, MEMBER),
        co_admin_person=await _person_id(db_session_factory, CO_ADMIN),
        invitee_person=await _person_id(db_session_factory, INVITEE),
    )
    # The fixture is honest: each reader reads the gathering in the view its
    # place gives, the co-host as a co-host; the two left out draw its 404.
    expected = {
        "host": ("full", "host"),
        "co-host": ("full", "co_host"),
        "invitee": ("full", None),
        "shared with": ("memory", None),
    }
    for seat, headers in world.readers.items():
        detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
        assert detail.status_code == 200, (seat, detail.text)
        assert (detail.json()["caller_view"], detail.json()["caller_role"]) == expected[seat], seat
    for headers in (cast.admin, excluded):
        assert (await client.get(f"/gatherings/{gathering_id}", headers=headers)).status_code == 404
    return world


async def _photo(
    db_session_factory,
    gathering_id: str,
    uploader_person_id: UUID,
    *,
    status: MediaStatus = MediaStatus.READY,
    publication_state: PublicationState = PublicationState.LIVE,
    created_at: datetime | None = None,
    removed_by_person_id: UUID | None = None,
    failure_reason: MediaFailureReason | None = None,
    caption: str | None = None,
    filename: str | None = None,
    tags: tuple[str, ...] = (),
    occurrence_id: str | None = None,
) -> str:
    """One media row — `ready` and `live` by default, a published photograph
    — with its three derivative rows when it is ready and its tags as rows
    of their own. A `removed` row is removed at its birth, inside the bin's
    window, by whoever the test names."""
    born = created_at or _now()
    async with db_session_factory() as db:
        row = Media(
            gathering_id=UUID(gathering_id),
            occurrence_id=UUID(occurrence_id) if occurrence_id else None,
            uploader_person_id=uploader_person_id,
            upload_content_type="image/jpeg",
            upload_size_bytes=1_300_000,
            status=status,
            publication_state=publication_state,
            removed_at=born if publication_state is PublicationState.REMOVED else None,
            removed_by_person_id=removed_by_person_id,
            published_at=born if publication_state is PublicationState.LIVE else None,
            failure_reason=failure_reason,
            caption=caption,
            filename=filename,
            created_at=born,
            uploaded_at=None if status is MediaStatus.PENDING_UPLOAD else born,
        )
        db.add(row)
        await db.flush()
        if status is MediaStatus.READY:
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
        for tag in tags:
            db.add(MediaTag(media_id=row.id, tag=tag, added_by_person_id=uploader_person_id))
        await db.commit()
        return str(row.id)


async def _published(db_session_factory, gathering_id: str, uploader: UUID, n: int, newest: datetime) -> list[str]:
    """`n` published photographs, a minute apart, the newest at `newest`;
    returned newest first — the list's order."""
    ids = [
        await _photo(db_session_factory, gathering_id, uploader, created_at=newest - timedelta(minutes=i))
        for i in range(n)
    ]
    return ids


async def _group_media(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/media", headers=headers)


async def _answer(client, headers, group_id: str) -> dict:
    response = await _group_media(client, headers, group_id)
    assert response.status_code == 200, response.text
    return response.json()


def _section_ids(answer: dict) -> list[str]:
    return [section["gathering_id"] for section in answer["sections"]]


def _media_ids(section: dict) -> list[str]:
    return [item["id"] for item in section["media"]]


async def _list_items(client, headers, gathering_id: str, **params) -> list[dict]:
    response = await client.get(f"/gatherings/{gathering_id}/media", params=params, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["media"]


async def _photo_count(db_session_factory, gathering_id: str) -> int:
    async with db_session_factory() as db:
        return (await db.get(Gathering, UUID(gathering_id))).photo_count


# --- auth ----------------------------------------------------------------------------


async def test_the_route_requires_auth(client):
    assert (await client.get(f"/groups/{uuid4()}/media")).status_code == 401


# --- who -----------------------------------------------------------------------------


async def test_each_reader_has_the_section_and_the_left_out_the_keeper_and_a_stranger_have_nothing(
    client, capsys, db_session_factory
):
    """The host, the co-host, the invitee and the member shared with each
    read the gathering's one section with its count. The EXCLUDED member and
    the ADMIN — the group's keeper — are left out: each reads `{"sections":
    []}`, and the gathering's id appears nowhere in what they read. A keeper
    BY KEEPING with no place at all (a member planted after the gathering
    was made, the group's keeper moved to them) reads the same nothing —
    and before they are a member they draw the group's 404, byte-identical
    to a random id's and to `GET /groups/{missing}`'s, as the stranger
    does."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    published = await _published(db_session_factory, world.gathering_id, world.invitee_person, 2, _now())

    for seat, headers in world.readers.items():
        answer = await _answer(client, headers, cast.group_id)
        assert _section_ids(answer) == [world.gathering_id], seat
        (section,) = answer["sections"]
        assert section["published_count"] == 2, seat
        assert _media_ids(section) == published, seat

    for headers in (world.excluded, cast.admin):
        response = await _group_media(client, headers, cast.group_id)
        assert response.status_code == 200, response.text
        assert response.json() == {"sections": []}
        assert world.gathering_id not in response.text
        for media_id in published:
            assert media_id not in response.text

    # The admin keeps the group — and so, through the resolver's first rung,
    # the gathering: the keeper reads nothing by keeping.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(world.gathering_id))
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution.keeper_account_id == (await _account_for(db, ADMIN)).id

    random_404 = await _group_media(client, cast.stranger, str(uuid4()))
    missing_detail = await _group_404(client, cast.stranger)
    assert (random_404.status_code, random_404.content) == missing_detail
    stranger = await _group_media(client, cast.stranger, cast.group_id)
    assert (stranger.status_code, stranger.content) == missing_detail

    # A keeper by keeping with NO place: not yet a member — the group's 404.
    keeper = await _signed_in_headers(client, capsys, PLACELESS_KEEPER)
    before = await _group_media(client, keeper, cast.group_id)
    assert (before.status_code, before.content) == (random_404.status_code, random_404.content)
    await _add_member(db_session_factory, cast.group_id, PLACELESS_KEEPER)
    async with db_session_factory() as db:
        group = await db.get(Group, UUID(cast.group_id))
        group.keeper_account_id = (await _account_for(db, PLACELESS_KEEPER)).id
        await db.commit()
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(world.gathering_id))
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution.keeper_account_id == (await _account_for(db, PLACELESS_KEEPER)).id
    assert (await client.get(f"/groups/{cast.group_id}", headers=keeper)).status_code == 200
    assert (await client.get(f"/gatherings/{world.gathering_id}", headers=keeper)).status_code == 404
    response = await _group_media(client, keeper, cast.group_id)
    assert response.status_code == 200, response.text
    assert response.json() == {"sections": []}
    assert world.gathering_id not in response.text

    # Nothing moved for the readers.
    assert _section_ids(await _answer(client, world.sharer, cast.group_id)) == [world.gathering_id]


async def test_only_the_groups_own_gatherings_are_sections(client, capsys, db_session_factory):
    """The MEMBER hosts a standalone gathering and a gathering in a second
    group of their own, and sees the published photographs of both in each
    one's own list — and neither is a section of the first group, whose
    answer is its own gathering alone. The second group's answer is its own
    gathering alone."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    ours = await _published(db_session_factory, world.gathering_id, world.invitee_person, 1, _now())
    standalone = await _create_standalone(client, cast.member, title="Just us")
    alone = await _published(db_session_factory, standalone["id"], world.member_person, 2, _now())
    other_group = await _create_group(client, cast.member, name="Lee cousins")
    elsewhere = await _create_in_group(client, cast.member, other_group["id"], title="Cousins' picnic")
    theirs = await _published(db_session_factory, elsewhere["id"], world.member_person, 3, _now())

    # Each is visible to the member in its own list.
    assert [m["id"] for m in await _list_items(client, cast.member, standalone["id"])] == alone
    assert [m["id"] for m in await _list_items(client, cast.member, elsewhere["id"])] == theirs

    answer = await _answer(client, cast.member, cast.group_id)
    assert _section_ids(answer) == [world.gathering_id]
    assert _media_ids(answer["sections"][0]) == ours
    for foreign in (standalone["id"], elsewhere["id"], *alone, *theirs):
        assert foreign not in str(answer)

    other = await _answer(client, cast.member, other_group["id"])
    assert _section_ids(other) == [elsewhere["id"]]
    assert other["sections"][0]["published_count"] == 3
    # The first group's members are not in the second group.
    refused = await _group_media(client, world.sharer, other_group["id"])
    assert (refused.status_code, refused.content) == await _group_404(client, world.sharer)


# --- what ----------------------------------------------------------------------------


async def test_only_published_photos_are_in_a_section_or_its_count(client, capsys, db_session_factory):
    """Two published photographs, and beside them every other state a row
    can be in: the invitee's own waiting photograph, the host's queue (the
    co-host's upload, waiting), a photograph in its uploader's bin and one
    in the gathering's bin, a failed row, `pending_upload`, `uploaded` and
    `processing`, `destroying` and `destroyed` — and two rows `live` but
    not `ready`, a shape no writer leaves, planted to prove the route asks
    both. Each of them is first shown VISIBLE to some seat in the
    gathering's own list (so its absence below is the route's filter, not
    the audience), and none is in any section or any count. A second
    gathering of the group holding only rows that are not published has no
    section, and nor does a third with no photographs at all."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid, invitee = world.cast, world.gathering_id, world.invitee_person
    published = await _published(db_session_factory, gid, invitee, 2, _now() - timedelta(hours=2))

    def plant(by: UUID = invitee, **kwargs):
        return _photo(db_session_factory, gid, by, **kwargs)

    # Every one NEWER than the published two, so a leak would lead the list.
    waiting = await plant(publication_state=PublicationState.PENDING)
    queued = await plant(by=world.co_admin_person, publication_state=PublicationState.PENDING)
    own_bin = await plant(publication_state=PublicationState.REMOVED, removed_by_person_id=invitee)
    gathering_bin = await plant(publication_state=PublicationState.REMOVED, removed_by_person_id=world.member_person)
    failed = await plant(
        status=MediaStatus.FAILED, publication_state=PublicationState.PENDING, failure_reason=MediaFailureReason.UNREADABLE
    )
    in_flight = {
        status: await plant(status=status, publication_state=PublicationState.PENDING)
        for status in (MediaStatus.PENDING_UPLOAD, MediaStatus.UPLOADED, MediaStatus.PROCESSING)
    }
    destroying = await plant(status=MediaStatus.DESTROYING)
    destroyed = await plant(status=MediaStatus.DESTROYED)
    live_unready = [
        await plant(status=MediaStatus.UPLOADED),
        await plant(status=MediaStatus.PROCESSING),
    ]

    # Visible to someone, each in its own list.
    invitee_list = {m["id"] for m in await _list_items(client, world.invitee, gid)}
    assert {waiting, own_bin, failed, *in_flight.values(), *live_unready} <= invitee_list
    host_list = {m["id"] for m in await _list_items(client, cast.member, gid)}
    assert {waiting, queued, *in_flight.values(), *live_unready} <= host_list
    co_host_bin = {m["id"] for m in await _list_items(client, cast.co_admin, gid, removed="true")}
    assert gathering_bin in co_host_bin
    sharer_list = {m["id"] for m in await _list_items(client, world.sharer, gid)}
    assert set(live_unready) <= sharer_list
    # The two destruction rungs are visible to nobody, anywhere.
    for headers in world.readers.values():
        listed = {m["id"] for m in await _list_items(client, headers, gid)}
        assert not {destroying, destroyed} & listed

    # A gathering of nothing published, and one of no photographs at all.
    unpublished = await _create_in_group(client, cast.member, cast.group_id, title="Not yet")
    await _photo(db_session_factory, unpublished["id"], world.member_person, publication_state=PublicationState.PENDING)
    await _photo(
        db_session_factory,
        unpublished["id"],
        world.member_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=world.member_person,
    )
    empty = await _create_in_group(client, cast.member, cast.group_id, title="Nothing")

    for seat, headers in world.readers.items():
        answer = await _answer(client, headers, cast.group_id)
        assert _section_ids(answer) == [gid], seat
        (section,) = answer["sections"]
        assert section["published_count"] == 2, seat
        assert _media_ids(section) == published, seat
        assert unpublished["id"] not in str(answer) and empty["id"] not in str(answer), seat


# --- the count and the preview -------------------------------------------------------


async def test_a_section_carries_its_full_count_and_its_newest_eight_in_the_lists_order(
    client, capsys, db_session_factory
):
    """A gathering with ten published photographs answers 10 and the newest
    eight; one with three answers 3 and all three — each in the order the
    gathering's own list gives the same caller, a tie on `created_at`
    broken by id as the list breaks it. Read by the host and by a member
    shared with."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    assert getattr(media_api, "GROUP_MEDIA_PREVIEW", None) == PREVIEW
    ten = world.gathering_id
    three = (await _create_in_group(client, cast.member, cast.group_id, title="Brunch"))["id"]
    newest = _now() - timedelta(minutes=5)
    await _published(db_session_factory, ten, world.invitee_person, 8, newest)
    # Two at one instant, inside the eight shown: the list's id tie-break.
    tied = newest - timedelta(minutes=3, seconds=30)
    for _ in range(2):
        await _photo(db_session_factory, ten, world.member_person, created_at=tied)
    await _published(db_session_factory, three, world.co_admin_person, 3, newest - timedelta(hours=1))

    for headers in (cast.member, world.sharer):
        sections = {s["gathering_id"]: s for s in (await _answer(client, headers, cast.group_id))["sections"]}
        assert set(sections) == {ten, three}
        listed_ten = [m["id"] for m in await _list_items(client, headers, ten)]
        assert len(listed_ten) == 10
        assert sections[ten]["published_count"] == 10
        assert _media_ids(sections[ten]) == listed_ten[:PREVIEW]
        listed_three = [m["id"] for m in await _list_items(client, headers, three)]
        assert sections[three]["published_count"] == 3
        assert _media_ids(sections[three]) == listed_three


async def test_the_count_never_reads_the_keepers_charge_and_drops_by_one_when_a_photo_is_binned(
    client, capsys, db_session_factory
):
    """Four published photographs, one the invitee binned and one waiting
    for the host — six `ready` rows, so the keeper's charge,
    `gatherings.photo_count`, is 6 — and the section counts 4 for every
    reader, the invitee who sees their own binned row included. The invitee
    then bins a published photograph through the route: the count drops to
    3 for everyone and the photograph leaves the section, while the charge
    stays 6 (binning frees nothing — the bin record §3) — a count that read
    the charge would have told every member nothing changed, and one that
    moved with a removal it could not see would tell them it happened."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    published = await _published(db_session_factory, gid, world.invitee_person, 4, _now() - timedelta(hours=1))
    await _photo(
        db_session_factory,
        gid,
        world.invitee_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=world.invitee_person,
    )
    await _photo(db_session_factory, gid, world.invitee_person, publication_state=PublicationState.PENDING)
    async with db_session_factory() as db:
        await _set_photo_count(db, gid, 6)

    for seat, headers in world.readers.items():
        (section,) = (await _answer(client, headers, cast.group_id))["sections"]
        assert section["published_count"] == 4, seat
        assert section["published_count"] != await _photo_count(db_session_factory, gid)

    binned = published[1]
    response = await _remove(client, world.invitee, binned)
    assert response.status_code == 200, response.text
    assert await _photo_count(db_session_factory, gid) == 6
    for seat, headers in world.readers.items():
        (section,) = (await _answer(client, headers, cast.group_id))["sections"]
        assert section["published_count"] == 3, seat
        assert _media_ids(section) == [published[0], *published[2:]], seat


# --- the order -----------------------------------------------------------------------


async def test_the_sections_run_newest_photo_first_not_by_the_gatherings_dates_or_creation(
    client, capsys, db_session_factory
):
    """Three gatherings made X, Y, Z, dated so that neither their dates nor
    their creation give the answer, and each holding an older photograph
    too, so that ordering by the oldest would give another answer again:
    the newest photographs fall Z, X, Y, and so do the sections."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    now = _now()

    def dated(days: int) -> list[dict]:
        return [{"starts_at": _iso(now + timedelta(days=days))}]

    x = (await _create_in_group(client, cast.member, cast.group_id, title="X", occurrences=dated(30)))["id"]
    y = (await _create_in_group(client, cast.member, cast.group_id, title="Y", occurrences=dated(10)))["id"]
    z = (await _create_in_group(client, cast.member, cast.group_id, title="Z", occurrences=dated(20)))["id"]
    hours = {x: (2, 10), y: (3, 4), z: (1, 20)}
    for gid, (newest, oldest) in hours.items():
        for ago in (newest, oldest):
            await _photo(db_session_factory, gid, world.member_person, created_at=now - timedelta(hours=ago))

    expected = [z, x, y]
    # The fixture is honest: no other reading gives the same answer.
    assert expected not in ([x, y, z], [z, y, x], [y, z, x], [x, z, y])  # creation, dates
    assert expected != [y, x, z]  # by the oldest photograph, most recent first
    for headers in (cast.member, world.invitee, world.sharer):
        assert _section_ids(await _answer(client, headers, cast.group_id)) == expected


async def test_a_tie_on_the_newest_photo_is_broken_by_gathering_id(client, capsys, db_session_factory):
    """Gatherings whose newest photographs share one instant run by
    `gathering_id`, ascending, after a gathering with a newer one — made
    until the order they were created in is neither the ids' order nor its
    reverse, so a missing tie-break cannot pass by the order of creation."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    instant = _now() - timedelta(hours=1)
    made: list[str] = []
    while len(made) < 3 or made in (sorted(made), sorted(made, reverse=True)):
        made.append((await _create_in_group(client, cast.member, cast.group_id, title=f"Tie {len(made)}"))["id"])
    for gid in made:
        await _photo(db_session_factory, gid, world.member_person, created_at=instant)
        await _photo(db_session_factory, gid, world.member_person, created_at=instant - timedelta(hours=1))
    newer = (await _create_in_group(client, cast.member, cast.group_id, title="Newer"))["id"]
    await _photo(db_session_factory, newer, world.member_person, created_at=instant + timedelta(minutes=1))

    for headers in (cast.member, world.sharer):
        assert _section_ids(await _answer(client, headers, cast.group_id)) == [newer, *sorted(made)]


# --- the body ------------------------------------------------------------------------


async def test_every_item_is_the_item_the_gatherings_own_list_answers_the_same_caller(
    client, capsys, db_session_factory, monkeypatch
):
    """Photographs by three people with captions, file names, tags (one
    typed in two cases of letter, so the order is the tags' own) and a date
    label: for the host, the co-host, the invitee (the invited tier) and the
    member shared with (the memory tier), every item in the section equals
    the item `GET /gatherings/{id}/media` answers that caller for that
    photograph — `is_own` included — and the answer's and the section's
    keys are exactly theirs. No URL is minted (`presign_read` is never
    called), and no URL, no email and no person id is in any answer."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    base = _now() - timedelta(hours=1)
    await _photo(
        db_session_factory,
        gid,
        world.invitee_person,
        created_at=base,
        caption="Jenny at the dock",
        filename="IMG_0412.HEIC",
        tags=("dock", "Jenny", "sunset"),
        occurrence_id=world.date_id,
    )
    await _photo(
        db_session_factory, gid, world.member_person, created_at=base - timedelta(minutes=1), tags=("zebra", "Apple", "apple pie")
    )
    await _photo(db_session_factory, gid, world.co_admin_person, created_at=base - timedelta(minutes=2), filename="lake.jpg")

    minted: list = []
    monkeypatch.setattr(media_api, "presign_read", lambda *args, **kwargs: minted.append(args))

    async with db_session_factory() as db:
        person_ids = {str(p) for p in (await db.scalars(select(Person.id))).all()}
    for seat, headers in world.readers.items():
        response = await _group_media(client, headers, cast.group_id)
        assert response.status_code == 200, response.text
        answer = response.json()
        assert set(answer) == ANSWER_KEYS, seat
        (section,) = answer["sections"]
        assert set(section) == SECTION_KEYS, seat
        listed = {m["id"]: m for m in await _list_items(client, headers, gid)}
        assert len(section["media"]) == 3, seat
        for item in section["media"]:
            assert item == listed[item["id"]], (seat, item["id"])
        assert [item["is_own"] for item in section["media"]] == [
            seat == "invitee",
            seat == "host",
            seat == "co-host",
        ], seat
        text = response.text
        assert "http" not in text and "x-amz" not in text.lower(), seat
        for address in ADDRESSES:
            assert address not in text, (seat, address)
        assert "@" not in text, seat
        for person_id in person_ids:
            assert person_id not in text, (seat, person_id)
    assert minted == []


# --- one statement -------------------------------------------------------------------


async def test_one_statement_reads_the_photos_however_many_sections(client, capsys, db_session_factory):
    """After the group's read, ONE statement answers every section — the
    photographs, their count, their order, their uploaders' names and their
    tags — whether there is one section or five (the CK-20 discipline; the
    `before_cursor_execute` listener `tests/test_group_gatherings.py`
    uses)."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    now = _now()
    await _photo(db_session_factory, world.gathering_id, world.invitee_person, created_at=now, tags=("one", "two"))
    await _photo(db_session_factory, world.gathering_id, world.invitee_person, created_at=now - timedelta(minutes=1))

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count_statements() -> tuple[int, int]:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            answer = await _answer(client, world.sharer, cast.group_id)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        reads_media = [i for i, s in enumerate(statements) if re.search(r"\bmedia\b", s)]
        assert reads_media == [len(statements) - 1], statements
        return len(statements), len(answer["sections"])

    await _answer(client, world.sharer, cast.group_id)  # warm the session's refresh
    at_one, sections = await count_statements()
    assert sections == 1
    for n in range(4):
        gid = (await _create_in_group(client, cast.member, cast.group_id, title=f"More {n}"))["id"]
        for minutes in range(3):
            await _photo(
                db_session_factory, gid, world.member_person, created_at=now - timedelta(hours=n + 1, minutes=minutes), tags=("t",)
            )
    at_five, sections = await count_statements()
    assert sections == 5
    assert at_five == at_one


# --- nothing logged ------------------------------------------------------------------


async def test_the_route_logs_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """The media router still has no logger. With the root logger at DEBUG,
    reading a group's sections puts no caption, tag, file name, display
    name or id into any APPLICATION log record (the httpx client's records
    carry the request line, as every access log does; excluded, and shown
    non-empty)."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    assert not hasattr(media_api, "logger")
    media_id = await _photo(
        db_session_factory,
        world.gathering_id,
        world.invitee_person,
        caption="Quiet caption",
        filename="quiet-file.jpg",
        tags=("quiet-tag",),
    )
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (await _group_media(client, world.sharer, cast.group_id)).status_code == 200
        assert (await _group_media(client, world.excluded, cast.group_id)).status_code == 200
        assert (await _group_media(client, cast.stranger, cast.group_id)).status_code == 404
    application = [r for r in caplog.records if not r.name.startswith("httpx")]
    assert any(r.name.startswith("httpx") for r in caplog.records)
    assert not [r for r in application if r.name.startswith(("app", "covey-keep"))]
    joined = "\n".join(r.getMessage() for r in application)
    for word in ("Quiet caption", "quiet-file.jpg", "quiet-tag", "invitee", media_id, world.gathering_id, cast.group_id):
        assert word not in joined, word
