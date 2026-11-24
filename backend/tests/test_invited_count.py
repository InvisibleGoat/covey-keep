"""CK-103 — how many people are invited, on the gathering's detail body.

A gathering's chat reads *{N} invited* in its header (the chat record's §10),
so the detail body and the setting route's answer — one builder,
`_detail_body` — carry `invited_count`: the people holding an invitation row,
not anonymized, the host's own account aside. No other body takes it.

The pins: members, an outsider and a co-host count once each; the host does
not, whether or not they hold a row; an anonymized person, a pending
invitation, a member only shared with, one left out and a row that names a
group do not; nobody invited is 0; the memory view carries null, withheld and
never 0, and reads nothing to say so; the setting route's answer agrees with
the detail; the create, patch, list and calendar bodies have no such key; and
the count is ONE statement, whatever the number of people.
"""

from uuid import UUID

from sqlalchemy import event, text

from app.db import engine
from tests.test_account_deletion import DELETE_BODY
from tests.test_co_hosts import _add as _add_co_host
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_group_gatherings import _create_in_group, _invitation_id
from tests.test_group_membership import CO_ADMIN, MEMBER, _cast, _person_id
from tests.test_invitations import _accept, _invite, _invite_token
from tests.test_member_places import _extra_member, _put_place
from tests.test_outside_invitations import OUTSIDER, _detail, _let_in, _off, _on, _turn, _window
from tests.test_calendar import _calendar

# What the count's own statement is found by, in a request's statements.
COUNT_FROM = "FROM gathering_invitations JOIN people"


async def _invited(client, headers, gathering_id: str):
    return (await _detail(client, headers, gathering_id))["invited_count"]


class _Recorder:
    """Every statement a block sends."""

    def __init__(self):
        self.statements: list[str] = []

    def _record(self, conn, cursor, statement, parameters, context, executemany):
        self.statements.append(" ".join(statement.split()))

    def __enter__(self):
        event.listen(engine.sync_engine, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *exc):
        event.remove(engine.sync_engine, "before_cursor_execute", self._record)

    @property
    def counts(self) -> list[str]:
        return [s for s in self.statements if "count(" in s and COUNT_FROM in s]


async def test_a_standalone_gathering_counts_the_people_who_accepted(client, capsys):
    host = await _signed_in_headers(client, capsys, "ic-host@example.com")
    created = await _create(client, host)
    # Nobody invited: 0, a number and not null.
    assert await _invited(client, host, created["id"]) == 0

    for address in ("ic-one@example.com", "ic-two@example.com"):
        token = await _invite_token(client, capsys, host, created["id"], address)
        # A pending invitation is not a person invited yet.
        before = await _invited(client, host, created["id"])
        await _accept(client, await _signed_in_headers(client, capsys, address), token)
        assert await _invited(client, host, created["id"]) == before + 1

    assert (await _invite(client, host, created["id"], "ic-pending@example.com")).status_code == 201
    # Two accepted, one pending; the host is not counted; every invited
    # person reads the same number.
    assert await _invited(client, host, created["id"]) == 2
    invited = await _signed_in_headers(client, capsys, "ic-one@example.com")
    assert await _invited(client, invited, created["id"]) == 2


async def test_a_groups_gathering_counts_its_invited_members(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    _, shared_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, "ic-shared@example.com")
    _, left_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, "ic-left@example.com")
    # The member hosts; the other four members each hold an invitation row.
    created = await _create_in_group(client, cast.member, cast.group_id)
    assert await _invited(client, cast.member, created["id"]) == 4

    # A place moved away from invited is not counted, either way.
    assert (
        await _put_place(client, cast.member, created["id"], shared_membership, "shared_with")
    ).status_code == 200
    assert (await _put_place(client, cast.member, created["id"], left_membership, "left_out")).status_code == 200
    assert await _invited(client, cast.member, created["id"]) == 2
    assert await _invited(client, cast.admin, created["id"]) == 2


