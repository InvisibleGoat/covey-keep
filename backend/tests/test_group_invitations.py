"""CK-75 — emailed invitations to a group
(decisions/2026-10-23-joining-a-group-and-co-admins.md §2; api/group_invitations.py).
CK-25's own tests re-pointed at the group where they apply: management is
the organisers' (a co-admin invites; a member and a stranger draw the group
404 byte-identical to a missing id); `SMS` is the CK-25 422 word for word;
supersession, revocation and the tally surviving both; acceptance routes
through the SESSION — a brand-new invitee has a person, an accounts row and
a tos_acceptances row afterwards — and creates the MEMBERSHIP, consumes the
token, and closes an open join request by the same person as `approved` by
nobody; `already_accepted` and every dead-token state distinguished; the
reaper wired; creation never looking the destination up in `people`.
"""

import re
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import func, select, text

from app.api.group_invitations import (
    MAX_GROUP_INVITATIONS_PER_INVITER,
    MAX_INVITATIONS_PER_GROUP,
)
from app.api.invitations import (
    INVITATION_TTL,
    MAX_INVITATIONS_PER_GATHERING,
    MAX_INVITATIONS_PER_INVITER,
)
from app.models import (
    Account,
    GroupInvitationPending,
    GroupJoinRequest,
    Membership,
    Person,
    TosAcceptance,
)
from app.security import hash_token
from app.services.retention import PURGE_GRACE
from app.brand import PRODUCT_NAME
from tests.test_gatherings import _create as _create_gathering
from tests.test_gatherings import _field_errors, _signed_in_headers
from tests.test_group_links import _join, _make, _request_rows, _token_of
from tests.test_group_membership import ADMIN, _cast, _group_404, _members, _person_id
from tests.test_groups import MISSING, _create
from tests.test_invitations import _invite as _invite_to_gathering

# The link targets the FRONTEND acceptance screen with the token in the URL
# fragment (never the query string).
INVITE_LINK_RE = re.compile(r"http://localhost:5173/groups/invitations/accept#token=([A-Za-z0-9_\-]+)")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _invite(client, headers, group_id: str, destination: str):
    return await client.post(
        f"/groups/{group_id}/invitations",
        json={"channel": "EMAIL", "destination": destination},
        headers=headers,
    )


async def _invite_token(client, capsys, headers, group_id: str, destination: str) -> str:
    capsys.readouterr()  # drop anything buffered: the link captured is THIS invite's
    response = await _invite(client, headers, group_id, destination)
    assert response.status_code == 201, response.text
    out = capsys.readouterr().out
    match = INVITE_LINK_RE.search(out)
    assert match, f"no invitation link in console output: {out!r}"
    return match.group(1)


