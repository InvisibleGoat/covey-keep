"""CK-90 — the calendar, the backend: `GET /calendar?from=&to=` and
`GET /groups/{id}/calendar?from=&to=`, every date of every gathering the
caller is invited to, in a range of instants
(decisions/2026-10-04-calendars-and-alerts-by-scope.md §1, §2;
decisions/2026-10-31-the-design-and-how-it-is-merged.md §3 item 10; the
surface is CK-91's). The world is tests/test_group_media.py's: a group whose
ADMIN created it (and so KEEPS it), a CO-ADMIN, a MEMBER, a STRANGER, and an
INVITEE, a SHARER (shared with) and an EXCLUDED member (left out); the
MEMBER hosts one gathering, the CO-ADMIN its co-host, and the ADMIN — the
group's keeper — is left out of it, the surprise-party case.

The load-bearing pins:
- WHO: the invited tier exactly — the host (who holds no invitation row on
  a group's gathering), a co-host (one planted with no invitation row, a
  shape no writer leaves, so the co-host term is not redundant with the
  invitation term), a member invited by choice or by the whole-group
  create, a standalone gathering's accepted invitee, and a member who has
  since left the group; never a member only shared with, one left out, the
  keeper by keeping, a pending emailed invitation's addressee or a stranger;
- THE GROUP ROUTE: the group's 404 first, byte-identical; that group's
  gatherings alone;
- THE RANGE: half-open, in instants, every edge; the span at most 62 days;
  each refusal a field-level 422 at its field;
- THE ANSWER: the caller's own, by person — never anyone else's, never a
  guest's row;
- POSITION AND DATE COUNT: over all of the gathering's dates, never the
  range's;
- THE PHOTO COUNT: `ready` + `live` ANDed with `_visible_media`; never
  `gatherings.photo_count`;
- THE BODY: the keys exactly; each date the detail's date plus `position`;
  each gathering's facts the list item's; the order; no email, no person id,
  no URL;
- ONE STATEMENT after the auth read, at one gathering and at five with
  thirty dates;
- no logger.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import delete, event, select

from app.api import calendar as calendar_api
from app.db import engine
from app.models import (
    RSVP,
    Gathering,
    GatheringCoHost,
    GatheringInvitation,
    MediaFailureReason,
    MediaStatus,
    Person,
    PublicationState,
    RSVPResponse,
)
from app.services import keeping
from tests.test_cover_images import FACTS, _plant_image, _point
from tests.test_covers import GATHERINGS, _plant_cover
from tests.test_destruction import _remove as _bin
from tests.test_gatherings import _account_for, _signed_in_headers
from tests.test_gatherings import _create as _create_standalone
from tests.test_group_gatherings import _create_in_group, _iso
from tests.test_group_media import ADDRESSES, _photo, _published, _world
from tests.test_group_membership import (
    _add_member,
    _group_404,
    _leave,
    _person_id,
)
from tests.test_groups import _create as _create_group
from tests.test_invitations import _accept, _invite, _invite_token
from tests.test_media_intents import _set_photo_count
from tests.test_rsvps import _put_rsvp

MAX_SPAN = timedelta(days=62)
ANSWER_KEYS = {"dates", "gatherings"}
OCCURRENCE_KEYS = {"id", "gathering_id", "starts_at", "ends_at", "location", "map_url"}
DATE_KEYS = OCCURRENCE_KEYS | {"caller_response", "position"}
GATHERING_KEYS = {"id", "title", "gathering_type", "cover", "group", "date_count", "published_count"}
LIST_FACTS = ("title", "gathering_type", "cover", "group")

STANDALONE_GUEST = "cal-guest@example.com"
PENDING_ADDRESSEE = "cal-pending@example.com"
PLANTED_CO_HOST = "cal-planted-co-host@example.com"
OUTSIDER = "cal-outsider@example.com"

# A fixed instant for the range tests, so no edge depends on the clock.
BASE = datetime(2027, 3, 1, 12, 0, tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _calendar(client, headers, start: datetime, end: datetime, group_id: str | None = None):
    path = f"/groups/{group_id}/calendar" if group_id else "/calendar"
    return await client.get(path, params={"from": _iso(start), "to": _iso(end)}, headers=headers)


async def _read(client, headers, start: datetime, end: datetime, group_id: str | None = None) -> dict:
    response = await _calendar(client, headers, start, end, group_id)
    assert response.status_code == 200, response.text
    return response.json()


def _gathering_ids(answer: dict) -> list[str]:
    return [g["id"] for g in answer["gatherings"]]


def _date_gatherings(answer: dict) -> set[str]:
    return {d["gathering_id"] for d in answer["dates"]}


def _world_window(world) -> tuple[datetime, datetime]:
    """A range around the world's gathering's one date (30 days ahead)."""
    return _now() + timedelta(days=29), _now() + timedelta(days=31)


async def _detail_dates(client, headers, gathering_id: str) -> dict[str, dict]:
    response = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert response.status_code == 200, response.text
    return {o["id"]: o for o in response.json()["occurrences"]}


async def _list_items(client, headers) -> dict[str, dict]:
    response = await client.get("/gatherings", headers=headers)
    assert response.status_code == 200, response.text
    return {g["id"]: g for g in response.json()["gatherings"]}


async def _plant_co_host(db_session_factory, gathering_id: str, address: str, host_address: str) -> None:
    """A co-host row for a person who holds NO invitation row on the
    gathering — a shape no writer leaves (a co-host is made from an accepted
    invitation, CK-68), planted so that the co-host term of the audience and
    `_visible_media` in the count are each the only thing that decides."""
    async with db_session_factory() as db:
        account = await _account_for(db, address)
        host = await _account_for(db, host_address)
        db.add(GatheringCoHost(gathering_id=UUID(gathering_id), account_id=account.id, added_by_account_id=host.id))
        await db.commit()
    async with db_session_factory() as db:
        person = await _person_id(db_session_factory, address)
        held = await db.scalar(
            select(GatheringInvitation.id).where(
                GatheringInvitation.gathering_id == UUID(gathering_id), GatheringInvitation.person_id == person
            )
        )
        assert held is None, "the planted co-host must hold no invitation row"


# --- auth ----------------------------------------------------------------------------


async def test_the_routes_require_auth(client):
    params = {"from": _iso(BASE), "to": _iso(BASE + timedelta(days=7))}
    assert (await client.get("/calendar", params=params)).status_code == 401
    assert (await client.get(f"/groups/{uuid4()}/calendar", params=params)).status_code == 401


# --- who -----------------------------------------------------------------------------


async def test_the_invited_tier_sees_the_dates_and_nobody_else_does(client, capsys, db_session_factory):
    """Five gatherings with a date in one range: the world's (MEMBER hosts,
    CO-ADMIN co-hosts, INVITEE invited, SHARER shared with, the ADMIN — the
    group's keeper — and EXCLUDED left out), a whole-group create (every
    member invited), a standalone one with an accepted invitee, a standalone
    one with only a PENDING emailed invitation, and the world's gathering
    seen by a co-host planted with no invitation row. Each seat's calendar
    holds exactly the gatherings its place gives, in `dates` and in
    `gatherings`, and a gathering a seat may not see appears nowhere in its
    answer — not its id, not its title."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    when = _now() + timedelta(days=30, hours=2)
    start, end = _now() + timedelta(days=29), _now() + timedelta(days=31)
    lake = world.gathering_id
    whole = (
        await _create_in_group(
            client, cast.member, cast.group_id, title="Whole family", occurrences=[{"starts_at": _iso(when)}]
        )
    )["id"]
    standalone = (await _create_standalone(client, cast.member, title="Just us", occurrences=[{"starts_at": _iso(when)}]))["id"]
    guest = await _signed_in_headers(client, capsys, STANDALONE_GUEST)
    await _accept(client, guest, await _invite_token(client, capsys, cast.member, standalone, STANDALONE_GUEST))
    pending = (await _create_standalone(client, cast.member, title="Not yet answered", occurrences=[{"starts_at": _iso(when)}]))[
        "id"
    ]
    invited = await _invite(client, cast.member, pending, PENDING_ADDRESSEE)
    assert invited.status_code == 201, invited.text
    addressee = await _signed_in_headers(client, capsys, PENDING_ADDRESSEE)
    planted = await _signed_in_headers(client, capsys, PLANTED_CO_HOST)
    await _plant_co_host(db_session_factory, lake, PLANTED_CO_HOST, "member@example.com")

    # The ADMIN keeps the group, and so — through the resolver's first rung —
    # both group gatherings: keeping lets no one in.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(lake))
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution.keeper_account_id == (await _account_for(db, "admin@example.com")).id

    titles = {lake: "Lake weekend", whole: "Whole family", standalone: "Just us", pending: "Not yet answered"}
    expected = {
        "host": (cast.member, {lake, whole, standalone, pending}),
        "co-host": (cast.co_admin, {lake, whole}),
        "planted co-host": (planted, {lake}),
        "invitee": (world.invitee, {lake, whole}),
        "standalone guest": (guest, {standalone}),
        "shared with": (world.sharer, {whole}),
        "left out": (world.excluded, {whole}),
        "keeper by keeping": (cast.admin, {whole}),
        "pending addressee": (addressee, set()),
        "stranger": (cast.stranger, set()),
    }
    for seat, (headers, gatherings) in expected.items():
        response = await _calendar(client, headers, start, end)
        assert response.status_code == 200, (seat, response.text)
        answer = response.json()
        assert set(_gathering_ids(answer)) == gatherings, seat
        assert _date_gatherings(answer) == gatherings, seat
        assert len(answer["dates"]) == len(gatherings), seat
        for absent in set(titles) - gatherings:
            assert absent not in response.text, (seat, titles[absent])
            assert titles[absent] not in response.text, (seat, titles[absent])


