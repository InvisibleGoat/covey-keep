"""Messages in a group's chat and a gathering's (CK-102;
decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §2, §3, §6,
§9, §14; Steven's answers of 2026-11-21).

`api/chat.py`, the sixteenth router: `GET` and `POST /groups/{id}/chat`,
`GET` and `POST /gatherings/{id}/chat`, and `POST /messages/{id}/remove`.

- **A gathering's chat** is behind `_gathering_for_invited`, unchanged: the
  host, the co-hosts and everyone invited, whenever they were invited — an
  invitee who answered *Can't make it*, an outsider while they hold their
  row, the co-hosts of a hostless gathering. Everyone else draws the
  gathering's 404, byte-identical to a missing id.
- **A group's chat** is read from the caller's membership's `created_at` on
  (`group_chat_window`): a message one microsecond older is unread; leaving
  ends reading at once; coming back is a new window; the admin seat alone
  opens nothing.
- **Lines the chat writes itself**: a join line in the membership's own
  transaction (its instant), a setting line when the outside setting
  actually changes — drawn only for the group's members now.
- **Removing** is one guarded UPDATE; the remover says which act it was. A
  removed message is HELD: shown in place, marked, to the people who run
  the place inside their own window, until `removed_at + REMOVED_BIN`, and
  to nobody else at any moment.
- **The poll** reads `since` minus a lookback, names what left the
  caller's chat, and gives up past 200.
- **What cannot be kept or read is a 422 at its own field** (CK-102's
  fix-up): a message that holds a NUL, a `since` or a cursor's instant
  before `EARLIEST_INSTANT` or past what UTC can hold.

The sweep that destroys a held message at its window is in
tests/test_chat_sweep.py; the container in tests/test_chat_container.py.
"""

import base64
import importlib
import logging
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import event, text

from app.db import engine
from app.services.retention import REMOVED_BIN
from tests.test_account_deletion import DELETE_BODY
from tests.test_chat_container import _container
from tests.test_gatherings import _account_for, _signed_in_headers
from tests.test_gatherings import _create as _create_standalone
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _approve, _join, _make, _requests, _token_of
from tests.test_group_membership import (
    ADMIN,
    MEMBER,
    _add_member,
    _appoint,
    _cast,
    _group_404,
    _hand_over,
    _leave,
    _person_id,
    _remove,
)
from tests.test_groups import MISSING
from tests.test_groups import _create as _create_group
from tests.test_invitations import _accept as _accept_invitation
from tests.test_invitations import _invite_token
from tests.test_member_places import _extra_member, _put_place
from tests.test_outside_invitations import INVITEE, KEEPER, LEAVER, LEFT, OUTSIDER, _let_in, _off, _on, _world
from tests.test_race_backstops import _select_from, _stage
from tests.test_rsvps import _put_rsvp

JOINER = "joiner@example.com"
PLAIN = "plain@example.com"  # a member who runs nothing
LATER = "later@example.com"  # joins after the words were written

ITEM_KEYS = {"id", "kind", "created_at", "author", "body", "removed"}
READ_KEYS = {"items", "older", "as_of", "may_moderate"}
POLL_KEYS = {"items", "removed", "truncated", "as_of", "may_moderate"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _chat_api():
    """The router module, imported when a test needs it — so this file
    collects, and fails test by test, before the router exists."""
    return importlib.import_module("app.api.chat")


# --- routes ------------------------------------------------------------------------


async def _gread(client, headers, group_id: str, **params):
    return await client.get(f"/groups/{group_id}/chat", params=params, headers=headers)


async def _gsend(client, headers, group_id: str, body: str = "Hello"):
    return await client.post(f"/groups/{group_id}/chat", json={"body": body}, headers=headers)


async def _xread(client, headers, gathering_id: str, **params):
    return await client.get(f"/gatherings/{gathering_id}/chat", params=params, headers=headers)


async def _xsend(client, headers, gathering_id: str, body: str = "Hello"):
    return await client.post(f"/gatherings/{gathering_id}/chat", json={"body": body}, headers=headers)


async def _remove_message(client, headers, message_id: str):
    return await client.post(f"/messages/{message_id}/remove", headers=headers)


async def _sent(response) -> dict:
    assert response.status_code == 201, response.text
    return response.json()


async def _answer(response) -> dict:
    assert response.status_code == 200, response.text
    return response.json()


def _bodies(answer: dict) -> list[str]:
    return [item["body"] for item in answer["items"] if item["kind"] == "message"]


def _kinds(answer: dict) -> list[str]:
    return [item["kind"] for item in answer["items"]]


def _by_id(answer: dict) -> dict[str, dict]:
    return {item["id"]: item for item in answer["items"]}


async def _missing_gathering(client, headers, method: str = "GET") -> tuple[int, bytes]:
    if method == "GET":
        response = await _xread(client, headers, MISSING)
    else:
        response = await _xsend(client, headers, MISSING, "Anyone there?")
    assert response.status_code == 404, response.text
    return response.status_code, response.content


async def _missing_message(client, headers) -> tuple[int, bytes]:
    response = await _remove_message(client, headers, MISSING)
    assert response.status_code == 404, response.text
    return response.status_code, response.content


def _code(response) -> str:
    return response.json()["detail"]["code"]


async def _plant_message(
    db_session_factory, gathering_id: str, author_address: str, body: str, *, at: str | None = None
) -> str:
    """A message written straight to `posts`, its instant given as SQL
    (`at`) or the transaction's `now()`."""
    async with db_session_factory() as db:
        author = await db.scalar(text("SELECT id FROM people WHERE email = :e"), {"e": author_address})
        made = await db.scalar(
            text(
                "INSERT INTO posts (gathering_id, author_person_id, kind, body, publication_state, created_at) "
                f"VALUES (:g, :a, 'message', :b, 'live', {at or 'now()'}) RETURNING id"
            ),
            {"g": UUID(gathering_id), "a": author, "b": body},
        )
        await db.commit()
        return str(made)


async def _membership_since(db_session_factory, group_id: str, address: str) -> datetime:
    async with db_session_factory() as db:
        return await db.scalar(
            text(
                "SELECT m.created_at FROM memberships m JOIN people p ON p.id = m.person_id "
                "WHERE m.group_id = :g AND p.email = :e"
            ),
            {"g": UUID(group_id), "e": address},
        )


async def _post(db_session_factory, post_id: str) -> tuple:
    async with db_session_factory() as db:
        return (
            await db.execute(
                text(
                    "SELECT kind::text, body, publication_state::text, removed_at, removed_by_person_id, created_at "
                    "FROM posts WHERE id = :p"
                ),
                {"p": UUID(post_id)},
            )
        ).one()


async def _posts_count(db_session_factory) -> int:
    async with db_session_factory() as db:
        return await db.scalar(text("SELECT count(*) FROM posts"))


async def _invite_into_group(client, capsys, admin: dict, group_id: str, address: str) -> dict:
    headers = await _signed_in_headers(client, capsys, address)
    token = await _group_invite_token(client, capsys, admin, group_id, address)
    assert (await _accept_group_invitation(client, headers, token))["status"] == "accepted"
    return headers


async def _approve_into_group(client, capsys, admin: dict, group_id: str, address: str) -> dict:
    headers = await _signed_in_headers(client, capsys, address)
    token = _token_of((await _make(client, admin, group_id)).json())
    assert (await _join(client, headers, token)).status_code in (200, 201)
    (entry,) = (await _requests(client, admin, group_id)).json()["join_requests"]
    assert (await _approve(client, admin, group_id, entry["id"])).status_code == 200
    return headers


async def _make_keeper(client, capsys, db_session_factory, group_id: str) -> dict:
    headers = await _signed_in_headers(client, capsys, KEEPER)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE groups SET keeper_account_id = :k WHERE id = :g"),
            {"k": (await _account_for(db, KEEPER)).id, "g": UUID(group_id)},
        )
        await db.commit()
    return headers


