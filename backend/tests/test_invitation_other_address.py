"""CK-101 — an invitation asks before another account accepts it.

FINDING 1 of CK-100's switch checks (2026-11-20): a phone still signed in
to one account opened an invitation sent to another address, and the
landing accepted it on opening as the account that happened to be signed
in — the invitation spent, with no sign anything had happened. Steven chose
"Ask when they differ". So both acceptances — a group's
(`POST /group-invitations/accept`) and a gathering's
(`POST /invitations/accept`, standalone and a group's gathering with its
outside invitations on) — compare the invitation's stored destination with
the caller's own address, normalized as `normalize_email` reads it, on the
`valid` path and before any write:

- sent to the caller, or `confirm_other_address` true: accepted as today;
- not sent to the caller, no confirmation, the caller already in (a member
  of the group; holding an invitation row on the gathering):
  `already_accepted` with the id, as today, and NOTHING WRITTEN — the token
  stays unused for the person it was sent to (Q3);
- not sent to the caller, no confirmation, not in: 200
  `{"status": "other_address", <id>: null, <name>: …}` and NOTHING WRITTEN —
  no token consumed, no row, no lock.

Every dead status answers first, exactly as today; no answer ever carries
the destination; `confirm_other_address` is a StrictBool on the two accept
bodies alone, so the previews and the group's link stay strict.

Each rule is run on the three paths: a group, a standalone gathering, and a
group's gathering with its outside invitations on.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional
from uuid import UUID

import pytest
from sqlalchemy import select, text

from app.models import (
    Gathering,
    GatheringInvitation,
    GatheringInvitationPending,
    GatheringMemberPlace,
    GroupInvitationPending,
    Membership,
)
from app.security import hash_token
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _make, _token_of
from tests.test_group_membership import ADMIN, CO_ADMIN, MEMBER, STRANGER, _cast, _person_id
from tests.test_invitations import _invite_token as _gathering_invite_token
from tests.test_outside_invitations import _on

KINDS = ("group", "gathering", "group_gathering")

INVITED = "invited@example.com"  # the address every invitation here is sent to
OTHER = "someone-else@example.com"  # an account the invitation was not sent to


@dataclass
class World:
    """One of the three acceptance paths, with what a test needs to drive
    it and to read back what it wrote."""

    kind: str
    target_id: str
    name: str  # the group's name or the gathering's title — what the preview shows
    inviter: dict
    seats: dict  # address -> headers, every seat signed in
    already_in: str  # a seat already in (Q3): a member, or holding an invitation row
    placed: Optional[str] = None  # a seat holding a place row (the group's gathering)
    invite: Callable[[str], Awaitable[str]] = field(default=None)  # type: ignore[assignment]

    @property
    def accept_path(self) -> str:
        return "/group-invitations/accept" if self.kind == "group" else "/invitations/accept"

    @property
    def id_key(self) -> str:
        return "group_id" if self.kind == "group" else "gathering_id"

    @property
    def name_key(self) -> str:
        return "group_name" if self.kind == "group" else "gathering_title"

    @property
    def pending_model(self):
        return GroupInvitationPending if self.kind == "group" else GatheringInvitationPending


async def _world(kind: str, client, capsys, db_session_factory) -> World:
    if kind == "group":
        cast = await _cast(client, capsys, db_session_factory)
        seats = {
            ADMIN: cast.admin,
            CO_ADMIN: cast.co_admin,
            MEMBER: cast.member,
            STRANGER: cast.stranger,
            OTHER: await _signed_in_headers(client, capsys, OTHER),
        }

        async def invite(address: str) -> str:
            return await _group_invite_token(client, capsys, cast.admin, cast.group_id, address)

        return World(kind, cast.group_id, "Finch family", cast.admin, seats, already_in=MEMBER, invite=invite)

    if kind == "gathering":
        host = await _signed_in_headers(client, capsys, "host@example.com")
        guest = await _signed_in_headers(client, capsys, "guest@example.com")
        other = await _signed_in_headers(client, capsys, OTHER)
        created = await _create(client, host, title="Sunday potluck")
        gid = created["id"]

        async def invite(address: str) -> str:
            return await _gathering_invite_token(client, capsys, host, gid, address)

        # The guest already holds an invitation row: invited and accepted
        # through their own address, the case that accepts on opening.
        token = await invite("guest@example.com")
        response = await client.post("/invitations/accept", json={"token": token}, headers=guest)
        assert response.json() == {"status": "accepted", "gathering_id": gid}
        seats = {"host@example.com": host, "guest@example.com": guest, OTHER: other}
        return World(kind, gid, "Sunday potluck", host, seats, already_in="guest@example.com", invite=invite)

    # A group's gathering, its outside invitations on: the member hosts it,
    # the admin is invited (a row), the co-admin is only shared with (a
    # place row), and OTHER is an outsider.
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(
        client, cast.member, cast.group_id, title="Thanksgiving", invited=[cast.admin_membership]
    )
    gid = created["id"]
    await _on(client, cast.admin, gid)
    seats = {
        ADMIN: cast.admin,
        CO_ADMIN: cast.co_admin,
        MEMBER: cast.member,
        OTHER: await _signed_in_headers(client, capsys, OTHER),
    }

    async def invite(address: str) -> str:
        return await _gathering_invite_token(client, capsys, cast.member, gid, address)

    return World(
        kind, gid, "Thanksgiving", cast.member, seats, already_in=ADMIN, placed=CO_ADMIN, invite=invite
    )


async def _accept(client, world: World, headers: dict, token: str, **extra):
    return await client.post(world.accept_path, json={"token": token, **extra}, headers=headers)


async def _consumed(db_session_factory, world: World, token: str) -> bool:
    async with db_session_factory() as db:
        row = (
            await db.execute(
                select(world.pending_model).where(world.pending_model.token_hash == hash_token(token))
            )
        ).scalar_one()
        return row.consumed_at is not None


async def _snapshot(db_session_factory, world: World) -> dict:
    """Everything an acceptance can write, on the world's target: every
    pending row's stamps, the membership rows or the invitation rows, and
    the place rows."""
    async with db_session_factory() as db:
        pending = (
            await db.execute(
                select(
                    world.pending_model.id,
                    world.pending_model.consumed_at,
                    world.pending_model.revoked_at,
                    world.pending_model.expires_at,
                )
            )
        ).all()
        if world.kind == "group":
            rows = (
                await db.execute(
                    select(Membership.person_id).where(Membership.group_id == UUID(world.target_id))
                )
            ).all()
            places = []
        else:
            rows = (
                await db.execute(
                    select(GatheringInvitation.person_id, GatheringInvitation.from_outside).where(
                        GatheringInvitation.gathering_id == UUID(world.target_id)
                    )
                )
            ).all()
            places = (
                await db.execute(
                    select(
                        GatheringMemberPlace.person_id,
                        GatheringMemberPlace.place,
                        GatheringMemberPlace.updated_at,
                    ).where(GatheringMemberPlace.gathering_id == UUID(world.target_id))
                )
            ).all()
        join_requests = (await db.execute(text("SELECT id, decided_at FROM group_join_requests"))).all()
    return {
        "pending": sorted(map(tuple, pending)),
        "rows": sorted(map(tuple, rows)),
        "places": sorted(map(tuple, places)),
        "join_requests": sorted(map(tuple, join_requests)),
    }


async def _in(db_session_factory, world: World, address: str) -> bool:
    person = await _person_id(db_session_factory, address)
    async with db_session_factory() as db:
        if world.kind == "group":
            found = await db.scalar(
                select(Membership.id).where(
                    Membership.group_id == UUID(world.target_id), Membership.person_id == person
                )
            )
        else:
            found = await db.scalar(
                select(GatheringInvitation.id).where(
                    GatheringInvitation.gathering_id == UUID(world.target_id),
                    GatheringInvitation.person_id == person,
                )
            )
    return found is not None


def _other_address_body(world: World) -> dict:
    return {"status": "other_address", world.id_key: None, world.name_key: world.name}


# --- sent to the caller: accepted on opening, as today ------------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_sent_to_the_caller_accepts_on_opening_as_today(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    invited = await _signed_in_headers(client, capsys, INVITED)
    response = await _accept(client, world, invited, token)
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "accepted", world.id_key: world.target_id}
    assert await _consumed(db_session_factory, world, token)
    assert await _in(db_session_factory, world, INVITED)


@pytest.mark.parametrize("kind", KINDS)
async def test_a_mixed_case_or_padded_caller_address_is_sent_to_the_caller(
    kind, client, capsys, db_session_factory
):
    """The comparison reads the caller's address as `normalize_email` reads
    it — trimmed and lowercased — so a stored address in another case still
    matches the normalized destination and accepts on opening. (Every writer
    of `people.email` stores the normalized form; this plants one that is
    not, so the normalization itself is what is pinned.)"""
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    invited = await _signed_in_headers(client, capsys, INVITED)
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE people SET email = :shown WHERE email = :stored"),
            {"shown": "  Invited@Example.COM ", "stored": INVITED},
        )
        await db.commit()
    response = await _accept(client, world, invited, token)
    assert response.json() == {"status": "accepted", world.id_key: world.target_id}
    assert await _consumed(db_session_factory, world, token)


# --- sent to another address, no confirmation: other_address, nothing written --------


@pytest.mark.parametrize("kind", KINDS)
async def test_sent_to_another_address_asks_and_writes_nothing(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    before = await _snapshot(db_session_factory, world)

    response = await _accept(client, world, world.seats[OTHER], token)
    assert response.status_code == 200, response.text
    assert response.json() == _other_address_body(world)

    assert await _snapshot(db_session_factory, world) == before
    assert not await _consumed(db_session_factory, world, token)
    assert not await _in(db_session_factory, world, OTHER)
    # Asking again asks again, and still writes nothing; the person it was
    # sent to can still accept it, on opening.
    assert (await _accept(client, world, world.seats[OTHER], token)).json() == _other_address_body(world)
    assert await _snapshot(db_session_factory, world) == before
    invited = await _signed_in_headers(client, capsys, INVITED)
    assert (await _accept(client, world, invited, token)).json() == {
        "status": "accepted",
        world.id_key: world.target_id,
    }


@pytest.mark.parametrize("kind", ("gathering", "group_gathering"))
async def test_the_inviter_opening_their_own_invitation_is_asked(kind, client, capsys, db_session_factory):
    """The third case the step catches: a host who opens the invitation
    they just sent, to see what it looks like. The host holds no invitation
    row, so they are asked, and the guest's link is not spent."""
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    response = await _accept(client, world, world.inviter, token)
    assert response.json() == _other_address_body(world)
    assert not await _consumed(db_session_factory, world, token)


