"""CK-92 — inviting people outside the group, the backend: the setting on a
group's gathering, invitations from outside while it is on, turning it off,
and the alert's data (decisions/2026-10-04-a-groups-gathering-stays-in-the-
group.md §5, §6, §7, §11; decisions/2026-10-23-joining-a-group-and-co-admins.md
§6, §9; Steven's answers of 2026-11-10; migration 0037). The cast is
tests/test_group_membership.py's — an ADMIN who created the group (and so
keeps it), a CO-ADMIN, a MEMBER, a STRANGER — plus members and outsiders
added per test; every seat is signed in; no network anywhere.

The load-bearing pins:
- WHO MAY CHANGE IT: the host, a co-host, the group's admin who is invited,
  a co-admin who is only shared with; everyone else — an invited member who
  runs nothing, the group's admin and a co-admin LEFT OUT, the keeper by
  keeping, an outsider, a stranger — the gathering's 404, byte-identical to
  a random id's; a standalone gathering `not_in_a_group`;
- WHO IS AN OUTSIDER IS A FACT ON THE ROW: `from_outside` written true when
  a non-member accepts, cleared when they join the group (either path, any
  gathering of the group, past included), never worked out from membership
  — so a member who LEAVES keeps the gathering when it is turned off;
- TURNING IT OFF LEAVES NO WAY BACK IN: the outsiders' invitation rows
  deleted and the live pending ones revoked, in one transaction, under the
  gathering's row lock — staged both ways against an acceptance and against
  a new invitation, never timed;
- NO ANSWER IS DELETED, yet a removed outsider's answer leaves the RSVP
  list; on every gathering that exists today the list is unchanged;
- A MEMBER KEPT A SURPRISE LEARNS NOTHING, the group's admin and co-admins
  included — not through the setting, the preview, the body or the alert;
- the detail body's three fields by seat, the list item and the calendar
  byte-identical and no new query; the alert and its dismissal; the
  verifier's lines, each fired by a plant; the 0037 round trip.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import event, select, text, update

from app.api import gatherings as gatherings_api
from app.api import invitations as invitations_api
from app.api.gatherings import NOT_IN_A_GROUP
from app.api.invitations import MEMBERS_ONLY
from app.db import engine
from app.models import Gathering, GatheringInvitationPending, PublicationState
from app.security import hash_token
from tests.test_account_deletion import DELETE_BODY
from tests.test_calendar import _calendar
from tests.test_co_hosts import _add as _add_co_host
from tests.test_co_hosts import _co_hosts
from tests.test_destruction import _verifier
from tests.test_double_requests import _pending, _until_the_route_waits_or_finishes
from tests.test_gatherings import _account_for, _create, _signed_in_headers
from tests.test_group_gatherings import (
    _create_in_group,
    _invitation_id,
    _iso,
    _photograph,
)
from tests.test_group_gatherings import _list as _gathering_list
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _approve, _join, _make, _requests, _token_of
from tests.test_group_membership import (
    ADMIN,
    CO_ADMIN,
    MEMBER,
    STRANGER,
    Cast,
    _cast,
    _leave,
    _person_id,
)
from tests.test_groups import MISSING
from tests.test_invitations import INVITE_LINK_RE, _invite, _invite_token
from tests.test_invitations import _accept as _accept_invitation
from tests.test_media_intents import _intents, _item
from tests.test_media_reads import _ids, _url
from tests.test_media_reads import _list as _media_list
from tests.test_member_places import _extra_member, _place_rows, _places, _usage
from tests.test_photo_count import _migrate, at_head_afterwards  # noqa: F401 — the fixture
from tests.test_race_backstops import _select_from, _stage
from tests.test_rsvps import _get_rsvps, _put_rsvp

INVITEE = "invitee@example.com"  # an invited member who runs nothing
CO_HOST = "cohost@example.com"  # a member made a co-host
KEEPER = "keeper@example.com"  # keeps the group by keeping, in nothing
LEAVER = "leaver@example.com"  # a member who leaves the group, still invited
OUTSIDER = "outsider@example.com"
OUTSIDER_2 = "outsider2@example.com"
LEFT = "leftout@example.com"

# The verifier's total, pinned as a number (the CK-57 convention): 438 at
# CK-83b; CK-92 adds twenty — the two setting columns' nullability (2), the
# setting's FK target and its delete rule (2), the two CHECKs (2),
# `from_outside`'s NOT NULL, type and default (3), the dismissals table (1),
# its three NOT NULLs (3), its key (1), its two FKs' targets and delete rules
# (4), and two data lines (2: a `from_outside` row sits on a group's
# gathering whose outside invitations are on; its person holds no membership
# of that group) — and the members-only line is NARROWED in place (one line
# out, one in), so 458.
VERIFIER_TOTAL = 458

THREE_FIELDS = ("outside_invitations", "caller_in_group", "outside_alert")
SETTING_KEYS = {"on", "since", "by", "may_change"}
PREVIEW_KEYS = {"on", "since", "by", "outsiders", "pending"}
# The list item's keys at CK-91, measured before this phase and unchanged by it.
LIST_ITEM_KEYS = {
    "caller_role",
    "caller_view",
    "cover",
    "created_at",
    "created_by_account_id",
    "gathering_type",
    "group",
    "host_account_id",
    "id",
    "memorial_decedent_name",
    "next_occurrence",
    "occurrence_count",
    "publication_state",
    "requires_approval",
    "requires_approval_override",
    "rsvp_list_visibility",
    "title",
    "updated_at",
}
CALENDAR_GATHERING_KEYS = {"id", "title", "gathering_type", "cover", "group", "date_count", "published_count"}

ON_ONLY_LINE = "every from_outside invitation row sits on a group's gathering whose outside invitations are on"
NOT_A_MEMBER_LINE = "no from_outside invitation row's person holds a membership of the gathering's group"
LIVE_PENDING_LINE = (
    "no LIVE pending invitation (neither consumed nor revoked) sits on a group's gathering "
    "whose outside invitations are off"
)
ONE_PLACE_LINE = "no person holds both an invitation row and a place row for one gathering (one place each)"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- routes ------------------------------------------------------------------------


async def _turn(client, headers, gathering_id: str, on: bool):
    return await client.put(f"/gatherings/{gathering_id}/outside-invitations", json={"on": on}, headers=headers)


async def _on(client, headers, gathering_id: str) -> dict:
    response = await _turn(client, headers, gathering_id, True)
    assert response.status_code == 200, response.text
    assert response.json()["outside_invitations"]["on"] is True
    return response.json()


async def _off(client, headers, gathering_id: str) -> dict:
    response = await _turn(client, headers, gathering_id, False)
    assert response.status_code == 200, response.text
    assert response.json()["outside_invitations"]["on"] is False
    return response.json()


async def _preview(client, headers, gathering_id: str):
    return await client.get(f"/gatherings/{gathering_id}/outside-invitations", headers=headers)


async def _dismiss(client, headers, gathering_id: str):
    return await client.post(f"/gatherings/{gathering_id}/outside-alert/dismiss", headers=headers)


async def _detail(client, headers, gathering_id: str) -> dict:
    response = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _accept(client, headers, token: str):
    return await client.post("/invitations/accept", json={"token": token}, headers=headers)


async def _let_in(client, capsys, host_headers, gathering_id: str, address: str, headers: dict | None = None) -> dict:
    """Invite `address` from outside and accept it as them: their headers."""
    headers = headers or await _signed_in_headers(client, capsys, address)
    token = await _invite_token(client, capsys, host_headers, gathering_id, address)
    assert (await _accept_invitation(client, headers, token)) == {"status": "accepted", "gathering_id": gathering_id}
    return headers


async def _gathering_404(client, headers) -> tuple[int, bytes]:
    response = await client.get(f"/gatherings/{MISSING}", headers=headers)
    assert response.status_code == 404
    return response.status_code, response.content


async def _put_404(client, headers) -> tuple[int, bytes]:
    response = await _turn(client, headers, MISSING, True)
    assert response.status_code == 404
    return response.status_code, response.content


def _window() -> tuple[datetime, datetime]:
    """A range holding the default group gathering's one date (30 days ahead)."""
    return _now() + timedelta(days=1), _now() + timedelta(days=60)


