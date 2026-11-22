"""The group's chat container (CK-102; decisions/2026-11-21-the-chat-who-reads-
it-and-what-it-keeps.md P1-P5; decisions/2026-09-02-group-chat-and-media.md
§4).

ONE `group_media` gathering per group, made by ONE get-or-create helper
(`services/group_chat.py::container_for`) and never by a migration: it looks
without a lock, and only when there is none takes the group's row lock, looks
again and makes one. `POST /groups` makes it in its own transaction, so every
new group is born with its chat; an older group's is made on its first chat
read, its first send, or the first time someone joins it.

The container holds `owning_group_id` and a fixed title that no body ever
shows — and NOTHING else: no host, no keeper of its own, no date, no
invitation row, no place row, no co-host, no cover, no outside setting,
`requires_approval` NULL. Every existing way into a gathering opens on a host,
an invitation row, a place row or a date, so the container is invisible to all
of them with no change to any of them; this file proves the 404 or the absence
on each, for the group's admin, a member, its keeper and a stranger.

Reached by the chat's routes alone (tests/test_chat.py).
"""

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import text

from app.services import keeping
from tests.test_gatherings import _account_for, _signed_in_headers
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _approve, _join, _make, _requests, _token_of
from tests.test_group_membership import ADMIN, MEMBER, STRANGER, _cast, _membership_id
from tests.test_groups import MISSING
from tests.test_groups import _create as _create_group
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_race_backstops import _select_from, _stage

KEEPER = "chatkeeper@example.com"  # keeps the group by keeping, in nothing
JOINER = "joiner@example.com"
CONTAINER_TITLE = "Group chat"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- helpers -----------------------------------------------------------------------


async def _containers(db_session_factory, group_id: str) -> list[UUID]:
    """Every `group_media` gathering of the group. The label is compared as
    text, so this reads [] — never an error — on a schema without it."""
    async with db_session_factory() as db:
        return list(
            (
                await db.execute(
                    text(
                        "SELECT id FROM gatherings WHERE owning_group_id = :g "
                        "AND gathering_type::text = 'group_media' ORDER BY created_at"
                    ),
                    {"g": UUID(group_id)},
                )
            ).scalars()
        )


async def _container(db_session_factory, group_id: str) -> str:
    (found,) = await _containers(db_session_factory, group_id)
    return str(found)


async def _make_older(db_session_factory, group_id: str) -> None:
    """Stand the group in for one made before CK-102: no container. (Its
    posts go first — they hang on the container.)"""
    async with db_session_factory() as db:
        params = {"g": UUID(group_id)}
        await db.execute(
            text(
                "DELETE FROM posts WHERE gathering_id IN (SELECT id FROM gatherings "
                "WHERE owning_group_id = :g AND gathering_type::text = 'group_media')"
            ),
            params,
        )
        await db.execute(
            text("DELETE FROM gatherings WHERE owning_group_id = :g AND gathering_type::text = 'group_media'"),
            params,
        )
        await db.commit()
    assert await _containers(db_session_factory, group_id) == []


async def _read_chat(client, headers, group_id: str, **params):
    return await client.get(f"/groups/{group_id}/chat", params=params, headers=headers)


async def _send(client, headers, group_id: str, body: str = "Hello, all"):
    return await client.post(f"/groups/{group_id}/chat", json={"body": body}, headers=headers)


async def _gatherings_count(db_session_factory) -> int:
    async with db_session_factory() as db:
        return await db.scalar(text("SELECT count(*) FROM gatherings"))


async def _approve_joiner(client, capsys, admin: dict, group_id: str, joiner: dict) -> None:
    """The first way in: a join request through the group's link, approved."""
    token = _token_of((await _make(client, admin, group_id)).json())
    assert (await _join(client, joiner, token)).status_code in (200, 201)
    (entry,) = (await _requests(client, admin, group_id)).json()["join_requests"]
    approved = await _approve(client, admin, group_id, entry["id"])
    assert approved.status_code == 200, approved.text


async def _invite_and_accept(client, capsys, admin: dict, group_id: str, address: str, joiner: dict) -> None:
    """The second way in: an emailed invitation, accepted."""
    token = await _group_invite_token(client, capsys, admin, group_id, address)
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"


# --- born with its chat ---------------------------------------------------------------