async def test_a_member_only_shared_with_is_asked_and_keeps_their_place(client, capsys, db_session_factory):
    """On a group's gathering a member holding a place row is not "already
    in" — they hold no invitation row — so they are asked, and their place
    row is not moved: no row deleted, none written."""
    world = await _world("group_gathering", client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    placed = await _person_id(db_session_factory, world.placed)
    async with db_session_factory() as db:
        place = await db.scalar(
            select(GatheringMemberPlace.place).where(
                GatheringMemberPlace.gathering_id == UUID(world.target_id),
                GatheringMemberPlace.person_id == placed,
            )
        )
    assert place is not None and place.value == "shared_with"
    before = await _snapshot(db_session_factory, world)

    response = await _accept(client, world, world.seats[world.placed], token)
    assert response.json() == _other_address_body(world)
    assert await _snapshot(db_session_factory, world) == before
    assert not await _in(db_session_factory, world, world.placed)


# --- the same, confirmed: accepted as today -------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_confirmed_another_account_accepts_as_today(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    response = await _accept(client, world, world.seats[OTHER], token, confirm_other_address=True)
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "accepted", world.id_key: world.target_id}
    assert await _consumed(db_session_factory, world, token)
    assert await _in(db_session_factory, world, OTHER)
    # A re-click is idempotent, as today, confirmed or not.
    for extra in ({"confirm_other_address": True}, {}):
        assert (await _accept(client, world, world.seats[OTHER], token, **extra)).json() == {
            "status": "already_accepted",
            world.id_key: world.target_id,
        }


