"""CK-45 — groups get a surface: create, read, rename; the creator as admin
and first member.

The load-bearing pins: creation births the group AND the creator's
memberships row in ONE transaction (a group never exists with zero members),
with household_id / sub_group_id / role_id left NULL; both authorization
checks live on the PERSON spine (admin_person_id, memberships.person_id — no
account fact anywhere); HOUSEHOLD is the only accepted group type and the
refusal is a field-level 422 naming rung 2 that leaves no row; a missing
profile row fails loudly and creates nothing; non-permitted access is a 404
byte-identical to a missing id; updated_at is NULL until the first rename
and stamped by renames alone; the list is ONE statement; no body carries a
roster, an email, or a person id beyond the two admin columns; and the
router logs no name.
"""

import logging

import pytest
from sqlalchemy import event, func, select, text

from app.api import groups as groups_api
from app.db import engine
from app.models import CapabilityProfile, Group, GroupType, Membership, Person
from tests.test_auth import _sign_in

MISSING = "00000000-0000-0000-0000-000000000000"
BODY_KEYS = {
    "id",
    "name",
    "group_type",
    "admin_person_id",
    "backup_admin_person_id",
    "member_count",
    "created_at",
    "updated_at",
}


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


def _error_locs(response) -> set[tuple]:
    return {tuple(err["loc"]) for err in response.json()["detail"]}