async def _calendar_ids(client, headers) -> set[str]:
    start, end = _window()
    response = await _calendar(client, headers, start, end)
    assert response.status_code == 200, response.text
    return {g["id"] for g in response.json()["gatherings"]}


async def _rsvp_names(client, headers, occurrence_id: str) -> list[tuple[str, str]]:
    response = await _get_rsvps(client, headers, occurrence_id)
    assert response.status_code == 200, response.text
    return [(row["display_name"], row["response"]) for row in response.json()["rsvps"]]


# --- rows -------------------------------------------------------------------------


async def _setting(db_session_factory, gathering_id: str) -> tuple:
    """(outside_invitations_since, outside_invitations_by_person_id, updated_at)."""
    async with db_session_factory() as db:
        return tuple(
            (
                await db.execute(
                    text(
                        "SELECT outside_invitations_since, outside_invitations_by_person_id, updated_at "
                        "FROM gatherings WHERE id = :g"
                    ),
                    {"g": UUID(gathering_id)},
                )
            ).one()
        )


async def _outside_rows(db_session_factory, gathering_id: str) -> dict[UUID, bool]:
    """{person_id: from_outside} for every person-targeted invitation row."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT person_id, from_outside FROM gathering_invitations "
                    "WHERE gathering_id = :g AND person_id IS NOT NULL"
                ),
                {"g": UUID(gathering_id)},
            )
        ).all()
    return {person: flag for person, flag in rows}


async def _pending_rows(db_session_factory, gathering_id: str) -> dict[str, tuple[bool, bool]]:
    """{destination: (consumed, revoked)} for every pending row."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(
                    GatheringInvitationPending.destination,
                    GatheringInvitationPending.consumed_at,
                    GatheringInvitationPending.revoked_at,
                ).where(GatheringInvitationPending.gathering_id == UUID(gathering_id))
            )
        ).all()
    return {destination: (consumed is not None, revoked is not None) for destination, consumed, revoked in rows}


async def _pending_id(db_session_factory, token: str) -> UUID:
    async with db_session_factory() as db:
        return (
            await db.execute(
                select(GatheringInvitationPending.id).where(
                    GatheringInvitationPending.token_hash == hash_token(token)
                )
            )
        ).scalar_one()


async def _dismissals(db_session_factory, gathering_id: str) -> dict[UUID, datetime]:
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT person_id, dismissed_at FROM gathering_outside_alert_dismissals "
                    "WHERE gathering_id = :g"
                ),
                {"g": UUID(gathering_id)},
            )
        ).all()
    return {person: at for person, at in rows}


async def _rsvp_count(db_session_factory, person_id: UUID) -> int:
    async with db_session_factory() as db:
        return await db.scalar(text("SELECT count(*) FROM rsvps WHERE person_id = :p"), {"p": person_id})


async def _turn_off_by_hand(db, gathering_id: str) -> None:
    """The turn-off's three statements, from a competitor's session (the
    route's own shape: revoke the live pending rows, delete the outsiders'
    rows, clear both columns)."""
    params = {"g": UUID(gathering_id)}
    await db.execute(
        text(
            "UPDATE gathering_invitations_pending SET revoked_at = now(), expires_at = LEAST(expires_at, now()) "
            "WHERE gathering_id = :g AND consumed_at IS NULL AND revoked_at IS NULL"
        ),
        params,
    )
    await db.execute(text("DELETE FROM gathering_invitations WHERE gathering_id = :g AND from_outside"), params)
    await db.execute(
        text(
            "UPDATE gatherings SET outside_invitations_since = NULL, outside_invitations_by_person_id = NULL "
            "WHERE id = :g"
        ),
        params,
    )


# --- the world --------------------------------------------------------------------


@dataclass
class World:
    cast: Cast
    invitee: dict
    co_host: dict
    invitee_membership: str
    co_host_membership: str
    gathering_id: str  # chosen: the admin, the invitee and the co-host invited; the co-admin shared with
    occurrence_id: str


async def _world(client, capsys, db_session_factory) -> World:
    cast = await _cast(client, capsys, db_session_factory)
    invitee, invitee_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, INVITEE)
    co_host, co_host_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, CO_HOST)
    created = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        title="Thanksgiving",
        invited=[cast.admin_membership, invitee_membership, co_host_membership],
    )
    gathering_id = created["id"]
    handle = await _invitation_id(db_session_factory, gathering_id, CO_HOST)
    assert (await _add_co_host(client, cast.member, gathering_id, handle)).status_code == 201
    return World(
        cast=cast,
        invitee=invitee,
        co_host=co_host,
        invitee_membership=invitee_membership,
        co_host_membership=co_host_membership,
        gathering_id=gathering_id,
        occurrence_id=created["occurrences"][0]["id"],
    )


# --- auth and shape ---------------------------------------------------------------


async def test_the_routes_require_auth_and_the_setting_takes_exactly_on(client, capsys, db_session_factory):
    assert (await client.put(f"/gatherings/{MISSING}/outside-invitations", json={"on": True})).status_code == 401
    assert (await client.get(f"/gatherings/{MISSING}/outside-invitations")).status_code == 401
    assert (await client.post(f"/gatherings/{MISSING}/outside-alert/dismiss")).status_code == 401
    world = await _world(client, capsys, db_session_factory)
    path = f"/gatherings/{world.gathering_id}/outside-invitations"
    for body in ({"on": True, "since": "now"}, {}, {"on": None}):
        response = await client.put(path, json=body, headers=world.cast.member)
        assert response.status_code == 422, (body, response.text)
    assert (await _setting(db_session_factory, world.gathering_id))[:2] == (None, None)


# --- the setting's seats ----------------------------------------------------------


