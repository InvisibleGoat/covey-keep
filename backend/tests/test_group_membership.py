"""CK-75 — Groups 1: the member list, co-admins, leaving, removal and handing
over; the keeper written at creation and backfilled once; the deletion leg's
succession (decisions/2026-10-23-joining-a-group-and-co-admins.md §5–§8;
migration 0032). Joining through the link is tests/test_group_links.py; the
emailed invitation is tests/test_group_invitations.py; both import this
file's cast.

The cast: an ADMIN who created the group through the API, a CO-ADMIN and a
MEMBER whose membership rows are planted directly (membership of anyone but
the creator had no surface before this phase; the two ways in are pinned in
the sibling files) — the co-admin appointed THROUGH THE API — and a
STRANGER. Every seat is signed in; no network anywhere.

The load-bearing pins:
- creation writes `keeper_account_id` (the fact nothing wrote from 0022 to
  CK-75) and NOTHING here moves it — not a rename, an appointment, a
  hand-over, a leave or a removal (record §7);
- every body carries `caller_role` and no `backup_admin_person_id`;
  `member_count` and the member list exclude an anonymized person, whose
  row stays;
- the helper pair classifies every check: appointing and removing
  co-admins and handing over are the ADMIN's alone (a co-admin, a member
  and a stranger draw the group 404 byte-identical to a missing id);
  renaming and removing ordinary members are the admin's OR a co-admin's;
  the member list and leaving are any member's;
- every 422 code, each refusal writing nothing; a co-admin steps down and
  cannot remove another; the admin's leave is refused with
  `hand_over_first` until the hand-over, after which the former admin is
  an ordinary member; the only member leaves and the group stays empty;
- account deletion promotes the LONGEST-SERVING co-admin (earliest
  created_at, then person_id), NULLs the admin with none, deletes the
  person's co-admin rows and OPEN join requests, keeps memberships;
- THE 0032 ROUND TRIP against four planted subjects, the INFO line verbatim,
  the backfilled keepers surviving the downgrade;
- the verifier's new lines, fired by a plant each and by nothing else.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import event, func, select, text

from app.api import groups as groups_api
from app.api.groups import (
    ACCOUNT_DELETED,
    ALREADY_CO_ADMIN,
    HAND_OVER_FIRST,
    IS_ADMIN,
    NOT_A_MEMBER,
)
from app.db import engine
from app.models import Group, GroupCoAdmin, GroupJoinRequest, JoinRequestOutcome, Membership, Person
from tests.test_account_deletion import DELETE_BODY
from tests.test_destruction import _verifier
from tests.test_gatherings import _account_for
from tests.test_groups import BODY_KEYS, MISSING, _create, _signed_in_headers
from tests.test_photo_count import _migrate, at_head_afterwards  # noqa: F401 — the fixture

ADMIN = "admin@example.com"
CO_ADMIN = "coadmin@example.com"
MEMBER = "member@example.com"
STRANGER = "stranger@example.com"

ENTRY_KEYS = {"membership_id", "display_name", "role", "is_self"}

# The verifier's TOTAL, pinned as a number (the CK-57 convention): 271 at
# CK-73.2, and 336 since CK-75's sixty-five lines — the four tables' shapes
# (NOT NULLs, PKs, ten FKs with no delete rule, the index, the partial
# uniques and the token-hash unique by name, the new type's labels), the
# two CHECKs, the group invitation's normalization line, and five
# invariants — with CK-45's at-least-one-membership line REPLACED by
# admin-has-membership (net zero); and 339 since CK-76's three lines —
# the index on gatherings.owning_group_id, no pending invitation on a
# gathering that belongs to a group, every group gathering under a
# HOUSEHOLD group.
VERIFIER_TOTAL = 339


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- helpers ---------------------------------------------------------------------


async def _person_id(db_session_factory, address: str) -> UUID:
    async with db_session_factory() as db:
        return (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()


async def _add_member(db_session_factory, group_id: str, address: str) -> str:
    """A membership row planted directly — the shape the two ways in
    (an approved request, an accepted invitation) both write. Returns the
    membership id, the handle every membership act takes."""
    async with db_session_factory() as db:
        person_id = (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()
        row = Membership(group_id=UUID(group_id), person_id=person_id)
        db.add(row)
        await db.commit()
        return str(row.id)


async def _membership_id(db_session_factory, group_id: str, address: str) -> str:
    async with db_session_factory() as db:
        return str(
            (
                await db.execute(
                    select(Membership.id)
                    .join(Person, Person.id == Membership.person_id)
                    .where(Membership.group_id == UUID(group_id), Person.email == address)
                )
            ).scalar_one()
        )


async def _members(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/members", headers=headers)


async def _appoint(client, headers, group_id: str, membership_id: str):
    return await client.post(
        f"/groups/{group_id}/co-admins", json={"membership_id": membership_id}, headers=headers
    )


async def _unappoint(client, headers, group_id: str, membership_id: str):
    return await client.delete(f"/groups/{group_id}/co-admins/{membership_id}", headers=headers)


async def _leave(client, headers, group_id: str):
    return await client.post(f"/groups/{group_id}/leave", headers=headers)


async def _remove(client, headers, group_id: str, membership_id: str):
    return await client.delete(f"/groups/{group_id}/members/{membership_id}", headers=headers)


async def _hand_over(client, headers, group_id: str, membership_id: str):
    return await client.post(
        f"/groups/{group_id}/hand-over", json={"membership_id": membership_id}, headers=headers
    )


async def _detail(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}", headers=headers)


async def _group_404(client, headers) -> tuple[int, bytes]:
    """The group's 404 — what every non-organiser must draw on a reserved or
    delegable route, byte-identical to a missing id."""
    response = await _detail(client, headers, MISSING)
    assert response.status_code == 404
    return response.status_code, response.content


async def _co_admin_rows(db_session_factory, group_id: str) -> list[tuple[UUID, UUID]]:
    """(person_id, added_by_person_id) per co-admin row, in appointment order."""
    async with db_session_factory() as db:
        return [
            (row.person_id, row.added_by_person_id)
            for row in (
                await db.scalars(
                    select(GroupCoAdmin)
                    .where(GroupCoAdmin.group_id == UUID(group_id))
                    .order_by(GroupCoAdmin.created_at, GroupCoAdmin.person_id)
                )
            ).all()
        ]


async def _group_row(db_session_factory, group_id: str) -> Group:
    async with db_session_factory() as db:
        return await db.get(Group, UUID(group_id))


async def _backup_admin_column(db_session_factory, group_id: str):
    """`groups.backup_admin_person_id` for one group, by raw SQL: the column
    exists in the database and is UNMAPPED since CK-76 (nothing writes it,
    nothing reads it through the model; the verifier asserts it NULL the
    same way until CK-77 drops it)."""
    async with db_session_factory() as db:
        return await db.scalar(
            text("SELECT backup_admin_person_id FROM groups WHERE id = :g"), {"g": UUID(group_id)}
        )


async def _membership_people(db_session_factory, group_id: str) -> set[UUID]:
    async with db_session_factory() as db:
        return set(
            (
                await db.scalars(
                    select(Membership.person_id).where(Membership.group_id == UUID(group_id))
                )
            ).all()
        )


@dataclass
class Cast:
    group_id: str
    admin: dict
    co_admin: dict
    member: dict
    stranger: dict
    admin_membership: str
    co_admin_membership: str
    member_membership: str


async def _cast(client, capsys, db_session_factory) -> Cast:
    """The group with its four seats: the admin created it through the API,
    the co-admin and the member hold planted membership rows, the co-admin
    was appointed through the API, the stranger is in nothing."""
    admin = await _signed_in_headers(client, capsys, ADMIN)
    co_admin = await _signed_in_headers(client, capsys, CO_ADMIN)
    member = await _signed_in_headers(client, capsys, MEMBER)
    stranger = await _signed_in_headers(client, capsys, STRANGER)
    created = await _create(client, admin, name="Finch family")
    group_id = created["id"]
    co_admin_membership = await _add_member(db_session_factory, group_id, CO_ADMIN)
    member_membership = await _add_member(db_session_factory, group_id, MEMBER)
    admin_membership = await _membership_id(db_session_factory, group_id, ADMIN)
    response = await _appoint(client, admin, group_id, co_admin_membership)
    assert response.status_code == 201, response.text
    return Cast(
        group_id=group_id,
        admin=admin,
        co_admin=co_admin,
        member=member,
        stranger=stranger,
        admin_membership=admin_membership,
        co_admin_membership=co_admin_membership,
        member_membership=member_membership,
    )


def _code_of(response) -> str:
    assert response.status_code == 422, response.text
    (error,) = response.json()["detail"]
    assert error["loc"] == ["body", "membership_id"]
    return error["code"]


# --- auth ------------------------------------------------------------------------


async def test_membership_routes_require_auth(client):
    body = {"membership_id": MISSING}
    assert (await client.get(f"/groups/{MISSING}/members")).status_code == 401
    assert (await client.post(f"/groups/{MISSING}/co-admins", json=body)).status_code == 401
    assert (await client.delete(f"/groups/{MISSING}/co-admins/{MISSING}")).status_code == 401
    assert (await client.post(f"/groups/{MISSING}/leave")).status_code == 401
    assert (await client.delete(f"/groups/{MISSING}/members/{MISSING}")).status_code == 401
    assert (await client.post(f"/groups/{MISSING}/hand-over", json=body)).status_code == 401


# --- the keeper (record §8), and that nothing here moves it (record §7) -------------


async def test_creation_writes_the_keeper_and_a_rename_does_not_move_it(
    client, capsys, db_session_factory
):
    """`POST /groups` writes the creator's account as the keeper in the
    transaction that writes the group — the defect since 0022 fixed — and
    a rename leaves it where it is. (A hand-over, an appointment, a leave
    and a removal are pinned to leave it below, each in its own test.)"""
    headers = await _signed_in_headers(client, capsys, ADMIN)
    created = await _create(client, headers)
    async with db_session_factory() as db:
        account_id = (await _account_for(db, ADMIN)).id
    group = await _group_row(db_session_factory, created["id"])
    assert group.keeper_account_id == account_id
    assert group.admin_person_id == await _person_id(db_session_factory, ADMIN)
    assert (
        await client.patch(f"/groups/{created['id']}", json={"name": "Renamed"}, headers=headers)
    ).status_code == 200
    assert (await _group_row(db_session_factory, created["id"])).keeper_account_id == account_id


# --- bodies (record §5): caller_role, no backup column, the live count --------------


async def test_every_body_carries_caller_role_and_no_backup_column(
    client, capsys, db_session_factory
):
    """`caller_role` — `admin`, `co_admin`, `member` — on the create, detail,
    list and patch bodies, decided by the admin column and the co-admin row
    (never an account comparison); `backup_admin_person_id` on none of
    them; the list's role riding the one statement (the CK-20 pin in
    test_groups.py passes unedited)."""
    cast = await _cast(client, capsys, db_session_factory)
    for headers, role in ((cast.admin, "admin"), (cast.co_admin, "co_admin"), (cast.member, "member")):
        detail = await _detail(client, headers, cast.group_id)
        assert detail.status_code == 200, role
        assert set(detail.json()) == BODY_KEYS
        assert detail.json()["caller_role"] == role, role
        assert "backup_admin_person_id" not in detail.json()
        listed = await client.get("/groups", headers=headers)
        (item,) = [g for g in listed.json()["groups"] if g["id"] == cast.group_id]
        assert item["caller_role"] == role, role
        assert set(item) == BODY_KEYS
    # The patch body too — a co-admin renaming reads their own role.
    patched = await client.patch(f"/groups/{cast.group_id}", json={"name": "Finches"}, headers=cast.co_admin)
    assert patched.status_code == 200, patched.text
    assert patched.json()["caller_role"] == "co_admin"
    assert set(patched.json()) == BODY_KEYS
    # The retired column is still on the ROW, NULL, and in no body — read
    # by raw SQL since CK-76, because the model no longer maps it (the
    # unmap is the step before CK-77's drop; the attribute read here until
    # CK-76 would now be an AttributeError).
    assert await _backup_admin_column(db_session_factory, cast.group_id) is None


async def test_the_member_list_and_the_count_exclude_a_deleted_account_and_carry_no_contact_detail(
    client, capsys, db_session_factory
):
    """Every member reads the list; each entry is the handle, the display
    name, the role and `is_self`, in joining order; a person who deleted
    their account is ABSENT and UNCOUNTED while their membership row stays;
    no email, person id or account id anywhere in the body; ONE statement
    beyond the loader's; a stranger draws the group 404 byte-identical to
    a missing id."""
    cast = await _cast(client, capsys, db_session_factory)
    leaver = "leaver@example.com"
    leaver_headers = await _signed_in_headers(client, capsys, leaver)
    await _add_member(db_session_factory, cast.group_id, leaver)
    names = {}
    for address, headers in ((ADMIN, cast.admin), (CO_ADMIN, cast.co_admin), (MEMBER, cast.member), (leaver, leaver_headers)):
        names[address] = (await client.get("/auth/me", headers=headers)).json()["display_name"]

    before = await _members(client, cast.member, cast.group_id)
    assert before.status_code == 200, before.text
    assert [(e["display_name"], e["role"]) for e in before.json()["members"]] == [
        (names[ADMIN], "admin"),
        (names[CO_ADMIN], "co_admin"),
        (names[MEMBER], "member"),
        (names[leaver], "member"),
    ]
    assert (await _detail(client, cast.member, cast.group_id)).json()["member_count"] == 4

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=leaver_headers)).status_code == 204
    for headers, self_address in ((cast.admin, ADMIN), (cast.co_admin, CO_ADMIN), (cast.member, MEMBER)):
        listed = await _members(client, headers, cast.group_id)
        assert listed.status_code == 200
        entries = listed.json()["members"]
        assert [e["display_name"] for e in entries] == [names[ADMIN], names[CO_ADMIN], names[MEMBER]]
        assert all(set(e) == ENTRY_KEYS for e in entries)
        assert [e["is_self"] for e in entries] == [a == self_address for a in (ADMIN, CO_ADMIN, MEMBER)]
        assert {e["membership_id"] for e in entries} == {
            cast.admin_membership,
            cast.co_admin_membership,
            cast.member_membership,
        }
        body = listed.text
        for address in (ADMIN, CO_ADMIN, MEMBER, leaver):
            assert address not in body
        async with db_session_factory() as db:
            for address in (ADMIN, CO_ADMIN, MEMBER):
                assert str((await _account_for(db, address)).id) not in body
                assert str(await _person_id(db_session_factory, address)) not in body
        assert "a former member" not in body
        assert (await _detail(client, headers, cast.group_id)).json()["member_count"] == 3
    # The row stays, attributed to the anonymized person (CK-45's retention).
    assert len(await _membership_people(db_session_factory, cast.group_id)) == 4

    # A stranger: the group 404, byte-identical to a missing id.
    refused = await _members(client, cast.stranger, cast.group_id)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.stranger)

    # One statement for the list itself, however many members (the CK-20
    # pin's shape): equal counts at four and seven members, and exactly one
    # statement joining memberships to people.
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count_statements() -> int:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            assert (await _members(client, cast.admin, cast.group_id)).status_code == 200
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        return len(statements)

    at_four = await count_statements()
    for n in range(3):
        await _signed_in_headers(client, capsys, f"more{n}@example.com")
        await _add_member(db_session_factory, cast.group_id, f"more{n}@example.com")
    at_seven = await count_statements()
    assert at_seven == at_four
    assert len([s for s in statements if "FROM memberships" in s and "JOIN people" in s]) == 1


# --- co-admins (record §6) --------------------------------------------------------


async def test_appointing_a_co_admin_is_the_admins_alone_with_stable_codes_and_no_row(
    client, capsys, db_session_factory
):
    """Reserved: a co-admin, a member and a stranger each draw the group 404
    byte-identical to a missing id. The four refusals are 422s on
    `membership_id` with their code and no row: a handle naming no
    membership of THIS group (a missing id and another group's membership
    draw one code, so the refusal confirms nothing about other groups), the
    admin's own membership, someone already a co-admin, and a member whose
    account is deleted. The 201 is the member-list entry, and the row names
    the admin as provenance."""
    cast = await _cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    assert await _co_admin_rows(db_session_factory, cast.group_id) == [(co_admin_person, admin_person)]

    for headers in (cast.co_admin, cast.member, cast.stranger):
        refused = await _appoint(client, headers, cast.group_id, cast.member_membership)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)

    assert _code_of(await _appoint(client, cast.admin, cast.group_id, MISSING)) == NOT_A_MEMBER
    other = await _create(client, cast.member, name="The other family")
    elsewhere = await _membership_id(db_session_factory, other["id"], MEMBER)
    assert _code_of(await _appoint(client, cast.admin, cast.group_id, elsewhere)) == NOT_A_MEMBER
    assert _code_of(await _appoint(client, cast.admin, cast.group_id, cast.admin_membership)) == IS_ADMIN
    assert _code_of(await _appoint(client, cast.admin, cast.group_id, cast.co_admin_membership)) == ALREADY_CO_ADMIN
    gone = "gone@example.com"
    gone_headers = await _signed_in_headers(client, capsys, gone)
    gone_membership = await _add_member(db_session_factory, cast.group_id, gone)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    assert _code_of(await _appoint(client, cast.admin, cast.group_id, gone_membership)) == ACCOUNT_DELETED
    assert await _co_admin_rows(db_session_factory, cast.group_id) == [(co_admin_person, admin_person)]

    # The 201: the entry shape, `is_self` false, no contact detail.
    member_name = (await client.get("/auth/me", headers=cast.member)).json()["display_name"]
    added = await _appoint(client, cast.admin, cast.group_id, cast.member_membership)
    assert added.status_code == 201, added.text
    assert added.json() == {
        "membership_id": cast.member_membership,
        "display_name": member_name,
        "role": "co_admin",
        "is_self": False,
    }
    assert MEMBER not in added.text
    assert (await _detail(client, cast.member, cast.group_id)).json()["caller_role"] == "co_admin"
    # The keeper did not move with an appointment.
    async with db_session_factory() as db:
        assert (await _group_row(db_session_factory, cast.group_id)).keeper_account_id == (
            await _account_for(db, ADMIN)
        ).id


async def test_the_admin_removes_a_co_admin_a_co_admin_steps_down_and_cannot_remove_another(
    client, capsys, db_session_factory
):
    """Two co-admins. The admin removes one: 204, the row gone, the role
    `member`, the next reserved-or-delegable act refused — and idempotent
    (a second remove, and a member who never was a co-admin, are 204s; a
    handle naming no membership of this group is the member 404). A
    co-admin steps down from their own row: 204, role `member`. A co-admin
    naming ANOTHER — co-admin or not — draws the group 404, hidden. An
    ordinary member and a stranger draw the group 404 on everything."""
    cast = await _cast(client, capsys, db_session_factory)
    assert (await _appoint(client, cast.admin, cast.group_id, cast.member_membership)).status_code == 201
    assert len(await _co_admin_rows(db_session_factory, cast.group_id)) == 2

    # A co-host naming the other co-host, or the admin's membership: hidden.
    for membership_id in (cast.member_membership, cast.admin_membership, MISSING):
        refused = await _unappoint(client, cast.co_admin, cast.group_id, membership_id)
        assert (refused.status_code, refused.content) == await _group_404(client, cast.co_admin), membership_id
    assert len(await _co_admin_rows(db_session_factory, cast.group_id)) == 2
    # An ordinary member and a stranger.
    stranger_404 = await _group_404(client, cast.stranger)
    refused = await _unappoint(client, cast.stranger, cast.group_id, cast.co_admin_membership)
    assert (refused.status_code, refused.content) == stranger_404

    # The admin removes the second co-admin.
    assert (await _unappoint(client, cast.admin, cast.group_id, cast.member_membership)).status_code == 204
    assert [p for p, _ in await _co_admin_rows(db_session_factory, cast.group_id)] == [
        await _person_id(db_session_factory, CO_ADMIN)
    ]
    assert (await _detail(client, cast.member, cast.group_id)).json()["caller_role"] == "member"
    refused = await client.patch(f"/groups/{cast.group_id}", json={"name": "Hijacked"}, headers=cast.member)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.member)
    # Idempotent for the admin; a foreign handle is the member 404.
    assert (await _unappoint(client, cast.admin, cast.group_id, cast.member_membership)).status_code == 204
    assert (await _unappoint(client, cast.admin, cast.group_id, MISSING)).status_code == 404
    assert (await _unappoint(client, cast.admin, cast.group_id, MISSING)).json() == {"detail": "No such member."}

    # The remaining co-admin steps down — their own row alone.
    assert (await _unappoint(client, cast.co_admin, cast.group_id, cast.co_admin_membership)).status_code == 204
    assert await _co_admin_rows(db_session_factory, cast.group_id) == []
    assert (await _detail(client, cast.co_admin, cast.group_id)).json()["caller_role"] == "member"
    # Still a member: the list still carries them, and the membership stands.
    assert {e["membership_id"] for e in (await _members(client, cast.co_admin, cast.group_id)).json()["members"]} == {
        cast.admin_membership,
        cast.co_admin_membership,
        cast.member_membership,
    }


async def test_renaming_is_delegable_and_an_ordinary_member_is_refused(
    client, capsys, db_session_factory
):
    """The admin renames; a co-admin renames (stamping updated_at as any
    rename does); an ordinary member and a stranger draw the group 404
    byte-identical to a missing id, and nothing moves."""
    cast = await _cast(client, capsys, db_session_factory)
    renamed = await client.patch(f"/groups/{cast.group_id}", json={"name": "By the co-admin"}, headers=cast.co_admin)
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "By the co-admin" and renamed.json()["updated_at"] is not None
    for headers in (cast.member, cast.stranger):
        refused = await client.patch(f"/groups/{cast.group_id}", json={"name": "Taken"}, headers=headers)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)
    assert (await _group_row(db_session_factory, cast.group_id)).name == "By the co-admin"


# --- leaving, removal, handing over (record §7) -----------------------------------


async def test_leaving_deletes_the_membership_and_the_admin_hands_over_first(
    client, capsys, db_session_factory
):
    """A member leaves: the membership row gone, the group a 404 to them
    afterwards. A co-admin leaves: the co-admin row goes with the
    membership. THE ADMIN with any other live member is refused with the
    409 `hand_over_first` and nothing changes; after handing over, the
    former admin — an ordinary member — leaves. An admin whose only other
    members are anonymized just leaves: membership gone, `admin_person_id`
    NULL, the group row standing with nobody in it. A stranger draws the
    group 404. The keeper never moves."""
    cast = await _cast(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        keeper = (await _account_for(db, ADMIN)).id
    stranger_404 = await _group_404(client, cast.stranger)
    refused = await _leave(client, cast.stranger, cast.group_id)
    assert (refused.status_code, refused.content) == stranger_404

    # The admin, with two other live members: hand over first.
    refused = await _leave(client, cast.admin, cast.group_id)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == HAND_OVER_FIRST
    group = await _group_row(db_session_factory, cast.group_id)
    assert group.admin_person_id == await _person_id(db_session_factory, ADMIN)
    assert len(await _membership_people(db_session_factory, cast.group_id)) == 3

    # The member leaves.
    assert (await _leave(client, cast.member, cast.group_id)).status_code == 204
    assert (await _detail(client, cast.member, cast.group_id)).status_code == 404
    assert await _person_id(db_session_factory, MEMBER) not in await _membership_people(db_session_factory, cast.group_id)
    # Leaving twice: not a member any more — the group 404.
    refused = await _leave(client, cast.member, cast.group_id)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.member)

    # The admin hands over to the co-admin, then leaves as an ordinary member.
    handed = await _hand_over(client, cast.admin, cast.group_id, cast.co_admin_membership)
    assert handed.status_code == 200, handed.text
    assert (await _leave(client, cast.admin, cast.group_id)).status_code == 204
    assert await _membership_people(db_session_factory, cast.group_id) == {
        await _person_id(db_session_factory, CO_ADMIN)
    }
    assert (await _group_row(db_session_factory, cast.group_id)).keeper_account_id == keeper

    # The new admin, now the only member — beside one anonymized member,
    # who counts for nothing: just leaves.
    gone = "gone@example.com"
    gone_headers = await _signed_in_headers(client, capsys, gone)
    await _add_member(db_session_factory, cast.group_id, gone)
    gone_person = await _person_id(db_session_factory, gone)  # before the email goes
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    assert (await _leave(client, cast.co_admin, cast.group_id)).status_code == 204
    group = await _group_row(db_session_factory, cast.group_id)
    assert group.admin_person_id is None
    assert group.keeper_account_id == keeper
    assert group.updated_at is None
    assert await _membership_people(db_session_factory, cast.group_id) == {gone_person}
    assert await _co_admin_rows(db_session_factory, cast.group_id) == []
    # Nobody can read it now; the row stands (the abandoned state).
    for headers in (cast.admin, cast.co_admin, cast.member):
        assert (await _detail(client, headers, cast.group_id)).status_code == 404


async def test_the_admin_removes_anyone_but_themselves_and_a_co_admin_an_ordinary_member_only(
    client, capsys, db_session_factory
):
    """The admin removes a member and a co-admin (the co-admin row goes
    with the membership); naming their OWN membership draws the member 404
    (the leave route's). A co-admin removes an ordinary member; naming the
    admin or another co-admin draws the member 404, hidden. An ordinary
    member and a stranger draw the group 404. A handle naming no membership
    of this group is the member 404. The keeper never moves."""
    cast = await _cast(client, capsys, db_session_factory)
    second_co = "second@example.com"
    second_co_headers = await _signed_in_headers(client, capsys, second_co)
    second_co_membership = await _add_member(db_session_factory, cast.group_id, second_co)
    assert (await _appoint(client, cast.admin, cast.group_id, second_co_membership)).status_code == 201
    extra = "extra@example.com"
    await _signed_in_headers(client, capsys, extra)
    extra_membership = await _add_member(db_session_factory, cast.group_id, extra)
    member_404 = {"detail": "No such member."}

    # An ordinary member and a stranger: the group 404 on the route.
    for headers in (cast.member, cast.stranger):
        refused = await _remove(client, headers, cast.group_id, extra_membership)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)

    # A co-admin: the admin and the other co-admin are hidden; their own is
    # the leave route's; a member goes.
    for membership_id in (cast.admin_membership, second_co_membership, cast.co_admin_membership, MISSING):
        refused = await _remove(client, cast.co_admin, cast.group_id, membership_id)
        assert (refused.status_code, refused.json()) == (404, member_404), membership_id
    assert (await _remove(client, cast.co_admin, cast.group_id, extra_membership)).status_code == 204
    assert await _person_id(db_session_factory, extra) not in await _membership_people(db_session_factory, cast.group_id)

    # The admin: their own membership is the leave route's; everyone else goes.
    refused = await _remove(client, cast.admin, cast.group_id, cast.admin_membership)
    assert (refused.status_code, refused.json()) == (404, member_404)
    assert (await _remove(client, cast.admin, cast.group_id, MISSING)).status_code == 404
    assert (await _remove(client, cast.admin, cast.group_id, second_co_membership)).status_code == 204
    assert (await _remove(client, cast.admin, cast.group_id, cast.member_membership)).status_code == 204
    assert await _membership_people(db_session_factory, cast.group_id) == {
        await _person_id(db_session_factory, ADMIN),
        await _person_id(db_session_factory, CO_ADMIN),
    }
    assert [p for p, _ in await _co_admin_rows(db_session_factory, cast.group_id)] == [
        await _person_id(db_session_factory, CO_ADMIN)
    ]
    assert (await _detail(client, second_co_headers, cast.group_id)).status_code == 404
    async with db_session_factory() as db:
        assert (await _group_row(db_session_factory, cast.group_id)).keeper_account_id == (
            await _account_for(db, ADMIN)
        ).id


async def test_handing_over_is_immediate_the_old_admin_stays_a_member_and_the_keeper_does_not_move(
    client, capsys, db_session_factory
):
    """The admin names a member: that person is the admin AT ONCE, their
    co-admin row (if any) is gone, the former admin is an ordinary member
    with their membership untouched, `updated_at` is unstamped and the
    keeper is where it was — the creator's account. 422 codes on
    `membership_id`, none writing: `not_a_member`, `is_admin`,
    `account_deleted`. A co-admin, a member and a stranger draw the group
    404 byte-identical to a missing id. The new admin may hand it back."""
    cast = await _cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    async with db_session_factory() as db:
        keeper = (await _account_for(db, ADMIN)).id

    for headers in (cast.co_admin, cast.member, cast.stranger):
        refused = await _hand_over(client, headers, cast.group_id, cast.member_membership)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)
    assert _code_of(await _hand_over(client, cast.admin, cast.group_id, MISSING)) == NOT_A_MEMBER
    assert _code_of(await _hand_over(client, cast.admin, cast.group_id, cast.admin_membership)) == IS_ADMIN
    gone = "gone@example.com"
    gone_headers = await _signed_in_headers(client, capsys, gone)
    gone_membership = await _add_member(db_session_factory, cast.group_id, gone)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    assert _code_of(await _hand_over(client, cast.admin, cast.group_id, gone_membership)) == ACCOUNT_DELETED
    group = await _group_row(db_session_factory, cast.group_id)
    assert group.admin_person_id == admin_person

    handed = await _hand_over(client, cast.admin, cast.group_id, cast.co_admin_membership)
    assert handed.status_code == 200, handed.text
    assert handed.json()["caller_role"] == "member"
    assert handed.json()["admin_person_id"] == str(co_admin_person)
    group = await _group_row(db_session_factory, cast.group_id)
    assert group.admin_person_id == co_admin_person
    assert group.keeper_account_id == keeper
    assert group.updated_at is None
    assert await _co_admin_rows(db_session_factory, cast.group_id) == []
    assert admin_person in await _membership_people(db_session_factory, cast.group_id)
    assert (await _detail(client, cast.co_admin, cast.group_id)).json()["caller_role"] == "admin"
    assert (await _detail(client, cast.admin, cast.group_id)).json()["caller_role"] == "member"
    # The former admin holds nothing reserved now …
    refused = await _appoint(client, cast.admin, cast.group_id, cast.member_membership)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.admin)
    # … and the new admin may hand it straight back.
    assert (await _hand_over(client, cast.co_admin, cast.group_id, cast.admin_membership)).status_code == 200
    assert (await _group_row(db_session_factory, cast.group_id)).admin_person_id == admin_person
    assert (await _group_row(db_session_factory, cast.group_id)).keeper_account_id == keeper


# --- the deletion leg (record §7): succession --------------------------------------


async def test_deletion_promotes_the_longest_serving_co_admin_or_nulls_the_admin(
    client, capsys, db_session_factory
):
    """One person P, four groups: A — P admin, X and Y co-admins (X
    appointed first) → X is promoted, X's row gone, Y's stays; B — P admin,
    two co-admins appointed at the SAME instant → the lower person_id (the
    tiebreak); C — P admin, no co-admin → NULL; D — Q admin, P a co-admin →
    P's row gone, Q untouched. P's OPEN join request on E is deleted; a
    DECIDED one stays for the reaper. Every membership row stays. A's
    keeper (P's account) is NULLed by the ACCOUNT lapse, never handed to X:
    running a group and keeping it never touch."""
    p = await _signed_in_headers(client, capsys, "p@example.com")
    x = await _signed_in_headers(client, capsys, "x@example.com")
    y = await _signed_in_headers(client, capsys, "y@example.com")
    q = await _signed_in_headers(client, capsys, "q@example.com")
    p_id, x_id, y_id, q_id = [await _person_id(db_session_factory, f"{n}@example.com") for n in "pxyq"]

    a = (await _create(client, p, name="A"))["id"]
    xa = await _add_member(db_session_factory, a, "x@example.com")
    ya = await _add_member(db_session_factory, a, "y@example.com")
    assert (await _appoint(client, p, a, xa)).status_code == 201
    await asyncio.sleep(0.01)
    assert (await _appoint(client, p, a, ya)).status_code == 201

    b = (await _create(client, p, name="B"))["id"]
    await _add_member(db_session_factory, b, "x@example.com")
    await _add_member(db_session_factory, b, "y@example.com")
    same_instant = _now() - timedelta(hours=1)
    async with db_session_factory() as db:
        for person in (x_id, y_id):
            await db.execute(
                text(
                    "INSERT INTO group_co_admins (group_id, person_id, added_by_person_id, created_at) "
                    "VALUES (:g, :p, :a, :t)"
                ),
                {"g": UUID(b), "p": person, "a": p_id, "t": same_instant},
            )
        await db.commit()
    lower = min(x_id, y_id)

    c = (await _create(client, p, name="C"))["id"]
    d = (await _create(client, q, name="D"))["id"]
    pd = await _add_member(db_session_factory, d, "p@example.com")
    assert (await _appoint(client, q, d, pd)).status_code == 201
    e = (await _create(client, q, name="E"))["id"]
    f = (await _create(client, q, name="F"))["id"]
    async with db_session_factory() as db:
        db.add(GroupJoinRequest(group_id=UUID(e), person_id=p_id))
        db.add(
            GroupJoinRequest(
                group_id=UUID(f),
                person_id=p_id,
                decided_at=_now(),
                outcome=JoinRequestOutcome.DECLINED,
                decided_by_person_id=q_id,
            )
        )
        await db.commit()
        p_account = (await _account_for(db, "p@example.com")).id

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=p)).status_code == 204

    group_a = await _group_row(db_session_factory, a)
    assert group_a.admin_person_id == x_id
    assert [person for person, _ in await _co_admin_rows(db_session_factory, a)] == [y_id]
    assert group_a.keeper_account_id is None  # the account lapse; never X's
    assert group_a.updated_at is None
    assert (await _group_row(db_session_factory, b)).admin_person_id == lower
    assert [person for person, _ in await _co_admin_rows(db_session_factory, b)] == [max(x_id, y_id)]
    assert (await _group_row(db_session_factory, c)).admin_person_id is None
    assert (await _group_row(db_session_factory, d)).admin_person_id == q_id
    assert await _co_admin_rows(db_session_factory, d) == []
    async with db_session_factory() as db:
        requests = (
            await db.execute(
                select(GroupJoinRequest.group_id, GroupJoinRequest.decided_at).where(
                    GroupJoinRequest.person_id == p_id
                )
            )
        ).all()
        assert [(str(g), decided is not None) for g, decided in requests] == [(f, True)]
        assert (
            await db.scalar(select(func.count()).select_from(GroupCoAdmin).where(GroupCoAdmin.person_id == p_id))
        ) == 0
    for group_id, expected in ((a, {p_id, x_id, y_id}), (b, {p_id, x_id, y_id}), (c, {p_id}), (d, {q_id, p_id})):
        assert await _membership_people(db_session_factory, group_id) == expected, group_id
    # X administers A now: a reserved act works, and the former admin is
    # absent from the list.
    assert (await _detail(client, x, a)).json()["caller_role"] == "admin"
    assert [e["role"] for e in (await _members(client, x, a)).json()["members"]] == ["admin", "co_admin"]
    assert (await _detail(client, y, a)).json()["caller_role"] == "co_admin"


# --- the 0032 round trip (record §8) ------------------------------------------------


async def _plant_group(db, *, name: str, profile_id, admin_person, keeper) -> UUID:
    return (
        await db.execute(
            text(
                "INSERT INTO groups (group_type, capability_profile_id, name, admin_person_id, keeper_account_id) "
                "VALUES ('HOUSEHOLD', :p, :n, :a, :k) RETURNING id"
            ),
            {"p": profile_id, "n": name, "a": admin_person, "k": keeper},
        )
    ).scalar_one()


async def _plant_person(db, *, name: str, anonymized: bool = False) -> tuple[UUID, UUID]:
    account = (
        await db.execute(text("INSERT INTO accounts (kind) VALUES ('PERSON') RETURNING id"))
    ).scalar_one()
    person = (
        await db.execute(
            text(
                "INSERT INTO people (account_id, display_name, anonymized_at) "
                "VALUES (:a, :n, :z) RETURNING id"
            ),
            {"a": account, "n": name, "z": _now() if anonymized else None},
        )
    ).scalar_one()
    return account, person


async def _tables_and_type(db) -> tuple[set[str], bool]:
    tables = set(
        (
            await db.scalars(
                text(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
                    "AND table_name IN ('group_co_admins', 'group_invitations_pending', 'group_links', 'group_join_requests')"
                )
            )
        ).all()
    )
    has_type = (
        await db.scalar(text("SELECT count(*) FROM pg_type WHERE typname = 'join_request_outcome'"))
    ) == 1
    return tables, has_type


NEW_TABLES = {"group_co_admins", "group_invitations_pending", "group_links", "group_join_requests"}
BACKFILL_PREFIX = "0032 backfilled groups.keeper_account_id from the admin's account: "


async def test_0032_round_trip_backfills_the_keeper_and_the_downgrade_is_genuine(
    db_session_factory, capsys, at_head_afterwards
):
    """Down to 0031 — the four tables and the type gone. Four groups planted
    THERE by raw SQL: (1) a NULL keeper and a live admin → backfilled to
    the admin's account; (2) a keeper already set → untouched; (3) no admin
    → untouched; (4) an admin whose person is anonymized → untouched. Up:
    the INFO line verbatim — ONE group — and the four keepers. Down: the
    tables and the type gone again, THE BACKFILLED KEEPER STAYS (it is
    true). Up: the line reads zero, because nothing is left to backfill."""
    async with db_session_factory() as db:
        assert await _tables_and_type(db) == (NEW_TABLES, True)
    await _migrate("downgrade", "0031", capsys)
    async with db_session_factory() as db:
        assert await _tables_and_type(db) == (set(), False)
        assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0031"
        profile_id = (
            await db.execute(text("SELECT id FROM capability_profiles WHERE name = 'household-default'"))
        ).scalar_one()
        live_account, live_person = await _plant_person(db, name="live")
        other_account, _ = await _plant_person(db, name="other")
        _, gone_person = await _plant_person(db, name="a former member", anonymized=True)
        ids = {
            "backfilled": await _plant_group(db, name="1 NULL keeper, live admin", profile_id=profile_id, admin_person=live_person, keeper=None),
            "kept": await _plant_group(db, name="2 keeper set", profile_id=profile_id, admin_person=live_person, keeper=other_account),
            "no_admin": await _plant_group(db, name="3 no admin", profile_id=profile_id, admin_person=None, keeper=None),
            "anonymized": await _plant_group(db, name="4 anonymized admin", profile_id=profile_id, admin_person=gone_person, keeper=None),
        }
        await db.commit()

    lines = await _migrate("upgrade", "head", capsys)
    backfill = [m for m in lines if m.startswith(BACKFILL_PREFIX)]
    assert len(backfill) == 1, lines
    assert backfill[0] == (
        BACKFILL_PREFIX + "1 group(s) (NULL keeper, admin set, admin's person not anonymized; "
        "on a database that holds groups created since 0022, a zero here is a finding)"
    )
    assert backfill[0].isascii()
    assert any(m.startswith("Running upgrade 0031 -> 0032") for m in lines), lines

    async def keepers() -> dict[str, UUID | None]:
        async with db_session_factory() as db:
            rows = (
                await db.execute(
                    text("SELECT id, keeper_account_id FROM groups WHERE id = ANY(:ids)"),
                    {"ids": list(ids.values())},
                )
            ).all()
            by_id = {row[0]: row[1] for row in rows}
            return {key: by_id[value] for key, value in ids.items()}

    expected = {"backfilled": live_account, "kept": other_account, "no_admin": None, "anonymized": None}
    assert await keepers() == expected
    async with db_session_factory() as db:
        assert await _tables_and_type(db) == (NEW_TABLES, True)

    # The downgrade is genuine for the tables and the type — and the
    # backfilled keeper STAYS.
    await _migrate("downgrade", "0031", capsys)
    async with db_session_factory() as db:
        assert await _tables_and_type(db) == (set(), False)
    assert await keepers() == expected
    lines = await _migrate("upgrade", "head", capsys)
    (line,) = [m for m in lines if m.startswith(BACKFILL_PREFIX)]
    assert line.startswith(BACKFILL_PREFIX + "0 group(s)")
    assert await keepers() == expected
    async with db_session_factory() as db:
        assert await _tables_and_type(db) == (NEW_TABLES, True)


# --- the verifier -------------------------------------------------------------------


async def test_the_verifier_asserts_the_shapes_and_the_membership_invariants(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's sixty-five CK-75 lines, run as the
    operator runs it — a fresh interpreter against the test database — on a
    clean baseline holding a real co-admin, then on the plant each
    invariant exists to catch, one at a time: a co-admin row with no
    membership; a co-admin row naming the group's admin; a backup admin
    set; a group whose admin holds no membership (the CK-45 failure, still
    caught); a co-admin row on an anonymized person; an open join request
    from an anonymized person. A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's lesson)."""
    cast = await _cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    gone = "gone@example.com"
    gone_headers = await _signed_in_headers(client, capsys, gone)
    gone_membership = await _add_member(db_session_factory, cast.group_id, gone)
    gone_person = await _person_id(db_session_factory, gone)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    del gone_membership

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    for line in (
        "table group_co_admins exists",
        "group_co_admins primary key is (group_id, person_id)",
        "group_co_admins.added_by_person_id has no delete rule",
        "index ix_group_co_admins_person_id exists on group_co_admins.person_id",
        "table group_invitations_pending exists",
        "group_invitations_pending.token_hash is UNIQUE",
        "uq_group_invitations_pending_live_destination is UNIQUE",
        "group_invitations_pending.email is gone",
        "table group_links exists",
        "group_links.token is gone",
        "group_links.token_hash is gone",
        "uq_group_links_live is UNIQUE on (group_id) WHERE revoked_at IS NULL",
        "table group_join_requests exists",
        "join_request_outcome carries exactly 'approved', 'declined'",
        "uq_group_join_requests_open is UNIQUE on (group_id, person_id) WHERE decided_at IS NULL",
        "CHECK ck_group_invitations_pending_consumed_or_revoked exists",
        "CHECK ck_group_join_requests_decided_with_outcome exists",
        "every group whose admin is set has a membership for that admin",
        "every co-admin holds a membership in the group",
        "no co-admin row names its group's own admin (admin and co-admin are exclusive)",
        "no co-admin row names an anonymized person",
        "no open join request names an anonymized person",
        "groups.backup_admin_person_id is NULL on every row (retired at CK-75; dropped later)",
        "every EMAIL group-invitation destination is stored normalized",
    ):
        assert f"PASS  {line}" in out, line
    assert "every group has at least one membership" not in out
    assert "INFO  group_co_admins rows: 1" in out

    async def plant(label: str, sql: str, confirm: str, undo: str, params: dict) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), params)
            await db.commit()
            assert await db.scalar(text(confirm), params) == 1, f"the plant did not land: {label}"
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 1, 1, 1), (label, out)
        assert f"FAIL  {label}" in out, out
        async with db_session_factory() as db:
            await db.execute(text(undo), params)
            await db.commit()
        assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # (1) A co-admin row with no membership — the stranger's person.
    stranger_person = await _person_id(db_session_factory, STRANGER)
    await plant(
        "every co-admin holds a membership in the group",
        "INSERT INTO group_co_admins (group_id, person_id, added_by_person_id) VALUES (:g, :p, :a)",
        "SELECT count(*) FROM group_co_admins c WHERE c.group_id = :g AND c.person_id = :p "
        "AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = c.group_id AND m.person_id = c.person_id)",
        "DELETE FROM group_co_admins WHERE group_id = :g AND person_id = :p",
        {"g": UUID(cast.group_id), "p": stranger_person, "a": admin_person},
    )
    # (2) A co-admin row naming the admin (the endpoint refuses it).
    await plant(
        "no co-admin row names its group's own admin (admin and co-admin are exclusive)",
        "INSERT INTO group_co_admins (group_id, person_id, added_by_person_id) VALUES (:g, :p, :a)",
        "SELECT count(*) FROM group_co_admins c JOIN groups g ON g.id = c.group_id "
        "WHERE c.group_id = :g AND g.admin_person_id = c.person_id",
        "DELETE FROM group_co_admins WHERE group_id = :g AND person_id = :p",
        {"g": UUID(cast.group_id), "p": admin_person, "a": admin_person},
    )
    # (3) The retired backup slot set (nothing writes it).
    await plant(
        "groups.backup_admin_person_id is NULL on every row (retired at CK-75; dropped later)",
        "UPDATE groups SET backup_admin_person_id = :p WHERE id = :g",
        "SELECT count(*) FROM groups WHERE id = :g AND backup_admin_person_id IS NOT NULL",
        "UPDATE groups SET backup_admin_person_id = NULL WHERE id = :g",
        {"g": UUID(cast.group_id), "p": stranger_person},
    )
    # (4) A group whose admin holds no membership — the CK-45 failure
    # (a group committed before its creator's membership), still caught.
    async with db_session_factory() as db:
        profile_id = (
            await db.execute(text("SELECT id FROM capability_profiles WHERE name = 'household-default'"))
        ).scalar_one()
    await plant(
        "every group whose admin is set has a membership for that admin",
        "INSERT INTO groups (id, group_type, capability_profile_id, name, admin_person_id) "
        "VALUES (:g, 'HOUSEHOLD', :pr, 'planted', :p)",
        "SELECT count(*) FROM groups g WHERE g.id = :g AND g.admin_person_id IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = g.id AND m.person_id = g.admin_person_id)",
        "DELETE FROM groups WHERE id = :g",
        {"g": UUID("00000000-0000-4000-8000-0000000000a1"), "pr": profile_id, "p": stranger_person},
    )
    # (5) A co-admin row on an anonymized person (the leg deletes them).
    await plant(
        "no co-admin row names an anonymized person",
        "INSERT INTO group_co_admins (group_id, person_id, added_by_person_id) VALUES (:g, :p, :a)",
        "SELECT count(*) FROM group_co_admins c JOIN people p ON p.id = c.person_id "
        "WHERE c.group_id = :g AND c.person_id = :p AND p.anonymized_at IS NOT NULL",
        "DELETE FROM group_co_admins WHERE group_id = :g AND person_id = :p",
        {"g": UUID(cast.group_id), "p": gone_person, "a": admin_person},
    )
    # (6) An open join request from an anonymized person (the leg deletes them).
    await plant(
        "no open join request names an anonymized person",
        "INSERT INTO group_join_requests (group_id, person_id) VALUES (:g, :p)",
        "SELECT count(*) FROM group_join_requests r JOIN people p ON p.id = r.person_id "
        "WHERE r.group_id = :g AND r.person_id = :p AND r.decided_at IS NULL AND p.anonymized_at IS NOT NULL",
        "DELETE FROM group_join_requests WHERE group_id = :g AND person_id = :p",
        {"g": UUID(cast.group_id), "p": gone_person},
    )