async def test_a_member_who_has_left_keeps_their_dates_and_draws_the_groups_404(client, capsys, db_session_factory):
    """The INVITEE leaves the group. Their invitation row stays (a place is a
    row — the archive record §6.1), so the gathering's date stays on their
    `GET /calendar`; the group's calendar draws the group's 404,
    byte-identical to a missing group's and to a random id's."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    start, end = _world_window(world)
    before = await _read(client, world.invitee, start, end, cast.group_id)
    assert _gathering_ids(before) == [world.gathering_id]

    left = await _leave(client, world.invitee, cast.group_id)
    assert left.status_code == 204, left.text

    assert _gathering_ids(await _read(client, world.invitee, start, end)) == [world.gathering_id]
    refused = await _calendar(client, world.invitee, start, end, cast.group_id)
    missing = await _group_404(client, world.invitee)
    assert (refused.status_code, refused.content) == missing
    random = await _calendar(client, world.invitee, start, end, str(uuid4()))
    assert (random.status_code, random.content) == missing


# --- the group route -----------------------------------------------------------------


async def test_the_group_calendar_holds_that_groups_gatherings_alone(client, capsys, db_session_factory):
    """The MEMBER hosts the world's gathering, a standalone gathering and a
    gathering in a second group of their own, all with a date in the range;
    their own calendar holds all three. The first group's calendar holds its
    own gathering alone, the second group's its own alone. A member shared
    with reads the first group's calendar empty (a 200). A stranger, an
    outsider and a random id draw the group's 404, byte-identical."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    start, end = _world_window(world)
    when = _iso(_now() + timedelta(days=30, hours=1))
    standalone = (await _create_standalone(client, cast.member, title="Just us", occurrences=[{"starts_at": when}]))["id"]
    other_group = await _create_group(client, cast.member, name="Lee cousins")
    elsewhere = (
        await _create_in_group(client, cast.member, other_group["id"], title="Cousins' picnic", occurrences=[{"starts_at": when}])
    )["id"]

    assert set(_gathering_ids(await _read(client, cast.member, start, end))) == {world.gathering_id, standalone, elsewhere}
    ours = await _read(client, cast.member, start, end, cast.group_id)
    assert _gathering_ids(ours) == [world.gathering_id]
    assert _date_gatherings(ours) == {world.gathering_id}
    theirs = await _read(client, cast.member, start, end, other_group["id"])
    assert _gathering_ids(theirs) == [elsewhere]
    assert _date_gatherings(theirs) == {elsewhere}

    assert await _read(client, world.sharer, start, end, cast.group_id) == {"dates": [], "gatherings": []}

    missing = await _group_404(client, cast.stranger)
    for headers in (cast.stranger, await _signed_in_headers(client, capsys, OUTSIDER), world.sharer):
        refused = await _calendar(client, headers, start, end, other_group["id"])
        assert (refused.status_code, refused.content) == missing
    refused = await _calendar(client, cast.stranger, start, end, cast.group_id)
    assert (refused.status_code, refused.content) == missing
    random = await _calendar(client, cast.member, start, end, str(uuid4()))
    assert (random.status_code, random.content) == missing


