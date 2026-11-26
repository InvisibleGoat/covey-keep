"""How far each person has read, opening a chat at the first unread message,
and what is new (CK-104; the chat record §8 as amended, Q1, Q2; Steven,
2026-11-24 and 2026-11-25).

- **The position**: `PUT /groups/{id}/chat/read` and
  `PUT /gatherings/{id}/chat/read`, `{"through": id}`, 204. A place in the
  read's own order and never a time; it only moves forward; it is in no
  answer but its owner's own way in.
- **It goes when its person can no longer read the chat** — leaving and being
  removed from a group, a place moving off *invited*, the outside setting
  turning off, an account's deletion, and a host stepping back from keeping
  (which no route reaches) — and so does their typing entry.
- **`GET …/chat?open=true`**: the page at the first unread message, up to 20
  items before it; `unread` counted to 100; `newer` on towards the newest,
  by `?after=`.
- **`GET /chats/new`**: the caller's own chats with something unread.
- **Unread** is a live message, not the caller's own, inside their window.
"""

import asyncio
import importlib
import logging
import re
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Awaitable, Callable
from uuid import UUID

import pytest
from sqlalchemy import event, select, text

from app.db import engine
from app.models import Account, Gathering
from app.services.keeping import unkeep
from tests.test_account_deletion import DELETE_BODY
from tests.test_chat import (
    EXTREMES,
    JOINER,
    PLAIN,
    READ_KEYS,
    _answer,
    _bodies,
    _by_id,
    _chat_api,
    _forged,
    _gread,
    _gsend,
    _invite_into_group,
    _kinds,
    _missing_gathering,
    _no_index_walked,
    _now,
    _plant_many,
    _plant_message,
    _remove_message,
    _sent,
    _xread,
    _xsend,
)
from tests.test_chat_container import _container
from tests.test_chat_reactions import _long_in_the_group, _without_a_membership
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_gatherings import _account_for, _signed_in_headers
from tests.test_gatherings import _create as _create_standalone
from tests.test_group_gatherings import _create_in_group
from tests.test_group_membership import ADMIN, CO_ADMIN, MEMBER, _cast, _group_404, _leave, _person_id, _remove
from tests.test_groups import MISSING
from tests.test_groups import _create as _create_group
from tests.test_member_places import _extra_member, _put_place
from tests.test_outside_invitations import CO_HOST, INVITEE, OUTSIDER, _let_in, _off, _on, _world

OPEN_KEYS = READ_KEYS | {"first_unread", "unread", "newer"}
AFTER_KEYS = {"items", "newer", "as_of", "may_moderate"}
LATER = "later@example.com"


# --- routes --------------------------------------------------------------------------


async def _gmark(client, headers, group_id: str, through: str):
    return await client.put(f"/groups/{group_id}/chat/read", json={"through": through}, headers=headers)


async def _xmark(client, headers, gathering_id: str, through: str):
    return await client.put(f"/gatherings/{gathering_id}/chat/read", json={"through": through}, headers=headers)


async def _marked(response) -> None:
    assert response.status_code == 204, response.text
    assert response.content == b""


async def _new(client, headers) -> dict[str, list[str]]:
    response = await client.get("/chats/new", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"groups", "gatherings"}
    for ids in body.values():
        assert len(ids) == len(set(ids))
    return body


async def _no_such_message(client, headers, mark, place: str) -> tuple[int, bytes]:
    response = await mark(client, headers, place, MISSING)
    assert response.status_code == 404 and response.json() == {"detail": "No such message."}, response.text
    return response.status_code, response.content


def _typing():
    return importlib.import_module("app.services.chat_typing")


async def _positions(db_session_factory) -> dict[tuple[UUID, str], tuple]:
    """{(person_id, chat's gathering id): (through_created_at, through_post_id)}."""
    async with db_session_factory() as db:
        return {
            (row.person_id, str(row.gathering_id)): (row.through_created_at, str(row.through_post_id))
            for row in await db.execute(
                text("SELECT person_id, gathering_id, through_created_at, through_post_id FROM chat_read_positions")
            )
        }


async def _instant(db_session_factory, post_id: str):
    async with db_session_factory() as db:
        return await db.scalar(text("SELECT created_at FROM posts WHERE id = :p"), {"p": UUID(post_id)})


async def _at(db_session_factory, gathering_id: str, address: str, body: str, ago: str) -> str:
    """A message written `ago` before now — `7 days`, `3 hours` — into a chat."""
    return await _plant_message(db_session_factory, gathering_id, address, body, at=f"now() - interval '{ago}'")


async def _plant_join_line(db_session_factory, gathering_id: str, address: str, ago: str) -> str:
    async with db_session_factory() as db:
        made = await db.scalar(
            text(
                "INSERT INTO posts (gathering_id, author_person_id, kind, publication_state, created_at) "
                f"SELECT :g, id, 'joined', 'live', now() - interval '{ago}' FROM people WHERE email = :e RETURNING id"
            ),
            {"g": UUID(gathering_id), "e": address},
        )
        await db.commit()
        return str(made)


async def _hold(db_session_factory, *post_ids: str) -> None:
    """Removed an hour ago by their writer, with their words kept: held."""
    async with db_session_factory() as db:
        for post_id in post_ids:
            await db.execute(
                text(
                    "UPDATE posts SET publication_state = 'removed', removed_at = now() - interval '1 hour', "
                    "removed_by_person_id = author_person_id WHERE id = :p"
                ),
                {"p": UUID(post_id)},
            )
        await db.commit()


async def _a_group_chat(client, capsys, db_session_factory):
    """The cast, their windows sixty days wide, and their container's id."""
    cast = await _cast(client, capsys, db_session_factory)
    await _long_in_the_group(db_session_factory, cast.group_id)
    return cast, await _container(db_session_factory, cast.group_id)


# --- the position: by seat, by window -----------------------------------------------------


async def test_a_position_is_a_place_in_the_reads_own_order_by_every_reader_of_a_groups_chat(
    client, capsys, db_session_factory
):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    first = (await _sent(await _gsend(client, cast.member, cast.group_id, "One")))["id"]
    line = await _plant_join_line(db_session_factory, container, CO_ADMIN, "2 days")
    for headers, address, through in (
        (cast.admin, ADMIN, first),
        (cast.member, MEMBER, first),  # their own
        (cast.co_admin, CO_ADMIN, line),  # a line is an item like any other
    ):
        await _marked(await _gmark(client, headers, cast.group_id, through))
        person = await _person_id(db_session_factory, address)
        assert (await _positions(db_session_factory))[(person, container)] == (
            await _instant(db_session_factory, through),
            through,
        )
    assert len(await _positions(db_session_factory)) == 3
    async with db_session_factory() as db:  # never when: the place, and whose, and nothing else
        columns = (
            await db.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_read_positions'")
            )
        ).scalars()
        assert set(columns) == {"person_id", "gathering_id", "through_created_at", "through_post_id"}