async def test_a_new_group_is_born_with_its_container_in_the_creating_transaction(
    client, capsys, db_session_factory
):
    """`POST /groups` makes exactly one container, in its own transaction:
    the container's `created_at`, the group's and the creator's membership's
    are one `now()`. It holds the group and a fixed title, and nothing else."""
    admin = await _signed_in_headers(client, capsys, ADMIN)
    group = await _create_group(client, admin, name="Finch family")
    container = await _container(db_session_factory, group["id"])
    async with db_session_factory() as db:
        row = (
            await db.execute(
                text(
                    "SELECT g.owning_group_id, g.title, g.host_account_id, g.keeper_account_id, "
                    "g.requires_approval, g.publication_state::text, g.invitees_chosen, "
                    "g.cover_media_id, g.cover_image_id, g.outside_invitations_since, "
                    "g.memorial_decedent_name, g.photo_count, g.created_at, gr.created_at, m.created_at "
                    "FROM gatherings g JOIN groups gr ON gr.id = g.owning_group_id "
                    "JOIN memberships m ON m.group_id = gr.id WHERE g.id = :c"
                ),
                {"c": UUID(container)},
            )
        ).one()
        empties = {
            table: await db.scalar(text(f"SELECT count(*) FROM {table} WHERE gathering_id = :c"), {"c": UUID(container)})
            for table in (
                "occurrences",
                "gathering_invitations",
                "gathering_invitations_pending",
                "gathering_member_places",
                "gathering_co_hosts",
                "media",
                "posts",
            )
        }
    (owning, title, host, keeper, approval, state, chosen, cover_media, cover_image, outside, decedent, photos,
     made_at, group_made_at, member_since) = row
    assert owning == UUID(group["id"])
    assert title == CONTAINER_TITLE
    assert (host, keeper, approval, cover_media, cover_image, outside, decedent) == (None,) * 7
    assert (state, chosen, photos) == ("live", False, 0)
    assert made_at == group_made_at == member_since  # one transaction
    assert empties == dict.fromkeys(empties, 0)  # no line at creation either (Q3b)
    assert container not in (await client.get(f"/groups/{group['id']}", headers=admin)).text


