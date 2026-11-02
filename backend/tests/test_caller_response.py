"""CK-87 — the caller's own answer on each date of a gathering body.

The gathering page's answer chip (`Going`, `Maybe`, `Can't make it`, or
*Not answered*) needs the caller's RSVP on every date without opening each
date's block, so every occurrence a gathering body carries gains
`caller_response`: `"yes"`, `"maybe"`, `"no"` or null — the caller's OWN
row on that date, matched by person. Nothing new is disclosed: the caller
already reads the same answer as `own` from `GET /occurrences/{id}/rsvps`.

The pins: the detail carries each date's own answer and null where the
caller has not answered; another person's answer is never shown; a guest's
row (no person) never matches anyone; an answer changed is the answer read;
the create body's dates carry null without a read; the PATCH body carries no
occurrences, as it never has; the memory view carries no occurrences and so
no field anywhere; the occurrence routes' own bodies are unchanged; and the
answers ride ONE statement whatever the number of dates — never one per date.
"""

from uuid import UUID

from sqlalchemy import event

from app.db import engine
from app.models import RSVP, RSVPResponse
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_group_gatherings import _create_in_group
from tests.test_group_membership import _cast
from tests.test_invitations import _accept, _invite_token
from tests.test_member_places import _extra_member
from tests.test_rsvps import _put_rsvp

DATES = [
    {"starts_at": "2026-12-01T18:00:00+00:00"},
    {"starts_at": "2026-12-08T18:00:00+00:00"},
    {"starts_at": "2026-12-15T18:00:00+00:00"},
]


async def _host_and_invitee(client, capsys, host_addr, invitee_addr, dates=DATES):
    headers_host = await _signed_in_headers(client, capsys, host_addr)
    created = await _create(client, headers_host, occurrences=dates)
    token = await _invite_token(client, capsys, headers_host, created["id"], invitee_addr)
    headers_invitee = await _signed_in_headers(client, capsys, invitee_addr)
    await _accept(client, headers_invitee, token)
    return headers_host, headers_invitee, created


async def _answers(client, headers, gathering_id: str) -> list:
    response = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert response.status_code == 200, response.text
    return [occurrence["caller_response"] for occurrence in response.json()["occurrences"]]


async def test_the_detail_carries_each_dates_own_answer_and_no_one_elses(client, capsys):
    host, invitee, created = await _host_and_invitee(client, capsys, "cr-host@example.com", "cr-guest@example.com")
    ids = [occurrence["id"] for occurrence in created["occurrences"]]

    # Nobody has answered: every date null, the key present on each.
    assert await _answers(client, host, created["id"]) == [None, None, None]
    assert await _answers(client, invitee, created["id"]) == [None, None, None]

    assert (await _put_rsvp(client, invitee, ids[0], {"response": "yes"})).status_code == 200
    assert (await _put_rsvp(client, invitee, ids[1], {"response": "maybe"})).status_code == 200
    assert (await _put_rsvp(client, host, ids[2], {"response": "no"})).status_code == 200

    # Each caller reads their own answer on each date, and null where they
    # have not answered — never the other person's.
    assert await _answers(client, invitee, created["id"]) == ["yes", "maybe", None]
    assert await _answers(client, host, created["id"]) == [None, None, "no"]

    # A changed answer is the answer read.
    assert (await _put_rsvp(client, invitee, ids[0], {"response": "no"})).status_code == 200
    assert await _answers(client, invitee, created["id"]) == ["no", "maybe", None]


async def test_a_guests_row_never_matches(client, capsys, db_session_factory):
    """A guest's RSVP has no person: the match is by the caller's person id,
    and NULL equals nothing — so no caller ever reads a guest's answer."""
    host, invitee, created = await _host_and_invitee(client, capsys, "cr-host2@example.com", "cr-guest2@example.com")
    first = created["occurrences"][0]["id"]
    async with db_session_factory() as db:
        db.add(RSVP(occurrence_id=UUID(first), person_id=None, guest_name="A guest", response=RSVPResponse.YES))
        await db.commit()

    assert await _answers(client, host, created["id"]) == [None, None, None]
    assert await _answers(client, invitee, created["id"]) == [None, None, None]


async def test_the_create_body_carries_null_on_every_date(client, capsys):
    """Nobody has answered a date that did not exist a moment ago: the create
    body carries the key, null, on every date — and the create path reads no
    RSVP to say so."""
    headers = await _signed_in_headers(client, capsys, "cr-creator@example.com")
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        created = await _create(client, headers, occurrences=DATES)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert [occurrence["caller_response"] for occurrence in created["occurrences"]] == [None, None, None]
    assert not [statement for statement in statements if "FROM rsvps" in statement]