async def test_the_group_route_asks_the_group_first(client, capsys, db_session_factory):
    """A stranger asking a group's calendar with a range the route would
    refuse draws the group's 404, not the range's 422: the group is read
    before anything else is said."""
    world = await _world(client, capsys, db_session_factory)
    refused = await _calendar(client, world.cast.stranger, BASE, BASE + timedelta(days=90), world.cast.group_id)
    assert (refused.status_code, refused.content) == await _group_404(client, world.cast.stranger)
    allowed = await _calendar(client, world.cast.member, BASE, BASE + timedelta(days=90), world.cast.group_id)
    assert allowed.status_code == 422


# --- the range -----------------------------------------------------------------------


async def test_the_range_is_half_open_in_instants(client, capsys, db_session_factory):
    """A season of six dates around the range `[BASE, BASE + 7 days)`: a
    date with no end AT `from` is in, one AT `to` is out; a date spanning
    `from` is in, one ENDING exactly at `from` is out; a date starting
    before `to` and ending after it is in; a date wholly before is out. The
    three dates in the range carry their places among all six (3, 4, 5) and
    the season's `date_count`, 6."""
    host = await _signed_in_headers(client, capsys, "cal-range@example.com")
    end = BASE + timedelta(days=7)
    occurrences = [
        {"starts_at": _iso(BASE - timedelta(days=3))},  # 1: wholly before
        {"starts_at": _iso(BASE - timedelta(days=2)), "ends_at": _iso(BASE)},  # 2: ends exactly at from
        {"starts_at": _iso(BASE - timedelta(days=1)), "ends_at": _iso(BASE + timedelta(hours=1))},  # 3: spans from
        {"starts_at": _iso(BASE)},  # 4: no end, at from
        {"starts_at": _iso(end - timedelta(hours=1)), "ends_at": _iso(end + timedelta(days=1))},  # 5: spans to
        {"starts_at": _iso(end)},  # 6: no end, at to
    ]
    created = await _create_standalone(client, host, gathering_type="season", title="Spring league", occurrences=occurrences)
    ids = [o["id"] for o in sorted(created["occurrences"], key=lambda o: o["starts_at"])]

    answer = await _read(client, host, BASE, end)
    assert [d["id"] for d in answer["dates"]] == [ids[2], ids[3], ids[4]]
    assert [d["position"] for d in answer["dates"]] == [3, 4, 5]
    (gathering,) = answer["gatherings"]
    assert gathering["date_count"] == 6
    for absent in (ids[0], ids[1], ids[5]):
        assert absent not in str(answer)


