"""Reactions on a chat's messages (CK-104; the chat record §4, §5, P14;
Steven's approval of 2026-11-25).

`PUT /messages/{id}/reactions` takes `{"kind", "on"}` and answers that
message's reactions as the caller sees them; `GET` the same answers who left
each kind, names only.

- **Who**: anyone who can read the message, by the chat's own two doors.
  Everyone else, a message that doesn't exist and a removed one — for the
  people who run the place too — draw one 404, byte-identical.
- **A line the chat wrote** is 409 `not_a_message`; an unknown kind a 422.
- **Guarded, never read-then-assign**: an INSERT … SELECT from the live
  message ON CONFLICT DO NOTHING, a DELETE where the message is live, and the
  stamp (`posts.reactions_updated_at`) in the same transaction, only when a
  row was added or taken away.
- **An item carries `reactions`**: the kinds present, in the kinds' order,
  each with its count — null in a memorial gathering's chat, on every answer
  — and whether the caller left one.
- **The poll** returns a message whose reactions changed.
- **Account deletion** takes the person's reactions and stamps the messages
  they were on; leaving a group keeps them; a message the sweep destroys
  takes its reactions with it.

Migration 0039 and the verifier's lines are in tests/test_chat_0039.py.
"""

import asyncio
import logging
import re
from datetime import datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import event, text

from app.db import engine
from app.services import destruction
from app.services.retention import REMOVED_BIN
from tests.test_account_deletion import DELETE_BODY
from tests.test_chat import (
    JOINER,
    PLAIN,
    _answer,
    _by_id,
    _chat_api,
    _code,
    _gread,
    _gsend,
    _invite_into_group,
    _now,
    _plant_message,
    _post,
    _remove_message,
    _sent,
    _xread,
    _xsend,
)
from tests.test_chat_container import _container
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_gatherings import _create as _create_standalone
from tests.test_group_gatherings import _create_in_group
from tests.test_group_membership import ADMIN, MEMBER, _cast, _leave, _person_id
from tests.test_groups import MISSING
from tests.test_member_places import _extra_member
from tests.test_outside_invitations import INVITEE, OUTSIDER, _let_in, _on, _world
from tests.test_race_backstops import _select_from, _stage

KINDS = ["like", "heart", "laugh", "surprise", "sad", "thumbs_up", "celebrate"]
LATER = "later@example.com"


# --- routes --------------------------------------------------------------------------


async def _react(client, headers, message_id: str, kind: str = "like", on: bool = True):
    return await client.put(f"/messages/{message_id}/reactions", json={"kind": kind, "on": on}, headers=headers)


async def _who(client, headers, message_id: str):
    return await client.get(f"/messages/{message_id}/reactions", headers=headers)


async def _reacted(response) -> list[dict]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"reactions"}
    return body["reactions"]


def _one(kind: str, count: int | None = 1, mine: bool = True) -> dict:
    return {"kind": kind, "count": count, "mine": mine}


async def _no_such_message(client, headers, method: str = "PUT") -> tuple[int, bytes]:
    response = await (_react(client, headers, MISSING) if method == "PUT" else _who(client, headers, MISSING))
    assert response.status_code == 404 and response.json() == {"detail": "No such message."}, response.text
    return response.status_code, response.content


async def _rows(db_session_factory, message_id: str) -> list[tuple[UUID, str]]:
    async with db_session_factory() as db:
        return [
            tuple(row)
            for row in await db.execute(
                text(
                    "SELECT person_id, kind::text FROM post_reactions WHERE post_id = :p ORDER BY person_id, kind"
                ),
                {"p": UUID(message_id)},
            )
        ]


async def _stamp(db_session_factory, message_id: str) -> datetime | None:
    async with db_session_factory() as db:
        return await db.scalar(text("SELECT reactions_updated_at FROM posts WHERE id = :p"), {"p": UUID(message_id)})


async def _plant_reaction(db_session_factory, message_id: str, address: str, kind: str, *, at: str = "now()") -> None:
    async with db_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO post_reactions (post_id, person_id, kind, created_at) "
                f"SELECT :p, id, CAST(:k AS post_reaction_kind), {at} FROM people WHERE email = :e"
            ),
            {"p": UUID(message_id), "k": kind, "e": address},
        )
        await db.commit()