async def _create(client, headers, **overrides) -> dict:
    body = {"name": "Finch family"}
    body.update(overrides)
    response = await client.post("/groups", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _person_id(db, address: str):
    return (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()


async def _household_profile(db) -> CapabilityProfile:
    return (
        await db.execute(
            select(CapabilityProfile).where(
                CapabilityProfile.name == groups_api.HOUSEHOLD_PROFILE_NAME
            )
        )
    ).scalar_one()


async def _counts(db) -> tuple[int, int]:
    groups = await db.scalar(select(func.count()).select_from(Group))
    memberships = await db.scalar(select(func.count()).select_from(Membership))
    return groups, memberships


# --- auth gate ----------------------------------------------------------------


async def test_groups_require_auth(client):
    assert (await client.post("/groups", json={"name": "x"})).status_code == 401
    assert (await client.get("/groups")).status_code == 401
    assert (await client.get(f"/groups/{MISSING}")).status_code == 401
    assert (await client.patch(f"/groups/{MISSING}", json={"name": "x"})).status_code == 401


# --- creation: one transaction, admin + first member, NULL where nothing reads --


async def test_create_births_group_admin_and_first_member_together(
    client, capsys, db_session_factory
):
    address = "founder@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    response = await client.post("/groups", json={"name": "  Finch family  "}, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()

    # The body: exactly the eight fields — no roster, no email, no person id
    # beyond the two admin columns — and the name trimmed.
    assert set(created) == BODY_KEYS
    assert created["name"] == "Finch family"
    assert created["group_type"] == "HOUSEHOLD"
    assert created["member_count"] == 1
    assert created["updated_at"] is None
    assert created["backup_admin_person_id"] is None
    assert address not in response.text

    async with db_session_factory() as db:
        person_id = await _person_id(db, address)
        profile = await _household_profile(db)
        group = (await db.execute(select(Group))).scalars().one()
        membership = (await db.execute(select(Membership))).scalars().one()
        assert str(group.id) == created["id"]
        # Creator = admin, on the PERSON spine.
        assert group.admin_person_id == person_id
        assert created["admin_person_id"] == str(person_id)
        assert group.backup_admin_person_id is None
        assert group.organization_id is None
        assert group.group_type == GroupType.HOUSEHOLD
        # The profile resolved by lookup, of the group's own type.
        assert group.capability_profile_id == profile.id
        assert profile.group_type == GroupType.HOUSEHOLD
        assert group.updated_at is None
        # Creator = first member, in the same transaction — and the three
        # columns no reader consumes left NULL.
        assert membership.group_id == group.id
        assert membership.person_id == person_id
        assert membership.household_id is None
        assert membership.sub_group_id is None
        assert membership.role_id is None


async def test_household_is_the_only_group_type_and_a_refusal_leaves_no_row(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "typed@example.com")
    # Schema-valid, endpoint-refused (the CK-25 SMS shape): a field-level
    # 422 on group_type naming the rung-2 gate, and NO row created.
    for refused in ("TEAM", "CONGREGATION", "CLUB"):
        response = await client.post(
            "/groups", json={"name": "Finch family", "group_type": refused}, headers=headers
        )
        assert response.status_code == 422, refused
        assert _error_locs(response) == {("body", "group_type")}
        assert "rung 2" in response.json()["detail"][0]["msg"]
    # An unknown value lands on the same field.
    response = await client.post(
        "/groups", json={"name": "Finch family", "group_type": "FAMILY"}, headers=headers
    )
    assert response.status_code == 422
    assert _error_locs(response) == {("body", "group_type")}
    async with db_session_factory() as db:
        assert await _counts(db) == (0, 0)

    # Absent defaults to HOUSEHOLD; explicit HOUSEHOLD is accepted.
    assert (await _create(client, headers))["group_type"] == "HOUSEHOLD"
    assert (await _create(client, headers, group_type="HOUSEHOLD"))["group_type"] == "HOUSEHOLD"
    async with db_session_factory() as db:
        assert await _counts(db) == (2, 2)


async def test_name_is_trimmed_and_blank_over_long_or_extra_fields_refused(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "namer@example.com")
    for bad in ("", "   ", "x" * 201):
        response = await client.post("/groups", json={"name": bad}, headers=headers)
        assert response.status_code == 422, repr(bad)
        assert _error_locs(response) == {("body", "name")}
    assert (await client.post("/groups", json={}, headers=headers)).status_code == 422
    # extra="forbid": an unknown field is a 422, never a silent no-op.
    assert (
        await client.post("/groups", json={"name": "ok", "extra": True}, headers=headers)
    ).status_code == 422
    async with db_session_factory() as db:
        assert await _counts(db) == (0, 0)
    assert (await _create(client, headers, name="x" * 200))["name"] == "x" * 200


async def test_a_missing_household_profile_fails_loudly_and_creates_nothing(
    client, capsys, db_session_factory
):
    """The profile is migration 0001's seed and never created here: with it
    hidden, creation raises (a 500 — loud), writes no group, no membership,
    and no profile."""
    headers = await _signed_in_headers(client, capsys, "seedless@example.com")
    hidden = "household-default-hidden-for-test"
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE capability_profiles SET name = :hidden WHERE name = :name"),
            {"hidden": hidden, "name": groups_api.HOUSEHOLD_PROFILE_NAME},
        )
        await db.commit()
        profiles_before = await db.scalar(select(func.count()).select_from(CapabilityProfile))
    try:
        with pytest.raises(RuntimeError, match="never created here"):
            await client.post("/groups", json={"name": "Finch family"}, headers=headers)
        async with db_session_factory() as db:
            assert await _counts(db) == (0, 0)
            assert (
                await db.scalar(select(func.count()).select_from(CapabilityProfile))
            ) == profiles_before
    finally:
        async with db_session_factory() as db:
            await db.execute(
                text("UPDATE capability_profiles SET name = :name WHERE name = :hidden"),
                {"hidden": hidden, "name": groups_api.HOUSEHOLD_PROFILE_NAME},
            )
            await db.commit()
    # Restored: creation works again.
    await _create(client, headers)


# --- reads: member OR admin, on the person spine; 404-not-403 -------------------


async def test_list_is_the_persons_groups_newest_first_member_or_admin(
    client, capsys, db_session_factory
):
    address_a = "lister@example.com"
    address_b = "other@example.com"
    headers_a = await _signed_in_headers(client, capsys, address_a)
    headers_b = await _signed_in_headers(client, capsys, address_b)
    first = await _create(client, headers_a, name="First created")
    second = await _create(client, headers_a, name="Second created")
    theirs = await _create(client, headers_b, name="Someone else's")

    response = await client.get("/groups", headers=headers_a)
    assert response.status_code == 200
    assert [g["name"] for g in response.json()["groups"]] == ["Second created", "First created"]
    assert {g["id"] for g in response.json()["groups"]} == {first["id"], second["id"]}
    assert [g["name"] for g in (await client.get("/groups", headers=headers_b)).json()["groups"]] == [
        "Someone else's"
    ]

    # The two halves of the read rule, constructed directly because the API
    # cannot yet make either: a group A is a MEMBER of but does not
    # administer (admin B, members A and B), and one A ADMINISTERS without a
    # membership row of their own (admin A, member B). Both list for A, each
    # once, with member_count computed from the rows.
    async with db_session_factory() as db:
        person_a = await _person_id(db, address_a)
        person_b = await _person_id(db, address_b)
        profile = await _household_profile(db)
        member_only = Group(
            group_type=GroupType.HOUSEHOLD,
            capability_profile_id=profile.id,
            name="member-only",
            admin_person_id=person_b,
        )
        admin_only = Group(
            group_type=GroupType.HOUSEHOLD,
            capability_profile_id=profile.id,
            name="admin-only",
            admin_person_id=person_a,
        )
        db.add_all([member_only, admin_only])
        await db.flush()
        db.add_all(
            [
                Membership(group_id=member_only.id, person_id=person_a),
                Membership(group_id=member_only.id, person_id=person_b),
                Membership(group_id=admin_only.id, person_id=person_b),
            ]
        )
        await db.commit()
        member_only_id, admin_only_id = str(member_only.id), str(admin_only.id)

    listed = (await client.get("/groups", headers=headers_a)).json()["groups"]
    assert [g["id"] for g in listed].count(member_only_id) == 1
    assert [g["id"] for g in listed].count(admin_only_id) == 1
    assert {g["id"] for g in listed} == {first["id"], second["id"], member_only_id, admin_only_id}
    by_id = {g["id"]: g for g in listed}
    assert by_id[member_only_id]["member_count"] == 2
    assert by_id[admin_only_id]["member_count"] == 1
    assert by_id[first["id"]]["member_count"] == 1
    # Both read individually for A too; neither body carries a roster or an
    # address.
    for group_id in (member_only_id, admin_only_id):
        detail = await client.get(f"/groups/{group_id}", headers=headers_a)
        assert detail.status_code == 200
        assert set(detail.json()) == BODY_KEYS
        assert address_b not in detail.text
    # B's list: their own, plus both constructed groups (member of one,
    # admin-and-member of the other) — and never A's.
    assert {g["id"] for g in (await client.get("/groups", headers=headers_b)).json()["groups"]} == {
        theirs["id"],
        member_only_id,
        admin_only_id,
    }


async def test_non_member_read_is_404_indistinguishable_from_missing(
    client, capsys, db_session_factory
):
    headers_a = await _signed_in_headers(client, capsys, "owner@example.com")
    headers_b = await _signed_in_headers(client, capsys, "prober@example.com")
    created = await _create(client, headers_a)

    foreign = await client.get(f"/groups/{created['id']}", headers=headers_b)
    missing = await client.get(f"/groups/{MISSING}", headers=headers_b)
    # 404, not 403 — and byte-identical to a genuinely missing id: the
    # existence of a group is not public information.
    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.content == missing.content
    assert (await client.get("/groups", headers=headers_b)).json()["groups"] == []

    # A read stamps nothing.
    own = await client.get(f"/groups/{created['id']}", headers=headers_a)
    assert own.status_code == 200
    assert own.json()["updated_at"] is None
    async with db_session_factory() as db:
        assert (await db.execute(select(Group))).scalars().one().updated_at is None


# --- rename: admin only, stamped, name never clearable ----------------------------


async def test_rename_stamps_updated_at_and_only_a_rename_stamps_it(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "renamer@example.com")
    created = await _create(client, headers)
    group_id = created["id"]

    response = await client.patch(
        f"/groups/{group_id}", json={"name": "  The Finches  "}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert set(response.json()) == BODY_KEYS
    assert response.json()["name"] == "The Finches"
    assert response.json()["updated_at"] is not None
    assert response.json()["member_count"] == 1
    async with db_session_factory() as db:
        group = (await db.execute(select(Group))).scalars().one()
        assert group.name == "The Finches"
        assert group.updated_at is not None
        first_stamp = group.updated_at
        assert group.created_at <= first_stamp

    # A second rename moves the stamp forward, never back.
    response = await client.patch(f"/groups/{group_id}", json={"name": "Finches"}, headers=headers)
    assert response.status_code == 200
    async with db_session_factory() as db:
        group = (await db.execute(select(Group))).scalars().one()
        assert group.updated_at >= first_stamp
        second_stamp = group.updated_at

    # Refused, each a 422 that changes nothing and stamps nothing: an
    # explicit null (NOT NULL — a name is corrected, never removed), a
    # blank, an empty patch, and a field outside the surface (group_type is
    # fixed at creation).
    for bad_body in (
        {"name": None},
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 201},
        {},
        {"name": "ok", "group_type": "HOUSEHOLD"},
        {"group_type": "TEAM"},
    ):
        response = await client.patch(f"/groups/{group_id}", json=bad_body, headers=headers)
        assert response.status_code == 422, bad_body
    explicit_null = await client.patch(f"/groups/{group_id}", json={"name": None}, headers=headers)
    assert _error_locs(explicit_null) == {("body", "name")}
    async with db_session_factory() as db:
        group = (await db.execute(select(Group))).scalars().one()
        assert group.name == "Finches"
        assert group.updated_at == second_stamp


async def test_rename_is_the_admins_alone_and_the_refusal_is_the_group_404(
    client, capsys, db_session_factory
):
    address_admin = "admin@example.com"
    address_member = "member@example.com"
    headers_admin = await _signed_in_headers(client, capsys, address_admin)
    headers_member = await _signed_in_headers(client, capsys, address_member)
    headers_stranger = await _signed_in_headers(client, capsys, "stranger@example.com")
    created = await _create(client, headers_admin)
    group_id = created["id"]
    # A member who is not the admin — constructed directly (membership of
    # anyone but the creator has no surface yet).
    async with db_session_factory() as db:
        db.add(Membership(group_id=created["id"], person_id=await _person_id(db, address_member)))
        await db.commit()

    # The member can read the group (person-spine membership) …
    assert (await client.get(f"/groups/{group_id}", headers=headers_member)).status_code == 200
    assert (await client.get(f"/groups/{group_id}", headers=headers_member)).json()["member_count"] == 2
    # … and cannot rename it: the 404 byte-identical to a missing id, for
    # the member and for a stranger alike.
    missing = await client.patch(f"/groups/{MISSING}", json={"name": "x"}, headers=headers_member)
    assert missing.status_code == 404
    for headers in (headers_member, headers_stranger):
        refused = await client.patch(f"/groups/{group_id}", json={"name": "Taken"}, headers=headers)
        assert refused.status_code == 404
        assert refused.content == missing.content
    async with db_session_factory() as db:
        group = (await db.execute(select(Group))).scalars().one()
        assert group.name == "Finch family"
        assert group.updated_at is None
        # No account fact anywhere: the admin column and the membership rows
        # are person ids, and the person who administers is the creator.
        assert group.admin_person_id == await _person_id(db, address_admin)


# --- the list is one statement ---------------------------------------------------


async def test_list_statement_count_does_not_scale_with_groups(client, capsys):
    """The member count and the membership test ride ONE query — the CK-20
    pin's shape: equal statement counts at one and four groups, and exactly
    one statement in the request reading groups."""
    headers = await _signed_in_headers(client, capsys, "counter@example.com")
    await _create(client, headers, name="One")

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert (await client.get("/groups", headers=headers)).status_code == 200
        at_one_group = len(statements)

        for n in range(3):
            await _create(client, headers, name=f"More {n}")
        statements.clear()
        assert (await client.get("/groups", headers=headers)).status_code == 200
        at_four_groups = len(statements)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert at_four_groups == at_one_group
    assert len([s for s in statements if "FROM groups" in s]) == 1


# --- a group's name is never logged ------------------------------------------------


async def test_no_group_name_reaches_the_log(client, capsys, caplog):
    """A group's name is user-supplied text naming a family. With the root
    logger at DEBUG, a create, a rename, a list and a refused rename put
    none of the words into any APPLICATION log record — the module has no
    logger. (The httpx client's records carry the request line, as every
    access log does; excluded below, and shown to be non-empty so the
    exclusion is doing real work.)"""
    headers = await _signed_in_headers(client, capsys, "quiet@example.com")
    headers_other = await _signed_in_headers(client, capsys, "louder@example.com")
    assert not hasattr(groups_api, "logger")
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        created = await _create(client, headers, name="secret-family-7f3a")
        assert (
            await client.patch(
                f"/groups/{created['id']}", json={"name": "renamed-family-9c2e"}, headers=headers
            )
        ).status_code == 200
        assert (await client.get("/groups", headers=headers)).status_code == 200
        assert (
            await client.patch(
                f"/groups/{created['id']}", json={"name": "other-word-4b1d"}, headers=headers_other
            )
        ).status_code == 404
    application_log = "\n".join(
        record.getMessage() for record in caplog.records if not record.name.startswith("httpx")
    )
    assert any(record.name.startswith("httpx") for record in caplog.records)
    for word in ("secret-family-7f3a", "renamed-family-9c2e", "other-word-4b1d"):
        assert word not in application_log