async def _accept(client, headers, token: str) -> dict:
    response = await client.post("/group-invitations/accept", json={"token": token}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _preview(client, token: str) -> dict:
    response = await client.post("/group-invitations/preview", json={"token": token})
    assert response.status_code == 200, response.text
    return response.json()


async def _list(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/invitations", headers=headers)


async def _revoke(client, headers, group_id: str, invitation_id: str):
    return await client.delete(f"/groups/{group_id}/invitations/{invitation_id}", headers=headers)


async def _rows(db_session_factory) -> list[GroupInvitationPending]:
    async with db_session_factory() as db:
        return (
            await db.scalars(select(GroupInvitationPending).order_by(GroupInvitationPending.created_at))
        ).all()


def test_the_group_limits_are_ck25s_values_and_the_ttl_exceeds_the_window():
    # The group router's own names, bound to CK-25's values (the two surfaces
    # cannot drift apart silently); the link's lifetime is the invitation's.
    assert MAX_INVITATIONS_PER_GROUP == MAX_INVITATIONS_PER_GATHERING == 10
    assert MAX_GROUP_INVITATIONS_PER_INVITER == MAX_INVITATIONS_PER_INVITER == 20
    assert INVITATION_TTL > PURGE_GRACE


async def test_group_invitation_endpoints_require_auth_but_the_preview_does_not(client):
    body = {"channel": "EMAIL", "destination": "a@example.com"}
    assert (await client.post(f"/groups/{MISSING}/invitations", json=body)).status_code == 401
    assert (await client.get(f"/groups/{MISSING}/invitations")).status_code == 401
    assert (await client.delete(f"/groups/{MISSING}/invitations/{MISSING}")).status_code == 401
    assert (await client.post("/group-invitations/accept", json={"token": "x"})).status_code == 401
    assert await _preview(client, "x") == {"status": "invalid", "group_name": None}


async def test_management_is_the_organisers_404_not_403(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    pending_id = (await _invite(client, cast.admin, cast.group_id, "guest@example.com")).json()["id"]
    # A co-admin invites, lists and revokes.
    assert (await _invite(client, cast.co_admin, cast.group_id, "other@example.com")).status_code == 201
    assert (await _list(client, cast.co_admin, cast.group_id)).status_code == 200
    assert (await _revoke(client, cast.co_admin, cast.group_id, pending_id)).status_code == 204
    # A member and a stranger: the group 404, byte-identical to a missing id.
    for headers in (cast.member, cast.stranger):
        expected = await _group_404(client, headers)
        for response in (
            await _invite(client, headers, cast.group_id, "spam@example.com"),
            await _list(client, headers, cast.group_id),
            await _revoke(client, headers, cast.group_id, pending_id),
        ):
            assert (response.status_code, response.content) == expected
    assert len(await _rows(db_session_factory)) == 2


async def test_sms_is_refused_with_a_usable_422_and_nothing_is_written_or_sent(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    capsys.readouterr()
    response = await client.post(
        f"/groups/{cast.group_id}/invitations",
        json={"channel": "SMS", "destination": "+15555550123"},
        headers=cast.admin,
    )
    assert response.status_code == 422
    assert "channel" in _field_errors(response)
    assert response.json()["detail"][0]["msg"] == (
        "text-message invitations aren't available yet — invite by email for now"
    )
    assert "console-mode send" not in capsys.readouterr().out
    assert await _rows(db_session_factory) == []
    response = await client.post(
        f"/groups/{cast.group_id}/invitations",
        json={"channel": "CARRIER_PIGEON", "destination": "x"},
        headers=cast.admin,
    )
    assert response.status_code == 422 and "channel" in _field_errors(response)


async def test_invite_stores_the_hash_normalizes_the_destination_and_sends_the_link(
    client, capsys, db_session_factory
):
    """Only the SHA-256 hash is stored; the email carries the group's name,
    the inviter's display name and the link; a destination that already
    holds an account draws the same uniform 201 and no lookup (the people
    count is untouched — creation never looks the destination up)."""
    cast = await _cast(client, capsys, db_session_factory)
    inviter_name = (await client.get("/auth/me", headers=cast.admin)).json()["display_name"]
    capsys.readouterr()
    async with db_session_factory() as db:
        people_before = await db.scalar(select(func.count()).select_from(Person))

    response = await _invite(client, cast.admin, cast.group_id, "  Guest@Example.COM ")
    assert response.status_code == 201, response.text
    assert response.json()["destination"] == "guest@example.com"
    assert set(response.json()) == {"id", "channel", "destination", "created_at", "expires_at"}
    out = capsys.readouterr().out
    assert "to=guest@example.com" in out
    assert "Finch family" in out and inviter_name in out
    assert PRODUCT_NAME in out
    match = INVITE_LINK_RE.search(out)
    assert match, out
    raw_token = match.group(1)
    (row,) = await _rows(db_session_factory)
    assert row.token_hash == hash_token(raw_token) and raw_token not in row.token_hash
    assert row.group_id == UUID(cast.group_id)
    assert row.invited_by_person_id == await _person_id(db_session_factory, ADMIN)
    assert row.consumed_at is None and row.revoked_at is None
    assert INVITATION_TTL - timedelta(minutes=5) <= row.expires_at - row.created_at <= INVITATION_TTL + timedelta(minutes=5)

    # An address that already has an account — the stranger's — draws the
    # same 201, and nobody was looked up or created.
    assert (await _invite(client, cast.admin, cast.group_id, "stranger@example.com")).status_code == 201
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(Person)) == people_before


async def test_reinvite_supersedes_never_deletes_and_the_limits_count_superseded_and_revoked_rows(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    token_1 = await _invite_token(client, capsys, cast.admin, cast.group_id, "guest@example.com")
    token_2 = await _invite_token(client, capsys, cast.admin, cast.group_id, "guest@example.com")
    assert token_1 != token_2
    rows = await _rows(db_session_factory)
    assert len(rows) == 2 and rows[0].revoked_at is not None and rows[0].expires_at <= _now()
    assert rows[1].revoked_at is None
    guest = await _signed_in_headers(client, capsys, "guest@example.com")
    assert (await _accept(client, guest, token_1))["status"] == "revoked"
    assert await _accept(client, guest, token_2) == {"status": "accepted", "group_id": cast.group_id}

    # Per group: every re-invite superseded the last, one live row at most,
    # and the tally still trips.
    for _ in range(MAX_INVITATIONS_PER_GROUP - 2):
        assert (await _invite(client, cast.admin, cast.group_id, "victim@example.com")).status_code == 201
    assert (await _invite(client, cast.admin, cast.group_id, "victim@example.com")).status_code == 429

    # Per inviter, across groups, surviving revocation — and counting GROUP
    # rows alone: a gathering invitation by the same person is its own tally.
    # (Half the inviter's cap on each of two groups, under the per-group cap
    # — CK-25's shape — and the twenty-first on a third group is refused.)
    second = (await _create(client, cast.co_admin, name="Second"))["id"]
    third = (await _create(client, cast.co_admin, name="Third"))["id"]
    fourth_of_theirs = (await _create(client, cast.co_admin, name="Fourth of theirs"))["id"]
    pending_ids = []
    per_group = MAX_GROUP_INVITATIONS_PER_INVITER // 2
    assert per_group <= MAX_INVITATIONS_PER_GROUP
    for group_id in (second, third):
        for n in range(per_group):
            response = await _invite(client, cast.co_admin, group_id, f"guest{n}@example.com")
            assert response.status_code == 201, response.text
            pending_ids.append(response.json()["id"])
    assert (await _invite(client, cast.co_admin, fourth_of_theirs, "one-more@example.com")).status_code == 429
    assert (await _revoke(client, cast.co_admin, second, pending_ids[0])).status_code == 204
    assert (await _invite(client, cast.co_admin, fourth_of_theirs, "one-more@example.com")).status_code == 429
    # The admin's inviter tally is ten (the group above is at its own
    # limit); a gathering invitation by the same person is its own tally,
    # so a group invitation elsewhere still goes through.
    gathering = await _create_gathering(client, cast.admin)
    assert (await _invite_to_gathering(client, cast.admin, gathering["id"], "g@example.com")).status_code == 201
    fourth = (await _create(client, cast.admin, name="Fourth"))["id"]
    assert (await _invite(client, cast.admin, fourth, "another@example.com")).status_code == 201


async def test_accept_as_new_person_creates_the_membership_and_closes_an_open_request(
    client, capsys, db_session_factory
):
    """THE regression test for the create-a-person-outside-/auth/verify trap,
    re-pointed: the invitee did not exist, and after acceptance they hold a
    person row, an accounts row AND a tos_acceptances row — because sign-in
    went through /auth/verify — plus a membership; the pending row is
    consumed; and the open join request they had made through the link is
    closed as `approved` by nobody."""
    cast = await _cast(client, capsys, db_session_factory)
    link_token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    token = await _invite_token(client, capsys, cast.admin, cast.group_id, "newcomer@example.com")
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(Person).where(Person.email == "newcomer@example.com"))
        ) == 0
    assert (await client.get(f"/groups/{cast.group_id}", headers=cast.stranger)).status_code == 404

    invitee = await _signed_in_headers(client, capsys, "newcomer@example.com")
    assert (await _join(client, invitee, link_token)).json()["status"] == "requested"
    result = await _accept(client, invitee, token)
    assert result == {"status": "accepted", "group_id": cast.group_id}

    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == "newcomer@example.com"))).scalars().one()
        account = (await db.execute(select(Account).where(Account.id == person.account_id))).scalars().one()
        assert account.kind.value == "PERSON"
        assert len((await db.scalars(select(TosAcceptance).where(TosAcceptance.person_id == person.id))).all()) == 1
        membership = (
            await db.execute(
                select(Membership).where(Membership.group_id == UUID(cast.group_id), Membership.person_id == person.id)
            )
        ).scalars().one()
        assert membership.household_id is None and membership.sub_group_id is None and membership.role_id is None
        (pending,) = (await db.scalars(select(GroupInvitationPending))).all()
        assert pending.consumed_at is not None
        (request,) = (await db.scalars(select(GroupJoinRequest))).all()
        assert request.decided_at is not None and request.outcome.value == "approved"
        assert request.decided_by_person_id is None
    assert (await client.get(f"/groups/{cast.group_id}", headers=invitee)).json()["caller_role"] == "member"
    assert "newcomer" in [e["display_name"] for e in (await _members(client, invitee, cast.group_id)).json()["members"]]
    assert (await _request_rows(db_session_factory, cast.group_id))[0].decided_by_person_id is None