async def test_the_span_is_at_most_62_days_and_each_refusal_names_its_field(client, capsys, db_session_factory):
    """62 days is answered; 62 days and a second, `to` equal to `from` and
    `to` before `from` each draw a field-level 422 at `to`; a naive `from`
    at `from` and a naive `to` at `to`; a missing `from` or `to`, FastAPI's
    own 422 at the missing field. The group route refuses the same way."""
    world = await _world(client, capsys, db_session_factory)
    host = world.cast.member
    assert getattr(calendar_api, "CALENDAR_MAX_SPAN", None) == MAX_SPAN

    assert (await _calendar(client, host, BASE, BASE + MAX_SPAN)).status_code == 200
    assert (await _calendar(client, host, BASE, BASE + MAX_SPAN, world.cast.group_id)).status_code == 200

    def loc(response) -> list:
        assert response.status_code == 422, response.text
        (error,) = response.json()["detail"]
        return error["loc"]

    for group_id in (None, world.cast.group_id):
        for end in (BASE + MAX_SPAN + timedelta(seconds=1), BASE, BASE - timedelta(days=1)):
            assert loc(await _calendar(client, host, BASE, end, group_id)) == ["query", "to"], (group_id, end)

    path = "/calendar"
    naive_from = await client.get(path, params={"from": "2027-03-01T12:00:00", "to": _iso(BASE + timedelta(days=7))}, headers=host)
    assert loc(naive_from) == ["query", "from"]
    naive_to = await client.get(path, params={"from": _iso(BASE), "to": "2027-03-08T12:00:00"}, headers=host)
    assert loc(naive_to) == ["query", "to"]
    no_from = await client.get(path, params={"to": _iso(BASE)}, headers=host)
    assert loc(no_from) == ["query", "from"]
    no_to = await client.get(path, params={"from": _iso(BASE)}, headers=host)
    assert loc(no_to) == ["query", "to"]