async def test_who_may_change_it_and_everyone_else_draws_the_gatherings_404(client, capsys, db_session_factory):
    """May: the host, a co-host, the group's admin who is invited, a co-admin
    only shared with. The gathering's 404, byte-identical to a random id's,
    on the PUT and the preview: an invited member who runs nothing, the
    keeper by keeping, an outsider, a stranger — and the group's admin and a
    co-admin LEFT OUT, who learn nothing (the setting is part of the
    gathering). A standalone gathering's host reads `not_in_a_group`."""
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    keeper = await _signed_in_headers(client, capsys, KEEPER)
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, KEEPER)
        await db.execute(
            text("UPDATE groups SET keeper_account_id = :k WHERE id = :g"),
            {"k": keeper_account.id, "g": UUID(cast.group_id)},
        )
        await db.commit()
    surprise = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        title="The admin's surprise",
        left_out=[cast.admin_membership, cast.co_admin_membership],
    )
    standalone = await _create(client, cast.member, title="Just ours")

    await _on(client, cast.member, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    for headers in (world.invitee, keeper, outsider, cast.stranger):
        for on in (False, True):
            refused = await _turn(client, headers, gid, on)
            assert (refused.status_code, refused.content) == await _put_404(client, headers)
        peek = await _preview(client, headers, gid)
        assert (peek.status_code, peek.content) == await _gathering_404(client, headers)
    assert (await _setting(db_session_factory, gid))[0] is not None  # nobody refused changed it

    for headers in (cast.member, world.co_host, cast.admin, cast.co_admin):
        off = await _off(client, headers, gid)
        assert off["outside_invitations"]["may_change"] is True
        assert (await _preview(client, headers, gid)).status_code == 200
        assert (await _on(client, headers, gid))["outside_invitations"]["may_change"] is True

    # Left out of a gathering in their own group: no trace, the setting included.
    for headers in (cast.admin, cast.co_admin):
        for on in (True, False):
            refused = await _turn(client, headers, surprise["id"], on)
            assert (refused.status_code, refused.content) == await _put_404(client, headers)
        peek = await _preview(client, headers, surprise["id"])
        assert (peek.status_code, peek.content) == await _gathering_404(client, headers)
        assert (await _dismiss(client, headers, surprise["id"])).status_code == 404
    assert (await _setting(db_session_factory, surprise["id"]))[:2] == (None, None)
    await _on(client, cast.member, surprise["id"])  # its host may

    for refused in (await _turn(client, cast.member, standalone["id"], True), await _preview(client, cast.member, standalone["id"])):
        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"]["code"] == NOT_IN_A_GROUP
    stranger = await _turn(client, cast.stranger, standalone["id"], True)
    assert (stranger.status_code, stranger.content) == await _put_404(client, cast.stranger)


async def test_turning_it_on_stamps_the_time_and_the_person_and_on_again_writes_nothing(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    before = _now()
    _, _, updated_before = await _setting(db_session_factory, gid)
    body = await _on(client, world.cast.admin, gid)
    since, by, updated_at = await _setting(db_session_factory, gid)
    assert since is not None and before <= since <= _now()
    assert by == await _person_id(db_session_factory, ADMIN)
    assert updated_at == updated_before  # who can see it is not an edit of the gathering
    assert body["outside_invitations"] == {
        "on": True,
        "since": since.isoformat(),
        "by": "admin",
        "may_change": True,
    }
    # On again, by someone else: nothing written, the stamp and the person unmoved.
    again = await _on(client, world.cast.co_admin, gid)
    assert await _setting(db_session_factory, gid) == (since, by, updated_at)
    assert again["outside_invitations"]["since"] == since.isoformat()
    assert again["outside_invitations"]["by"] == "admin"
    # Off, then off again: nothing written the second time.
    await _off(client, world.cast.member, gid)
    assert await _setting(db_session_factory, gid) == (None, None, updated_at)
    await _off(client, world.cast.member, gid)
    assert await _setting(db_session_factory, gid) == (None, None, updated_at)


# --- invitations, off and on -------------------------------------------------------


async def test_while_off_an_invitation_is_members_only_first_and_while_on_it_is_written_and_sent(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    capsys.readouterr()
    refused = await _invite(client, world.cast.member, gid, OUTSIDER)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == MEMBERS_ONLY
    assert "outside" in refused.json()["detail"]["message"]  # it names the setting
    # First: before the channel check, so an SMS is the same 409.
    sms = await client.post(
        f"/gatherings/{gid}/invitations", json={"channel": "SMS", "destination": "+15555550100"}, headers=world.cast.member
    )
    assert sms.status_code == 409 and sms.json()["detail"]["code"] == MEMBERS_ONLY
    assert await _pending_rows(db_session_factory, gid) == {}
    assert INVITE_LINK_RE.search(capsys.readouterr().out) is None

    await _on(client, world.cast.admin, gid)
    token = await _invite_token(client, capsys, world.cast.member, gid, OUTSIDER)
    assert token
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, False)}
    # A co-host invites too; the destination is never looked up — an address
    # that is a member's is invited as any other.
    assert (await _invite(client, world.co_host, gid, MEMBER)).status_code == 201
    # The SMS channel is refused as on a standalone gathering, now that it is on.
    sms = await client.post(
        f"/gatherings/{gid}/invitations", json={"channel": "SMS", "destination": "+15555550100"}, headers=world.cast.member
    )
    assert sms.status_code == 422, sms.text


# --- accepting ---------------------------------------------------------------------


async def test_an_outsider_accepts_holds_a_from_outside_row_and_reads_the_full_view(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    await _on(client, world.cast.admin, gid)
    outsider = await _let_in(client, capsys, world.cast.member, gid, OUTSIDER)
    outsider_person = await _person_id(db_session_factory, OUTSIDER)
    rows = await _outside_rows(db_session_factory, gid)
    assert rows[outsider_person] is True
    assert {person for person, flag in rows.items() if flag} == {outsider_person}

    detail = await _detail(client, outsider, gid)
    assert detail["caller_view"] == "full" and detail["caller_role"] is None
    assert [o["id"] for o in detail["occurrences"]] == [world.occurrence_id]
    assert (await _put_rsvp(client, outsider, world.occurrence_id, {"response": "yes"})).status_code == 200
    assert (await _get_rsvps(client, outsider, world.occurrence_id)).status_code == 200
    assert (await _intents(client, outsider, gid, [_item()])).status_code == 201
    assert gid in {g["id"] for g in await _gathering_list(client, outsider)}
    # The places are the group's members': the outsider is in no place list.
    places = await _places(client, world.cast.member, gid)
    assert places.status_code == 200
    assert "outsider" not in places.text


async def test_a_member_who_accepts_ends_with_one_invitation_and_no_place(client, capsys, db_session_factory):
    """Invited already: `already_accepted`, no second row. Shared with, or
    left out: the place row deleted and an invitation row written,
    `from_outside` false, in the same transaction — moving a member TO
    invited is never refused, and one place per person holds."""
    cast = await _cast(client, capsys, db_session_factory)
    left, left_membership, left_person = await _extra_member(client, capsys, db_session_factory, cast, LEFT)
    created = await _create_in_group(
        client, cast.member, cast.group_id, invited=[cast.admin_membership], left_out=[left_membership]
    )
    gid = created["id"]
    admin_person = await _person_id(db_session_factory, ADMIN)
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    places = await _place_rows(db_session_factory, gid)
    assert set(places) == {co_admin_person, left_person}
    await _on(client, cast.member, gid)

    token = await _invite_token(client, capsys, cast.member, gid, ADMIN)
    assert (await _accept_invitation(client, cast.admin, token)) == {"status": "already_accepted", "gathering_id": gid}
    for headers, address in ((cast.co_admin, CO_ADMIN), (left, LEFT)):
        token = await _invite_token(client, capsys, cast.member, gid, address)
        assert (await _accept_invitation(client, headers, token)) == {"status": "accepted", "gathering_id": gid}
    assert await _place_rows(db_session_factory, gid) == {}
    assert await _outside_rows(db_session_factory, gid) == {
        admin_person: False,
        co_admin_person: False,
        left_person: False,
    }
    assert (await _detail(client, cast.co_admin, gid))["caller_view"] == "full"
    assert (await _detail(client, left, gid))["caller_view"] == "full"


async def test_a_token_accepted_after_turning_it_off_answers_revoked_and_writes_nothing(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    outsider = await _signed_in_headers(client, capsys, OUTSIDER)
    await _on(client, world.cast.admin, gid)
    token = await _invite_token(client, capsys, world.cast.member, gid, OUTSIDER)
    await _off(client, world.cast.admin, gid)
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, True)}  # revoked, never deleted
    roster = await client.get(f"/gatherings/{gid}/invitations", headers=world.cast.member)
    assert roster.json()["pending"] == []
    response = await _accept(client, outsider, token)
    assert response.json() == {"status": "revoked", "gathering_id": None}
    assert await _person_id(db_session_factory, OUTSIDER) not in await _outside_rows(db_session_factory, gid)
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, True)}
    # Turned on again, the old link stays dead.
    await _on(client, world.cast.admin, gid)
    assert (await _accept(client, outsider, token)).json() == {"status": "revoked", "gathering_id": None}