async def test_accept_is_idempotent_and_dead_tokens_are_distinguished(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    guest = await _signed_in_headers(client, capsys, "guest@example.com")
    token = await _invite_token(client, capsys, cast.admin, cast.group_id, "guest@example.com")
    assert (await _accept(client, guest, token))["status"] == "accepted"
    assert await _accept(client, guest, token) == {"status": "already_accepted", "group_id": cast.group_id}
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(Membership).where(Membership.group_id == UUID(cast.group_id)))
        ) == 4
    # A member already (the cast's member) accepting a second invitation:
    # already_accepted, the token still consumed.
    token_member = await _invite_token(client, capsys, cast.admin, cast.group_id, "member@example.com")
    assert await _accept(client, cast.member, token_member) == {"status": "already_accepted", "group_id": cast.group_id}
    # Consumed by someone else: spent, pointing nowhere.
    other = await _signed_in_headers(client, capsys, "other@example.com")
    assert await _accept(client, other, token) == {"status": "used", "group_id": None}
    # Expired.
    expired = await _invite_token(client, capsys, cast.admin, cast.group_id, "late@example.com")
    async with db_session_factory() as db:
        row = (
            await db.execute(select(GroupInvitationPending).where(GroupInvitationPending.token_hash == hash_token(expired)))
        ).scalars().one()
        row.expires_at = _now() - timedelta(minutes=1)
        await db.commit()
    assert (await _accept(client, other, expired))["status"] == "expired"
    # Revoked.
    revoked = await _invite(client, cast.admin, cast.group_id, "withdrawn@example.com")
    revoked_token = INVITE_LINK_RE.search(capsys.readouterr().out).group(1)
    assert (await _revoke(client, cast.admin, cast.group_id, revoked.json()["id"])).status_code == 204
    assert (await _accept(client, other, revoked_token))["status"] == "revoked"
    # Garbage.
    assert (await _accept(client, other, "not-a-token"))["status"] == "invalid"
    async with db_session_factory() as db:
        consumed = (await db.scalars(select(GroupInvitationPending.consumed_at))).all()
        assert sum(1 for c in consumed if c is not None) == 2