# --- a gathering's chat, by seat --------------------------------------------------------


async def test_a_gatherings_chat_is_read_and_written_by_the_invited_tier_alone(client, capsys, db_session_factory):
    """The host, a co-host, an invitee who answered Can't make it, an
    invited group admin who runs nothing there, and an outsider while the
    setting is on each send and read the whole chat. A member only shared
    with, one left out, the keeper by keeping, a group admin who isn't
    invited and a stranger draw the gathering's 404 on both — byte-identical
    to a missing id — and an outsider does once the setting is off."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    assert (await _put_rsvp(client, world.invitee, world.occurrence_id, {"response": "no"})).status_code == 200
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    readers = {
        "host": cast.member,
        "co_host": world.co_host,
        "invitee": world.invitee,
        "admin": cast.admin,
        "outsider": outsider,
    }
    for seat, headers in readers.items():
        item = await _sent(await _xsend(client, headers, gid, f"From the {seat}"))
        assert set(item) == ITEM_KEYS and item["kind"] == "message" and item["author"]["is_self"] is True
    for seat, headers in readers.items():
        answer = await _answer(await _xread(client, headers, gid))
        assert set(answer) == READ_KEYS
        assert _bodies(answer) == [f"From the {s}" for s in readers], seat
        assert answer["may_moderate"] is (seat in ("host", "co_host")), seat

    left, left_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, LEFT)
    assert (await _put_place(client, cast.member, gid, left_membership, "left_out")).status_code == 200
    keeper = await _make_keeper(client, capsys, db_session_factory, cast.group_id)
    other = await _create_in_group(
        client, cast.member, cast.group_id, title="Not for the admin", invited=[world.invitee_membership]
    )
    refused = {
        "shared with": (cast.co_admin, gid),
        "left out": (left, gid),
        "keeper": (keeper, gid),
        "admin not invited": (cast.admin, other["id"]),
        "stranger": (cast.stranger, gid),
    }
    before = await _posts_count(db_session_factory)
    for seat, (headers, target) in refused.items():
        read = await _xread(client, headers, target)
        sent = await _xsend(client, headers, target, "Let me in")
        assert (read.status_code, read.content) == await _missing_gathering(client, headers), seat
        assert (sent.status_code, sent.content) == await _missing_gathering(client, headers, "POST"), seat
    assert await _posts_count(db_session_factory) == before

    await _off(client, cast.member, gid)
    read = await _xread(client, outsider, gid)
    assert (read.status_code, read.content) == await _missing_gathering(client, outsider)


async def test_the_co_hosts_of_a_hostless_gathering_still_read_write_and_run_its_chat(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        await db.execute(text("UPDATE gatherings SET host_account_id = NULL WHERE id = :g"), {"g": UUID(world.gathering_id)})
        await db.commit()
    await _sent(await _xsend(client, world.co_host, world.gathering_id, "Still here"))
    answer = await _answer(await _xread(client, world.co_host, world.gathering_id))
    assert _bodies(answer) == ["Still here"] and answer["may_moderate"] is True
    host_view = await _xread(client, world.cast.member, world.gathering_id)
    assert (host_view.status_code, host_view.content) == await _missing_gathering(client, world.cast.member)


async def test_a_standalone_gathering_has_a_chat_too(client, capsys, db_session_factory):
    host = await _signed_in_headers(client, capsys, "host@example.com")
    guest = await _signed_in_headers(client, capsys, "guest@example.com")
    stranger = await _signed_in_headers(client, capsys, "nobody@example.com")
    gid = (await _create_standalone(client, host))["id"]
    token = await _invite_token(client, capsys, host, gid, "guest@example.com")
    assert (await _accept_invitation(client, guest, token))["status"] == "accepted"
    await _sent(await _xsend(client, host, gid, "Bring a chair"))
    await _sent(await _xsend(client, guest, gid, "Will do"))
    for headers in (host, guest):
        assert _bodies(await _answer(await _xread(client, headers, gid))) == ["Bring a chair", "Will do"]
    read = await _xread(client, stranger, gid)
    assert (read.status_code, read.content) == await _missing_gathering(client, stranger)


async def test_the_container_is_not_a_gathering_anyone_can_reach_through_the_gathering_chat(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _sent(await _gsend(client, cast.member, cast.group_id, "In the group"))
    container = await _container(db_session_factory, cast.group_id)
    for headers in (cast.admin, cast.member, cast.stranger):
        read = await _xread(client, headers, container)
        sent = await _xsend(client, headers, container, "Sideways")
        assert (read.status_code, read.content) == await _missing_gathering(client, headers)
        assert (sent.status_code, sent.content) == await _missing_gathering(client, headers, "POST")


# --- a group's chat, and its window -------------------------------------------------------


async def test_a_member_reads_from_the_instant_they_joined_and_not_a_microsecond_before(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.admin, cast.group_id)  # the container, made on the first read
    container = await _container(db_session_factory, cast.group_id)
    since = await _membership_since(db_session_factory, cast.group_id, MEMBER)
    await _plant_message(
        db_session_factory, container, ADMIN, "A microsecond early",
        at=f"'{since.isoformat()}'::timestamptz - interval '1 microsecond'",
    )
    await _plant_message(db_session_factory, container, ADMIN, "Exactly then", at=f"'{since.isoformat()}'::timestamptz")
    assert _bodies(await _answer(await _gread(client, cast.member, cast.group_id))) == ["Exactly then"]
    assert _bodies(await _answer(await _gread(client, cast.admin, cast.group_id))) == ["A microsecond early", "Exactly then"]


async def test_leaving_or_being_removed_ends_reading_at_once_and_coming_back_is_a_new_window(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    plain, plain_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    await _sent(await _gsend(client, cast.member, cast.group_id, "Before I go"))
    assert (await _leave(client, cast.member, cast.group_id)).status_code == 204
    assert (await _remove(client, cast.admin, cast.group_id, plain_membership)).status_code == 204
    for headers in (cast.member, plain):
        read = await _gread(client, headers, cast.group_id)
        sent = await _gsend(client, headers, cast.group_id, "Still here?")
        assert (read.status_code, read.content) == await _group_404(client, headers)
        assert (sent.status_code, sent.content) == await _group_404(client, headers)
    await _add_member(db_session_factory, cast.group_id, MEMBER)  # back, a new row
    assert _bodies(await _answer(await _gread(client, cast.member, cast.group_id))) == []  # their own old one too
    await _sent(await _gsend(client, cast.member, cast.group_id, "Back again"))
    assert _bodies(await _answer(await _gread(client, cast.member, cast.group_id))) == ["Back again"]
    assert _bodies(await _answer(await _gread(client, cast.admin, cast.group_id))) == ["Before I go", "Back again"]


async def test_an_admin_reads_from_their_own_joining_and_the_admin_seat_alone_opens_nothing(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _sent(await _gsend(client, cast.admin, cast.group_id, "Before you came"))
    later, later_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, LATER)
    assert (await _hand_over(client, cast.admin, cast.group_id, later_membership)).status_code == 200
    answer = await _answer(await _gread(client, later, cast.group_id))
    assert _bodies(answer) == [] and answer["may_moderate"] is True
    # The admin seat with no membership row: nothing.
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM memberships WHERE id = :m"), {"m": UUID(later_membership)})
        await db.commit()
    read = await _gread(client, later, cast.group_id)
    sent = await _gsend(client, later, cast.group_id, "I run this")
    assert (read.status_code, read.content) == await _group_404(client, later)
    assert (sent.status_code, sent.content) == await _group_404(client, later)


async def test_a_groups_chat_is_refused_to_a_stranger_and_for_a_missing_group(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    keeper = await _make_keeper(client, capsys, db_session_factory, cast.group_id)
    for headers in (cast.stranger, keeper):
        read = await _gread(client, headers, cast.group_id)
        assert (read.status_code, read.content) == await _group_404(client, headers)
    missing = await _gread(client, cast.member, MISSING)
    assert (missing.status_code, missing.content) == await _group_404(client, cast.member)


# --- the join line -------------------------------------------------------------------


async def test_both_ways_in_write_a_join_line_at_the_memberships_instant_that_the_joiner_sees(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _sent(await _gsend(client, cast.admin, cast.group_id, "Before anyone joined"))
    invited = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    approved = await _approve_into_group(client, capsys, cast.admin, cast.group_id, PLAIN)
    container = await _container(db_session_factory, cast.group_id)
    for headers, address in ((invited, JOINER), (approved, PLAIN)):
        answer = await _answer(await _gread(client, headers, cast.group_id))
        (line,) = [item for item in answer["items"] if item["author"]["is_self"]]
        assert line["kind"] == "joined" and line["body"] is None and line["removed"] is None
        assert line["author"] == {"display_name": address.split("@")[0], "is_self": True}
        assert "Before anyone joined" not in _bodies(answer)
        async with db_session_factory() as db:
            line_at, member_since, in_container = (
                await db.execute(
                    text(
                        "SELECT p.created_at, m.created_at, p.gathering_id = :c FROM posts p "
                        "JOIN memberships m ON m.person_id = p.author_person_id AND m.group_id = :g "
                        "WHERE p.id = :p"
                    ),
                    {"c": UUID(container), "g": UUID(cast.group_id), "p": UUID(line["id"])},
                )
            ).one()
        assert line_at == member_since and in_container
    seen_by_admin = await _answer(await _gread(client, cast.admin, cast.group_id))
    assert _kinds(seen_by_admin) == ["message", "joined", "joined"]


async def test_no_line_at_creation_and_a_second_line_on_coming_back(client, capsys, db_session_factory):
    admin = await _signed_in_headers(client, capsys, ADMIN)
    group = await _create_group(client, admin)
    assert (await _answer(await _gread(client, admin, group["id"])))["items"] == []
    joiner = await _invite_into_group(client, capsys, admin, group["id"], JOINER)
    assert (await _leave(client, joiner, group["id"])).status_code == 204
    token = await _group_invite_token(client, capsys, admin, group["id"], JOINER)
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"
    assert _kinds(await _answer(await _gread(client, admin, group["id"]))) == ["joined", "joined"]
    assert _kinds(await _answer(await _gread(client, joiner, group["id"]))) == ["joined"]


# --- the setting line ----------------------------------------------------------------


async def test_turning_the_setting_on_and_off_writes_one_line_each_and_a_repeat_writes_none(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, world.co_host, gid)
    await _on(client, cast.member, gid)
    await _off(client, cast.member, gid)
    await _off(client, world.co_host, gid)
    answer = await _answer(await _xread(client, cast.member, gid))
    assert _kinds(answer) == ["outside_invitations_on", "outside_invitations_off"]
    assert [item["author"]["display_name"] for item in answer["items"]] == ["cohost", "member"]
    assert [item["body"] for item in answer["items"]] == [None, None]


async def test_a_setting_line_is_drawn_for_the_groups_members_and_never_for_an_outsider(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    leaver, leaver_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, LEAVER)
    assert (await _put_place(client, cast.member, gid, leaver_membership, "invited")).status_code == 200
    first = await _answer(await _xread(client, world.invitee, gid))
    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    await _sent(await _xsend(client, outsider, gid, "Thanks for having me"))
    assert (await _leave(client, leaver, cast.group_id)).status_code == 204  # still invited, no longer a member
    for headers in (world.invitee, cast.admin, world.co_host):
        assert _kinds(await _answer(await _xread(client, headers, gid))) == ["outside_invitations_on", "message"]
        polled = await _answer(await _xread(client, headers, gid, since=first["as_of"]))
        assert "outside_invitations_on" in _kinds(polled)
    for headers in (outsider, leaver):
        assert _kinds(await _answer(await _xread(client, headers, gid))) == ["message"]
        polled = await _answer(await _xread(client, headers, gid, since=first["as_of"]))
        assert _kinds(polled) == ["message"]


# --- sending ---------------------------------------------------------------------


async def test_send_answers_201_with_the_item_its_words_trimmed(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    item = await _sent(await _gsend(client, cast.member, cast.group_id, "  \n Dinner at six?\t "))
    assert set(item) == ITEM_KEYS
    assert (item["kind"], item["body"], item["removed"]) == ("message", "Dinner at six?", None)
    assert item["author"] == {"display_name": "member", "is_self": True}
    kind, body, state, removed_at, remover, _ = await _post(db_session_factory, item["id"])
    assert (kind, body, state, removed_at, remover) == ("message", "Dinner at six?", "live", None, None)
    seen = _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))[item["id"]]
    assert seen["author"] == {"display_name": "member", "is_self": False}
    assert seen["created_at"] == item["created_at"]


async def test_the_words_are_one_to_four_thousand_code_points_and_nothing_else_is_taken(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.member, cast.group_id)
    before = await _posts_count(db_session_factory)
    family = "\U0001f468‍\U0001f469‍\U0001f467‍\U0001f466"  # seven code points
    assert len(family) == 7
    for body, error_type in (
        ("", "string_too_short"),
        ("  \n\t ", "string_too_short"),
        ("x" * 4001, "string_too_long"),
        (family * 571 + "abcd", "string_too_long"),
    ):
        refused = await _gsend(client, cast.member, cast.group_id, body)
        assert refused.status_code == 422, refused.text
        assert [(e["loc"], e["type"]) for e in refused.json()["detail"]] == [(["body", "body"], error_type)]
    for extra in ({"body": "Hi", "kind": "joined"}, {}, {"body": None}):
        refused = await client.post(f"/groups/{cast.group_id}/chat", json=extra, headers=cast.member)
        assert refused.status_code == 422, (extra, refused.text)
    assert await _posts_count(db_session_factory) == before
    for body in ("x" * 4000, family * 571 + "abc", " " + "y" * 4000 + " "):
        item = await _sent(await _gsend(client, cast.member, cast.group_id, body))
        assert len(item["body"]) == 4000


async def test_a_message_that_holds_a_nul_is_refused_at_its_field_and_nothing_is_written(
    client, capsys, db_session_factory
):
    """PostgreSQL's text holds no NUL, so such a message could never be kept:
    a 422 at `body` through both doors, and never the words with the NUL
    taken out. Every other control character is the writer's and is kept."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _gread(client, cast.admin, cast.group_id)
    before = await _posts_count(db_session_factory)
    for words in ("\x00", "a\x00b", " \x00 ", "at the end\x00", "\x00at the start"):
        for refused in (
            await _gsend(client, cast.admin, cast.group_id, words),
            await _xsend(client, cast.admin, gid, words),
        ):
            assert refused.status_code == 422, (words, refused.text)
            assert [(e["loc"], e["type"]) for e in refused.json()["detail"]] == [(["body", "body"], "value_error")]
    assert await _posts_count(db_session_factory) == before
    kept = "one\x01two\ttwo\u2400"
    item = await _sent(await _gsend(client, cast.admin, cast.group_id, kept))
    assert item["body"] == kept
    assert (await _post(db_session_factory, item["id"]))[1] == kept