# --- nothing logged -------------------------------------------------------------------


async def test_membership_acts_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """A member list is a roster. With the root logger at DEBUG, the list,
    an appointment, a hand-over, a removal and a leave put no display name,
    no address and no id into any APPLICATION log record — the module has
    no logger (the httpx client's records carry the request line, as every
    access log does; excluded, and shown non-empty so the exclusion does
    real work)."""
    cast = await _cast(client, capsys, db_session_factory)
    assert not hasattr(groups_api, "logger")
    names = [
        (await client.get("/auth/me", headers=h)).json()["display_name"]
        for h in (cast.admin, cast.co_admin, cast.member)
    ]
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        assert (await _members(client, cast.member, cast.group_id)).status_code == 200
        assert (await _appoint(client, cast.admin, cast.group_id, cast.member_membership)).status_code == 201
        assert (await _unappoint(client, cast.member, cast.group_id, cast.member_membership)).status_code == 204
        assert (await _hand_over(client, cast.admin, cast.group_id, cast.co_admin_membership)).status_code == 200
        assert (await _remove(client, cast.co_admin, cast.group_id, cast.member_membership)).status_code == 204
        assert (await _leave(client, cast.admin, cast.group_id)).status_code == 204
    application = [r for r in caplog.records if not r.name.startswith("httpx")]
    assert any(r.name.startswith("httpx") for r in caplog.records)
    assert not [r for r in application if r.name.startswith(("app", "covey-keep"))]
    joined = "\n".join(r.getMessage() for r in application)
    for word in (*names, ADMIN, CO_ADMIN, MEMBER, cast.member_membership, cast.co_admin_membership):
        assert word not in joined, word