async def test_an_older_groups_container_is_made_on_its_first_read_and_only_once(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    await _make_older(db_session_factory, cast.group_id)
    read = await _read_chat(client, cast.member, cast.group_id)
    assert read.status_code == 200, read.text
    first = await _containers(db_session_factory, cast.group_id)
    assert len(first) == 1
    assert (await _read_chat(client, cast.admin, cast.group_id)).status_code == 200
    assert (await _send(client, cast.co_admin, cast.group_id)).status_code == 201
    assert await _containers(db_session_factory, cast.group_id) == first


async def test_an_older_groups_container_is_made_on_its_first_send(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _make_older(db_session_factory, cast.group_id)
    sent = await _send(client, cast.member, cast.group_id, "First words")
    assert sent.status_code == 201, sent.text
    container = await _container(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        assert (
            await db.scalar(text("SELECT count(*) FROM posts WHERE gathering_id = :c"), {"c": UUID(container)})
        ) == 1


async def test_an_older_groups_container_is_made_on_its_first_join_either_way_in(
    client, capsys, db_session_factory
):
    """An approved join request and an accepted emailed invitation each make
    the container in the membership's own transaction, the join line in it."""
    cast = await _cast(client, capsys, db_session_factory)
    joiner = await _signed_in_headers(client, capsys, JOINER)
    await _make_older(db_session_factory, cast.group_id)
    await _approve_joiner(client, capsys, cast.admin, cast.group_id, joiner)
    container = await _container(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        made_at, line_at, member_since = (
            await db.execute(
                text(
                    "SELECT g.created_at, p.created_at, m.created_at FROM gatherings g "
                    "JOIN posts p ON p.gathering_id = g.id "
                    "JOIN memberships m ON m.group_id = g.owning_group_id AND m.person_id = p.author_person_id "
                    "WHERE g.id = :c"
                ),
                {"c": UUID(container)},
            )
        ).one()
    assert made_at == line_at == member_since

    second = await _signed_in_headers(client, capsys, "second@example.com")
    await _make_older(db_session_factory, cast.group_id)
    await _invite_and_accept(client, capsys, cast.admin, cast.group_id, "second@example.com", second)
    assert len(await _containers(db_session_factory, cast.group_id)) == 1


async def test_two_first_sends_at_once_make_exactly_one_container(client, capsys, db_session_factory, monkeypatch):
    """THE RACE, staged (CK-77.1's `_stage`, CK-77.2's watcher): the route's
    unlocked look finds nothing; a competitor in a second session then takes
    the group's row lock and makes a container, and HOLDS it uncommitted. The
    route must wait on that lock, find the competitor's container when it
    commits, and use it: one container, both writes in it. Without the
    helper's lock the route would look again, see nothing (uncommitted),
    and make a second."""
    cast = await _cast(client, capsys, db_session_factory)
    await _make_older(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        account_id = (await _account_for(db, ADMIN)).id
    holder: dict = {}

    async def competitor() -> None:
        session = db_session_factory()
        holder["session"] = session
        await session.execute(text("SELECT id FROM groups WHERE id = :g FOR UPDATE"), {"g": UUID(cast.group_id)})
        await session.execute(
            text(
                "INSERT INTO gatherings (created_by_account_id, gathering_type, title, publication_state, owning_group_id) "
                "VALUES (:a, 'group_media', 'Group chat', 'live', :g)"
            ),
            {"a": account_id, "g": UUID(cast.group_id)},
        )

    state = _stage(monkeypatch, when=_select_from("gatherings", containing="owning_group_id"), competitor=competitor)
    route = asyncio.create_task(_send(client, cast.member, cast.group_id, "Racing"))
    try:
        seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
    finally:
        if "session" in holder:
            await holder["session"].commit()
            await holder["session"].close()
    response = await route
    assert state["fired"], "the race was not staged — the unlocked look never ran"
    assert seen == "waiting", f"the route never waited on the group's lock ({seen})"
    assert response.status_code == 201, response.text
    (container,) = await _containers(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        assert (
            await db.scalar(text("SELECT count(*) FROM posts WHERE gathering_id = :c"), {"c": container})
        ) == 1


# --- nobody makes one by hand -------------------------------------------------------------


async def test_post_gatherings_refuses_group_media_before_anything_is_written(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    before = await _gatherings_count(db_session_factory)
    for body in (
        {"gathering_type": "group_media", "title": "Ours", "occurrences": [{"starts_at": (_now() + timedelta(days=3)).isoformat()}]},
        {
            "gathering_type": "group_media",
            "title": "Ours",
            "occurrences": [{"starts_at": (_now() + timedelta(days=3)).isoformat()}],
            "group_id": cast.group_id,
        },
    ):
        refused = await client.post("/gatherings", json=body, headers=cast.member)
        assert refused.status_code == 422, refused.text
        assert [error["loc"] for error in refused.json()["detail"]] == [["body", "gathering_type"]]
    assert await _gatherings_count(db_session_factory) == before


# --- invisible to every other way in ----------------------------------------------------


def _routes(gathering_id: str, membership_id: str) -> list[tuple[str, str, dict | None]]:
    """Every route that takes a gathering id, with a body that passes its
    model, so a 404 is the loader's and never a 422."""
    starts = (_now() + timedelta(days=9)).isoformat()
    return [
        ("GET", f"/gatherings/{gathering_id}", None),
        ("GET", f"/gatherings/{gathering_id}/chat", None),
        ("POST", f"/gatherings/{gathering_id}/chat", {"body": "Sideways"}),
        ("PATCH", f"/gatherings/{gathering_id}", {"title": "Renamed"}),
        ("POST", f"/gatherings/{gathering_id}/occurrences", {"starts_at": starts}),
        ("GET", f"/gatherings/{gathering_id}/places", None),
        ("PUT", f"/gatherings/{gathering_id}/places/{membership_id}", {"place": "invited"}),
        ("GET", f"/gatherings/{gathering_id}/outside-invitations", None),
        ("PUT", f"/gatherings/{gathering_id}/outside-invitations", {"on": True}),
        ("POST", f"/gatherings/{gathering_id}/outside-alert/dismiss", None),
        ("GET", f"/gatherings/{gathering_id}/invitations", None),
        ("POST", f"/gatherings/{gathering_id}/invitations", {"channel": "EMAIL", "destination": "someone@example.com"}),
        ("GET", f"/gatherings/{gathering_id}/co-hosts", None),
        ("POST", f"/gatherings/{gathering_id}/co-hosts", {"invitation_id": MISSING}),
        ("DELETE", f"/gatherings/{gathering_id}/co-hosts/{MISSING}", None),
        ("PUT", f"/gatherings/{gathering_id}/cover", {"media_id": MISSING}),
        ("DELETE", f"/gatherings/{gathering_id}/cover", None),
        ("POST", f"/gatherings/{gathering_id}/cover/upload", {"content_type": "image/jpeg", "size_bytes": 1000}),
        ("GET", f"/gatherings/{gathering_id}/cover/url?layer=web", None),
        ("GET", f"/gatherings/{gathering_id}/media", None),
        ("GET", f"/gatherings/{gathering_id}/media?awaiting_review=true", None),
        ("GET", f"/gatherings/{gathering_id}/media?removed=true", None),
        ("POST", f"/gatherings/{gathering_id}/media/intents", {"items": [{"content_type": "image/jpeg", "size_bytes": 1000}]}),
        ("POST", f"/gatherings/{gathering_id}/media/publish", {"media_ids": [MISSING]}),
    ]


async def _call(client, headers, method: str, path: str, body):
    return await client.request(method, path, json=body, headers=headers)


async def _keeper(client, capsys, db_session_factory, group_id: str) -> dict:
    headers = await _signed_in_headers(client, capsys, KEEPER)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE groups SET keeper_account_id = :k WHERE id = :g"),
            {"k": (await _account_for(db, KEEPER)).id, "g": UUID(group_id)},
        )
        await db.commit()
    return headers


async def test_every_route_into_a_gathering_answers_the_container_with_the_missing_ids_404(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    keeper = await _keeper(client, capsys, db_session_factory, cast.group_id)
    container = await _container(db_session_factory, cast.group_id)
    for headers in (cast.admin, cast.member, keeper, cast.stranger):
        for (method, path, body), (_, missing_path, _) in zip(
            _routes(container, cast.member_membership), _routes(MISSING, cast.member_membership)
        ):
            refused = await _call(client, headers, method, path, body)
            missing = await _call(client, headers, method, missing_path, body)
            assert refused.status_code == 404, (method, path, refused.text)
            assert (refused.status_code, refused.content) == (missing.status_code, missing.content), (method, path)
    # Nothing was written to it by any refusal.
    async with db_session_factory() as db:
        row = (
            await db.execute(
                text(
                    "SELECT title, host_account_id, outside_invitations_since, cover_media_id, cover_image_id "
                    "FROM gatherings WHERE id = :c"
                ),
                {"c": UUID(container)},
            )
        ).one()
        assert tuple(row) == (CONTAINER_TITLE, None, None, None, None)
        for table in ("occurrences", "gathering_invitations_pending", "gathering_co_hosts", "media"):
            assert (
                await db.scalar(text(f"SELECT count(*) FROM {table} WHERE gathering_id = :c"), {"c": UUID(container)})
            ) == 0, table


async def test_no_list_calendar_or_group_photo_read_ever_names_the_container(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    keeper = await _keeper(client, capsys, db_session_factory, cast.group_id)
    await _create_in_group(client, cast.member, cast.group_id, title="Sunday dinner")
    container = await _container(db_session_factory, cast.group_id)
    window = {"from": (_now() - timedelta(days=1)).isoformat(), "to": (_now() + timedelta(days=60)).isoformat()}
    for headers in (cast.admin, cast.member, keeper, cast.stranger):
        reads = [
            await client.get("/gatherings", headers=headers),
            await client.get(f"/groups/{cast.group_id}/gatherings", headers=headers),
            await client.get("/calendar", params=window, headers=headers),
            await client.get(f"/groups/{cast.group_id}/calendar", params=window, headers=headers),
            await client.get(f"/groups/{cast.group_id}/media", headers=headers),
            await client.get("/groups", headers=headers),
            await client.get(f"/groups/{cast.group_id}", headers=headers),
        ]
        for read in reads:
            assert read.status_code in (200, 404), read.text
            assert container not in read.text
            assert CONTAINER_TITLE not in read.text
    listed = (await client.get(f"/groups/{cast.group_id}/gatherings", headers=cast.member)).json()
    assert [item["title"] for item in listed["gatherings"]] == ["Sunday dinner"]


async def test_the_newcomer_helper_never_places_anyone_on_the_container(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _create_in_group(client, cast.member, cast.group_id, title="Sunday dinner")
    container = await _container(db_session_factory, cast.group_id)
    joiner = await _signed_in_headers(client, capsys, JOINER)
    await _invite_and_accept(client, capsys, cast.admin, cast.group_id, JOINER, joiner)
    second = await _signed_in_headers(client, capsys, "second@example.com")
    await _approve_joiner(client, capsys, cast.admin, cast.group_id, second)
    async with db_session_factory() as db:
        for table in ("gathering_invitations", "gathering_member_places"):
            assert (
                await db.scalar(text(f"SELECT count(*) FROM {table} WHERE gathering_id = :c"), {"c": UUID(container)})
            ) == 0, table
        # ...while the group's real gathering did invite both newcomers.
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM gathering_invitations i JOIN gatherings g ON g.id = i.gathering_id "
                    "WHERE g.owning_group_id = :g AND g.title = 'Sunday dinner'"
                ),
                {"g": UUID(cast.group_id)},
            )
        ) >= 3


async def test_account_usage_is_unchanged_by_the_container(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _make_older(db_session_factory, cast.group_id)
    async with db_session_factory() as db:
        before = await keeping.account_usage(db, await _account_for(db, ADMIN))
    assert (await _send(client, cast.member, cast.group_id, "Counted nowhere")).status_code == 201
    assert len(await _containers(db_session_factory, cast.group_id)) == 1
    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await _account_for(db, ADMIN)) == before == 0


async def test_the_creators_membership_is_their_window_and_a_read_shows_no_line_at_creation(
    client, capsys, db_session_factory
):
    admin = await _signed_in_headers(client, capsys, ADMIN)
    group = await _create_group(client, admin, name="Finch family")
    read = await _read_chat(client, admin, group["id"])
    assert read.status_code == 200, read.text
    assert read.json()["items"] == []
    assert await _membership_id(db_session_factory, group["id"], ADMIN)
    assert MEMBER and STRANGER  # the cast's seats, named for the reader