# --- the outsider is never a member -------------------------------------------------


async def test_the_outsider_is_never_a_member_and_sees_nothing_of_the_group(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    await _on(client, cast.admin, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    start, end = _window()
    window = {"from": _iso(start), "to": _iso(end)}
    for suffix, params in (("", None), ("/members", None), ("/gatherings", None), ("/media", None), ("/calendar", window)):
        theirs = await client.get(f"/groups/{cast.group_id}{suffix}", params=params, headers=outsider)
        missing = await client.get(f"/groups/{MISSING}{suffix}", params=params, headers=outsider)
        assert theirs.status_code == 404, (suffix, theirs.text)
        assert (theirs.status_code, theirs.content) == (missing.status_code, missing.content), suffix
    group_calendar = await _calendar(client, outsider, start, end, cast.group_id)
    assert group_calendar.status_code == 404
    groups = await client.get("/groups", headers=outsider)
    assert groups.json()["groups"] == []
    assert gid in await _calendar_ids(client, outsider)
    assert "outsider" not in (await _places(client, cast.member, gid)).text
    members = await client.get(f"/groups/{cast.group_id}/members", headers=cast.member)
    assert "outsider" not in members.text


# --- turning it off ----------------------------------------------------------------


async def test_turning_it_off_removes_the_outsiders_revokes_the_pending_and_keeps_everything_else(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    leaver, _, leaver_person = await _extra_member(client, capsys, db_session_factory, cast, LEAVER)
    whole = await _create_in_group(client, cast.member, cast.group_id, title="Thanksgiving")
    gid, occurrence_id = whole["id"], whole["occurrences"][0]["id"]
    # A member who leaves the group keeps the place the group's rule gave them.
    assert (await _leave(client, leaver, cast.group_id)).status_code == 204
    await _on(client, cast.admin, gid)
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    outsider_person = await _person_id(db_session_factory, OUTSIDER)
    member_person = await _person_id(db_session_factory, MEMBER)
    assert (await _put_rsvp(client, outsider, occurrence_id, {"response": "yes"})).status_code == 200
    assert (await _put_rsvp(client, cast.admin, occurrence_id, {"response": "maybe"})).status_code == 200
    assert (await _put_rsvp(client, leaver, occurrence_id, {"response": "no"})).status_code == 200
    assert (await _intents(client, outsider, gid, [_item()])).status_code == 201
    member_photo = await _photograph(db_session_factory, gid, member_person, publication_state=PublicationState.LIVE)
    outsider_photo = await _photograph(db_session_factory, gid, outsider_person, publication_state=PublicationState.LIVE)
    pending_token = await _invite_token(client, capsys, cast.member, gid, OUTSIDER_2)
    assert await _rsvp_names(client, cast.member, occurrence_id) == [("outsider", "yes"), ("admin", "maybe"), ("leaver", "no")]
    assert (await _url(client, outsider, member_photo)).status_code == 200
    usage = await _usage(db_session_factory, ADMIN)
    before = await _outside_rows(db_session_factory, gid)
    assert before[outsider_person] is True and before[leaver_person] is False

    await _off(client, cast.co_admin, gid)

    # The outsider loses the gathering on every route, each its own 404.
    refused = await client.get(f"/gatherings/{gid}", headers=outsider)
    assert (refused.status_code, refused.content) == await _gathering_404(client, outsider)
    assert (await _media_list(client, outsider, gid)).status_code == 404
    assert (await _url(client, outsider, member_photo)).status_code == 404
    assert (await _intents(client, outsider, gid, [_item()])).status_code == 404
    assert (await _put_rsvp(client, outsider, occurrence_id, {"response": "no"})).status_code == 404
    assert (await _get_rsvps(client, outsider, occurrence_id)).status_code == 404
    assert gid not in await _calendar_ids(client, outsider)
    assert gid not in {g["id"] for g in await _gathering_list(client, outsider)}
    # The pending invitation is revoked, and its link answers so.
    other = await _signed_in_headers(client, capsys, OUTSIDER_2)
    assert (await _accept(client, other, pending_token)).json() == {"status": "revoked", "gathering_id": None}
    # Only the outsider's row went: the leaver keeps the gathering (read from
    # the row, never from membership), and so does every member.
    after = await _outside_rows(db_session_factory, gid)
    assert after == {person: flag for person, flag in before.items() if person != outsider_person}
    assert (await _detail(client, leaver, gid))["caller_view"] == "full"
    # Their answer is kept, and leaves the list; their photographs stay, counted and charged.
    assert await _rsvp_count(db_session_factory, outsider_person) == 1
    assert await _rsvp_names(client, cast.member, occurrence_id) == [("admin", "maybe"), ("leaver", "no")]
    assert outsider_photo in _ids(await _media_list(client, cast.member, gid))
    assert await _usage(db_session_factory, ADMIN) == usage

    # Turned on again: nobody comes back; a new invitation brings them back, with their answer.
    await _on(client, cast.admin, gid)
    again = await client.get(f"/gatherings/{gid}", headers=outsider)
    assert (again.status_code, again.content) == await _gathering_404(client, outsider)
    await _let_in(client, capsys, cast.member, gid, OUTSIDER, headers=outsider)
    assert (await _detail(client, outsider, gid))["caller_view"] == "full"
    assert await _rsvp_names(client, cast.member, occurrence_id) == [("outsider", "yes"), ("admin", "maybe"), ("leaver", "no")]


# --- joining clears from_outside ----------------------------------------------------


async def test_joining_by_an_approved_request_clears_from_outside_on_every_gathering_of_the_group(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    upcoming = await _create_in_group(client, cast.member, cast.group_id, title="Christmas")
    past = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        title="Last summer",
        occurrences=[{"starts_at": _iso(_now() - timedelta(days=10))}],
    )
    for gathering in (upcoming, past):
        await _on(client, cast.admin, gathering["id"])
    joiner = await _let_in(client, capsys, cast.member, upcoming["id"], OUTSIDER)
    await _let_in(client, capsys, cast.member, past["id"], OUTSIDER, headers=joiner)
    joiner_person = await _person_id(db_session_factory, OUTSIDER)
    for gathering in (upcoming, past):
        assert (await _outside_rows(db_session_factory, gathering["id"]))[joiner_person] is True

    link = await _make(client, cast.admin, cast.group_id)
    assert (await _join(client, joiner, _token_of(link.json()))).json()["status"] == "requested"
    (request,) = (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]
    assert (await _approve(client, cast.admin, cast.group_id, request["id"])).status_code == 200

    for gathering in (upcoming, past):
        assert (await _outside_rows(db_session_factory, gathering["id"]))[joiner_person] is False
        await _off(client, cast.admin, gathering["id"])
        assert (await _detail(client, joiner, gathering["id"]))["caller_view"] == "full"
        assert (await _detail(client, joiner, gathering["id"]))["caller_in_group"] is True


async def test_joining_by_an_emailed_group_invitation_clears_from_outside(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    whole = await _create_in_group(client, cast.member, cast.group_id, title="Christmas")
    gid = whole["id"]
    await _on(client, cast.admin, gid)
    joiner = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    joiner_person = await _person_id(db_session_factory, OUTSIDER)
    assert (await _outside_rows(db_session_factory, gid))[joiner_person] is True
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, OUTSIDER)
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"
    assert (await _outside_rows(db_session_factory, gid))[joiner_person] is False
    await _off(client, cast.admin, gid)
    assert (await _detail(client, joiner, gid))["caller_view"] == "full"


# --- co-hosts are members -----------------------------------------------------------


async def test_a_co_host_of_a_groups_gathering_must_be_a_member(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    whole = await _create_in_group(client, cast.member, cast.group_id)
    gid = whole["id"]
    await _on(client, cast.admin, gid)
    await _let_in(client, capsys, cast.member, gid, OUTSIDER)

    missing = await _add_co_host(client, cast.member, gid, MISSING)
    assert missing.status_code == 422 and missing.json()["detail"][0]["code"] == "not_invited"
    refused = await _add_co_host(client, cast.member, gid, await _invitation_id(db_session_factory, gid, OUTSIDER))
    assert refused.status_code == 422, refused.text
    (error,) = refused.json()["detail"]
    assert error["loc"] == ["body", "invitation_id"] and error["code"] == "not_a_member", error
    assert "outsider" not in (await _co_hosts(client, cast.member, gid)).text

    handle = await _invitation_id(db_session_factory, gid, CO_ADMIN)
    assert (await _add_co_host(client, cast.member, gid, handle)).status_code == 201
    # A co-host who later leaves the group stays a co-host: rows, never a lookup.
    assert (await _leave(client, cast.co_admin, cast.group_id)).status_code == 204
    assert "coadmin" in (await _co_hosts(client, cast.member, gid)).text
    assert (await _detail(client, cast.co_admin, gid))["caller_role"] == "co_host"


# --- the preview -------------------------------------------------------------------


async def test_the_preview_names_the_outsiders_in_order_and_counts_the_pending(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    off = await _preview(client, cast.member, gid)
    assert off.status_code == 200
    assert off.json() == {"on": False, "since": None, "by": None, "outsiders": [], "pending": 0}

    await _on(client, cast.co_admin, gid)
    await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    await _let_in(client, capsys, cast.member, gid, OUTSIDER_2)
    await _invite_token(client, capsys, cast.member, gid, "waiting@example.com")
    withdrawn = await _invite(client, cast.member, gid, "withdrawn@example.com")
    assert (await client.delete(f"/invitations/pending/{withdrawn.json()['id']}", headers=cast.member)).status_code == 204
    since = (await _setting(db_session_factory, gid))[0]

    for headers in (cast.member, world.co_host, cast.admin, cast.co_admin):
        response = await _preview(client, headers, gid)
        assert response.status_code == 200, response.text
        assert response.json() == {
            "on": True,
            "since": since.isoformat(),
            "by": "coadmin",
            "outsiders": [{"display_name": "outsider"}, {"display_name": "outsider2"}],
            "pending": 1,
        }
        assert set(response.json()) == PREVIEW_KEYS
        # No address, no person id, no invitation id.
        assert "@" not in response.text
        for address in (OUTSIDER, OUTSIDER_2, CO_ADMIN):
            assert str(await _person_id(db_session_factory, address)) not in response.text
        for address in (OUTSIDER, OUTSIDER_2):
            assert await _invitation_id(db_session_factory, gid, address) not in response.text


# --- the body ----------------------------------------------------------------------


async def test_the_detail_body_carries_the_three_fields_by_seat_and_null_on_a_standalone(
    client, capsys, db_session_factory
):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    standalone = await _create(client, cast.member, title="Just ours")
    for key in THREE_FIELDS:
        assert key in standalone and standalone[key] is None
        assert (await _detail(client, cast.member, standalone["id"]))[key] is None

    def three(body) -> tuple:
        return tuple(body[k] for k in THREE_FIELDS)

    off = {"on": False, "since": None, "by": None}
    for headers, may in (
        (cast.member, True),
        (world.co_host, True),
        (cast.admin, True),
        (cast.co_admin, True),
        (world.invitee, False),
    ):
        assert three(await _detail(client, headers, gid)) == ({**off, "may_change": may}, True, False)
    # The memory view keeps its withheld fields null, and carries the three.
    memory = await _detail(client, cast.co_admin, gid)
    assert memory["caller_view"] == "memory" and memory["occurrences"] is None

    # A create's body and a patch's body carry them too.
    created = await _create_in_group(client, cast.member, cast.group_id, title="New one")
    assert three(created) == ({**off, "may_change": True}, True, False)
    patched = await client.patch(f"/gatherings/{gid}", json={"title": "Thanksgiving dinner"}, headers=world.co_host)
    assert patched.status_code == 200
    assert three(patched.json()) == ({**off, "may_change": True}, True, False)

    put = await _on(client, cast.admin, gid)
    since = (await _setting(db_session_factory, gid))[0].isoformat()
    on = {"on": True, "since": since, "by": "admin"}
    assert put == await _detail(client, cast.admin, gid)  # the PUT answers the detail body
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    for headers, may, in_group, alert in (
        (cast.member, True, True, True),
        (world.co_host, True, True, True),
        (cast.admin, True, True, False),
        (cast.co_admin, True, True, True),
        (world.invitee, False, True, True),
        (outsider, False, False, False),
    ):
        body = await _detail(client, headers, gid)
        assert set(body["outside_invitations"]) == SETTING_KEYS
        assert three(body) == ({**on, "may_change": may}, in_group, alert)
    shared = await _turn(client, cast.co_admin, gid, True)
    assert shared.json() == await _detail(client, cast.co_admin, gid)
    assert shared.json()["caller_view"] == "memory"

    # The person who turned it on, anonymized: `by` null, the setting still on.
    await _off(client, cast.member, gid)
    await _on(client, cast.co_admin, gid)
    assert (await _detail(client, cast.member, gid))["outside_invitations"]["by"] == "coadmin"
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=cast.co_admin)).status_code == 204
    setting = (await _detail(client, cast.member, gid))["outside_invitations"]
    assert setting["on"] is True and setting["by"] is None


async def test_the_list_item_and_the_calendar_are_unchanged_and_make_no_new_query(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    start, end = _window()
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def read(call) -> tuple[int, dict]:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            response = await call()
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        assert response.status_code == 200, response.text
        assert not [s for s in statements if "outside" in s or "dismissal" in s], statements
        return len(statements), response.json()

    calls = (
        lambda: client.get("/gatherings", headers=cast.member),
        lambda: _calendar(client, cast.member, start, end),
        lambda: _calendar(client, cast.member, start, end, cast.group_id),
    )
    await calls[0]()  # warm the session's refresh
    before = [await read(call) for call in calls]
    assert [n for n, _ in before] == [3, 3, 5]  # measured at CK-91, before this phase
    (item,) = before[0][1]["gatherings"]
    assert set(item) == LIST_ITEM_KEYS
    assert set(before[1][1]["gatherings"][0]) == CALENDAR_GATHERING_KEYS

    await _on(client, cast.admin, gid)
    await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    assert (await _dismiss(client, cast.member, gid)).status_code == 204
    after = [await read(call) for call in calls]
    assert after == before  # byte for byte, and no new query


# --- the alert ---------------------------------------------------------------------


async def test_the_alert_by_seat_its_dismissal_and_after_off_and_on(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    seats = {
        "host": cast.member,
        "co_host": world.co_host,
        "invitee": world.invitee,
        "shared": cast.co_admin,
        "opener": cast.admin,
    }

    async def alerts() -> dict[str, bool]:
        return {name: (await _detail(client, headers, gid))["outside_alert"] for name, headers in seats.items()}

    assert set((await alerts()).values()) == {False}
    # Off: a dismissal writes nothing and still answers 204.
    assert (await _dismiss(client, world.invitee, gid)).status_code == 204
    assert await _dismissals(db_session_factory, gid) == {}

    await _on(client, cast.admin, gid)
    assert await alerts() == {"host": True, "co_host": True, "invitee": True, "shared": True, "opener": False}
    outsider = await _let_in(client, capsys, cast.member, gid, OUTSIDER)
    assert (await _detail(client, outsider, gid))["outside_alert"] is False
    assert (await _dismiss(client, outsider, gid)).status_code == 204
    assert await _dismissals(db_session_factory, gid) == {}

    for name in ("invitee", "shared"):
        assert (await _dismiss(client, seats[name], gid)).status_code == 204
    assert await alerts() == {"host": True, "co_host": True, "invitee": False, "shared": False, "opener": False}
    assert set(await _dismissals(db_session_factory, gid)) == {
        await _person_id(db_session_factory, INVITEE),
        await _person_id(db_session_factory, CO_ADMIN),
    }
    first = (await _dismissals(db_session_factory, gid))[await _person_id(db_session_factory, INVITEE)]
    assert (await _dismiss(client, world.invitee, gid)).status_code == 204  # replaced, one row a person
    assert (await _dismissals(db_session_factory, gid))[await _person_id(db_session_factory, INVITEE)] > first

    await _off(client, cast.member, gid)
    assert set((await alerts()).values()) == {False}
    # On again — a new stamp, so a dismissed alert comes back.
    await _on(client, world.co_host, gid)
    assert await alerts() == {"host": True, "co_host": False, "invitee": True, "shared": True, "opener": True}

    stranger = await _dismiss(client, cast.stranger, gid)
    assert (stranger.status_code, stranger.content) == await _gathering_404(client, cast.stranger)


# --- the RSVP list -----------------------------------------------------------------


async def test_the_rsvp_list_is_unchanged_on_every_gathering_that_exists_today(client, capsys, db_session_factory):
    """A standalone gathering with an emailed guest, a whole-group gathering
    and a chosen one: every answer the list showed before this phase it
    shows now — the host's (who holds no invitation row), a co-host's, an
    invitee's."""
    cast = await _cast(client, capsys, db_session_factory)
    standalone = await _create(
        client, cast.member, title="Just ours", occurrences=[{"starts_at": _iso(_now() + timedelta(days=30))}]
    )
    guest = await _let_in(client, capsys, cast.member, standalone["id"], "guest@example.com")
    whole = await _create_in_group(client, cast.member, cast.group_id, title="Whole")
    chosen = await _create_in_group(client, cast.member, cast.group_id, title="Chosen", invited=[cast.admin_membership])
    handle = await _invitation_id(db_session_factory, whole["id"], CO_ADMIN)
    assert (await _add_co_host(client, cast.member, whole["id"], handle)).status_code == 201
    occurrence = {g["id"]: g["occurrences"][0]["id"] for g in (standalone, whole, chosen)}
    for gathering, headers, answer in (
        (standalone, cast.member, "yes"),
        (standalone, guest, "maybe"),
        (whole, cast.member, "yes"),
        (whole, cast.admin, "no"),
        (whole, cast.co_admin, "yes"),
        (chosen, cast.member, "yes"),
        (chosen, cast.admin, "yes"),
    ):
        assert (await _put_rsvp(client, headers, occurrence[gathering["id"]], {"response": answer})).status_code == 200
    expected = {
        standalone["id"]: [("member", "yes"), ("guest", "maybe")],
        whole["id"]: [("member", "yes"), ("admin", "no"), ("coadmin", "yes")],
        chosen["id"]: [("member", "yes"), ("admin", "yes")],
    }
    for gathering_id, rows in expected.items():
        assert await _rsvp_names(client, cast.member, occurrence[gathering_id]) == rows
    own = await _get_rsvps(client, cast.member, occurrence[whole["id"]])
    assert own.json()["own"]["response"] == "yes"


# --- the roster --------------------------------------------------------------------


async def test_the_roster_marks_who_came_from_outside(client, capsys, db_session_factory):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    await _on(client, world.cast.admin, gid)
    await _let_in(client, capsys, world.cast.member, gid, OUTSIDER)
    await _invite_token(client, capsys, world.cast.member, gid, "waiting@example.com")
    roster = await client.get(f"/gatherings/{gid}/invitations", headers=world.cast.member)
    assert roster.status_code == 200
    accepted = {entry["display_name"]: entry["from_outside"] for entry in roster.json()["accepted"]}
    assert accepted == {"admin": False, "invitee": False, "cohost": False, "outsider": True}
    assert all("from_outside" not in entry for entry in roster.json()["pending"])


# --- the races, staged both ways ---------------------------------------------------


async def _race_world(client, capsys, db_session_factory) -> tuple[Cast, str, dict, str]:
    """A whole-group gathering with its outside invitations on, and an
    outsider holding an unaccepted invitation: (cast, gathering id, the
    outsider's headers, their token)."""
    cast = await _cast(client, capsys, db_session_factory)
    gid = (await _create_in_group(client, cast.member, cast.group_id))["id"]
    await _on(client, cast.admin, gid)
    outsider = await _signed_in_headers(client, capsys, OUTSIDER)
    token = await _invite_token(client, capsys, cast.member, gid, OUTSIDER)
    return cast, gid, outsider, token


async def test_a_turn_off_waits_for_an_acceptance_holding_the_lock_and_then_removes_its_row(
    client, capsys, db_session_factory
):
    """The acceptance holds the gathering's row lock, its token consumed and
    its row written, uncommitted, while the turn-off runs: the turn-off
    WAITS, and once the acceptance commits it deletes the new row — the
    outsider is out, never slipped in after the turn-off."""
    cast, gid, _, token = await _race_world(client, capsys, db_session_factory)
    pending_id = await _pending_id(db_session_factory, token)
    outsider_person = await _person_id(db_session_factory, OUTSIDER)
    host_person = await _person_id(db_session_factory, MEMBER)
    async with db_session_factory() as competitor:
        await competitor.execute(select(Gathering).where(Gathering.id == UUID(gid)).with_for_update())
        await competitor.execute(
            update(GatheringInvitationPending).where(GatheringInvitationPending.id == pending_id).values(consumed_at=_now())
        )
        await competitor.execute(
            text(
                "INSERT INTO gathering_invitations (gathering_id, person_id, invited_by_person_id, from_outside) "
                "VALUES (:g, :p, :b, true)"
            ),
            {"g": UUID(gid), "p": outsider_person, "b": host_person},
        )
        route = asyncio.create_task(_turn(client, cast.admin, gid, False))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
        response = await route
    assert seen == "waiting", f"the turn-off never took its turn behind the acceptance ({seen})"
    assert response.status_code == 200, response.text
    assert outsider_person not in await _outside_rows(db_session_factory, gid)
    assert (await _setting(db_session_factory, gid))[:2] == (None, None)


async def test_an_acceptance_after_a_committed_turn_off_answers_revoked(client, capsys, db_session_factory, monkeypatch):
    """The turn-off commits between the acceptance's read of its token and
    its read of the setting: the acceptance reads off under the lock and
    answers `revoked`, nothing written."""
    cast, gid, outsider, token = await _race_world(client, capsys, db_session_factory)

    async def competitor() -> None:
        async with db_session_factory() as db:
            await _turn_off_by_hand(db, gid)
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("gathering_invitations_pending"), competitor=competitor)
    response = await _accept(client, outsider, token)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.json() == {"status": "revoked", "gathering_id": None}
    assert await _person_id(db_session_factory, OUTSIDER) not in await _outside_rows(db_session_factory, gid)
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, True)}


async def test_an_acceptance_waits_for_a_turn_off_holding_the_lock_and_answers_revoked(
    client, capsys, db_session_factory
):
    """The turn-off holds the gathering's row lock while the acceptance runs:
    the acceptance WAITS, and once the turn-off commits it reads off and
    answers `revoked` — it never lands after the turn-off has run."""
    cast, gid, outsider, token = await _race_world(client, capsys, db_session_factory)
    async with db_session_factory() as competitor:
        await competitor.execute(select(Gathering).where(Gathering.id == UUID(gid)).with_for_update())
        route = asyncio.create_task(_accept(client, outsider, token))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await _turn_off_by_hand(competitor, gid)
            await competitor.commit()
        response = await route
    assert seen == "waiting", f"the acceptance never took its turn behind the turn-off ({seen})"
    assert response.json() == {"status": "revoked", "gathering_id": None}
    assert await _person_id(db_session_factory, OUTSIDER) not in await _outside_rows(db_session_factory, gid)
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, True)}