async def test_a_position_in_a_gatherings_chat_by_every_invited_seat(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    (setting_line,) = (await _answer(await _xread(client, cast.member, gid)))["items"]
    message = (await _sent(await _xsend(client, world.invitee, gid, "Pie?")))["id"]
    for headers in (cast.member, world.co_host, world.invitee, cast.admin, outsider):
        await _marked(await _xmark(client, headers, gid, message))
    assert {chat for _, chat in await _positions(db_session_factory)} == {gid}
    assert len(await _positions(db_session_factory)) == 5
    # A setting line is drawn for the group's members alone, so it can be a
    # member's place and is nobody else's.
    refused = await _xmark(client, outsider, gid, setting_line["id"])
    assert (refused.status_code, refused.content) == await _no_such_message(client, outsider, _xmark, gid)
    await _marked(await _xmark(client, cast.member, gid, setting_line["id"]))


async def test_a_message_the_caller_is_not_shown_now_is_the_404_and_writes_nothing(
    client, capsys, db_session_factory
):
    """Before their window, another chat's, held (for anyone who does not run
    the place), destroyed, and an id that is nothing — one body."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    before = (await _sent(await _gsend(client, cast.member, cast.group_id, "Before they joined")))["id"]
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    elsewhere = (await _sent(await _xsend(client, cast.member, gid, "In the gathering")))["id"]
    held = (await _sent(await _gsend(client, cast.member, cast.group_id, "Taken out")))["id"]
    past = (await _sent(await _gsend(client, cast.member, cast.group_id, "Past its hold")))["id"]
    for message in (held, past):
        assert (await _remove_message(client, cast.admin, message)).status_code == 204
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE posts SET removed_at = now() - interval '31 days' WHERE id = :p"), {"p": UUID(past)}
        )
        await db.commit()

    for headers, mark, place, through in (
        (joiner, _gmark, cast.group_id, before),
        (joiner, _gmark, cast.group_id, held),
        (cast.member, _gmark, cast.group_id, held),  # its writer, who runs nothing here
        (cast.admin, _gmark, cast.group_id, past),
        (cast.admin, _gmark, cast.group_id, elsewhere),
        (cast.member, _xmark, gid, before),
    ):
        refused = await mark(client, headers, place, through)
        assert (refused.status_code, refused.content) == await _no_such_message(client, headers, mark, place)
    assert await _positions(db_session_factory) == {}
    # Held, and shown to them, for the people who run the place.
    await _marked(await _gmark(client, cast.admin, cast.group_id, held))
    await _marked(await _gmark(client, cast.co_admin, cast.group_id, held))


async def test_whoever_cannot_read_the_chat_draws_its_own_404(client, capsys, db_session_factory):
    """Byte-identical to a missing group's and a missing gathering's, before
    any message is looked for."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    in_group = (await _sent(await _gsend(client, cast.member, cast.group_id, "One")))["id"]
    in_gathering = (await _sent(await _xsend(client, cast.member, gid, "One")))["id"]
    container = await _container(db_session_factory, cast.group_id)
    await _without_a_membership(db_session_factory, cast.group_id, ADMIN)
    for headers in (cast.stranger, outsider, cast.admin):
        refused = await _gmark(client, headers, cast.group_id, in_group)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)
    for headers, place in ((cast.stranger, gid), (cast.co_admin, gid), (cast.member, container)):
        refused = await _xmark(client, headers, place, in_gathering)
        assert (refused.status_code, refused.content) == await _missing_gathering(client, headers)
    assert await _positions(db_session_factory) == {}


async def test_the_body_takes_exactly_through(client, capsys, db_session_factory):
    for path in (f"/groups/{MISSING}/chat/read", f"/gatherings/{MISSING}/chat/read"):
        assert (await client.put(path, json={"through": MISSING})).status_code == 401
    assert (await client.get("/chats/new")).status_code == 401
    cast, _ = await _a_group_chat(client, capsys, db_session_factory)
    message = (await _sent(await _gsend(client, cast.member, cast.group_id, "One")))["id"]
    for body, loc in (
        ({}, ["body", "through"]),
        ({"through": None}, ["body", "through"]),
        ({"through": "yesterday"}, ["body", "through"]),
        ({"through": message, "at": "2026-11-25T10:00:00Z"}, ["body", "at"]),
        ({"through": message, "person_id": MISSING}, ["body", "person_id"]),
    ):
        response = await client.put(f"/groups/{cast.group_id}/chat/read", json=body, headers=cast.admin)
        assert response.status_code == 422, (body, response.text)
        assert [entry["loc"] for entry in response.json()["detail"]] == [loc]
    assert await _positions(db_session_factory) == {}


# --- only forward ------------------------------------------------------------------------