# --- the answer ----------------------------------------------------------------------


async def test_each_date_carries_the_callers_own_answer_and_no_one_elses(client, capsys, db_session_factory):
    """Four dates of one gathering: the invitee answers yes, maybe and no on
    the first three and nothing on the fourth. The host answers yes on the
    fourth and maybe on the first, and a guest's row (no person) says yes on
    the fourth: neither ever shows as the invitee's. Each reads their own,
    and the invitee's answers equal the detail's."""
    host = await _signed_in_headers(client, capsys, "cal-answer-host@example.com")
    dates = [{"starts_at": _iso(BASE + timedelta(days=d))} for d in range(4)]
    created = await _create_standalone(client, host, gathering_type="season", title="Four Fridays", occurrences=dates)
    invitee = await _signed_in_headers(client, capsys, "cal-answer-guest@example.com")
    await _accept(client, invitee, await _invite_token(client, capsys, host, created["id"], "cal-answer-guest@example.com"))
    ids = [o["id"] for o in sorted(created["occurrences"], key=lambda o: o["starts_at"])]
    for occurrence_id, response in zip(ids, ("yes", "maybe", "no")):
        assert (await _put_rsvp(client, invitee, occurrence_id, {"response": response})).status_code in (200, 201)
    assert (await _put_rsvp(client, host, ids[3], {"response": "yes"})).status_code in (200, 201)
    assert (await _put_rsvp(client, host, ids[0], {"response": "maybe"})).status_code in (200, 201)
    async with db_session_factory() as db:
        db.add(RSVP(occurrence_id=UUID(ids[3]), person_id=None, guest_name="Aunt Ruth", response=RSVPResponse.YES))
        await db.commit()

    end = BASE + timedelta(days=7)
    mine = await _read(client, invitee, BASE, end)
    assert [d["caller_response"] for d in mine["dates"]] == ["yes", "maybe", "no", None]
    detail = await _detail_dates(client, invitee, created["id"])
    assert [detail[d["id"]]["caller_response"] for d in mine["dates"]] == ["yes", "maybe", "no", None]
    theirs = await _read(client, host, BASE, end)
    assert [d["caller_response"] for d in theirs["dates"]] == ["maybe", None, None, "yes"]

    # An answer changed is the answer read.
    assert (await _put_rsvp(client, invitee, ids[2], {"response": "yes"})).status_code in (200, 201)
    assert [d["caller_response"] for d in (await _read(client, invitee, BASE, end))["dates"]] == ["yes", "maybe", "yes", None]


# --- position ------------------------------------------------------------------------


async def test_position_and_date_count_are_over_all_the_gatherings_dates(client, capsys, db_session_factory):
    """A season of five dates, a week apart, read through a range covering
    its third and fourth, answers positions 3 and 4 and `date_count` 5 — and
    two dates at one instant are ordered by id, in `position` and in
    `dates`."""
    host = await _signed_in_headers(client, capsys, "cal-position@example.com")
    weekly = [{"starts_at": _iso(BASE + timedelta(weeks=w))} for w in range(5)]
    season = await _create_standalone(client, host, gathering_type="season", title="Five weeks", occurrences=weekly)
    ids = [o["id"] for o in sorted(season["occurrences"], key=lambda o: o["starts_at"])]
    answer = await _read(client, host, BASE + timedelta(weeks=2), BASE + timedelta(weeks=3, days=1))
    assert [d["id"] for d in answer["dates"]] == ids[2:4]
    assert [d["position"] for d in answer["dates"]] == [3, 4]
    assert answer["gatherings"][0]["date_count"] == 5

    later = BASE + timedelta(days=40)
    twins = await _create_standalone(
        client,
        host,
        gathering_type="season",
        title="Twin matches",
        occurrences=[{"starts_at": _iso(later - timedelta(days=1))}, {"starts_at": _iso(later)}, {"starts_at": _iso(later)}],
    )
    tied = sorted(o["id"] for o in twins["occurrences"] if o["starts_at"] == _iso(later))
    answer = await _read(client, host, later, later + timedelta(days=1))
    assert [d["id"] for d in answer["dates"]] == tied
    assert [d["position"] for d in answer["dates"]] == [2, 3]
    assert answer["gatherings"][0]["date_count"] == 3


# --- the photo count -----------------------------------------------------------------