async def test_a_co_host_is_counted_once(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    before = await _invited(client, cast.member, created["id"])
    invitation = await _invitation_id(db_session_factory, created["id"], CO_ADMIN)
    assert (await _add_co_host(client, cast.member, created["id"], invitation)).status_code == 201
    assert await _invited(client, cast.member, created["id"]) == before == 2


async def test_an_outsider_is_counted_while_they_hold_their_row(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    assert await _invited(client, cast.member, created["id"]) == 2
    await _on(client, cast.member, created["id"])
    outsider = await _let_in(client, capsys, cast.member, created["id"], OUTSIDER)
    assert await _invited(client, cast.member, created["id"]) == 3
    assert await _invited(client, outsider, created["id"]) == 3
    # The turn-off deletes their row, and its own answer says so.
    answer = await _off(client, cast.member, created["id"])
    assert answer["invited_count"] == 2
    assert await _invited(client, cast.member, created["id"]) == 2


async def test_the_host_is_not_counted_even_holding_a_row(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    assert await _invited(client, cast.member, created["id"]) == 2
    async with db_session_factory() as db:
        await db.execute(
            text("INSERT INTO gathering_invitations (gathering_id, person_id) VALUES (:g, :p)"),
            {"g": UUID(created["id"]), "p": await _person_id(db_session_factory, MEMBER)},
        )
        await db.commit()
    assert await _invited(client, cast.member, created["id"]) == 2


async def test_a_gathering_with_no_host_counts_everyone_invited(client, capsys, db_session_factory):
    """A host's account deleted leaves the gathering hostless: nobody is set
    aside, and the deleted host, anonymized, is not counted."""
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    deleted = await client.post("/me/delete", json=DELETE_BODY, headers=cast.member)
    assert deleted.status_code in (200, 204), deleted.text
    async with db_session_factory() as db:
        assert (
            await db.scalar(
                text("SELECT host_account_id FROM gatherings WHERE id = :g"), {"g": UUID(created["id"])}
            )
        ) is None
    assert await _invited(client, cast.admin, created["id"]) == 2


async def test_an_anonymized_person_is_not_counted(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    assert await _invited(client, cast.member, created["id"]) == 2
    deleted = await client.post("/me/delete", json=DELETE_BODY, headers=cast.co_admin)
    assert deleted.status_code in (200, 204), deleted.text
    async with db_session_factory() as db:
        # Their invitation row is kept: the count is what leaves them out.
        assert (
            await db.scalar(
                text("SELECT count(*) FROM gathering_invitations WHERE gathering_id = :g"),
                {"g": UUID(created["id"])},
            )
        ) == 2
    assert await _invited(client, cast.member, created["id"]) == 1


async def test_a_row_that_names_a_group_is_not_counted(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    host = await _signed_in_headers(client, capsys, "ic-host2@example.com")
    created = await _create(client, host)
    async with db_session_factory() as db:
        await db.execute(
            text("INSERT INTO gathering_invitations (gathering_id, group_id) VALUES (:g, :gr)"),
            {"g": UUID(created["id"]), "gr": UUID(cast.group_id)},
        )
        await db.commit()
    assert await _invited(client, host, created["id"]) == 0


async def test_the_photos_only_view_carries_null_and_reads_nothing(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    shared, _, _ = await _extra_member(client, capsys, db_session_factory, cast, "ic-memory@example.com")
    created = await _create_in_group(client, cast.member, cast.group_id, invited=[cast.co_admin_membership])
    with _Recorder() as recorder:
        body = await _detail(client, shared, created["id"])
    assert body["caller_view"] == "memory"
    assert body["invited_count"] is None
    assert recorder.counts == []
    assert await _invited(client, cast.co_admin, created["id"]) == 1


async def test_the_setting_routes_answer_is_the_details(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id, invited=[cast.admin_membership])
    # The host, in full: on and off alike.
    for on in (True, False):
        answer = await _turn(client, cast.member, created["id"], on)
        assert answer.status_code == 200, answer.text
        detail = await _detail(client, cast.member, created["id"])
        assert answer.json()["invited_count"] == detail["invited_count"] == 1
    # A co-admin only shared with: the memory view, withheld on both.
    answer = await _turn(client, cast.co_admin, created["id"], True)
    assert answer.status_code == 200, answer.text
    assert answer.json()["caller_view"] == "memory"
    assert answer.json()["invited_count"] is None
    assert (await _detail(client, cast.co_admin, created["id"]))["invited_count"] is None


async def test_no_other_body_takes_it(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    assert "invited_count" not in created
    patched = await client.patch(
        f"/gatherings/{created['id']}", json={"title": "Renamed"}, headers=cast.member
    )
    assert patched.status_code == 200, patched.text
    assert "invited_count" not in patched.json()
    listed = await client.get("/gatherings", headers=cast.member)
    assert listed.status_code == 200 and "invited_count" not in listed.text
    in_group = await client.get(f"/groups/{cast.group_id}/gatherings", headers=cast.member)
    assert in_group.status_code == 200 and "invited_count" not in in_group.text
    start, end = _window()
    calendar = await _calendar(client, cast.member, start, end)
    assert calendar.status_code == 200 and "invited_count" not in calendar.text
    # The detail carries it.
    assert "invited_count" in await _detail(client, cast.member, created["id"])


async def test_the_count_is_one_statement(client, capsys):
    host = await _signed_in_headers(client, capsys, "ic-host3@example.com")
    none = await _create(client, host)
    some = await _create(client, host)
    for address in ("ic-three@example.com", "ic-four@example.com", "ic-five@example.com"):
        token = await _invite_token(client, capsys, host, some["id"], address)
        await _accept(client, await _signed_in_headers(client, capsys, address), token)
    with _Recorder() as alone:
        assert await _invited(client, host, none["id"]) == 0
    with _Recorder() as three:
        assert await _invited(client, host, some["id"]) == 3
    assert len(alone.statements) == len(three.statements)
    assert len(alone.counts) == len(three.counts) == 1