async def test_a_turn_off_waits_for_an_invitation_holding_the_lock_and_then_revokes_it(
    client, capsys, db_session_factory
):
    cast, gid, _, _ = await _race_world(client, capsys, db_session_factory)
    host_person = await _person_id(db_session_factory, MEMBER)
    async with db_session_factory() as competitor:
        await competitor.execute(select(Gathering).where(Gathering.id == UUID(gid)).with_for_update())
        competitor.add(_pending(gid, "late@example.com", host_person))
        await competitor.flush()
        route = asyncio.create_task(_turn(client, cast.admin, gid, False))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
        response = await route
    assert seen == "waiting", f"the turn-off never took its turn behind the invitation ({seen})"
    assert response.status_code == 200, response.text
    assert await _pending_rows(db_session_factory, gid) == {OUTSIDER: (False, True), "late@example.com": (False, True)}


async def test_an_invitation_after_a_committed_turn_off_is_members_only(client, capsys, db_session_factory, monkeypatch):
    """The turn-off commits after the route has loaded the gathering (read
    while on) and before it reads the setting under the lock: the
    invitation is the 409 `members_only`, nothing written or sent."""
    cast, gid, _, _ = await _race_world(client, capsys, db_session_factory)

    async def competitor() -> None:
        async with db_session_factory() as db:
            await _turn_off_by_hand(db, gid)
            await db.commit()

    # Keyed on the statement that reads the setting, BEFORE it runs — the
    # loader is `db.get`, which no execute hook sees — and never on its lock
    # clause (the CK-83a Gotcha's rule (3)).
    staged = _stage(
        monkeypatch,
        when=_select_from("gatherings", containing="outside_invitations_since"),
        competitor=competitor,
        before=True,
    )
    capsys.readouterr()
    response = await _invite(client, cast.member, gid, "late@example.com")
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == MEMBERS_ONLY
    assert "late@example.com" not in await _pending_rows(db_session_factory, gid)
    assert INVITE_LINK_RE.search(capsys.readouterr().out) is None


