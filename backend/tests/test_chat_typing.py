"""Typing, in memory, and the poll's two headers (CK-104; the chat record §8.3
as amended; Steven's approval of 2026-11-25 and its amendment of the same
day).

The signal rides on the poll: `X-Chat-Typing: 1`. There is no typing route.
Its state is `services/chat_typing.py`, the standard library alone: one
instant a person a chat, overwritten, read for six seconds and then ignored,
dropped when they send in that chat, when their access ends and when their
account is deleted (those three are in tests/test_chat_reading.py beside the
position's). Every poll answer carries `typing`, the display names of the
OTHER people in that chat, oldest signal first; nothing else does.

Nothing about it is kept: not in the database, not in an address, not in a
query and not in a log, so an access line of a poll with the header is the
access line of a poll without it.

`X-Chat-Since` carries a poll's instant in place of `since`, so the address
is the same at every check and its preflight is cached (`max_age` 7200).
"""

import ast
import importlib
import importlib.util
import logging
import re
import sys
from contextlib import contextmanager
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, text

from app.db import engine
from tests.test_chat import (
    EXTREMES,
    JOINER,
    PLAIN,
    POLL_KEYS,
    _answer,
    _bodies,
    _by_id,
    _chat_api,
    _forged,
    _gread,
    _gsend,
    _invite_into_group,
    _missing_gathering,
    _now,
    _plant_many,
    _sent,
    _xread,
    _xsend,
)
from tests.test_chat_container import _container
from tests.test_group_membership import CO_ADMIN, MEMBER, _cast, _group_404, _person_id
from tests.test_groups import MISSING
from tests.test_member_places import _extra_member
from tests.test_outside_invitations import CO_HOST, INVITEE, OUTSIDER, _let_in, _on, _world

ORIGIN = "http://localhost:5173"
TYPING = {"X-Chat-Typing": "1"}


class _Clock:
    """A monotonic clock a test turns by hand."""

    def __init__(self) -> None:
        self.now = 5000.0

    def __call__(self) -> float:
        return self.now

    def turn(self, seconds: float) -> None:
        self.now += seconds


def _module():
    return importlib.import_module("app.services.chat_typing")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    """A store of its own for each test, on a clock turned by hand."""
    clock = _Clock()
    if importlib.util.find_spec("app.services.chat_typing") is not None:
        module = _module()
        monkeypatch.setattr(module, "store", module.TypingStore(clock))
    return clock


async def _gpoll(client, headers, group_id: str, *, typing: bool = False, **params):
    params.setdefault("since", _now().isoformat())
    return await _gread(client, {**headers, **(TYPING if typing else {})}, group_id, **params)


async def _xpoll(client, headers, gathering_id: str, *, typing: bool = False, **params):
    params.setdefault("since", _now().isoformat())
    return await _xread(client, {**headers, **(TYPING if typing else {})}, gathering_id, **params)


async def _typing(response) -> list[str]:
    answer = await _answer(response)
    assert set(answer) == POLL_KEYS
    return answer["typing"]


async def _names(db_session_factory) -> dict[str, str]:
    async with db_session_factory() as db:
        return dict((await db.execute(text("SELECT email, display_name FROM people WHERE email IS NOT NULL"))).all())


# --- who sees it ----------------------------------------------------------------------------


async def test_a_name_is_shown_to_the_other_people_in_a_groups_chat_and_never_to_its_own(
    client, capsys, db_session_factory, clock
):
    cast = await _cast(client, capsys, db_session_factory)
    names = await _names(db_session_factory)
    # Nobody yet: an empty list, on every poll.
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []
    assert await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True)) == []  # never their own
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER]]
    clock.turn(1)
    assert await _typing(await _gpoll(client, cast.co_admin, cast.group_id, typing=True)) == [names[MEMBER]]
    # Oldest signal first.
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER], names[CO_ADMIN]]
    assert await _typing(await _gpoll(client, cast.member, cast.group_id)) == [names[CO_ADMIN]]
    assert await _typing(await _gpoll(client, cast.co_admin, cast.group_id)) == [names[MEMBER]]