async def test_the_photo_count_is_published_photos_the_caller_can_see_never_the_charge(
    client, capsys, db_session_factory
):
    """Two published photographs, and beside them every other state a row
    can be in — the invitee's own waiting photo, the host's queue, a photo
    in its uploader's bin and one in the gathering's bin, a failed row, the
    three in-flight rungs and both destruction rungs. The keeper's charge,
    `gatherings.photo_count`, is planted at 9. The host, the co-host and the
    invitee each read 2, never 9. A co-host planted with NO invitation row —
    on the calendar by the co-host term, but outside `_visible_media`'s
    `live` branch — reads 0: the count asks the one audience rule, not the
    calendar's. The invitee then bins a published photo: the count drops to
    1 and the charge stays 9. A gathering with no photographs reads 0 and is
    still listed."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid, invitee = world.cast, world.gathering_id, world.invitee_person
    start, end = _world_window(world)
    published = await _published(db_session_factory, gid, invitee, 2, _now() - timedelta(hours=2))

    def plant(by: UUID = invitee, **kwargs):
        return _photo(db_session_factory, gid, by, **kwargs)

    await plant(publication_state=PublicationState.PENDING)
    await plant(by=world.co_admin_person, publication_state=PublicationState.PENDING)
    await plant(publication_state=PublicationState.REMOVED, removed_by_person_id=invitee)
    await plant(publication_state=PublicationState.REMOVED, removed_by_person_id=world.member_person)
    await plant(status=MediaStatus.FAILED, publication_state=PublicationState.PENDING, failure_reason=MediaFailureReason.UNREADABLE)
    for status in (MediaStatus.PENDING_UPLOAD, MediaStatus.UPLOADED, MediaStatus.PROCESSING):
        await plant(status=status, publication_state=PublicationState.PENDING)
    await plant(status=MediaStatus.DESTROYING)
    await plant(status=MediaStatus.DESTROYED)
    async with db_session_factory() as db:
        await _set_photo_count(db, gid, 9)
    empty = (
        await _create_in_group(
            client, cast.member, cast.group_id, title="Nothing yet", occurrences=[{"starts_at": _iso(_now() + timedelta(days=30))}]
        )
    )["id"]
    planted = await _signed_in_headers(client, capsys, PLANTED_CO_HOST)
    await _plant_co_host(db_session_factory, gid, PLANTED_CO_HOST, "member@example.com")

    def counts(answer: dict) -> dict[str, int]:
        return {g["id"]: g["published_count"] for g in answer["gatherings"]}

    for seat, headers in {"host": cast.member, "co-host": cast.co_admin, "invitee": world.invitee}.items():
        answer = await _read(client, headers, start, end)
        assert counts(answer) == {gid: 2, empty: 0}, seat
    assert counts(await _read(client, planted, start, end)) == {gid: 0}

    binned = await _bin(client, world.invitee, published[0])
    assert binned.status_code == 200, binned.text
    async with db_session_factory() as db:
        assert (await db.get(Gathering, UUID(gid))).photo_count == 9
    for seat, headers in {"host": cast.member, "invitee": world.invitee}.items():
        assert counts(await _read(client, headers, start, end))[gid] == 1, seat


async def test_the_photo_count_differs_from_the_charge_where_the_two_differ(client, capsys, db_session_factory):
    """Three published photographs and a charge planted at 3 read 3 — then
    one binned photograph planted beside them, its charge 4: the count stays
    3. The two agree only by accident; the count never reads the charge."""
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    start, end = _world_window(world)
    await _published(db_session_factory, gid, world.invitee_person, 3, _now() - timedelta(hours=1))
    async with db_session_factory() as db:
        await _set_photo_count(db, gid, 3)
    assert (await _read(client, world.cast.member, start, end))["gatherings"][0]["published_count"] == 3
    await _photo(
        db_session_factory, gid, world.invitee_person, publication_state=PublicationState.REMOVED, removed_by_person_id=world.invitee_person
    )
    async with db_session_factory() as db:
        await _set_photo_count(db, gid, 4)
    (gathering,) = (await _read(client, world.cast.member, start, end))["gatherings"]
    assert gathering["published_count"] == 3
    async with db_session_factory() as db:
        assert (await db.get(Gathering, UUID(gid))).photo_count == 4


# --- the body ------------------------------------------------------------------------


async def test_each_date_is_the_details_date_and_each_gathering_the_list_items_facts(client, capsys, db_session_factory):
    """Three gatherings in one range — one with a photo cover, one with an
    uploaded cover, one with none; dates with a place, a map link and an end
    — read by the host, the co-host and the invitee: the answer's keys are
    exactly `dates` and `gatherings`; each date's keys the detail's date's
    plus `position`, and each date EQUALS the matching date in `GET
    /gatherings/{id}` for the same caller, plus `position`; each gathering's
    keys exactly the seven, and its title, type, cover and group equal `GET
    /gatherings`'s item for the same caller."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    start, end = _world_window(world)
    when = _now() + timedelta(days=30, hours=3)
    photo_cover = world.gathering_id
    cover_media = (await _published(db_session_factory, photo_cover, world.invitee_person, 1, _now()))[0]
    await _plant_cover(db_session_factory, GATHERINGS, photo_cover, cover_media, world.member_person)
    uploaded = (
        await _create_in_group(
            client,
            cast.member,
            cast.group_id,
            title="Uploaded cover",
            occurrences=[
                {
                    "starts_at": _iso(when),
                    "ends_at": _iso(when + timedelta(hours=4)),
                    "location": "The boathouse",
                    "map_url": "https://maps.example.com/boathouse",
                }
            ],
        )
    )["id"]
    image = await _plant_image(db_session_factory, gathering_id=uploaded, person_id=world.member_person, status=MediaStatus.READY, **FACTS)
    await _point(db_session_factory, GATHERINGS, uploaded, image, world.member_person)
    plain = (await _create_in_group(client, cast.member, cast.group_id, title="No cover", occurrences=[{"starts_at": _iso(when)}]))["id"]

    for seat, headers in {"host": cast.member, "co-host": cast.co_admin, "invitee": world.invitee}.items():
        answer = await _read(client, headers, start, end)
        assert set(answer) == ANSWER_KEYS, seat
        assert {g["id"] for g in answer["gatherings"]} == {photo_cover, uploaded, plain}, seat
        listed = await _list_items(client, headers)
        for gathering in answer["gatherings"]:
            assert set(gathering) == GATHERING_KEYS, seat
            for fact in LIST_FACTS:
                assert gathering[fact] == listed[gathering["id"]][fact], (seat, fact)
        covers = {g["id"]: g["cover"] for g in answer["gatherings"]}
        assert covers[photo_cover]["source"] == "photo" and covers[uploaded]["source"] == "upload", seat
        assert covers[plain] is None, seat
        for date in answer["dates"]:
            assert set(date) == DATE_KEYS, seat
            detail = await _detail_dates(client, headers, date["gathering_id"])
            assert date == {**detail[date["id"]], "position": date["position"]}, seat
        boathouse = next(d for d in answer["dates"] if d["gathering_id"] == uploaded)
        assert boathouse["location"] == "The boathouse" and boathouse["ends_at"] is not None