async def _long_in_the_group(db_session_factory, group_id: str, days: int = 60) -> None:
    """Every member's window opens `days` ago, so a message planted in the
    past is inside it."""
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE memberships SET created_at = now() - make_interval(days => :d) WHERE group_id = :g"),
            {"d": days, "g": UUID(group_id)},
        )
        await db.commit()


async def _without_a_membership(db_session_factory, group_id: str, address: str) -> None:
    async with db_session_factory() as db:
        await db.execute(
            text(
                "DELETE FROM memberships WHERE group_id = :g AND person_id = "
                "(SELECT id FROM people WHERE email = :e)"
            ),
            {"g": UUID(group_id), "e": address},
        )
        await db.commit()


async def _old_message(db_session_factory, group_id: str, address: str = MEMBER, body: str = "An hour ago") -> str:
    """A message an hour old in the group's chat: a poll from now is nowhere
    near the span it was written in, so only a change can bring it back."""
    await _long_in_the_group(db_session_factory, group_id)
    container = await _container(db_session_factory, group_id)
    return await _plant_message(db_session_factory, container, address, body, at="now() - interval '1 hour'")


async def _memorial(client, headers, **overrides) -> dict:
    return await _create_standalone(
        client, headers, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith Hanson", **overrides
    )


# --- adding and taking away, by seat ------------------------------------------------------