async def test_a_name_is_shown_to_the_other_people_in_a_gatherings_chat_an_outsider_included(
    client, capsys, db_session_factory, clock
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    names = await _names(db_session_factory)
    for headers in (cast.member, world.co_host, world.invitee, outsider):
        await _typing(await _xpoll(client, headers, gid, typing=True))
        clock.turn(1)
    assert await _typing(await _xpoll(client, cast.admin, gid)) == [
        names[address] for address in (MEMBER, CO_HOST, INVITEE, OUTSIDER)
    ]
    assert names[OUTSIDER] not in await _typing(await _xpoll(client, outsider, gid))
    # The group's own chat is another chat: nobody is typing there.
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []


async def test_one_without_the_door_neither_signals_nor_sees(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    container = await _container(db_session_factory, cast.group_id)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    await _typing(await _xpoll(client, cast.member, gid, typing=True))
    refused = await _gpoll(client, cast.stranger, cast.group_id, typing=True)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.stranger)
    refused = await _xpoll(client, cast.stranger, gid, typing=True)
    assert (refused.status_code, refused.content) == await _missing_gathering(client, cast.stranger)
    refused = await _xpoll(client, cast.co_admin, gid, typing=True)  # only shared with
    assert (refused.status_code, refused.content) == await _missing_gathering(client, cast.co_admin)
    member = await _person_id(db_session_factory, MEMBER)
    nobody = UUID(MISSING)
    assert _module().store.others(UUID(container), nobody) == [member]
    assert _module().store.others(UUID(gid), nobody) == [member]


async def test_a_name_is_read_at_the_poll_and_only_of_someone_who_can_read_the_chat_now(
    client, capsys, db_session_factory
):
    """A signal that outlives its person's way in — one noted at the very
    instant their access ended — is never shown: the poll asks who can read
    the chat now, and whose account still is."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    container = await _container(db_session_factory, cast.group_id)
    plain, _, plain_person = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    async with db_session_factory() as db:
        stranger = await db.scalar(
            text("SELECT id FROM people WHERE id NOT IN (SELECT person_id FROM memberships) ORDER BY created_at LIMIT 1")
        )
    store = _module().store
    for person in (stranger, plain_person, await _person_id(db_session_factory, CO_ADMIN)):
        store.note(UUID(container), person)
        store.note(UUID(gid), person)
    names = await _names(db_session_factory)
    assert sorted(await _typing(await _gpoll(client, cast.admin, cast.group_id))) == sorted(
        [names[PLAIN], names[CO_ADMIN]]
    )
    assert await _typing(await _xpoll(client, cast.admin, gid)) == []  # shared with, or in neither
    async with db_session_factory() as db:
        await db.execute(text("UPDATE people SET display_name = 'Renamed' WHERE email = :e"), {"e": PLAIN})
        await db.execute(text("UPDATE people SET anonymized_at = now(), email = NULL WHERE email = :e"), {"e": CO_ADMIN})
        await db.commit()
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == ["Renamed"]


# --- six seconds, one entry, and what ends it ---------------------------------------------------


async def test_a_signal_is_read_for_six_seconds_and_then_ignored(client, capsys, db_session_factory, clock):
    cast = await _cast(client, capsys, db_session_factory)
    names = await _names(db_session_factory)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    clock.turn(5.9)
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER]]
    clock.turn(0.1)
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []
    assert _module().TYPING_WINDOW == 6.0
    # Nothing is kept of it, not even in memory.
    assert _module().store.entries() == 0


async def test_a_second_signal_overwrites_the_first_and_leaves_one_entry(client, capsys, db_session_factory, clock):
    cast = await _cast(client, capsys, db_session_factory)
    names = await _names(db_session_factory)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    clock.turn(4)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    assert _module().store.entries() == 1
    clock.turn(4)  # eight seconds from the first, four from the second
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER]]
    clock.turn(2)
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []


async def test_a_poll_without_the_header_changes_nothing(client, capsys, db_session_factory, clock):
    """A second window that isn't typing can't end the first's signal, and
    can't keep it going."""
    cast = await _cast(client, capsys, db_session_factory)
    names = await _names(db_session_factory)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    clock.turn(3)
    await _typing(await _gpoll(client, cast.member, cast.group_id))
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER]]
    clock.turn(3)
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []


async def test_sending_in_a_chat_ends_the_signal_there_and_nowhere_else(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    names = await _names(db_session_factory)
    for poll, place in ((_gpoll, cast.group_id), (_xpoll, gid)):
        await _typing(await poll(client, cast.member, place, typing=True))
    await _sent(await _gsend(client, cast.member, cast.group_id, "Done writing"))
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == []
    assert await _typing(await _xpoll(client, cast.admin, gid)) == [names[MEMBER]]
    await _sent(await _xsend(client, cast.admin, gid, "Somebody else's words"))
    assert await _typing(await _xpoll(client, world.co_host, gid)) == [names[MEMBER]]
    await _sent(await _xsend(client, cast.member, gid, "Done writing"))
    assert await _typing(await _xpoll(client, cast.admin, gid)) == []
    # A refused send ends nothing: the person is still writing.
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    assert (await _gsend(client, cast.member, cast.group_id, "   ")).status_code == 422
    assert await _typing(await _gpoll(client, cast.admin, cast.group_id)) == [names[MEMBER]]


async def test_a_fresh_app_knows_of_nobody(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    assert _module().store.entries() == 1
    spec = importlib.util.spec_from_file_location("a_fresh_chat_typing", _module().__file__)
    fresh = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = fresh
    try:
        spec.loader.exec_module(fresh)
        assert fresh.store.entries() == 0
    finally:
        del sys.modules[spec.name]


def test_the_stores_oldest_comes_first_and_expired_entries_are_dropped():
    clock = _Clock()
    store = _module().TypingStore(clock)
    chat, other_chat = uuid4(), uuid4()
    people = [uuid4() for _ in range(3)]
    for person in people:
        store.note(chat, person)
        clock.turn(1)
    store.note(other_chat, people[0])
    assert store.others(chat, people[1]) == [people[0], people[2]]
    store.note(chat, people[0])  # the newest signal now
    assert store.others(chat, uuid4()) == [people[1], people[2], people[0]]
    assert store.entries() == 4
    store.drop(chat, people[0])
    store.drop(chat, uuid4())  # nobody: nothing
    assert store.others(chat, uuid4()) == [people[1], people[2]]
    assert store.others(other_chat, uuid4()) == [people[0]]
    store.drop_person(people[0])
    assert store.others(other_chat, uuid4()) == []
    clock.turn(60)
    store.note(other_chat, people[2])  # a note anywhere clears what has run out everywhere
    assert store.entries() == 1


def test_the_module_is_the_standard_library_and_has_nothing_to_write_with():
    """In memory alone (Q4): it imports nothing of the app's and no library,
    logs nothing, prints nothing and opens nothing."""
    tree = ast.parse(open(_module().__file__, encoding="utf-8").read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0
            imported.add(node.module.split(".")[0])
    assert imported <= set(sys.stdlib_module_names)
    assert "logging" not in imported
    called = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
    assert not called & {"print", "open", "exec", "eval"}


# --- what carries it -----------------------------------------------------------------------------


async def test_every_poll_answer_carries_typing_and_nothing_else_does(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    names = await _names(db_session_factory)
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    sent = await _sent(await _gsend(client, cast.admin, cast.group_id, "Words"))
    assert "typing" not in sent
    for path, params in (
        (f"/groups/{cast.group_id}/chat", {}),
        (f"/groups/{cast.group_id}/chat", {"open": "true"}),
        (f"/groups/{cast.group_id}/chat", {"after": _forged("2026-01-01T00:00:00+00:00")}),
        (f"/groups/{cast.group_id}/chat", {"before": _forged("2999-01-01T00:00:00+00:00")}),
        (f"/gatherings/{gid}/chat", {}),
        (f"/groups/{cast.group_id}", {}),
        (f"/gatherings/{gid}", {}),
        ("/chats/new", {}),
        ("/groups", {}),
        ("/gatherings", {}),
        (f"/messages/{sent['id']}/reactions", {}),
    ):
        response = await client.get(path, params=params, headers=cast.admin)
        assert response.status_code == 200, (path, params, response.text)
        assert "typing" not in response.json(), path
    # A truncated poll too.
    container = await _container(db_session_factory, cast.group_id)
    await _plant_many(db_session_factory, container, CO_ADMIN, 205, start="now()")
    await _typing(await _gpoll(client, cast.member, cast.group_id, typing=True))
    answer = await _answer(await _gpoll(client, cast.admin, cast.group_id))
    assert answer["truncated"] is True and answer["items"] == [] and answer["typing"] == [names[MEMBER]]


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


async def test_the_names_are_one_small_read_made_only_when_someone_is_typing(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    for poll, place, others in (
        (_gpoll, cast.group_id, (cast.member, cast.co_admin, world.invitee)),
        (_xpoll, gid, (cast.member, world.co_host, world.invitee)),
    ):
        await poll(client, cast.admin, place)  # the session's refresh, the container

        async def counted() -> int:
            with _statements() as made:
                await _answer(await poll(client, cast.admin, place))
            return len(made)

        quiet = await counted()
        await _typing(await poll(client, cast.admin, place, typing=True))  # their own signal reads no name
        assert await counted() == quiet
        for headers in others:
            await _typing(await poll(client, headers, place, typing=True))
            assert await counted() == quiet + 1
        with _statements() as made:
            await _answer(await poll(client, cast.admin, place))
        assert not re.search(r"\bposts\b", made[-1]) and re.search(r"\bpeople\b", made[-1])


# --- the signal's header ------------------------------------------------------------------------------


def _only(refused, loc: list[str]) -> dict:
    assert refused.status_code == 422, refused.text
    (entry,) = refused.json()["detail"]
    assert entry["loc"] == loc, entry
    assert entry["type"] == "value_error"
    return entry


@pytest.mark.parametrize("value", ["0", "2", "11", "01", "true", "True", "yes", "", "1,1", "one", "½"])
async def test_any_value_but_1_is_a_422_at_its_name(client, capsys, db_session_factory, value):
    cast = await _cast(client, capsys, db_session_factory)
    headers = {name: told.encode("ascii") for name, told in cast.member.items()}
    headers["X-Chat-Typing"] = value.encode("latin-1")
    refused = await _gread(client, headers, cast.group_id, since=_now().isoformat())
    entry = _only(refused, ["header", "x-chat-typing"])
    assert entry["msg"] == _chat_api().BAD_TYPING
    assert _module().store.entries() == 0


async def test_the_signal_on_a_read_that_is_not_a_poll_is_a_422_at_its_name(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    cursor = _forged("2026-11-20T10:00:00+00:00")
    for read, place in ((_gread, cast.group_id), (_xread, gid)):
        for params in ({}, {"before": cursor}, {"after": cursor}, {"open": "true"}, {"limit": 5}):
            refused = await read(client, {**cast.member, **TYPING}, place, **params)
            entry = _only(refused, ["header", "x-chat-typing"])
            assert entry["msg"] == _chat_api().TYPING_NOT_A_POLL
    # Refused before any door is asked, as every refusal of a read's own shape is.
    assert (await _gread(client, {**cast.stranger, **TYPING}, cast.group_id)).status_code == 422
    assert _module().store.entries() == 0
    # And taken on a poll whichever way its instant comes.
    both = {**cast.member, **TYPING, "X-Chat-Since": _now().isoformat()}
    assert (await _gread(client, both, cast.group_id)).status_code == 200
    assert _module().store.entries() == 1


async def test_a_poll_with_the_signal_and_one_without_are_one_address_one_query_and_one_record(
    client, capsys, db_session_factory, caplog
):
    """The header alone tells them apart. No line anywhere does — not the
    address's, not the application's, not the database's — so nothing that
    is kept says anyone typed."""
    cast = await _cast(client, capsys, db_session_factory)
    since = _now().isoformat()
    await _gpoll(client, cast.member, cast.group_id, since=since)  # the session's refresh, the container

    async def polled(typing: bool):
        caplog.clear()
        with caplog.at_level(logging.DEBUG), _statements() as made:
            response = await _gpoll(client, cast.member, cast.group_id, typing=typing, since=since)
        await _answer(response)
        lines = [(r.name, r.levelname, r.getMessage()) for r in caplog.records]
        return response.request.url, lines, list(made)

    without = await polled(False)
    with_it = await polled(True)
    assert _module().store.entries() == 1
    assert str(with_it[0]) == str(without[0])
    assert with_it[0].query == without[0].query
    assert with_it[1] == without[1]
    assert with_it[2] == without[2]  # and nothing is written
    assert not [s for s in with_it[2] if re.match(r"\s*(INSERT|UPDATE|DELETE)\b", s)]


async def test_there_is_no_typing_route(client, capsys, db_session_factory):
    from app.main import app

    cast = await _cast(client, capsys, db_session_factory)
    for route in app.routes:
        assert "typing" not in getattr(route, "path", "")
    for path in (f"/groups/{cast.group_id}/chat/typing", f"/gatherings/{MISSING}/chat/typing"):
        for method in ("PUT", "POST", "GET"):
            assert (await client.request(method, path, headers=cast.member)).status_code == 404


# --- X-Chat-Since ----------------------------------------------------------------------------------------


async def test_a_poll_answers_the_same_through_the_header_as_through_the_query(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _sent(await _gsend(client, cast.member, cast.group_id, "In the group"))
    await _sent(await _xsend(client, cast.member, gid, "In the gathering"))
    for at in (_now() - timedelta(minutes=5), _now(), _now() + timedelta(days=1)):
        for text_at in (at.isoformat(), at.isoformat().replace("+00:00", "Z")):
            for read, place in ((_gread, cast.group_id), (_xread, gid)):
                by_query = await _answer(await read(client, cast.admin, place, since=text_at))
                answered = await read(client, {**cast.admin, "X-Chat-Since": text_at}, place)
                by_header = await _answer(answered)
                assert set(by_header) == POLL_KEYS
                by_query.pop("as_of"), by_header.pop("as_of")
                assert by_header == by_query
                assert str(answered.request.url).endswith("/chat")  # the same address at every check
    # Neither: the plain first read, as it was.
    plain = await _answer(await _gread(client, cast.admin, cast.group_id))
    assert "older" in plain and _bodies(plain) == ["In the group"]


async def test_the_header_is_refused_as_the_query_is_and_both_at_once_are_a_422(client, capsys, db_session_factory):
    chat = _chat_api()
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    for read, place in ((_gread, cast.group_id), (_xread, gid)):
        for at in EXTREMES:
            refused = await read(client, {**cast.member, "X-Chat-Since": at}, place)
            assert _only(refused, ["header", "x-chat-since"])["msg"] == chat.BAD_SINCE
        for at in ("yesterday", "", "2026-11-25T10:00:00"):
            refused = await read(client, {**cast.member, "X-Chat-Since": at}, place)
            by_query = await read(client, cast.member, place, since=at)
            assert refused.status_code == by_query.status_code == 422, at
            (of_header,), (of_query,) = refused.json()["detail"], by_query.json()["detail"]
            assert of_header["loc"] == ["header", "x-chat-since"] and of_query["loc"] == ["query", "since"]
            assert {k: v for k, v in of_header.items() if k != "loc"} == {
                k: v for k, v in of_query.items() if k != "loc"
            }
        for at in ("2000-01-01T00:00:00+00:00", "9999-12-31T23:59:59+00:00"):  # the edges are asked
            assert set(await _answer(await read(client, {**cast.member, "X-Chat-Since": at}, place))) == POLL_KEYS
        both = await read(client, {**cast.member, "X-Chat-Since": _now().isoformat()}, place, since=_now().isoformat())
        assert _only(both, ["query", "since"])["msg"] == chat.ONE_WAY


async def test_a_preflight_is_kept_two_hours_and_allows_both_headers(client):
    for path in (f"/groups/{MISSING}/chat", f"/gatherings/{MISSING}/chat"):
        answered = await client.options(
            path,
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,x-chat-since,x-chat-typing",
            },
        )
        assert answered.status_code == 200, answered.text
        assert answered.headers["access-control-max-age"] == "7200"
        allowed = {h.strip().lower() for h in answered.headers["access-control-allow-headers"].split(",")}
        assert {"authorization", "x-chat-since", "x-chat-typing"} <= allowed
        assert answered.headers["access-control-allow-origin"] == ORIGIN
        assert answered.headers["access-control-allow-credentials"] == "true"
    elsewhere = await client.options(
        f"/groups/{MISSING}/chat",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert elsewhere.status_code == 400 and "access-control-allow-origin" not in elsewhere.headers


async def test_a_poll_answer_through_the_header_carries_the_cors_headers(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    answered = await _gread(client, {**joiner, "X-Chat-Since": _now().isoformat(), "Origin": ORIGIN}, cast.group_id)
    assert answered.status_code == 200 and answered.headers["access-control-allow-origin"] == ORIGIN
    assert _by_id(answered.json())  # their own join line, inside the lookback