async def test_the_patch_body_carries_no_occurrences_as_before(client, capsys):
    """`PATCH /gatherings/{id}` answers with the gathering body WITHOUT its
    dates, as it always has — so there is no occurrence to carry the field,
    and the page re-reads the detail after a save."""
    host, invitee, created = await _host_and_invitee(client, capsys, "cr-host3@example.com", "cr-guest3@example.com")
    assert (await _put_rsvp(client, host, created["occurrences"][0]["id"], {"response": "yes"})).status_code == 200
    response = await client.patch(f"/gatherings/{created['id']}", json={"title": "Renamed"}, headers=host)
    assert response.status_code == 200, response.text
    assert "occurrences" not in response.json()
    assert "caller_response" not in response.text


async def test_the_occurrence_routes_bodies_are_unchanged(client, capsys):
    """The occurrence routes answer with the date alone, as before: the page
    re-reads the gathering after every date act, and the gathering body is
    where the caller's answer rides."""
    host, invitee, created = await _host_and_invitee(client, capsys, "cr-host4@example.com", "cr-guest4@example.com")
    added = await client.post(
        f"/gatherings/{created['id']}/occurrences",
        json={"starts_at": "2026-12-22T18:00:00+00:00"},
        headers=host,
    )
    assert added.status_code == 201, added.text
    assert set(added.json()) == {"id", "gathering_id", "starts_at", "ends_at", "location", "map_url"}
    patched = await client.patch(
        f"/occurrences/{added.json()['id']}", json={"location": "the hall"}, headers=host
    )
    assert patched.status_code == 200, patched.text
    assert set(patched.json()) == {"id", "gathering_id", "starts_at", "ends_at", "location", "map_url"}
    # The detail carries the new date with the field, null.
    assert await _answers(client, host, created["id"]) == [None, None, None, None]


async def test_the_memory_view_carries_no_occurrences_and_so_no_field(client, capsys, db_session_factory):
    """A member only shared with a group's gathering reads the memory view:
    `occurrences` null — withheld, not empty — so no `caller_response` rides
    the body anywhere, even where that member once answered a date (a row
    planted to prove the withholding is the view's, not the data's)."""
    cast = await _cast(client, capsys, db_session_factory)
    shared_headers, _membership, shared_person = await _extra_member(
        client, capsys, db_session_factory, cast, "cr-shared@example.com"
    )
    created = await _create_in_group(
        client, cast.member, cast.group_id, invited=[cast.co_admin_membership], left_out=[cast.admin_membership]
    )
    async with db_session_factory() as db:
        db.add(
            RSVP(
                occurrence_id=UUID(created["occurrences"][0]["id"]),
                person_id=shared_person,
                response=RSVPResponse.YES,
            )
        )
        await db.commit()

    response = await client.get(f"/gatherings/{created['id']}", headers=shared_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["caller_view"] == "memory"
    assert body["occurrences"] is None
    assert "caller_response" not in response.text

    # The invited tier reads the field on the same gathering.
    assert await _answers(client, cast.co_admin, created["id"]) == [None]


async def test_the_answers_ride_one_statement_whatever_the_number_of_dates(client, capsys):
    """One SELECT for the caller's answers on the body's dates — never one
    per date: the statement count of a detail request is the same at one date
    and at four, and exactly one statement in it reads `rsvps`."""
    host, invitee, one = await _host_and_invitee(
        client, capsys, "cr-host5@example.com", "cr-guest5@example.com", dates=DATES[:1]
    )
    four = await _create(client, host, occurrences=DATES + [{"starts_at": "2026-12-22T18:00:00+00:00"}])
    for occurrence in four["occurrences"][:2]:
        assert (await _put_rsvp(client, host, occurrence["id"], {"response": "yes"})).status_code == 200

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert (await client.get(f"/gatherings/{one['id']}", headers=host)).status_code == 200
        at_one_date = len(statements)
        rsvp_reads_at_one = [s for s in statements if "FROM rsvps" in s]
        statements.clear()
        assert (await client.get(f"/gatherings/{four['id']}", headers=host)).status_code == 200
        at_four_dates = len(statements)
        rsvp_reads_at_four = [s for s in statements if "FROM rsvps" in s]
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert at_four_dates == at_one_date
    assert len(rsvp_reads_at_one) == 1
    assert len(rsvp_reads_at_four) == 1
    assert await _answers(client, host, four["id"]) == ["yes", "yes", None, None]