async def test_a_reaction_is_added_and_taken_away_by_every_reader_of_a_groups_chat(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    plain, _, plain_person = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    assert await _stamp(db_session_factory, message) is None  # nothing has changed yet

    assert await _reacted(await _react(client, cast.admin, message, "heart")) == [_one("heart")]
    assert await _reacted(await _react(client, cast.co_admin, message, "heart")) == [_one("heart", 2)]
    # Your own message, and a member who runs nothing.
    assert await _reacted(await _react(client, cast.member, message, "like")) == [
        _one("like"),
        _one("heart", 2, mine=False),
    ]
    assert await _reacted(await _react(client, plain, message, "celebrate")) == [
        _one("like", 1, mine=False),
        _one("heart", 2, mine=False),
        _one("celebrate"),
    ]
    assert (plain_person, "celebrate") in await _rows(db_session_factory, message)

    assert await _reacted(await _react(client, cast.admin, message, "heart", on=False)) == [
        _one("like", 1, mine=False),
        _one("heart", 1, mine=False),
        _one("celebrate", 1, mine=False),
    ]
    assert await _reacted(await _react(client, cast.co_admin, message, "heart", on=False)) == [
        _one("like", 1, mine=False),
        _one("celebrate", 1, mine=False),
    ]
    assert [kind for _, kind in sorted(await _rows(db_session_factory, message), key=lambda r: r[1])] == [
        "celebrate",
        "like",
    ]


async def test_a_reaction_is_added_and_taken_away_by_every_reader_of_a_gatherings_chat(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    message = (await _sent(await _xsend(client, world.invitee, gid, "Pie?")))["id"]
    count = 0
    for headers in (cast.member, world.co_host, world.invitee, cast.admin, outsider):
        count += 1
        assert await _reacted(await _react(client, headers, message, "laugh")) == [_one("laugh", count)]
    for headers in (cast.member, world.co_host, world.invitee, cast.admin, outsider):
        answered = await _reacted(await _react(client, headers, message, "laugh", on=False))
        count -= 1
        assert answered == ([_one("laugh", count, mine=False)] if count else [])
    assert await _rows(db_session_factory, message) == []


async def test_adding_what_is_there_and_taking_away_what_is_not_change_nothing_and_stamp_nothing(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    # Taking away what was never there.
    assert await _reacted(await _react(client, cast.admin, message, "sad", on=False)) == []
    assert await _stamp(db_session_factory, message) is None

    assert await _reacted(await _react(client, cast.admin, message, "sad")) == [_one("sad")]
    added = await _stamp(db_session_factory, message)
    assert added is not None
    rows = await _rows(db_session_factory, message)
    assert await _reacted(await _react(client, cast.admin, message, "sad")) == [_one("sad")]
    assert await _rows(db_session_factory, message) == rows
    assert await _stamp(db_session_factory, message) == added  # nothing changed, so nothing stamped

    assert await _reacted(await _react(client, cast.admin, message, "sad", on=False)) == []
    taken = await _stamp(db_session_factory, message)
    assert taken > added
    assert await _reacted(await _react(client, cast.admin, message, "sad", on=False)) == []
    assert await _stamp(db_session_factory, message) == taken


async def test_a_person_may_leave_one_of_each_kind_on_one_message(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    # Left in an order that is not the kinds'; answered in the kinds' order.
    for kind in ("celebrate", "sad", "like", "thumbs_up", "surprise", "heart", "laugh"):
        assert (await _react(client, cast.admin, message, kind)).status_code == 200
    assert await _reacted(await _react(client, cast.admin, message, "like")) == [_one(kind) for kind in KINDS]
    (item,) = (await _answer(await _gread(client, cast.member, cast.group_id)))["items"]
    assert item["reactions"] == [_one(kind, mine=False) for kind in KINDS]


# --- refusals --------------------------------------------------------------------------


async def test_the_body_takes_exactly_kind_and_on(client, capsys, db_session_factory):
    assert (await client.put(f"/messages/{MISSING}/reactions", json={"kind": "like", "on": True})).status_code == 401
    assert (await client.get(f"/messages/{MISSING}/reactions")).status_code == 401
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]

    async def refused(body: dict) -> list[list]:
        response = await client.put(f"/messages/{message}/reactions", json=body, headers=cast.admin)
        assert response.status_code == 422, (body, response.text)
        return [entry["loc"] for entry in response.json()["detail"]]

    for kind in ("hug", "LIKE", "Like", "", "like ", "❤️", None, 1, ["like"]):
        assert await refused({"kind": kind, "on": True}) == [["body", "kind"]], kind
    for on in ("true", 1, None, "yes"):
        assert await refused({"kind": "like", "on": on}) == [["body", "on"]], on
    assert await refused({"on": True}) == [["body", "kind"]]
    assert await refused({"kind": "like"}) == [["body", "on"]]
    assert await refused({"kind": "like", "on": True, "person_id": MISSING}) == [["body", "person_id"]]
    assert await _rows(db_session_factory, message) == []
    assert await _stamp(db_session_factory, message) is None


async def test_everyone_who_cannot_read_the_message_draws_one_404(client, capsys, db_session_factory):
    """Byte-identical to a missing id's on both routes: a stranger, a member
    of the group only shared with, one left out of the gathering, a group
    admin with no membership, a member whose window opened after it, one who
    has left, and an outsider on the group's own chat."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    in_group = (await _sent(await _gsend(client, cast.member, cast.group_id, "In the group")))["id"]
    in_gathering = (await _sent(await _xsend(client, cast.member, gid, "In the gathering")))["id"]
    later = await _invite_into_group(client, capsys, cast.admin, cast.group_id, LATER)
    leaver, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    await _reacted(await _react(client, cast.member, in_group, "like"))
    await _reacted(await _react(client, cast.member, in_gathering, "like"))
    assert (await _leave(client, leaver, cast.group_id)).status_code == 204
    await _without_a_membership(db_session_factory, cast.group_id, ADMIN)  # still the admin, no longer a member

    for headers, message in (
        (cast.stranger, in_group),
        (cast.stranger, in_gathering),
        (cast.co_admin, in_gathering),  # only shared with
        (later, in_gathering),  # joined after: shared with, on a chosen gathering
        (cast.admin, in_group),  # the admin's seat alone opens nothing
        (later, in_group),  # written before they joined
        (leaver, in_group),
        (outsider, in_group),
    ):
        for on in (True, False):
            refused = await _react(client, headers, message, "heart", on=on)
            assert (refused.status_code, refused.content) == await _no_such_message(client, headers)
        refused = await _who(client, headers, message)
        assert (refused.status_code, refused.content) == await _no_such_message(client, headers, "GET")
    for message in (in_group, in_gathering):
        assert [kind for _, kind in await _rows(db_session_factory, message)] == ["like"]


async def test_a_removed_message_is_the_404_for_everyone_the_people_who_run_the_place_included(
    client, capsys, db_session_factory
):
    """A held message has no reactions to add to, take from or read."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    in_group = (await _sent(await _gsend(client, cast.member, cast.group_id, "In the group")))["id"]
    in_gathering = (await _sent(await _xsend(client, world.invitee, gid, "In the gathering")))["id"]
    await _reacted(await _react(client, cast.admin, in_group, "heart"))
    await _reacted(await _react(client, cast.member, in_gathering, "heart"))
    stamps = {m: await _stamp(db_session_factory, m) for m in (in_group, in_gathering)}
    assert (await _remove_message(client, cast.admin, in_group)).status_code == 204
    assert (await _remove_message(client, cast.member, in_gathering)).status_code == 204
    for headers, message in (
        (cast.admin, in_group),
        (cast.co_admin, in_group),
        (cast.member, in_group),  # its writer
        (cast.member, in_gathering),
        (world.co_host, in_gathering),
        (world.invitee, in_gathering),  # its writer
    ):
        for kind, on in (("laugh", True), ("heart", True), ("heart", False)):
            refused = await _react(client, headers, message, kind, on=on)
            assert (refused.status_code, refused.content) == await _no_such_message(client, headers), refused.text
        refused = await _who(client, headers, message)
        assert (refused.status_code, refused.content) == await _no_such_message(client, headers, "GET")
    for message in (in_group, in_gathering):
        # What was left on it before is still there, and goes when it does.
        assert [kind for _, kind in await _rows(db_session_factory, message)] == ["heart"]
        assert await _stamp(db_session_factory, message) == stamps[message]
    held = _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))[in_group]
    assert held["removed"] is not None and held["reactions"] == []


async def test_a_line_the_chat_wrote_takes_no_reaction(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    (join_line,) = [
        i for i in (await _answer(await _gread(client, cast.admin, cast.group_id)))["items"] if i["kind"] == "joined"
    ]
    await _on(client, cast.member, gid)
    (setting_line,) = (await _answer(await _xread(client, cast.member, gid)))["items"]
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    assert join_line["reactions"] == [] and setting_line["reactions"] == []
    for headers, line in ((cast.admin, join_line), (joiner, join_line), (world.invitee, setting_line)):
        for refused in (
            await _react(client, headers, line["id"]),
            await _react(client, headers, line["id"], on=False),
            await _who(client, headers, line["id"]),
        ):
            assert refused.status_code == 409 and _code(refused) == "not_a_message", refused.text
    # One who is not shown the line learns nothing of it.
    for headers, line in ((outsider, setting_line), (cast.stranger, join_line)):
        refused = await _react(client, headers, line["id"])
        assert (refused.status_code, refused.content) == await _no_such_message(client, headers)
        refused = await _who(client, headers, line["id"])
        assert (refused.status_code, refused.content) == await _no_such_message(client, headers, "GET")
    assert await _rows(db_session_factory, join_line["id"]) == []


# --- at once ---------------------------------------------------------------------------


async def test_two_adds_of_one_kind_at_once_leave_one_row_and_one_stamp(client, capsys, db_session_factory):
    """A competitor has added the same person's same kind and not committed;
    the route's INSERT waits on that key and then does nothing. Read-then-add
    would read none, add a second and answer the key's violation: a 500."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Racing")))["id"]
    admin_person = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as competitor:
        await competitor.execute(
            text("INSERT INTO post_reactions (post_id, person_id, kind) VALUES (:p, :a, 'heart')"),
            {"p": UUID(message), "a": admin_person},
        )
        await competitor.execute(
            text("UPDATE posts SET reactions_updated_at = now() - interval '5 minutes' WHERE id = :p"),
            {"p": UUID(message)},
        )
        route = asyncio.create_task(_react(client, cast.admin, message, "heart"))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    try:
        raced = await route
    except Exception as exc:  # an escaped IntegrityError, the 500, under ASGITransport
        pytest.fail(f"the route raised {type(exc).__name__}: {exc}")
    assert seen == "waiting", f"the route never met the competitor's row ({seen})"
    assert await _reacted(raced) == [_one("heart")]
    assert await _rows(db_session_factory, message) == [(admin_person, "heart")]
    stamp = await _stamp(db_session_factory, message)
    assert _now() - stamp > timedelta(minutes=4), "the second add changed nothing, so it stamps nothing"


async def test_a_reaction_during_a_removal_is_the_404_and_leaves_no_row(client, capsys, db_session_factory):
    """A removal has written and not committed as the reaction is added: the
    stamp waits on the removal's row, finds the message no longer live, and
    the reaction goes with it."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Racing")))["id"]
    async with db_session_factory() as competitor:
        await competitor.execute(
            text(
                "UPDATE posts SET publication_state = 'removed', removed_at = now(), "
                "removed_by_person_id = author_person_id WHERE id = :p AND publication_state = 'live'"
            ),
            {"p": UUID(message)},
        )
        route = asyncio.create_task(_react(client, cast.admin, message, "heart"))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    raced = await route
    assert seen == "waiting", seen
    assert (raced.status_code, raced.content) == await _no_such_message(client, cast.admin)
    assert await _rows(db_session_factory, message) == []
    assert await _stamp(db_session_factory, message) is None