async def test_the_order_and_only_gatherings_with_a_date_in_range(client, capsys, db_session_factory):
    """Dates run by `starts_at`, then `gathering_id`, then id; `gatherings`
    run by their first date in `dates`, once each; a gathering of the
    caller's whose dates all fall outside the range is in neither list.
    Three gatherings, made until their creation order is neither their ids'
    order nor its reverse, share their first date's instant; a fourth
    starts earlier but is made last; a fifth has its one date next month."""
    host = await _signed_in_headers(client, capsys, "cal-order@example.com")
    tied = BASE + timedelta(days=2)
    made: list[str] = []
    while len(made) < 3 or made in (sorted(made), sorted(made, reverse=True)):
        created = await _create_standalone(
            client,
            host,
            gathering_type="season",
            title=f"Tie {len(made)}",
            occurrences=[{"starts_at": _iso(tied)}, {"starts_at": _iso(tied + timedelta(days=len(made) + 1))}],
        )
        made.append(created["id"])
    first = (await _create_standalone(client, host, title="Earliest", occurrences=[{"starts_at": _iso(BASE)}]))["id"]
    outside = (await _create_standalone(client, host, title="Next month", occurrences=[{"starts_at": _iso(BASE + timedelta(days=40))}]))[
        "id"
    ]

    answer = await _read(client, host, BASE, BASE + timedelta(days=14))
    assert _gathering_ids(answer) == [first, *sorted(made)]
    keys = [(d["starts_at"], d["gathering_id"], d["id"]) for d in answer["dates"]]
    assert keys == sorted(keys, key=lambda k: (datetime.fromisoformat(k[0]), k[1], k[2]))
    # Each gathering's first date is in the first 1 + len(made) dates: the
    # loop above makes a fourth or more when the first three come out sorted.
    assert [d["gathering_id"] for d in answer["dates"][: 1 + len(made)]] == [first, *sorted(made)]
    assert len(answer["dates"]) == 1 + 2 * len(made)
    assert outside not in str(answer)