async def test_an_invitation_waits_for_a_turn_off_holding_the_lock_and_is_members_only(
    client, capsys, db_session_factory
):
    cast, gid, _, _ = await _race_world(client, capsys, db_session_factory)
    capsys.readouterr()
    async with db_session_factory() as competitor:
        await competitor.execute(select(Gathering).where(Gathering.id == UUID(gid)).with_for_update())
        route = asyncio.create_task(_invite(client, cast.member, gid, "late@example.com"))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await _turn_off_by_hand(competitor, gid)
            await competitor.commit()
        response = await route
    assert seen == "waiting", f"the invitation never took its turn behind the turn-off ({seen})"
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == MEMBERS_ONLY
    assert "late@example.com" not in await _pending_rows(db_session_factory, gid)
    assert INVITE_LINK_RE.search(capsys.readouterr().out) is None


# --- the verifier ------------------------------------------------------------------


async def test_the_verifier_asserts_the_shape_and_the_outsider_invariants(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    opened = await _create_in_group(client, cast.member, cast.group_id, title="Opened")
    closed = await _create_in_group(client, cast.member, cast.group_id, title="Closed")
    await _on(client, cast.admin, opened["id"])
    await _let_in(client, capsys, cast.member, opened["id"], OUTSIDER)
    await _invite_token(client, capsys, cast.member, opened["id"], "waiting@example.com")
    assert (await _dismiss(client, cast.co_admin, opened["id"])).status_code == 204
    stranger_person = await _person_id(db_session_factory, STRANGER)
    admin_person = await _person_id(db_session_factory, ADMIN)
    member_person = await _person_id(db_session_factory, MEMBER)

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    for line in (
        "gatherings.outside_invitations_since is nullable",
        "gatherings.outside_invitations_by_person_id is nullable",
        "gatherings.outside_invitations_by_person_id references people",
        "gatherings.outside_invitations_by_person_id has no delete rule",
        "CHECK ck_gatherings_outside_invitations_both_or_neither exists",
        "CHECK ck_gatherings_outside_invitations_need_group exists",
        "gathering_invitations.from_outside is NOT NULL",
        "gathering_invitations.from_outside is boolean",
        "gathering_invitations.from_outside defaults to false",
        "table gathering_outside_alert_dismissals exists",
        "gathering_outside_alert_dismissals.gathering_id is NOT NULL",
        "gathering_outside_alert_dismissals.person_id is NOT NULL",
        "gathering_outside_alert_dismissals.dismissed_at is NOT NULL",
        "gathering_outside_alert_dismissals primary key is (gathering_id, person_id)",
        "gathering_outside_alert_dismissals.gathering_id references gatherings",
        "gathering_outside_alert_dismissals.gathering_id has no delete rule",
        "gathering_outside_alert_dismissals.person_id references people",
        "gathering_outside_alert_dismissals.person_id has no delete rule",
        ON_ONLY_LINE,
        NOT_A_MEMBER_LINE,
        LIVE_PENDING_LINE,
        ONE_PLACE_LINE,
    ):
        assert any(row.startswith(f"PASS  {line}") for row in out.splitlines()), line
    assert "INFO  gathering_outside_alert_dismissals rows: 1" in out

    async def plant(label: str, sql: str, undo: str, params: dict) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), params)
            await db.commit()
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 1, 1, 1), out
        assert f"FAIL  {label}" in out, out
        async with db_session_factory() as db:
            await db.execute(text(undo), params)
            await db.commit()
        assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # (1) An outsider's row on a gathering whose outside invitations are off.
    await plant(
        ON_ONLY_LINE,
        "INSERT INTO gathering_invitations (gathering_id, person_id, invited_by_person_id, from_outside) "
        "VALUES (:g, :p, :m, true)",
        "DELETE FROM gathering_invitations WHERE gathering_id = :g AND person_id = :p",
        {"g": UUID(closed["id"]), "p": stranger_person, "m": member_person},
    )
    # (2) A member's row marked from outside.
    await plant(
        NOT_A_MEMBER_LINE,
        "UPDATE gathering_invitations SET from_outside = true WHERE gathering_id = :g AND person_id = :p",
        "UPDATE gathering_invitations SET from_outside = false WHERE gathering_id = :g AND person_id = :p",
        {"g": UUID(opened["id"]), "p": admin_person},
    )
    # (3) A live pending invitation on a group's gathering that is off.
    await plant(
        LIVE_PENDING_LINE,
        "INSERT INTO gathering_invitations_pending "
        "(gathering_id, channel, destination, token_hash, expires_at, invited_by_person_id) "
        "VALUES (:g, 'EMAIL', 'planted@example.com', 'planted-hash', now() + interval '1 day', :m)",
        "DELETE FROM gathering_invitations_pending WHERE gathering_id = :g",
        {"g": UUID(closed["id"]), "m": member_person},
    )