@pytest.mark.parametrize("on", [True, False])
@pytest.mark.parametrize("gone", ["removed", "deleted"])
async def test_a_message_that_goes_after_the_door_is_the_404_never_a_500(
    client, capsys, db_session_factory, monkeypatch, on, gone
):
    """Staged: the message is removed, or destroyed, after the route has read
    it and before its own write."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Racing")))["id"]
    if not on:
        await _reacted(await _react(client, cast.admin, message, "heart"))
    before = await _rows(db_session_factory, message)

    async def it_goes() -> None:
        async with db_session_factory() as other:
            if gone == "removed":
                await other.execute(
                    text(
                        "UPDATE posts SET publication_state = 'removed', removed_at = now(), "
                        "removed_by_person_id = author_person_id WHERE id = :p"
                    ),
                    {"p": UUID(message)},
                )
            else:
                await other.execute(text("DELETE FROM posts WHERE id = :p"), {"p": UUID(message)})
            await other.commit()

    state = _stage(monkeypatch, when=_select_from("posts"), competitor=it_goes)
    raced = await _react(client, cast.admin, message, "heart", on=on)
    assert state["fired"], "the race was not staged"
    assert (raced.status_code, raced.content) == await _no_such_message(client, cast.admin)
    assert await _rows(db_session_factory, message) == (before if gone == "removed" else [])


async def test_a_reaction_during_its_persons_deletion_leaves_no_row(client, capsys, db_session_factory):
    """The deletion has anonymized the person and not committed: the reaction
    waits on them, finds them gone, and adds nothing an anonymized person
    would hold."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Racing")))["id"]
    admin_person = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as competitor:
        await competitor.execute(
            text("UPDATE people SET anonymized_at = now(), email = NULL, display_name = 'a former member' WHERE id = :a"),
            {"a": admin_person},
        )
        route = asyncio.create_task(_react(client, cast.admin, message, "heart"))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    raced = await route
    assert seen == "waiting", seen
    assert raced.status_code == 404, raced.text
    assert await _rows(db_session_factory, message) == []