async def test_confirmed_on_a_groups_gathering_runs_the_acceptance_unchanged(client, capsys, db_session_factory):
    """A confirmed acceptance goes through `_accept_into_group_gathering`
    unchanged: an outsider ends invited from outside, a member only shared
    with ends invited with the place row gone and `from_outside` false."""
    world = await _world("group_gathering", client, capsys, db_session_factory)
    outsider_token = await world.invite(INVITED)
    member_token = await world.invite("second@example.com")
    assert (
        await _accept(client, world, world.seats[OTHER], outsider_token, confirm_other_address=True)
    ).json()["status"] == "accepted"
    assert (
        await _accept(client, world, world.seats[world.placed], member_token, confirm_other_address=True)
    ).json()["status"] == "accepted"
    other = await _person_id(db_session_factory, OTHER)
    placed = await _person_id(db_session_factory, world.placed)
    snapshot = await _snapshot(db_session_factory, world)
    rows = dict(snapshot["rows"])
    assert rows[other] is True
    assert rows[placed] is False
    assert placed not in {person for person, *_ in snapshot["places"]}


@pytest.mark.parametrize("kind", KINDS)
async def test_confirm_false_is_no_confirmation(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    response = await _accept(client, world, world.seats[OTHER], token, confirm_other_address=False)
    assert response.json() == _other_address_body(world)
    assert not await _consumed(db_session_factory, world, token)


# --- Q3: the caller already in --------------------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_already_in_lands_with_already_accepted_and_spends_nothing(kind, client, capsys, db_session_factory):
    """Someone already in — a member of the group, a person holding an
    invitation row on the gathering — opens an invitation sent to another
    address: `already_accepted` with the id, as today, but the token is left
    unused, so the person it was sent to can still accept it (Q3)."""
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    before = await _snapshot(db_session_factory, world)
    response = await _accept(client, world, world.seats[world.already_in], token)
    assert response.json() == {"status": "already_accepted", world.id_key: world.target_id}
    assert await _snapshot(db_session_factory, world) == before
    assert not await _consumed(db_session_factory, world, token)
    invited = await _signed_in_headers(client, capsys, INVITED)
    assert (await _accept(client, world, invited, token)).json()["status"] == "accepted"


# --- every dead status first, exactly as today ---------------------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_every_dead_status_answers_before_the_check(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    other = world.seats[OTHER]
    model = world.pending_model

    expired = await world.invite("late@example.com")
    revoked = await world.invite("withdrawn@example.com")
    used = await world.invite(INVITED)
    async with db_session_factory() as db:
        now = datetime.now(timezone.utc)
        for token, values in (
            (expired, {"expires_at": now - timedelta(minutes=1)}),
            (revoked, {"revoked_at": now, "expires_at": now}),
        ):
            row = (await db.execute(select(model).where(model.token_hash == hash_token(token)))).scalar_one()
            for name, value in values.items():
                setattr(row, name, value)
        await db.commit()
    invited = await _signed_in_headers(client, capsys, INVITED)
    assert (await _accept(client, world, invited, used)).json()["status"] == "accepted"

    for token, status in ((expired, "expired"), (revoked, "revoked"), (used, "used"), ("not-a-token", "invalid")):
        for extra in ({}, {"confirm_other_address": True}):
            response = await _accept(client, world, other, token, **extra)
            assert response.json() == {"status": status, world.id_key: None}, (token, extra)


# --- the field: a StrictBool on the two accept bodies alone -------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_confirm_other_address_is_a_strict_bool(kind, client, capsys, db_session_factory):
    world = await _world(kind, client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    for value in ("true", 1, "yes", None):
        response = await _accept(client, world, world.seats[OTHER], token, confirm_other_address=value)
        assert response.status_code == 422, (value, response.text)
    assert not await _consumed(db_session_factory, world, token)
    assert not await _in(db_session_factory, world, OTHER)


async def test_the_previews_and_the_groups_link_still_refuse_the_field(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    group_token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, INVITED)
    gathering = await _create(client, cast.admin)
    gathering_token = await _gathering_invite_token(client, capsys, cast.admin, gathering["id"], INVITED)
    link_token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    for path, token, headers in (
        ("/invitations/preview", gathering_token, None),
        ("/group-invitations/preview", group_token, None),
        ("/group-links/preview", link_token, None),
        ("/group-links/join", link_token, cast.stranger),
    ):
        response = await client.post(
            path, json={"token": token, "confirm_other_address": True}, headers=headers or {}
        )
        assert response.status_code == 422, (path, response.text)
        # And each still answers its own body without the field.
        assert (await client.post(path, json={"token": token}, headers=headers or {})).status_code == 200


# --- no answer carries the destination -----------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
async def test_no_answer_carries_the_destination_and_every_bodys_keys_are_pinned(
    kind, client, capsys, db_session_factory
):
    world = await _world(kind, client, capsys, db_session_factory)
    other = world.seats[OTHER]
    plain = {"status", world.id_key}
    asked = {"status", world.id_key, world.name_key}
    destinations = [INVITED, "late@example.com"]

    token = await world.invite(INVITED)
    answers = [await _accept(client, world, other, token)]  # other_address
    answers.append(await _accept(client, world, world.seats[world.already_in], token))  # Q3
    answers.append(await _accept(client, world, other, token, confirm_other_address=True))  # accepted
    answers.append(await _accept(client, world, other, token))  # already_accepted, consumed
    answers.append(await _accept(client, world, world.inviter if world.kind != "group" else world.seats[STRANGER], token))
    expired = await world.invite("late@example.com")
    async with db_session_factory() as db:
        model = world.pending_model
        row = (await db.execute(select(model).where(model.token_hash == hash_token(expired)))).scalar_one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    answers.append(await _accept(client, world, other, expired))
    answers.append(await _accept(client, world, other, "not-a-token"))

    statuses = [response.json()["status"] for response in answers]
    assert statuses == [
        "other_address",
        "already_accepted",
        "accepted",
        "already_accepted",
        "used",
        "expired",
        "invalid",
    ]
    for response in answers:
        body = response.json()
        assert set(body) == (asked if body["status"] == "other_address" else plain), body
        for destination in destinations:
            assert destination not in response.text
            assert destination.split("@")[0] not in response.text


# --- the group's gathering: other_address takes no lock ------------------------------


async def test_a_groups_gathering_other_address_takes_no_lock(client, capsys, db_session_factory):
    """The check runs before `_accept_into_group_gathering`, so an answer of
    `other_address` never waits on the gathering's row lock: held here from
    another session, the route finishes while it is held. (A confirmed
    acceptance takes it, as today — so it waits.)"""
    world = await _world("group_gathering", client, capsys, db_session_factory)
    token = await world.invite(INVITED)
    async with db_session_factory() as competitor:
        await competitor.execute(
            select(Gathering).where(Gathering.id == UUID(world.target_id)).with_for_update()
        )
        route = asyncio.create_task(_accept(client, world, world.seats[OTHER], token))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
        response = await route
    assert seen == "finished", "the other_address answer waited on the gathering's row lock"
    assert response.json() == _other_address_body(world)

    async with db_session_factory() as competitor:
        await competitor.execute(
            select(Gathering).where(Gathering.id == UUID(world.target_id)).with_for_update()
        )
        route = asyncio.create_task(
            _accept(client, world, world.seats[OTHER], token, confirm_other_address=True)
        )
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
        response = await route
    assert seen == "waiting", "the confirmed acceptance no longer took the gathering's row lock"
    assert response.json()["status"] == "accepted"