# --- the round trip ----------------------------------------------------------------


async def test_0037_round_trip_with_outsiders_in_place(client, capsys, db_session_factory, at_head_afterwards):
    world = await _world(client, capsys, db_session_factory)
    gid = world.gathering_id
    await _on(client, world.cast.admin, gid)
    await _let_in(client, capsys, world.cast.member, gid, OUTSIDER)
    assert (await _dismiss(client, world.invitee, gid)).status_code == 204

    async def shape() -> tuple[str, set[str], bool]:
        async with db_session_factory() as db:
            head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
            columns = set(
                (
                    await db.execute(
                        text(
                            "SELECT table_name || '.' || column_name FROM information_schema.columns "
                            "WHERE column_name IN ('outside_invitations_since', 'outside_invitations_by_person_id', "
                            "'from_outside')"
                        )
                    )
                ).scalars()
            )
            table = (
                await db.scalar(
                    text("SELECT count(*) FROM information_schema.tables WHERE table_name = 'gathering_outside_alert_dismissals'")
                )
            ) == 1
        return head, columns, table

    new_columns = {
        "gatherings.outside_invitations_since",
        "gatherings.outside_invitations_by_person_id",
        "gathering_invitations.from_outside",
    }
    assert await shape() == ("0037", new_columns, True)
    await _migrate("downgrade", "0036", capsys)
    assert await shape() == ("0036", set(), False)
    await _migrate("upgrade", "head", capsys)
    assert await shape() == ("0037", new_columns, True)
    # Nothing backfilled: every gathering off, every row false, no dismissal.
    assert (await _setting(db_session_factory, gid))[:2] == (None, None)
    assert set((await _outside_rows(db_session_factory, gid)).values()) == {False}
    assert await _dismissals(db_session_factory, gid) == {}


# --- nothing logged ----------------------------------------------------------------


async def test_the_new_routes_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    world = await _world(client, capsys, db_session_factory)
    cast, gid = world.cast, world.gathering_id
    outsider = await _signed_in_headers(client, capsys, OUTSIDER)
    assert not hasattr(gatherings_api, "logger") and not hasattr(invitations_api, "logger")
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        await _on(client, cast.admin, gid)
        token = await _invite_token(client, capsys, cast.member, gid, OUTSIDER)
        assert (await _accept(client, outsider, token)).json()["status"] == "accepted"
        assert (await _preview(client, cast.member, gid)).status_code == 200
        assert (await _dismiss(client, cast.member, gid)).status_code == 204
        assert (await _turn(client, cast.stranger, gid, False)).status_code == 404
        await _off(client, cast.co_admin, gid)
    application = [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]
    assert application == []