# --- what an item carries -----------------------------------------------------------------


async def test_an_item_carries_its_reactions_as_its_reader_sees_them(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    first = (await _sent(await _xsend(client, world.invitee, gid, "One")))["id"]
    second = await _sent(await _xsend(client, world.invitee, gid, "Two"))
    assert second["reactions"] == []  # a message just sent carries none
    for headers, kind in (
        (cast.member, "thumbs_up"),
        (world.co_host, "thumbs_up"),
        (world.invitee, "like"),
        (cast.admin, "like"),
        (cast.admin, "celebrate"),
    ):
        await _reacted(await _react(client, headers, first, kind))
    # The kinds' own order, which is neither the alphabet's nor the order
    # they were left in.
    seen = {
        "host": (cast.member, [_one("like", 2, False), _one("thumbs_up", 2, True), _one("celebrate", 1, False)]),
        "co_host": (world.co_host, [_one("like", 2, False), _one("thumbs_up", 2, True), _one("celebrate", 1, False)]),
        "invitee": (world.invitee, [_one("like", 2, True), _one("thumbs_up", 2, False), _one("celebrate", 1, False)]),
        "admin": (cast.admin, [_one("like", 2, True), _one("thumbs_up", 2, False), _one("celebrate", 1, True)]),
    }
    for seat, (headers, expected) in seen.items():
        items = _by_id(await _answer(await _xread(client, headers, gid)))
        assert items[first]["reactions"] == expected, seat
        assert items[second["id"]]["reactions"] == [], seat
        polled = _by_id(await _answer(await _xread(client, headers, gid, since=_now().isoformat())))
        assert polled[first]["reactions"] == expected, seat


async def test_a_memorials_reactions_never_carry_a_number(client, capsys, db_session_factory):
    """Record §4 rule 4: on the item, on a poll, on the answer to a reaction,
    in a standalone memorial and in a group's. Everywhere else the number is
    there."""
    cast = await _cast(client, capsys, db_session_factory)
    standalone = (await _memorial(client, cast.admin))["id"]
    in_group = (
        await _create_in_group(
            client,
            cast.admin,
            cast.group_id,
            gathering_type="memorial",
            title="For Edith",
            memorial_decedent_name="Edith Hanson",
        )
    )["id"]
    ordinary = (await _create_in_group(client, cast.admin, cast.group_id, title="Sunday dinner"))["id"]
    for gid in (standalone, in_group):
        message = (await _sent(await _xsend(client, cast.admin, gid, "We miss her")))["id"]
        assert await _reacted(await _react(client, cast.admin, message, "heart")) == [_one("heart", None)]
        assert await _reacted(await _react(client, cast.admin, message, "sad")) == [_one("heart", None), _one("sad", None)]
        for answer in (
            await _answer(await _xread(client, cast.admin, gid)),
            await _answer(await _xread(client, cast.admin, gid, since=_now().isoformat())),
        ):
            assert _by_id(answer)[message]["reactions"] == [_one("heart", None), _one("sad", None)]
        assert await _reacted(await _react(client, cast.admin, message, "sad", on=False)) == [_one("heart", None)]
    message = (await _sent(await _xsend(client, cast.admin, in_group, "Two of us")))["id"]
    await _reacted(await _react(client, cast.admin, message, "heart"))
    assert await _reacted(await _react(client, cast.member, message, "heart")) == [_one("heart", None)]
    items = _by_id(await _answer(await _xread(client, cast.co_admin, in_group)))
    assert items[message]["reactions"] == [_one("heart", None, mine=False)]
    for send, react_on in ((_xsend, ordinary), (_gsend, cast.group_id)):
        message = (await _sent(await send(client, cast.admin, react_on, "Counted")))["id"]
        assert await _reacted(await _react(client, cast.admin, message, "heart")) == [_one("heart", 1)]


async def test_the_poll_returns_a_message_whose_reactions_changed(client, capsys, db_session_factory):
    """An hour-old message is nowhere near the poll's span; a reaction added
    to it, and one taken away, each bring it back, as its reader sees it."""
    cast = await _cast(client, capsys, db_session_factory)
    message = await _old_message(db_session_factory, cast.group_id)
    quiet = await _answer(await _gread(client, cast.admin, cast.group_id, since=_now().isoformat()))
    assert quiet["items"] == [] and quiet["removed"] == []

    await _reacted(await _react(client, cast.admin, message, "heart"))
    for headers, mine in ((cast.member, False), (cast.admin, True)):
        polled = await _answer(await _gread(client, headers, cast.group_id, since=_now().isoformat()))
        (item,) = polled["items"]
        assert item["id"] == message and item["body"] == "An hour ago" and item["removed"] is None
        assert item["reactions"] == [_one("heart", 1, mine)]
        assert polled["removed"] == []

    async with db_session_factory() as db:  # the add's stamp, moved out of the span
        await db.execute(text("UPDATE posts SET reactions_updated_at = now() - interval '1 hour'"))
        await db.commit()
    assert (await _answer(await _gread(client, cast.member, cast.group_id, since=_now().isoformat())))["items"] == []
    await _reacted(await _react(client, cast.admin, message, "heart", on=False))
    (item,) = (await _answer(await _gread(client, cast.member, cast.group_id, since=_now().isoformat())))["items"]
    assert item["id"] == message and item["reactions"] == []


async def test_a_change_to_a_message_the_caller_is_not_shown_brings_nothing_back(client, capsys, db_session_factory):
    """A held message's stamp, and one before the caller's window, are in no
    poll of theirs."""
    cast = await _cast(client, capsys, db_session_factory)
    message = await _old_message(db_session_factory, cast.group_id)
    await _reacted(await _react(client, cast.admin, message, "heart"))
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    polled = await _answer(await _gread(client, joiner, cast.group_id, since=_now().isoformat()))
    assert message not in _by_id(polled) and message not in polled["removed"]
    async with db_session_factory() as db:  # removed an hour ago, stamped just now
        await db.execute(
            text(
                "UPDATE posts SET publication_state = 'removed', removed_at = now() - interval '1 hour', "
                "removed_by_person_id = author_person_id, reactions_updated_at = now() WHERE id = :p"
            ),
            {"p": UUID(message)},
        )
        await db.commit()
    polled = await _answer(await _gread(client, cast.member, cast.group_id, since=_now().isoformat()))
    assert message not in _by_id(polled)


# --- who reacted -------------------------------------------------------------------------


async def test_who_reacted_is_names_alone_oldest_first_in_the_kinds_order(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    message = (await _sent(await _xsend(client, world.invitee, gid, "Pie?")))["id"]
    assert (await _who(client, cast.member, message)).json() == {"reactions": []}
    # Newest planted first, so the order can only come from the instant.
    for address, kind, at in (
        (MEMBER, "heart", "now() - interval '1 minute'"),
        (ADMIN, "heart", "now() - interval '3 minutes'"),
        (INVITEE, "heart", "now() - interval '2 minutes'"),
        (ADMIN, "celebrate", "now() - interval '9 minutes'"),
        (INVITEE, "like", "now()"),
    ):
        await _plant_reaction(db_session_factory, message, address, kind, at=at)
    async with db_session_factory() as db:
        names = dict((await db.execute(text("SELECT email, display_name FROM people WHERE email IS NOT NULL"))).all())
    expected = {
        "reactions": [
            {"kind": "like", "names": [names[INVITEE]]},
            {"kind": "heart", "names": [names[ADMIN], names[INVITEE], names[MEMBER]]},
            {"kind": "celebrate", "names": [names[ADMIN]]},
        ]
    }
    for headers in (cast.member, world.co_host, world.invitee, cast.admin):
        response = await _who(client, headers, message)
        assert response.status_code == 200 and response.json() == expected
    # A memorial's is the same answer: there is no number in it to withhold.
    memorial = (await _memorial(client, cast.admin))["id"]
    message = (await _sent(await _xsend(client, cast.admin, memorial, "We miss her")))["id"]
    await _reacted(await _react(client, cast.admin, message, "heart"))
    assert (await _who(client, cast.admin, message)).json() == {
        "reactions": [{"kind": "heart", "names": [names[ADMIN]]}]
    }


# --- what takes them away -----------------------------------------------------------------


async def test_deleting_an_account_takes_its_reactions_and_stamps_the_messages_they_were_on(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    plain, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    message = await _old_message(db_session_factory, cast.group_id)
    other = await _old_message(db_session_factory, cast.group_id, body="Not touched")
    both = await _old_message(db_session_factory, cast.group_id, body="Two people")
    await _reacted(await _react(client, plain, message, "heart"))
    await _reacted(await _react(client, plain, both, "heart"))
    await _reacted(await _react(client, cast.admin, both, "heart"))
    await _reacted(await _react(client, cast.admin, other, "like"))
    async with db_session_factory() as db:
        await db.execute(text("UPDATE posts SET reactions_updated_at = now() - interval '1 hour'"))
        await db.commit()
    untouched = await _stamp(db_session_factory, other)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=plain)).status_code == 204
    admin_person = await _person_id(db_session_factory, ADMIN)
    assert await _rows(db_session_factory, message) == []
    assert await _rows(db_session_factory, both) == [(admin_person, "heart")]
    assert await _stamp(db_session_factory, other) == untouched
    # An open chat drops the chips at its next check, and only theirs.
    polled = _by_id(await _answer(await _gread(client, cast.member, cast.group_id, since=_now().isoformat())))
    assert set(polled) == {message, both}
    assert polled[message]["reactions"] == []
    assert polled[both]["reactions"] == [_one("heart", 1, mine=False)]


async def test_leaving_a_group_keeps_a_persons_reactions(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    plain, _, plain_person = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    await _reacted(await _react(client, plain, message, "heart"))
    stamp = await _stamp(db_session_factory, message)
    assert (await _leave(client, plain, cast.group_id)).status_code == 204
    assert await _rows(db_session_factory, message) == [(plain_person, "heart")]
    assert await _stamp(db_session_factory, message) == stamp
    (item,) = (await _answer(await _gread(client, cast.admin, cast.group_id)))["items"]
    assert item["reactions"] == [_one("heart", 1, mine=False)]


async def test_a_message_the_sweep_destroys_takes_its_reactions_with_it(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    doomed = await _old_message(db_session_factory, cast.group_id)
    kept = await _old_message(db_session_factory, cast.group_id, body="Kept")
    await _reacted(await _react(client, cast.admin, doomed, "heart"))
    await _reacted(await _react(client, cast.admin, kept, "heart"))
    now = _now()
    async with db_session_factory() as db:
        await db.execute(
            text(
                "UPDATE posts SET publication_state = 'removed', removed_at = :r, "
                "removed_by_person_id = author_person_id WHERE id = :p"
            ),
            {"r": now - REMOVED_BIN, "p": UUID(doomed)},
        )
        await db.commit()
    async with db_session_factory() as db:
        assert await destruction.sweep_expired_messages(db, now) == 1
        await db.commit()
    assert await _rows(db_session_factory, doomed) == []
    assert len(await _rows(db_session_factory, kept)) == 1


# --- statements, and nothing logged ---------------------------------------------------------


async def test_reactions_add_no_statement_to_a_read_however_many_there_are(client, capsys, db_session_factory):
    """The page's reactions are in the read's own statement. And who reacted
    is one read, after the door's."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count(read) -> list[str]:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            response = await read()
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        assert response.status_code == 200, response.text
        return list(statements)

    reads = {
        "read": lambda: _gread(client, cast.admin, cast.group_id),
        "poll": lambda: _gread(client, cast.admin, cast.group_id, since=_now().isoformat()),
        "who": lambda: _who(client, cast.admin, message),
    }
    for read in reads.values():
        await read()  # the session's refresh
    none = {name: len(await count(read)) for name, read in reads.items()}
    for kind in KINDS:
        for headers in (cast.admin, cast.co_admin, cast.member):
            await _reacted(await _react(client, headers, message, kind))
    many = {name: await count(read) for name, read in reads.items()}
    assert {name: len(made) for name, made in many.items()} == none
    for name, made in many.items():
        touching = [i for i, s in enumerate(made) if re.search(r"\bpost_reactions\b", s)]
        assert touching == [len(made) - 1], (name, made)


async def test_no_record_carries_a_kind_a_word_a_name_or_an_id(client, capsys, db_session_factory, caplog):
    chat = _chat_api()
    assert "getLogger" not in open(chat.__file__, encoding="utf-8").read()
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Secret zucchini")))["id"]
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        await _reacted(await _react(client, cast.admin, message, "celebrate"))
        assert (await _who(client, cast.member, message)).status_code == 200
        await _reacted(await _react(client, cast.admin, message, "celebrate", on=False))
        await _answer(await _gread(client, cast.member, cast.group_id, since=_now().isoformat()))
    assert [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))] == []
    for record in caplog.records:
        words = record.getMessage()
        if record.name.startswith("sqlalchemy"):
            continue  # the engine's own statements, at DEBUG; not the router's
        assert "celebrate" not in words, (record.name, words)
        assert "zucchini" not in words, (record.name, words)
        if not record.name.startswith("httpx"):  # its request line carries the path, as an access line does
            assert message not in words, (record.name, words)


async def test_no_answer_to_a_reaction_moves_the_message_itself(client, capsys, db_session_factory):
    """A reaction stamps one column and nothing else of the post: not its
    instant, so no page, cursor or poll order moves."""
    cast = await _cast(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "Hello")))["id"]
    before = await _post(db_session_factory, message)
    await _reacted(await _react(client, cast.admin, message, "heart"))
    assert await _post(db_session_factory, message) == before