async def test_no_email_no_person_id_and_no_url_in_either_answer(client, capsys, db_session_factory, monkeypatch):
    """Every seat that reads the world's gathering, on both routes, with a
    photo cover set and the caller's answers saved: no address, no `@`, no
    person id, no `http` beyond the date's own map link (none set here), no
    `X-Amz` — and nothing minted."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    start, end = _world_window(world)
    cover_media = (await _published(db_session_factory, world.gathering_id, world.invitee_person, 1, _now()))[0]
    await _plant_cover(db_session_factory, GATHERINGS, world.gathering_id, cover_media, world.member_person)
    assert (await _put_rsvp(client, world.invitee, world.date_id, {"response": "yes"})).status_code in (200, 201)
    minted: list = []
    from app.api import media as media_api

    monkeypatch.setattr(media_api, "presign_read", lambda *args, **kwargs: minted.append(args))
    async with db_session_factory() as db:
        person_ids = {str(p) for p in (await db.scalars(select(Person.id))).all()}
    for headers in (cast.member, cast.co_admin, world.invitee):
        for group_id in (None, cast.group_id):
            response = await _calendar(client, headers, start, end, group_id)
            assert response.status_code == 200, response.text
            text = response.text
            assert world.gathering_id in text
            assert "http" not in text and "x-amz" not in text.lower()
            assert "@" not in text
            for address in ADDRESSES:
                assert address not in text
            for person_id in person_ids:
                assert person_id not in text
    assert minted == []


# --- one statement -------------------------------------------------------------------


async def test_one_statement_after_the_auth_read_however_many_gatherings_and_dates(client, capsys, db_session_factory):
    """After the auth read (and the group's read on the group route), ONE
    statement answers every date and every gathering — their answers, their
    places, their counts, their covers and groups, their photo counts —
    whether there is one gathering with one date or five gatherings holding
    thirty dates (the CK-20 discipline; the `before_cursor_execute`
    listener of tests/test_group_gatherings.py)."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    start, end = _now() + timedelta(days=1), _now() + timedelta(days=60)
    await _published(db_session_factory, world.gathering_id, world.invitee_person, 2, _now())
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count(group_id: str | None) -> tuple[int, int, int]:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            answer = await _read(client, cast.member, start, end, group_id)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        reads_dates = [i for i, s in enumerate(statements) if re.search(r"\boccurrences\b", s)]
        assert reads_dates == [len(statements) - 1], statements
        return len(statements), len(answer["gatherings"]), len(answer["dates"])

    for group_id in (None, cast.group_id):
        await _read(client, cast.member, start, end, group_id)  # warm the session's refresh
    at_one = {g: await count(g) for g in (None, cast.group_id)}
    assert [(n_g, n_d) for _, n_g, n_d in at_one.values()] == [(1, 1), (1, 1)]

    for n in range(4):
        dates = [{"starts_at": _iso(_now() + timedelta(days=5 + 7 * w, hours=n))} for w in range(7 if n < 3 else 8)]
        await _create_in_group(client, cast.member, cast.group_id, gathering_type="season", title=f"Season {n}", occurrences=dates)
    # The world's date, then 7 + 7 + 7 + 8: thirty dates in five gatherings.
    at_five = {g: await count(g) for g in (None, cast.group_id)}
    for g in (None, cast.group_id):
        assert at_five[g][1:] == (5, 30), at_five
        assert at_five[g][0] == at_one[g][0], (g, at_one, at_five)


# --- nothing logged ------------------------------------------------------------------


async def test_the_router_has_no_logger_and_logs_nothing(client, capsys, db_session_factory, caplog):
    world = await _world(client, capsys, db_session_factory)
    assert not hasattr(calendar_api, "logger")
    start, end = _world_window(world)
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (await _calendar(client, world.invitee, start, end)).status_code == 200
        assert (await _calendar(client, world.cast.stranger, start, end, world.cast.group_id)).status_code == 404
    application = [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]
    assert application == []