async def test_the_thirty_first_message_in_a_minute_across_every_chat_is_refused(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    first = None
    for n in range(15):
        item = await _sent(await _gsend(client, cast.admin, cast.group_id, f"Group {n}"))
        first = first or item
        await _sent(await _xsend(client, cast.admin, gid, f"Gathering {n}"))
    assert (await _remove_message(client, cast.admin, first["id"])).status_code == 204  # a deleted one still counts
    before = await _posts_count(db_session_factory)
    for refused in (
        await _gsend(client, cast.admin, cast.group_id, "One more"),
        await _xsend(client, cast.admin, gid, "One more"),
    ):
        assert refused.status_code == 429, refused.text
        assert _code(refused) == "too_many_messages"
    assert await _posts_count(db_session_factory) == before
    await _sent(await _gsend(client, cast.member, cast.group_id, "Someone else is fine"))


async def test_thirty_messages_in_a_minute_are_taken_and_the_thirty_first_is_not(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    for n in range(30):
        await _sent(await _gsend(client, cast.member, cast.group_id, f"Line {n}"))
    assert (await _gsend(client, cast.member, cast.group_id, "Thirty-one")).status_code == 429


# --- removing --------------------------------------------------------------------


async def test_the_writer_deletes_their_own_and_an_organiser_removes_anothers(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _sent(await _gsend(client, cast.member, cast.group_id, "Oops, wrong chat"))
    theirs = await _sent(await _gsend(client, cast.member, cast.group_id, "Something unkind"))
    by_co_admin = await _sent(await _gsend(client, cast.admin, cast.group_id, "Even the admin's"))
    assert (await _remove_message(client, cast.member, mine["id"])).status_code == 204
    assert (await _remove_message(client, cast.admin, theirs["id"])).status_code == 204
    assert (await _remove_message(client, cast.co_admin, by_co_admin["id"])).status_code == 204
    member_person = await _person_id(db_session_factory, MEMBER)
    admin_person = await _person_id(db_session_factory, ADMIN)
    assert (await _post(db_session_factory, mine["id"]))[2:5:2] == ("removed", member_person)
    assert (await _post(db_session_factory, theirs["id"]))[2:5:2] == ("removed", admin_person)
    held = _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))
    assert held[mine["id"]]["removed"]["by"] == "member" and held[mine["id"]]["removed"]["by_writer"] is True
    assert held[theirs["id"]]["removed"]["by"] == "admin" and held[theirs["id"]]["removed"]["by_writer"] is False
    assert held[by_co_admin["id"]]["removed"]["by"] == "coadmin"
    assert set(held[theirs["id"]]["removed"]) == {"at", "by", "by_writer", "by_self"}
    assert held[theirs["id"]]["body"] == "Something unkind"


async def test_a_reader_who_may_do_neither_draws_the_messages_404(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    plain, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    in_group = await _sent(await _gsend(client, cast.member, cast.group_id, "In the group"))
    in_gathering = await _sent(await _xsend(client, cast.member, gid, "From the host"))
    for headers, message in (
        (plain, in_group),
        (cast.stranger, in_group),
        (world.invitee, in_gathering),
        (cast.admin, in_gathering),  # invited, runs the group, not this gathering
        (cast.co_admin, in_gathering),  # only shared with
        (cast.stranger, in_gathering),
    ):
        refused = await _remove_message(client, headers, message["id"])
        assert (refused.status_code, refused.content) == await _missing_message(client, headers)
    for message in (in_group, in_gathering):
        assert (await _post(db_session_factory, message["id"]))[2] == "live"


async def test_a_line_the_chat_wrote_itself_cannot_be_removed(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    plain, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    (join_line,) = [i for i in (await _answer(await _gread(client, cast.admin, cast.group_id)))["items"] if i["kind"] == "joined"]
    await _on(client, cast.member, gid)
    (setting_line,) = (await _answer(await _xread(client, cast.member, gid)))["items"]
    for headers, line in ((cast.admin, join_line), (joiner, join_line), (cast.member, setting_line), (world.co_host, setting_line)):
        refused = await _remove_message(client, headers, line["id"])
        assert refused.status_code == 409 and _code(refused) == "not_a_message", refused.text
    refused = await _remove_message(client, plain, join_line["id"])
    assert (refused.status_code, refused.content) == await _missing_message(client, plain)
    assert (await _post(db_session_factory, join_line["id"]))[2] == "live"


async def test_a_second_remove_is_already_removed_for_an_organiser_and_the_404_for_the_writer(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Twice"))
    assert (await _remove_message(client, cast.member, message["id"])).status_code == 204
    again = await _remove_message(client, cast.admin, message["id"])
    assert again.status_code == 409 and _code(again) == "already_removed"
    by_writer = await _remove_message(client, cast.member, message["id"])
    assert (by_writer.status_code, by_writer.content) == await _missing_message(client, cast.member)
    assert (await _post(db_session_factory, message["id"]))[4] == await _person_id(db_session_factory, MEMBER)


async def test_two_removes_at_once_give_one_204_and_one_refusal_never_a_500(
    client, capsys, db_session_factory, monkeypatch
):
    """Staged (CK-77.1): the organiser's remove reads the message; the
    writer's own delete then commits from a second session; the organiser's
    guarded UPDATE finds the row no longer live and answers
    `already_removed`. A read-then-assign remove would overwrite the
    writer's delete and answer a second 204."""
    cast = await _cast(client, capsys, db_session_factory)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Racing"))
    member_person = await _person_id(db_session_factory, MEMBER)

    async def writer_deletes() -> None:
        async with db_session_factory() as other:
            await other.execute(
                text(
                    "UPDATE posts SET publication_state = 'removed', removed_at = now(), removed_by_person_id = :w "
                    "WHERE id = :p AND publication_state = 'live'"
                ),
                {"w": member_person, "p": UUID(message["id"])},
            )
            await other.commit()

    state = _stage(monkeypatch, when=_select_from("posts"), competitor=writer_deletes)
    raced = await _remove_message(client, cast.admin, message["id"])
    assert state["fired"], "the race was not staged"
    assert raced.status_code == 409 and _code(raced) == "already_removed", raced.text
    assert (await _post(db_session_factory, message["id"]))[4] == member_person


async def test_a_writer_who_has_left_the_group_cannot_delete_their_message(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Left behind"))
    assert (await _leave(client, cast.member, cast.group_id)).status_code == 204
    refused = await _remove_message(client, cast.member, message["id"])
    assert (refused.status_code, refused.content) == await _missing_message(client, cast.member)


# --- the hold --------------------------------------------------------------------


async def test_a_removed_message_leaves_every_other_read_at_once_and_is_named_in_their_poll(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    plain, _, _ = await _extra_member(client, capsys, db_session_factory, cast, PLAIN)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Taken back"))
    kept = await _sent(await _gsend(client, plain, cast.group_id, "Staying"))
    reads = {who: await _answer(await _gread(client, h, cast.group_id)) for who, h in (("member", cast.member), ("plain", plain), ("admin", cast.admin))}
    assert (await _remove_message(client, cast.admin, message["id"])).status_code == 204
    for headers in (cast.member, plain):
        fresh = await _answer(await _gread(client, headers, cast.group_id))
        assert message["id"] not in _by_id(fresh) and kept["id"] in _by_id(fresh)
    for who, headers in (("member", cast.member), ("plain", plain)):
        polled = await _answer(await _gread(client, headers, cast.group_id, since=reads[who]["as_of"]))
        assert set(polled) == POLL_KEYS
        assert polled["removed"] == [message["id"]] and message["id"] not in _by_id(polled)
        assert polled["truncated"] is False
    for headers in (cast.admin, cast.co_admin):
        fresh = _by_id(await _answer(await _gread(client, headers, cast.group_id)))
        assert fresh[message["id"]]["removed"]["by"] == "admin" and fresh[message["id"]]["body"] == "Taken back"
    polled = await _answer(await _gread(client, cast.admin, cast.group_id, since=reads["admin"]["as_of"]))
    assert polled["removed"] == [] and _by_id(polled)[message["id"]]["removed"]["by_writer"] is False


async def test_a_held_message_says_whether_the_caller_is_the_one_who_removed_it(client, capsys, db_session_factory):
    """`removed.by_self` (CK-103): true for the caller whose person removed
    it, in the read and in the check alike, so the screen says *You* rather
    than the caller's own name. It is the remover's and nobody else's: the
    writer of a message someone else removed reads false."""
    cast = await _cast(client, capsys, db_session_factory)
    members = await _sent(await _gsend(client, cast.member, cast.group_id, "A member's, removed by the admin"))
    admins = await _sent(await _gsend(client, cast.admin, cast.group_id, "The admin's, removed by the co-admin"))
    own = await _sent(await _gsend(client, cast.co_admin, cast.group_id, "The co-admin's, deleted by them"))
    deleted = await _sent(await _gsend(client, cast.member, cast.group_id, "A member's, deleted by them"))
    before = {"admin": await _answer(await _gread(client, cast.admin, cast.group_id))}
    before["co_admin"] = await _answer(await _gread(client, cast.co_admin, cast.group_id))
    assert (await _remove_message(client, cast.admin, members["id"])).status_code == 204
    assert (await _remove_message(client, cast.co_admin, admins["id"])).status_code == 204
    assert (await _remove_message(client, cast.co_admin, own["id"])).status_code == 204
    assert (await _remove_message(client, cast.member, deleted["id"])).status_code == 204

    expected = {
        "admin": {members["id"]: True, admins["id"]: False, own["id"]: False, deleted["id"]: False},
        "co_admin": {members["id"]: False, admins["id"]: True, own["id"]: True, deleted["id"]: False},
    }
    for who, headers in (("admin", cast.admin), ("co_admin", cast.co_admin)):
        read = _by_id(await _answer(await _gread(client, headers, cast.group_id)))
        polled = _by_id(await _answer(await _gread(client, headers, cast.group_id, since=before[who]["as_of"])))
        for items in (read, polled):
            assert {mid: items[mid]["removed"]["by_self"] for mid in expected[who]} == expected[who], who
    # A live message carries no `removed`, so nothing to say it of.
    kept = await _sent(await _gsend(client, cast.member, cast.group_id, "Staying"))
    assert _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))[kept["id"]]["removed"] is None


async def test_a_held_message_in_a_gatherings_chat_is_for_its_host_and_co_hosts(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    message = await _sent(await _xsend(client, world.invitee, gid, "Not appropriate"))
    assert (await _remove_message(client, world.co_host, message["id"])).status_code == 204
    for headers in (cast.member, world.co_host):
        assert _by_id(await _answer(await _xread(client, headers, gid)))[message["id"]]["removed"]["by"] == "cohost"
    for headers in (world.invitee, cast.admin):
        assert message["id"] not in _by_id(await _answer(await _xread(client, headers, gid)))


async def test_a_held_message_is_outside_an_organisers_window_and_gone_for_one_who_left(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Early words"))
    later, later_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, LATER)
    assert (await _appoint(client, cast.admin, cast.group_id, later_membership)).status_code == 201
    assert (await _remove_message(client, cast.admin, message["id"])).status_code == 204
    answer = await _answer(await _gread(client, later, cast.group_id))
    assert answer["may_moderate"] is True and message["id"] not in _by_id(answer)
    refused = await _remove_message(client, later, message["id"])
    assert (refused.status_code, refused.content) == await _missing_message(client, later)
    assert (await _leave(client, cast.co_admin, cast.group_id)).status_code == 204
    read = await _gread(client, cast.co_admin, cast.group_id)
    assert (read.status_code, read.content) == await _group_404(client, cast.co_admin)


async def test_a_held_message_is_gone_for_everyone_at_exactly_removed_at_plus_the_bin(
    client, capsys, db_session_factory, monkeypatch
):
    cast = await _cast(client, capsys, db_session_factory)
    message = await _sent(await _gsend(client, cast.member, cast.group_id, "Thirty days"))
    assert (await _remove_message(client, cast.member, message["id"])).status_code == 204
    removed_at = (await _post(db_session_factory, message["id"]))[3]
    chat = _chat_api()
    monkeypatch.setattr(chat, "_now", lambda: removed_at + REMOVED_BIN - timedelta(microseconds=1))
    assert message["id"] in _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))
    assert message["id"] not in _by_id(await _answer(await _gread(client, cast.member, cast.group_id)))
    monkeypatch.setattr(chat, "_now", lambda: removed_at + REMOVED_BIN)
    for headers in (cast.admin, cast.co_admin, cast.member):
        assert message["id"] not in _by_id(await _answer(await _gread(client, headers, cast.group_id)))
    again = await _remove_message(client, cast.admin, message["id"])
    assert (again.status_code, again.content) == await _missing_message(client, cast.admin)


# --- reading, paging and the poll ------------------------------------------------------


async def _plant_many(db_session_factory, gathering_id: str, author_address: str, n: int, *, start: str) -> None:
    """`n` messages, one a second from `start` (SQL), numbered 1..n."""
    async with db_session_factory() as db:
        author = await db.scalar(text("SELECT id FROM people WHERE email = :e"), {"e": author_address})
        await db.execute(
            text(
                "INSERT INTO posts (gathering_id, author_person_id, kind, body, publication_state, created_at) "
                "SELECT :g, :a, 'message', 'Number ' || n, 'live', "
                f"{start} + n * interval '1 second' FROM generate_series(1, :n) AS n"
            ),
            {"g": UUID(gathering_id), "a": author, "n": n},
        )
        await db.commit()


async def test_the_first_read_is_the_newest_fifty_oldest_first_and_before_pages_back(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.admin, cast.group_id)
    container = await _container(db_session_factory, cast.group_id)
    await _plant_many(db_session_factory, container, ADMIN, 60, start="now() + interval '1 minute'")
    first = await _answer(await _gread(client, cast.admin, cast.group_id))
    assert _bodies(first) == [f"Number {n}" for n in range(11, 61)]
    assert first["older"] and first["may_moderate"] is True
    datetime.fromisoformat(first["as_of"])
    older = await _answer(await _gread(client, cast.admin, cast.group_id, before=first["older"]))
    assert _bodies(older) == [f"Number {n}" for n in range(1, 11)] and older["older"] is None
    small = await _answer(await _gread(client, cast.admin, cast.group_id, limit=7))
    assert _bodies(small) == [f"Number {n}" for n in range(54, 61)]
    page = await _answer(await _gread(client, cast.admin, cast.group_id, limit=100))
    assert len(page["items"]) == 60 and page["older"] is None


@contextmanager
def _no_index_walked():
    """The database picks the plan, and one that walks the reading index hands
    back rows sharing an instant in the index's own order, asked for or not.
    With none walked, their order is only what the statement asks for."""

    def off(conn):
        for kind in ("indexscan", "indexonlyscan", "bitmapscan"):
            conn.exec_driver_sql(f"SET LOCAL enable_{kind} = off")

    event.listen(engine.sync_engine, "begin", off)
    try:
        yield
    finally:
        event.remove(engine.sync_engine, "begin", off)


async def test_paging_across_messages_sent_at_one_instant_misses_none_and_repeats_none(
    client, capsys, db_session_factory
):
    """Five messages at ONE instant, read two at a time: the pages are the
    whole read, in its order — the id's, which the rows were written in. A
    cursor of the instant alone would step over every message that shares it."""
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.admin, cast.group_id)
    container = await _container(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO posts (id, gathering_id, author_person_id, kind, body, publication_state, created_at) "
                "SELECT ('00000000-0000-4000-8000-00000000000' || n)::uuid, :g, :a, 'message', 'Number ' || n, "
                "'live', now() + interval '1 minute' FROM generate_series(1, 5) AS n"
            ),
            {"g": UUID(container), "a": await _person_id(db_session_factory, ADMIN)},
        )
        await db.commit()
    with _no_index_walked():
        whole = await _answer(await _gread(client, cast.admin, cast.group_id, limit=100))
        assert len(whole["items"]) == 5 and whole["older"] is None
        assert len({item["created_at"] for item in whole["items"]}) == 1
        assert _bodies(whole) == [f"Number {n}" for n in range(1, 6)]
        pages, before = [], None
        for _ in range(4):
            params = {"limit": 2} if before is None else {"limit": 2, "before": before}
            page = await _answer(await _gread(client, cast.admin, cast.group_id, **params))
            pages.append(page["items"])
            before = page["older"]
            if before is None:
                break
    assert [len(page) for page in pages] == [2, 2, 1]
    # Each page is oldest first and the pages go back in time, so the whole
    # read is the pages from the last to the first.
    assert [item["id"] for page in reversed(pages) for item in page] == [item["id"] for item in whole["items"]]


def _forged(at_text: str) -> str:
    """A cursor in this chat's own shape, its instant chosen by hand."""
    raw = f"{at_text}|{MISSING}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


# Each is an instant with an offset that no read can be asked from: before
# `EARLIEST_INSTANT`, or one UTC cannot hold.
EXTREMES = (
    "0001-01-01T00:00:00+23:59",
    "9999-12-31T23:59:59-23:59",
    "0001-01-20T00:00:00+00:00",  # a lookback fits, the hold's window does not
    "0001-01-01T00:00:00+00:00",
    "1999-12-31T23:59:59.999999+00:00",
    "2000-01-01T00:00:00+00:01",  # a minute before the earliest, in UTC
)


async def test_a_since_no_read_can_be_asked_from_is_refused_at_its_field(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    for headers in (cast.admin, cast.member):  # runs the place, and does not
        for at in EXTREMES:
            for refused in (
                await _gread(client, headers, cast.group_id, since=at),
                await _xread(client, headers, gid, since=at),
            ):
                assert refused.status_code == 422, (at, refused.text)
                (entry,) = refused.json()["detail"]
                assert (entry["loc"], entry["type"]) == (["query", "since"], "value_error")
        for at in ("2000-01-01T00:00:00+00:00", "9999-12-31T23:59:59+00:00"):  # the edges are asked
            polled = await _answer(await _gread(client, headers, cast.group_id, since=at))
            assert set(polled) == POLL_KEYS


async def test_a_forged_cursor_no_read_can_be_asked_from_is_refused_at_its_field(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.member, cast.group_id)
    for headers in (cast.admin, cast.member):
        # The last carries no offset: an instant in no zone is none of this chat's.
        for at in (*EXTREMES, "2026-11-21T10:00:00"):
            refused = await _gread(client, headers, cast.group_id, before=_forged(at))
            assert refused.status_code == 422, (at, refused.text)
            (entry,) = refused.json()["detail"]
            assert (entry["loc"], entry["msg"]) == (["query", "before"], _chat_api().BAD_CURSOR)
        for at in ("2000-01-01T00:00:00+00:00", "9999-12-31T23:59:59+00:00"):
            read = await _answer(await _gread(client, headers, cast.group_id, before=_forged(at)))
            assert set(read) == READ_KEYS


async def test_a_bad_cursor_an_instant_with_no_offset_or_a_bad_limit_is_a_422(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    good = await _answer(await _gread(client, cast.member, cast.group_id))
    for params in (
        {"before": "not-a-cursor"},
        {"before": "bm90LWEtY3Vyc29y"},
        {"since": "2026-11-21T10:00:00"},
        {"since": "yesterday"},
        {"since": good["as_of"], "before": "bm90LWEtY3Vyc29y"},
        {"limit": 0},
        {"limit": 101},
    ):
        refused = await _gread(client, cast.member, cast.group_id, **params)
        assert refused.status_code == 422, (params, refused.text)


async def test_the_poll_answers_as_of_and_what_arrived_since(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    first = await _answer(await _gread(client, cast.member, cast.group_id))
    one = await _sent(await _gsend(client, cast.admin, cast.group_id, "One"))
    two = await _sent(await _gsend(client, cast.co_admin, cast.group_id, "Two"))
    polled = await _answer(await _gread(client, cast.member, cast.group_id, since=first["as_of"]))
    assert set(polled) == POLL_KEYS and polled["truncated"] is False and polled["removed"] == []
    assert [one["id"], two["id"]] == [i["id"] for i in polled["items"] if i["id"] in (one["id"], two["id"])]
    assert datetime.fromisoformat(polled["as_of"]) >= datetime.fromisoformat(first["as_of"])


async def test_the_lookback_catches_a_message_whose_transaction_began_before_the_last_read(
    client, capsys, db_session_factory, monkeypatch
):
    """Staged: a send's transaction takes its instant (the server's `now()`)
    and is still open when the reader reads, so the read cannot see it and
    answers an `as_of` a second LATER than the message's `created_at`. The
    send then commits. The poll from that `as_of` reaches back
    `CHAT_LOOKBACK` and finds it; a poll that took `since` literally would
    miss it forever."""
    cast = await _cast(client, capsys, db_session_factory)
    await _gread(client, cast.member, cast.group_id)
    container = await _container(db_session_factory, cast.group_id)
    chat = _chat_api()
    assert chat.CHAT_LOOKBACK == timedelta(seconds=10)
    author = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as slow:
        made, made_at = (
            await slow.execute(
                text(
                    "INSERT INTO posts (gathering_id, author_person_id, kind, body, publication_state) "
                    "VALUES (:g, :a, 'message', 'Slow to commit', 'live') RETURNING id, created_at"
                ),
                {"g": UUID(container), "a": author},
            )
        ).one()
        monkeypatch.setattr(chat, "_now", lambda: made_at + timedelta(seconds=1))
        read = await _answer(await _gread(client, cast.member, cast.group_id))
        assert str(made) not in _by_id(read)
        await slow.commit()
    polled = await _answer(await _gread(client, cast.member, cast.group_id, since=read["as_of"]))
    assert str(made) in _by_id(polled)


async def test_a_poll_past_two_hundred_new_items_is_truncated(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    first = await _answer(await _gread(client, cast.member, cast.group_id))
    container = await _container(db_session_factory, cast.group_id)
    await _plant_many(db_session_factory, container, ADMIN, 200, start="now()")
    exactly = await _answer(await _gread(client, cast.member, cast.group_id, since=first["as_of"]))
    assert exactly["truncated"] is False and len(exactly["items"]) == 200
    await _plant_many(db_session_factory, container, ADMIN, 1, start="now() + interval '1 hour'")
    over = await _answer(await _gread(client, cast.member, cast.group_id, since=first["as_of"]))
    assert over["truncated"] is True and over["items"] == [] and over["removed"] == []


# --- account deletion --------------------------------------------------------------


async def test_an_account_deletion_keeps_messages_held_messages_and_lines_under_a_former_member(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    said = await _sent(await _gsend(client, joiner, cast.group_id, "Hello, family"))
    held = await _sent(await _gsend(client, joiner, cast.group_id, "Taken back"))
    by_co_admin = await _sent(await _gsend(client, cast.member, cast.group_id, "Removed by the co-admin"))
    assert (await _remove_message(client, joiner, held["id"])).status_code == 204
    assert (await _remove_message(client, cast.co_admin, by_co_admin["id"])).status_code == 204
    await _on(client, world.co_host, gid)
    for headers in (joiner, cast.co_admin, world.co_host):
        assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204
    group_items = _by_id(await _answer(await _gread(client, cast.admin, cast.group_id)))
    (join_line,) = [i for i in group_items.values() if i["kind"] == "joined"]
    assert join_line["author"]["display_name"] == "a former member"
    assert group_items[said["id"]]["author"]["display_name"] == "a former member"
    assert group_items[held["id"]]["removed"]["by"] == "a former member"
    assert group_items[held["id"]]["removed"]["by_writer"] is True
    assert group_items[by_co_admin["id"]]["removed"]["by"] == "a former member"
    (setting_line,) = (await _answer(await _xread(client, cast.member, gid)))["items"]
    assert setting_line["author"]["display_name"] == "a former member"


# --- nothing logged, one statement ---------------------------------------------------


async def test_the_router_has_no_logger_and_no_record_carries_a_word_a_name_or_a_chats_id(
    client, capsys, db_session_factory, caplog
):
    chat = _chat_api()
    assert not hasattr(chat, "logger")
    assert "getLogger" not in open(chat.__file__, encoding="utf-8").read()
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        sent = await _sent(await _gsend(client, cast.member, cast.group_id, "Secret recipe zucchini"))
        await _sent(await _xsend(client, world.invitee, gid, "Bringing the marmalade"))
        first = await _answer(await _gread(client, cast.admin, cast.group_id))
        await _answer(await _gread(client, cast.admin, cast.group_id, since=first["as_of"]))
        await _answer(await _xread(client, cast.member, gid))
        assert (await _remove_message(client, cast.admin, sent["id"])).status_code == 204
        await _answer(await _gread(client, cast.member, cast.group_id, since=first["as_of"]))
    container = await _container(db_session_factory, cast.group_id)
    application = [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]
    assert application == []
    # httpx logs every request line at INFO (the path carries the group's id,
    # as every path does), and the engine's own statements are SQLAlchemy's —
    # neither is the router's; every other record is held to the ban.
    others = [r for r in caplog.records if not r.name.startswith(("httpx", "sqlalchemy"))]
    for record in others:
        message = record.getMessage()
        for banned in ("zucchini", "marmalade", "invitee", container, gid, sent["id"]):
            assert banned not in message, (record.name, message)


async def test_a_read_is_one_statement_after_the_doors_reads_however_many_items(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count(read) -> int:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            await _answer(await read())
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        reads_posts = [i for i, s in enumerate(statements) if re.search(r"\bposts\b", s)]
        assert reads_posts == [len(statements) - 1], statements
        return len(statements)

    reads = {
        "group": lambda: _gread(client, cast.admin, cast.group_id),
        "group poll": lambda: _gread(client, cast.admin, cast.group_id, since=(_now() - timedelta(minutes=1)).isoformat()),
        "gathering": lambda: _xread(client, cast.member, gid),
        "gathering poll": lambda: _xread(client, cast.member, gid, since=(_now() - timedelta(minutes=1)).isoformat()),
    }
    for read in reads.values():
        await read()  # warm the session's refresh and make the container
    await _sent(await _gsend(client, cast.member, cast.group_id, "One"))
    await _sent(await _xsend(client, world.invitee, gid, "One"))
    at_one = {name: await count(read) for name, read in reads.items()}
    container = await _container(db_session_factory, cast.group_id)
    await _plant_many(db_session_factory, container, MEMBER, 40, start="now()")
    await _plant_many(db_session_factory, gid, INVITEE, 40, start="now()")
    joiner = await _invite_into_group(client, capsys, cast.admin, cast.group_id, JOINER)
    assert joiner
    await _on(client, cast.member, gid)
    at_many = {name: await count(read) for name, read in reads.items()}
    assert at_many == at_one