async def test_the_list_is_pending_only_and_revoke_is_idempotent(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    waiting = (await _invite(client, cast.admin, cast.group_id, "waiting@example.com")).json()
    token = await _invite_token(client, capsys, cast.admin, cast.group_id, "joiner@example.com")
    joiner = await _signed_in_headers(client, capsys, "joiner@example.com")
    await _accept(client, joiner, token)

    listed = await _list(client, cast.admin, cast.group_id)
    assert listed.status_code == 200
    assert set(listed.json()) == {"pending"}
    assert [p["destination"] for p in listed.json()["pending"]] == ["waiting@example.com"]
    assert set(listed.json()["pending"][0]) == {"id", "channel", "destination", "created_at", "expires_at"}
    # The accepted person is on the member list, by display name.
    assert "joiner" in [e["display_name"] for e in (await _members(client, cast.admin, cast.group_id)).json()["members"]]

    assert (await _revoke(client, cast.admin, cast.group_id, waiting["id"])).status_code == 204
    rows = await _rows(db_session_factory)
    revoked_row = next(r for r in rows if r.destination == "waiting@example.com")
    assert revoked_row.revoked_at is not None and revoked_row.expires_at <= _now()
    assert (await _revoke(client, cast.admin, cast.group_id, waiting["id"])).status_code == 204
    assert len(await _rows(db_session_factory)) == 2
    # A consumed invitation is not pending: the uniform 404; and another
    # group's id, from a group the admin organises, is the same 404.
    consumed_row = next(r for r in rows if r.destination == "joiner@example.com")
    assert (await _revoke(client, cast.admin, cast.group_id, str(consumed_row.id))).status_code == 404
    other = (await _create(client, cast.admin, name="Other"))["id"]
    assert (await _revoke(client, cast.admin, other, waiting["id"])).status_code == 404
    assert (await _revoke(client, cast.admin, cast.group_id, MISSING)).status_code == 404


async def test_preview_is_unauthenticated_and_distinguishes_states(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    token = await _invite_token(client, capsys, cast.admin, cast.group_id, "curious@example.com")
    assert await _preview(client, token) == {"status": "valid", "group_name": "Finch family"}
    async with db_session_factory() as db:
        row = (await db.execute(select(GroupInvitationPending))).scalars().one()
        row.expires_at = _now() - timedelta(minutes=1)
        await db.commit()
    assert await _preview(client, token) == {"status": "expired", "group_name": None}
    async with db_session_factory() as db:
        row = (await db.execute(select(GroupInvitationPending))).scalars().one()
        row.expires_at = _now() + timedelta(days=1)
        await db.commit()
    curious = await _signed_in_headers(client, capsys, "curious@example.com")
    await _accept(client, curious, token)
    assert await _preview(client, token) == {"status": "used", "group_name": None}
    revoked = await _invite(client, cast.admin, cast.group_id, "second@example.com")
    revoked_token = INVITE_LINK_RE.search(capsys.readouterr().out).group(1)
    await _revoke(client, cast.admin, cast.group_id, revoked.json()["id"])
    assert await _preview(client, revoked_token) == {"status": "revoked", "group_name": None}
    assert await _preview(client, "garbage") == {"status": "invalid", "group_name": None}


async def test_the_reaper_purges_stale_pending_rows_and_spares_recent_ones(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    await _invite(client, cast.admin, cast.group_id, "stale@example.com")
    token = await _invite_token(client, capsys, cast.admin, cast.group_id, "fresh@example.com")
    fresh = await _signed_in_headers(client, capsys, "fresh@example.com")
    await _accept(client, fresh, token)
    async with db_session_factory() as db:
        stale = (
            await db.execute(select(GroupInvitationPending).where(GroupInvitationPending.destination == "stale@example.com"))
        ).scalars().one()
        stale.expires_at = _now() - PURGE_GRACE - timedelta(minutes=1)
        await db.commit()
    assert (await _invite(client, cast.admin, cast.group_id, "another@example.com")).status_code == 201
    destinations = {r.destination for r in await _rows(db_session_factory)}
    assert "stale@example.com" not in destinations
    assert {"fresh@example.com", "another@example.com"} <= destinations