async def test_a_position_only_ever_moves_forward(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    ids = [await _at(db_session_factory, container, MEMBER, f"{n}", f"{10 - n} hours") for n in range(5)]
    admin = await _person_id(db_session_factory, ADMIN)
    for through, expected in ((ids[1], 1), (ids[3], 3), (ids[0], 3), (ids[3], 3), (ids[2], 3), (ids[4], 4)):
        await _marked(await _gmark(client, cast.admin, cast.group_id, through))
        assert (await _positions(db_session_factory))[(admin, container)] == (
            await _instant(db_session_factory, ids[expected]),
            ids[expected],
        )
    assert len(await _positions(db_session_factory)) == 1


async def test_two_messages_at_one_instant_are_told_apart_by_id(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    ids = [
        await _plant_message(
            db_session_factory, container, MEMBER, f"{n}", at="timestamptz '2026-11-20 10:00:00+00'"
        )
        for n in range(4)
    ]
    low, *_, high = sorted(ids, key=UUID)
    admin = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as db:  # the window reaches back past the instant chosen
        await db.execute(text("UPDATE memberships SET created_at = timestamptz '2026-01-01 00:00:00+00'"))
        await db.commit()
    for through, expected in ((low, low), (high, high), (low, high)):
        await _marked(await _gmark(client, cast.admin, cast.group_id, through))
        assert (await _positions(db_session_factory))[(admin, container)][1] == expected


async def test_two_marks_at_once_leave_the_later_place(client, capsys, db_session_factory):
    """A competitor has moved the position to the newest and not committed;
    the older mark waits on that row, finds the place behind it, and changes
    nothing. Read-then-write would put it back."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    ids = [await _at(db_session_factory, container, MEMBER, f"{n}", f"{10 - n} hours") for n in range(3)]
    await _marked(await _gmark(client, cast.admin, cast.group_id, ids[0]))
    admin = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as competitor:
        await competitor.execute(
            text(
                "UPDATE chat_read_positions SET through_post_id = :p, "
                "through_created_at = (SELECT created_at FROM posts WHERE id = :p) WHERE person_id = :a"
            ),
            {"p": UUID(ids[2]), "a": admin},
        )
        route = asyncio.create_task(_gmark(client, cast.admin, cast.group_id, ids[1]))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    await _marked(await route)
    assert seen == "waiting", seen
    assert (await _positions(db_session_factory))[(admin, container)][1] == ids[2]


# --- nobody else's, and in no other answer ---------------------------------------------------


async def test_no_answer_carries_anyones_position(client, capsys, db_session_factory):
    """One person's place moves nothing anybody else is sent: every answer of
    the other seats is the same before and after, byte for byte but the
    clock, and no body anywhere carries the person or the place."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    for headers in (cast.member, cast.admin, cast.member):
        await _sent(await _gsend(client, headers, cast.group_id, "In the group"))
        await _sent(await _xsend(client, headers, gid, "In the gathering"))

    async def everything(headers) -> list:
        answers = []
        for path, params in (
            (f"/groups/{cast.group_id}/chat", {}),
            (f"/groups/{cast.group_id}/chat", {"open": "true"}),
            (f"/groups/{cast.group_id}/chat", {"since": "2026-01-01T00:00:00Z"}),
            (f"/gatherings/{gid}/chat", {}),
            (f"/gatherings/{gid}/chat", {"open": "true"}),
            (f"/gatherings/{gid}/chat", {"since": "2026-01-01T00:00:00Z"}),
            (f"/groups/{cast.group_id}", {}),
            (f"/groups/{cast.group_id}/members", {}),
            (f"/groups/{cast.group_id}/gatherings", {}),
            (f"/gatherings/{gid}", {}),
            ("/gatherings", {}),
            ("/groups", {}),
            ("/chats/new", {}),
            ("/auth/me", {}),
        ):
            response = await client.get(path, params=params, headers=headers)
            body = response.json()
            if isinstance(body, dict):
                body.pop("as_of", None)
            answers.append((path, tuple(params), response.status_code, body))
        return answers

    before = await everything(cast.admin)
    items = (await _answer(await _gread(client, cast.member, cast.group_id)))["items"]
    in_gathering = (await _answer(await _xread(client, cast.member, gid)))["items"]
    # At the first item, with the member's own messages after it — where the
    # admin's chat would open, and what would be new to them, were the place
    # theirs — and then at the last.
    for which in (0, -1):
        await _marked(await _gmark(client, cast.member, cast.group_id, items[which]["id"]))
        await _marked(await _xmark(client, cast.member, gid, in_gathering[which]["id"]))
        assert await everything(cast.admin) == before, which
    member = str(await _person_id(db_session_factory, MEMBER))
    assert member not in str(await everything(cast.co_admin))


# --- it goes when the chat is no longer theirs ----------------------------------------------


@dataclass
class Ending:
    """A person (`reader`) who reads `chat` and, where they keep one,
    `other`; somebody else (`bystander`) who reads `chat` too; and the act
    that ends the reader's access to `chat`."""

    person: UUID
    chat: str
    bystander: UUID
    act: Callable[[], Awaitable[None]]
    other: str | None = None


async def _mark_newest(client, headers, chat_path: str) -> None:
    read = await client.get(f"{chat_path}/chat", headers=headers)
    items = (await _answer(read))["items"]
    response = await client.put(f"{chat_path}/chat/read", json={"through": items[-1]["id"]}, headers=headers)
    await _marked(response)


async def _ending(name: str, client, capsys, db_session_factory) -> Ending:
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    container = await _container(db_session_factory, cast.group_id)
    group_chat, gathering_chat = f"/groups/{cast.group_id}", f"/gatherings/{gid}"
    await _sent(await _gsend(client, cast.member, cast.group_id, "In the group"))
    await _sent(await _xsend(client, cast.member, gid, "In the gathering"))

    async def status(response, code: int) -> None:
        assert response.status_code == code, response.text

    if name in ("leave", "removed", "account"):
        # The invited member: the group's chat and the gathering's.
        reader, address, bystander, bystander_address = world.invitee, INVITEE, cast.co_admin, CO_ADMIN
        await _mark_newest(client, reader, group_chat)
        await _mark_newest(client, reader, gathering_chat)
        await _mark_newest(client, bystander, group_chat)

        async def act() -> None:
            if name == "leave":
                await status(await _leave(client, reader, cast.group_id), 204)
            elif name == "removed":
                await status(await _remove(client, cast.admin, cast.group_id, world.invitee_membership), 204)
            else:
                await status(await client.post("/me/delete", json=DELETE_BODY, headers=reader), 204)

        chat, other = container, None if name == "account" else gid
    elif name == "place":
        reader, address, bystander, bystander_address = world.invitee, INVITEE, cast.admin, ADMIN
        await _mark_newest(client, reader, group_chat)
        await _mark_newest(client, reader, gathering_chat)
        await _mark_newest(client, bystander, gathering_chat)

        async def act() -> None:
            await status(await _put_place(client, cast.member, gid, world.invitee_membership, "shared_with"), 200)

        chat, other = gid, container
    elif name == "outside_off":
        await _on(client, cast.member, gid)
        reader = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
        address, bystander, bystander_address = OUTSIDER, world.invitee, INVITEE
        own = (await _create_standalone(client, reader, title="Their own"))["id"]
        await _sent(await _xsend(client, reader, own, "Mine"))
        await _mark_newest(client, reader, gathering_chat)
        await _mark_newest(client, reader, f"/gatherings/{own}")
        await _mark_newest(client, bystander, gathering_chat)

        async def act() -> None:
            await _off(client, cast.member, gid)

        chat, other = gid, own
    else:  # unkeep: the host steps back from keeping, and holds no invitation
        reader, address, bystander, bystander_address = cast.admin, ADMIN, world.invitee, INVITEE
        own = (await _create_standalone(client, reader, title="Their own"))["id"]
        async with db_session_factory() as db:
            await db.execute(
                text("INSERT INTO gathering_invitations (gathering_id, person_id) SELECT :g, id FROM people WHERE email = :e"),
                {"g": UUID(own), "e": INVITEE},
            )
            await db.commit()
        await _sent(await _xsend(client, reader, own, "Mine"))
        await _mark_newest(client, reader, f"/gatherings/{own}")
        await _mark_newest(client, reader, group_chat)
        await _mark_newest(client, bystander, f"/gatherings/{own}")

        async def act() -> None:
            async with db_session_factory() as db:
                account = await db.get(Account, (await _account_for(db, ADMIN)).id)
                await unkeep(db, account, await db.get(Gathering, UUID(own)))
                await db.commit()

        chat, other = own, container
    return Ending(
        person=await _person_id(db_session_factory, address),
        chat=chat,
        bystander=await _person_id(db_session_factory, bystander_address),
        act=act,
        other=other,
    )


ENDINGS = ["leave", "removed", "place", "outside_off", "account", "unkeep"]


@pytest.mark.parametrize("name", ENDINGS)
async def test_a_position_and_a_typing_entry_go_when_the_chat_is_no_longer_theirs(
    client, capsys, db_session_factory, name
):
    """Theirs in that chat goes, and nothing else does: not the bystander's
    in the same chat, not theirs in a chat they still read — but an account's
    deletion takes every one of theirs. Read in memory too: the typing entry
    is dropped, not merely hidden by the poll's own check."""
    ending = await _ending(name, client, capsys, db_session_factory)
    store = _typing().store
    held = [chat for person, chat in await _positions(db_session_factory) if person == ending.person]
    assert ending.chat in held and len(held) == 2
    for chat in held:
        store.note(UUID(chat), ending.person)
    store.note(UUID(ending.chat), ending.bystander)

    await ending.act()

    after = set(await _positions(db_session_factory))
    mine = {chat for person, chat in after if person == ending.person}
    assert mine == ({ending.other} if ending.other else set()), name
    assert (ending.bystander, ending.chat) in after
    nobody = UUID(MISSING)
    assert store.others(UUID(ending.chat), nobody) == [ending.bystander]
    for chat in held:
        if chat != ending.chat:
            assert store.others(UUID(chat), nobody) == ([ending.person] if chat == ending.other else [])


async def test_a_host_who_stops_keeping_but_is_invited_still_reads_so_their_position_stays(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, ADMIN)
    own = (await _create_standalone(client, headers, title="Their own"))["id"]
    await _sent(await _xsend(client, headers, own, "Mine"))
    await _mark_newest(client, headers, f"/gatherings/{own}")
    person = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as db:
        await db.execute(
            text("INSERT INTO gathering_invitations (gathering_id, person_id) VALUES (:g, :p)"),
            {"g": UUID(own), "p": person},
        )
        account = await db.get(Account, (await _account_for(db, ADMIN)).id)
        await unkeep(db, account, await db.get(Gathering, UUID(own)))
        await db.commit()
    assert set(await _positions(db_session_factory)) == {(person, own)}
    assert (await _xread(client, headers, own)).status_code == 200


async def test_coming_back_is_a_new_window_with_no_position_and_a_first_open(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    await _sent(await _gsend(client, cast.member, cast.group_id, "While they were in"))
    await _mark_newest(client, joiner, f"/groups/{cast.group_id}")
    assert (await _leave(client, joiner, cast.group_id)).status_code == 204
    await _sent(await _gsend(client, cast.member, cast.group_id, "While they were away"))
    assert (await _new(client, joiner))["groups"] == []
    await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    joiner_person = await _person_id(db_session_factory, JOINER)
    assert (joiner_person, container) not in await _positions(db_session_factory)
    assert (await _new(client, joiner))["groups"] == []  # nothing in the new window but their own line
    await _sent(await _gsend(client, cast.member, cast.group_id, "Welcome back"))
    assert (await _new(client, joiner))["groups"] == [cast.group_id]
    opened = await _answer(await _gread(client, joiner, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"], opened["newer"]) == (None, 0, None)
    assert _bodies(opened) == ["Welcome back"]


async def test_a_mark_while_its_person_is_leaving_leaves_no_position(client, capsys, db_session_factory):
    """The membership has been deleted and not committed: the mark waits on
    that row and answers the group's 404. Without the wait it would write a
    position its person can never read from again."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    message = await _at(db_session_factory, container, MEMBER, "One", "1 hour")
    async with db_session_factory() as competitor:
        await competitor.execute(
            text("DELETE FROM memberships WHERE id = :m"), {"m": UUID(cast.co_admin_membership)}
        )
        route = asyncio.create_task(_gmark(client, cast.co_admin, cast.group_id, message))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    refused = await route
    assert seen == "waiting", seen
    assert (refused.status_code, refused.content) == await _group_404(client, cast.co_admin)
    assert await _positions(db_session_factory) == {}


async def test_a_mark_while_a_place_moves_off_invited_leaves_no_position(client, capsys, db_session_factory):
    """The same in a gathering's chat: the act holds the gathering's row and
    has deleted the invitation; the mark waits and answers its 404."""
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    message = (await _sent(await _xsend(client, world.cast.member, gid, "One")))["id"]
    async with db_session_factory() as competitor:
        await competitor.execute(text("SELECT id FROM gatherings WHERE id = :g FOR UPDATE"), {"g": UUID(gid)})
        await competitor.execute(
            text(
                "DELETE FROM gathering_invitations WHERE gathering_id = :g AND person_id = "
                "(SELECT id FROM people WHERE email = :e)"
            ),
            {"g": UUID(gid), "e": INVITEE},
        )
        route = asyncio.create_task(_xmark(client, world.invitee, gid, message))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    refused = await route
    assert seen == "waiting", seen
    assert (refused.status_code, refused.content) == await _missing_gathering(client, world.invitee)
    assert await _positions(db_session_factory) == {}


async def test_a_mark_while_its_person_is_deleted_leaves_no_position(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    message = await _at(db_session_factory, container, MEMBER, "One", "1 hour")
    async with db_session_factory() as competitor:
        await competitor.execute(
            text("UPDATE people SET anonymized_at = now(), email = NULL, display_name = 'a former member' WHERE email = :e"),
            {"e": CO_ADMIN},
        )
        route = asyncio.create_task(_gmark(client, cast.co_admin, cast.group_id, message))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
    refused = await route
    assert seen == "waiting", seen
    assert refused.status_code == 404, refused.text
    assert await _positions(db_session_factory) == {}


# --- opening ------------------------------------------------------------------------------


async def test_a_first_open_and_an_open_with_nothing_unread_are_the_plain_newest_page(
    client, capsys, db_session_factory
):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    await _plant_many(db_session_factory, container, MEMBER, 60, start="now() - interval '1 day'")
    plain = await _answer(await _gread(client, cast.admin, cast.group_id))
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert set(opened) == OPEN_KEYS
    # No position: the newest fifty, whatever is there.
    assert (opened["first_unread"], opened["unread"], opened["newer"]) == (None, 0, None)
    assert [i["id"] for i in opened["items"]] == [i["id"] for i in plain["items"]]
    assert opened["older"] == plain["older"] and opened["older"]
    assert _bodies(opened)[-1] == "Number 60"
    # And with everything read.
    await _marked(await _gmark(client, cast.admin, cast.group_id, plain["items"][-1]["id"]))
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true", limit=10))
    assert (opened["first_unread"], opened["unread"], opened["newer"]) == (None, 0, None)
    assert _bodies(opened) == [f"Number {n}" for n in range(51, 61)] and opened["older"]
    # A plain read carries none of the three, and `open=false` is a plain read.
    assert set(plain) == READ_KEYS
    assert set(await _answer(await _gread(client, cast.admin, cast.group_id, open="false"))) == READ_KEYS


async def test_open_lands_at_the_first_unread_after_a_week(client, capsys, db_session_factory):
    """Forty read, thirty written over the week since: twenty before the
    first unread and thirty from it, nothing loaded past them."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = [await _at(db_session_factory, container, MEMBER, f"Read {n}", f"{340 - n} hours") for n in range(40)]
    await _marked(await _gmark(client, cast.admin, cast.group_id, read[-1]))
    fresh = [await _at(db_session_factory, container, MEMBER, f"New {n}", f"{168 - n} hours") for n in range(30)]
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert set(opened) == OPEN_KEYS
    assert opened["first_unread"] == fresh[0] and opened["unread"] == 30
    assert [i["id"] for i in opened["items"]] == read[-20:] + fresh
    assert opened["newer"] is None
    # `older` goes on back from the page's own first item.
    back = await _answer(await _gread(client, cast.admin, cast.group_id, before=opened["older"]))
    assert [i["id"] for i in back["items"]] == read[:20] and back["older"] is None


@pytest.mark.parametrize("limit", [1, 2, 10, 21, 25, 50, 100])
async def test_newer_pages_on_to_the_end_with_no_repeat_and_no_miss(client, capsys, db_session_factory, limit):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    await _plant_many(db_session_factory, container, MEMBER, 30, start="now() - interval '10 days'")
    everything = (await _answer(await _gread(client, cast.admin, cast.group_id, limit=100)))["items"]
    await _marked(await _gmark(client, cast.admin, cast.group_id, everything[-1]["id"]))
    await _plant_many(db_session_factory, container, MEMBER, 70, start="now() - interval '3 days'")
    whole = (await _answer(await _gread(client, cast.admin, cast.group_id, limit=100)))["items"]
    assert len(whole) == 100

    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true", limit=limit))
    ahead = min(20, limit - 1)
    assert opened["first_unread"] == whole[30]["id"] and opened["unread"] == 70
    assert [i["id"] for i in opened["items"]] == [i["id"] for i in whole[30 - ahead : 30 - ahead + limit]]
    walked, newer, pages = opened["items"], opened["newer"], 0
    while newer is not None:
        page = await _answer(await _gread(client, cast.admin, cast.group_id, after=newer, limit=limit))
        assert set(page) == AFTER_KEYS and 1 <= len(page["items"]) <= limit
        walked, newer, pages = walked + page["items"], page["newer"], pages + 1
        assert pages < 200
    assert [i["id"] for i in walked] == [i["id"] for i in whole[30 - ahead :]]
    back, older = [], opened["older"]
    while older is not None:
        page = await _answer(await _gread(client, cast.admin, cast.group_id, before=older, limit=limit))
        back, older = page["items"] + back, page["older"]
    assert [i["id"] for i in back + walked] == [i["id"] for i in whole]


async def test_paging_on_across_messages_sent_at_one_instant_misses_none_and_repeats_none(
    client, capsys, db_session_factory
):
    """A position, the unread after it, and both cursors, inside one instant:
    told apart by id alone, whatever plan the database picks."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    ids = sorted(
        [
            await _plant_message(db_session_factory, container, MEMBER, f"{n}", at="timestamptz '2026-11-20 10:00:00+00'")
            for n in range(9)
        ],
        key=UUID,
    )
    async with db_session_factory() as db:
        await db.execute(text("UPDATE memberships SET created_at = timestamptz '2026-01-01 00:00:00+00'"))
        await db.commit()
    await _marked(await _gmark(client, cast.admin, cast.group_id, ids[2]))
    with _no_index_walked():
        opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true", limit=4))
        assert opened["first_unread"] == ids[3] and opened["unread"] == 6
        walked, newer = opened["items"], opened["newer"]
        while newer is not None:
            page = await _answer(await _gread(client, cast.admin, cast.group_id, after=newer, limit=2))
            walked, newer = walked + page["items"], page["newer"]
    assert [i["id"] for i in walked] == ids


async def test_a_persons_own_messages_and_the_lines_are_never_unread(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = await _at(db_session_factory, container, MEMBER, "Read", "9 hours")
    await _marked(await _gmark(client, cast.admin, cast.group_id, read))
    own = await _at(db_session_factory, container, ADMIN, "My own", "8 hours")
    line = await _plant_join_line(db_session_factory, container, CO_ADMIN, "7 hours")
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"], opened["newer"]) == (None, 0, None)
    assert [i["id"] for i in opened["items"]] == [read, own, line]
    assert (await _new(client, cast.admin))["groups"] == []
    # And with somebody's message past them, they are on the page before it,
    # and one after it is not counted.
    unread = await _at(db_session_factory, container, MEMBER, "Unread", "6 hours")
    own_after = await _at(db_session_factory, container, ADMIN, "Mine again", "5 hours")
    last = await _at(db_session_factory, container, CO_ADMIN, "And another", "4 hours")
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (unread, 2)
    assert [i["id"] for i in opened["items"]] == [read, own, line, unread, own_after, last]


async def test_a_held_message_is_never_unread_and_is_drawn_for_the_people_who_run_the_place(
    client, capsys, db_session_factory
):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    plain, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    await _long_in_the_group(db_session_factory, cast.group_id)
    read = await _at(db_session_factory, container, MEMBER, "Read", "9 hours")
    held_first = await _at(db_session_factory, container, MEMBER, "Held, the first after it", "8 hours")
    unread = await _at(db_session_factory, container, MEMBER, "Unread", "7 hours")
    held_last = await _at(db_session_factory, container, MEMBER, "Held, the last", "6 hours")
    await _hold(db_session_factory, held_first, held_last)
    for headers, drawn in (
        (cast.admin, [read, held_first, unread, held_last]),
        (cast.co_admin, [read, held_first, unread, held_last]),
        (plain, [read, unread]),
    ):
        await _marked(await _gmark(client, headers, cast.group_id, read))
        opened = await _answer(await _gread(client, headers, cast.group_id, open="true"))
        assert (opened["first_unread"], opened["unread"]) == (unread, 1)
        assert [i["id"] for i in opened["items"]] == drawn
        after = await _answer(await _gread(client, headers, cast.group_id, open="true", limit=2))
        walked, newer = after["items"], after["newer"]
        while newer is not None:
            page = await _answer(await _gread(client, headers, cast.group_id, after=newer, limit=1))
            walked, newer = walked + page["items"], page["newer"]
        assert [i["id"] for i in walked] == drawn[drawn.index(unread) - 1 :]
    # Only held messages past the place: nothing is unread.
    await _marked(await _gmark(client, plain, cast.group_id, unread))
    opened = await _answer(await _gread(client, plain, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (None, 0)
    assert (await _new(client, plain))["groups"] == []
    await _marked(await _gmark(client, cast.admin, cast.group_id, unread))
    assert (await _new(client, cast.admin))["groups"] == []


async def test_a_setting_line_is_on_the_page_for_the_groups_members_alone_and_never_unread(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    read = (await _sent(await _xsend(client, cast.member, gid, "Read")))["id"]
    for headers in (world.invitee, outsider):
        await _marked(await _xmark(client, headers, gid, read))
    await _off(client, cast.member, gid)
    await _on(client, cast.member, gid)  # two lines past the place, and the outsider is gone
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER, headers=outsider)
    opened = await _answer(await _xread(client, world.invitee, gid, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (None, 0)
    assert _kinds(opened)[-2:] == ["outside_invitations_off", "outside_invitations_on"]
    assert (await _new(client, world.invitee))["gatherings"] == []
    unread = (await _sent(await _xsend(client, cast.member, gid, "Unread")))["id"]
    opened = await _answer(await _xread(client, world.invitee, gid, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (unread, 1)
    assert _kinds(opened)[-3:] == ["outside_invitations_off", "outside_invitations_on", "message"]
    # The outsider came back: a first open, and no line of the setting's.
    opened = await _answer(await _xread(client, outsider, gid, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (None, 0)
    assert set(_kinds(opened)) == {"message"}


async def test_nothing_before_the_callers_window_is_unread_or_on_the_page(client, capsys, db_session_factory):
    """A position from before (it can't be made through the route, so it is
    planted) counts nothing outside the window and opens nothing older."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    await _plant_many(db_session_factory, container, MEMBER, 30, start="now() - interval '3 hours'")
    first = (await _answer(await _gread(client, cast.admin, cast.group_id, limit=100)))["items"][0]
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    person = await _person_id(db_session_factory, JOINER)
    async with db_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO chat_read_positions (person_id, gathering_id, through_created_at, through_post_id) "
                "SELECT :p, gathering_id, created_at, id FROM posts WHERE id = :m"
            ),
            {"p": person, "m": UUID(first["id"])},
        )
        await db.commit()
    opened = await _answer(await _gread(client, joiner, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (None, 0)
    assert _kinds(opened) == ["joined"]
    assert (await _new(client, joiner))["groups"] == []
    unread = (await _sent(await _gsend(client, cast.member, cast.group_id, "Welcome")))["id"]
    opened = await _answer(await _gread(client, joiner, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (unread, 1)
    assert _kinds(opened) == ["joined", "message"] and opened["older"] is None


async def test_unread_is_counted_to_a_hundred_and_no_further(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = await _at(db_session_factory, container, MEMBER, "Read", "9 days")
    await _marked(await _gmark(client, cast.admin, cast.group_id, read))
    await _plant_many(db_session_factory, container, MEMBER, 99, start="now() - interval '8 days'")
    assert (await _answer(await _gread(client, cast.admin, cast.group_id, open="true")))["unread"] == 99
    await _plant_many(db_session_factory, container, MEMBER, 1, start="now() - interval '7 days'")
    assert (await _answer(await _gread(client, cast.admin, cast.group_id, open="true")))["unread"] == 100
    await _plant_many(db_session_factory, container, MEMBER, 150, start="now() - interval '6 days'")
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert opened["unread"] == 100
    assert len(opened["items"]) == 50 and opened["newer"]


async def test_a_place_whose_message_is_gone_still_stands(client, capsys, db_session_factory):
    """No foreign key on the post: a held message can be destroyed under a
    position, and the place is still a place."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = await _at(db_session_factory, container, MEMBER, "Read, then gone", "9 hours")
    await _marked(await _gmark(client, cast.admin, cast.group_id, read))
    unread = await _at(db_session_factory, container, MEMBER, "Unread", "8 hours")
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM posts WHERE id = :p"), {"p": UUID(read)})
        await db.commit()
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
    assert (opened["first_unread"], opened["unread"]) == (unread, 1)


async def test_opening_and_reading_move_no_position(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = await _at(db_session_factory, container, MEMBER, "Read", "9 hours")
    await _marked(await _gmark(client, cast.admin, cast.group_id, read))
    await _plant_many(db_session_factory, container, MEMBER, 10, start="now() - interval '1 hour'")
    before = await _positions(db_session_factory)
    opened = await _answer(await _gread(client, cast.admin, cast.group_id, open="true", limit=3))
    await _answer(await _gread(client, cast.admin, cast.group_id, after=opened["newer"]))
    await _answer(await _gread(client, cast.admin, cast.group_id))
    await _answer(await _gread(client, cast.admin, cast.group_id, since=opened["as_of"]))
    await _new(client, cast.admin)
    assert await _positions(db_session_factory) == before


# --- what may be asked for together ------------------------------------------------------------


async def test_two_ways_of_reading_at_once_are_a_422_at_the_first_named(client, capsys, db_session_factory):
    chat = _chat_api()
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    cursor = _forged("2026-11-20T10:00:00+00:00")
    at = "2026-11-20T10:00:00+00:00"
    asked = {
        "before": ({"before": cursor}, {}, ["query", "before"]),
        "after": ({"after": cursor}, {}, ["query", "after"]),
        "open": ({"open": "true"}, {}, ["query", "open"]),
        "since": ({"since": at}, {}, ["query", "since"]),
        "header": ({}, {"X-Chat-Since": at}, ["header", "x-chat-since"]),
    }
    names = list(asked)
    for i, first in enumerate(names):
        for second in names[i + 1 :]:
            params = {**asked[first][0], **asked[second][0]}
            headers = {**cast.member, **asked[first][1], **asked[second][1]}
            for read, place in ((_gread, cast.group_id), (_xread, gid)):
                refused = await read(client, headers, place, **params)
                assert refused.status_code == 422, (first, second, refused.text)
                (entry,) = refused.json()["detail"]
                assert entry["loc"] == asked[first][2], (first, second)
                # CK-102's own words for its own pair, as they were.
                assert entry["msg"] == (chat.BOTH_CURSORS if (first, second) == ("before", "since") else chat.ONE_WAY)
    # Refused before any door is asked.
    refused = await _gread(client, cast.stranger, cast.group_id, open="true", after=cursor)
    assert refused.status_code == 422


async def test_a_cursor_that_is_not_this_chats_is_refused_at_its_own_field(client, capsys, db_session_factory):
    chat = _chat_api()
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    for read, place in ((_gread, cast.group_id), (_xread, gid)):
        for cursor in ("", "x", "!!!!", _forged("not an instant"), *(_forged(at) for at in EXTREMES)):
            refused = await read(client, cast.member, place, after=cursor)
            assert refused.status_code == 422, (cursor, refused.text)
            (entry,) = refused.json()["detail"]
            assert (entry["loc"], entry["msg"]) == (["query", "after"], chat.BAD_CURSOR)
        for at in ("2000-01-01T00:00:00+00:00", "9999-12-31T23:59:59+00:00"):
            assert set(await _answer(await read(client, cast.member, place, after=_forged(at)))) == AFTER_KEYS
        for params in ({"open": "maybe"}, {"open": "true", "limit": 0}, {"open": "true", "limit": 101}):
            assert (await read(client, cast.member, place, **params)).status_code == 422
    # Nothing after the newest: an empty page, and no further.
    page = await _answer(await _gread(client, cast.member, cast.group_id, after=_forged("2999-01-01T00:00:00+00:00")))
    assert (page["items"], page["newer"]) == ([], None)


async def test_after_goes_on_inside_the_window_and_shows_what_a_read_shows(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    await _plant_many(db_session_factory, container, MEMBER, 3, start="now() - interval '3 hours'")
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    await _sent(await _gsend(client, cast.member, cast.group_id, "Welcome"))
    held = await _sent(await _gsend(client, cast.member, cast.group_id, "Sent by mistake"))
    await _hold(db_session_factory, held["id"])
    from_the_start = _forged("2000-01-01T00:00:00+00:00")
    theirs = await _answer(await _gread(client, joiner, cast.group_id, after=from_the_start))
    assert set(theirs) == AFTER_KEYS and theirs["newer"] is None
    assert _kinds(theirs) == ["joined", "message"] and theirs["may_moderate"] is False
    everyones = await _answer(await _gread(client, cast.admin, cast.group_id, after=from_the_start))
    assert set(everyones) == AFTER_KEYS and everyones["newer"] is None
    # A held message, drawn for the people who run the place alone.
    assert _bodies(everyones) == ["Number 1", "Number 2", "Number 3", "Welcome", "Sent by mistake"]
    for headers, answer in ((cast.admin, everyones), (joiner, theirs)):
        assert _by_id(answer) == _by_id(await _answer(await _gread(client, headers, cast.group_id)))
    assert _by_id(everyones)[held["id"]]["removed"] and held["id"] not in _by_id(theirs)


# --- what is new ------------------------------------------------------------------------------


async def test_chats_new_lists_the_callers_own_chats_with_something_unread(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    await _without_a_membership(db_session_factory, cast.group_id, CO_ADMIN)  # a co-admin who reads nothing
    everyone = (cast.admin, cast.co_admin, cast.member, world.invitee, world.co_host, outsider, cast.stranger)
    for headers in everyone:
        assert await _new(client, headers) == {"groups": [], "gatherings": []}

    in_group = (await _sent(await _gsend(client, cast.member, cast.group_id, "In the group")))["id"]
    in_gathering = (await _sent(await _xsend(client, world.co_host, gid, "In the gathering")))["id"]
    group, gathering, nothing = [cast.group_id], [gid], []
    for headers, groups, gatherings in (
        (cast.admin, group, gathering),
        (cast.member, nothing, gathering),  # the group's message is their own
        (world.invitee, group, gathering),
        (world.co_host, group, nothing),  # the gathering's is theirs
        (outsider, nothing, gathering),  # never a member
        (cast.co_admin, nothing, nothing),  # only shared with, and no membership
        (cast.stranger, nothing, nothing),
    ):
        assert await _new(client, headers) == {"groups": groups, "gatherings": gatherings}

    await _marked(await _gmark(client, cast.admin, cast.group_id, in_group))
    assert await _new(client, cast.admin) == {"groups": [], "gatherings": gathering}
    await _marked(await _xmark(client, cast.admin, gid, in_gathering))
    assert await _new(client, cast.admin) == {"groups": [], "gatherings": []}
    assert await _new(client, world.invitee) == {"groups": group, "gatherings": gathering}  # nobody else's moved
    await _sent(await _gsend(client, world.invitee, cast.group_id, "And again"))
    assert await _new(client, cast.admin) == {"groups": group, "gatherings": []}


async def test_a_chat_never_opened_is_new_if_anyone_else_has_written_there(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    empty = (await _create_group(client, cast.admin, name="Nobody has written"))["id"]
    mine = (await _create_standalone(client, cast.admin, title="Only my own words"))["id"]
    await _sent(await _xsend(client, cast.admin, mine, "Just me"))
    lines_only = await _plant_join_line(db_session_factory, container, CO_ADMIN, "2 days")
    assert lines_only
    assert await _new(client, cast.admin) == {"groups": [], "gatherings": []}
    held = await _at(db_session_factory, container, MEMBER, "Held", "2 hours")
    await _hold(db_session_factory, held)
    assert await _new(client, cast.admin) == {"groups": [], "gatherings": []}
    await _at(db_session_factory, container, MEMBER, "Words", "1 hour")
    assert await _new(client, cast.admin) == {"groups": [cast.group_id], "gatherings": []}
    assert empty not in (await _new(client, cast.admin))["groups"]
    # Inside the window alone: one who joined since has nothing new.
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    assert await _new(client, joiner) == {"groups": [], "gatherings": []}
    # A group with no container yet has nothing new, and asking makes none.
    older = (await _create_group(client, cast.admin, name="Older"))["id"]
    async with db_session_factory() as db:
        await db.execute(
            text("DELETE FROM gatherings WHERE owning_group_id = :g AND gathering_type::text = 'group_media'"),
            {"g": UUID(older)},
        )
        await db.commit()
    assert older not in (await _new(client, cast.admin))["groups"]
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM gatherings WHERE owning_group_id = :g"), {"g": UUID(older)}) == 0


async def test_chats_new_names_a_gathering_by_host_by_co_host_and_by_invitation(client, capsys, db_session_factory):
    """The invited tier's three terms, each alone; and a container is never a
    gathering there, whoever asks."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _sent(await _xsend(client, world.invitee, gid, "Words"))
    await _sent(await _gsend(client, world.invitee, cast.group_id, "Words"))
    container = await _container(db_session_factory, cast.group_id)
    async with db_session_factory() as db:  # the co-host's row alone, its invitation gone
        await db.execute(
            text(
                "DELETE FROM gathering_invitations WHERE gathering_id = :g AND person_id = "
                "(SELECT id FROM people WHERE email = :e)"
            ),
            {"g": UUID(gid), "e": CO_HOST},
        )
        await db.commit()
    for headers in (cast.member, world.co_host, cast.admin):
        new = await _new(client, headers)
        assert new["gatherings"] == [gid] and container not in new["gatherings"]
    memorial = await _create_in_group(
        client, cast.member, cast.group_id, gathering_type="memorial", title="For Edith", memorial_decedent_name="Edith"
    )
    await _sent(await _xsend(client, cast.member, memorial["id"], "We miss her"))
    assert set((await _new(client, cast.admin))["gatherings"]) == {gid, memorial["id"]}


# --- statements, and nothing logged ------------------------------------------------------------


@contextmanager
def _statements():
    made: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        made.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        yield made
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def _counted(read) -> list[str]:
    with _statements() as made:
        response = await read()
    assert response.status_code == 200, response.text
    return list(made)


async def test_the_open_reads_statements_are_two_after_the_doors_and_after_is_one(
    client, capsys, db_session_factory
):
    """The first unread and the count together, then the page: two, whether
    there is anything unread or not, and however much."""
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    read = await _at(db_session_factory, container, MEMBER, "Read", "9 days")
    plain = lambda: _gread(client, cast.admin, cast.group_id)  # noqa: E731
    opened = lambda: _gread(client, cast.admin, cast.group_id, open="true", limit=10)  # noqa: E731
    after = lambda: _gread(  # noqa: E731
        client, cast.admin, cast.group_id, after=_forged("2026-01-01T00:00:00+00:00"), limit=10
    )
    await plain()  # the session's refresh
    door = len(await _counted(plain)) - 1
    none = {"open": await _counted(opened), "after": await _counted(after)}
    await _marked(await _gmark(client, cast.admin, cast.group_id, read))
    nothing_unread = {"open": await _counted(opened), "after": await _counted(after)}
    await _plant_many(db_session_factory, container, MEMBER, 150, start="now() - interval '8 days'")
    many = {"open": await _counted(opened), "after": await _counted(after)}
    for made in (none, nothing_unread, many):
        assert len(made["open"]) == door + 2, made["open"]
        assert len(made["after"]) == door + 1, made["after"]
        touching = [i for i, s in enumerate(made["open"]) if re.search(r"\bposts\b", s)]
        assert touching == [door, door + 1]


async def test_chats_new_is_one_statement_after_the_sign_in_read(client, capsys, db_session_factory):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    await client.get("/auth/me", headers=cast.admin)  # the session's refresh
    sign_in = len(await _counted(lambda: client.get("/auth/me", headers=cast.admin)))
    assert len(await _counted(lambda: client.get("/chats/new", headers=cast.admin))) == sign_in + 1
    await _plant_many(db_session_factory, container, MEMBER, 30, start="now() - interval '1 hour'")
    for n in range(4):
        group = (await _create_group(client, cast.admin, name=f"Group {n}"))["id"]
        await _create_in_group(client, cast.admin, group, title=f"Dinner {n}")
    made = await _counted(lambda: client.get("/chats/new", headers=cast.admin))
    assert len(made) == sign_in + 1 and re.search(r"\bposts\b", made[-1])


async def test_marking_writes_one_upsert_and_nothing_of_it_is_logged(client, capsys, db_session_factory, caplog):
    cast, container = await _a_group_chat(client, capsys, db_session_factory)
    message = await _at(db_session_factory, container, MEMBER, "Secret zucchini", "1 hour")
    await client.get("/auth/me", headers=cast.admin)
    caplog.clear()
    with caplog.at_level(logging.DEBUG), _statements() as made:
        await _marked(await _gmark(client, cast.admin, cast.group_id, message))
    writes = [s for s in made if re.match(r"\s*(INSERT|UPDATE|DELETE)\b", s)]
    assert len(writes) == 1 and "ON CONFLICT" in writes[0] and "chat_read_positions" in writes[0]
    with caplog.at_level(logging.DEBUG):
        await _answer(await _gread(client, cast.admin, cast.group_id, open="true"))
        await _new(client, cast.admin)
    assert [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))] == []
    for record in caplog.records:
        words = record.getMessage()
        assert message not in words and "zucchini" not in words, (record.name, words)


def test_the_first_unread_is_within_twenty_of_the_pages_top():
    assert _chat_api().BEFORE_UNREAD == 20
    assert _chat_api().UNREAD_MAX == 100
    assert timedelta(days=30)  # the hold's window is REMOVED_BIN's, pinned in test_chat.py


async def test_a_deleted_accounts_positions_are_gone_though_its_memberships_stay(client, capsys, db_session_factory):
    """Account deletion keeps the memberships and the invitation rows, so
    nothing but the person could find these."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _sent(await _gsend(client, cast.member, cast.group_id, "In the group"))
    await _sent(await _xsend(client, cast.member, gid, "In the gathering"))
    person = await _person_id(db_session_factory, INVITEE)
    await _mark_newest(client, world.invitee, f"/groups/{cast.group_id}")
    await _mark_newest(client, world.invitee, f"/gatherings/{gid}")
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=world.invitee)).status_code == 204
    assert await _positions(db_session_factory) == {}
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM memberships WHERE person_id = :p"), {"p": person}) == 1
        assert await db.scalar(text("SELECT count(*) FROM gathering_invitations WHERE person_id = :p"), {"p": person}) == 1
        assert await db.scalar(select(Gathering.id).where(Gathering.id == UUID(gid))) is not None
