"""CK-27 — account-holder RSVPs: the "are you coming" half.

The load-bearing pins: the audience is CK-25's exactly (keeper/admin/invitee
may RSVP and read; a stranger's 404 is byte-identical to a missing id); the
write is an UPSERT — a second submission updates the one row, never a 500,
never a duplicate; stay_included appears in NO authorization path — an
invitee who sets it and one who does not hold identical read access, asserted
directly; all three visibility settings behave, the caller always sees their
own answer, and the admin is never shown less than HOST_ONLY would show; no
email address appears in any RSVP response body; arrival_time is a bare time
that round-trips untouched; and the guest columns stay NULL after every
operation.
"""

from sqlalchemy import func, select

from app.models import RSVP, Gathering, RSVPListVisibility
from tests.test_gatherings import _create, _field_errors, _signed_in_headers
from tests.test_invitations import _accept, _invite_token

MISSING_ID = "00000000-0000-0000-0000-000000000000"

RSVP_YES = {"response": "yes", "adult_count": 2, "child_count": 1}
RSVP_NO = {"response": "no"}


async def _gathering_with_invitee(client, capsys, admin_addr, invitee_addr):
    """An admin, a gathering with one occurrence, and an accepted invitee —
    the smallest CK-25 audience with both arms populated."""
    headers_admin = await _signed_in_headers(client, capsys, admin_addr)
    created = await _create(
        client,
        headers_admin,
        occurrences=[{"starts_at": "2026-09-01T18:00:00+00:00"}],
    )
    token = await _invite_token(
        client, capsys, headers_admin, created["id"], invitee_addr
    )
    headers_invitee = await _signed_in_headers(client, capsys, invitee_addr)
    await _accept(client, headers_invitee, token)
    return headers_admin, headers_invitee, created


async def _put_rsvp(client, headers, occurrence_id, body):
    return await client.put(
        f"/occurrences/{occurrence_id}/rsvp", json=body, headers=headers
    )


async def _get_rsvps(client, headers, occurrence_id):
    return await client.get(f"/occurrences/{occurrence_id}/rsvps", headers=headers)


async def _set_visibility(client, headers, gathering_id, value: str):
    response = await client.patch(
        f"/gatherings/{gathering_id}",
        json={"rsvp_list_visibility": value},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_rsvp_endpoints_require_auth(client):
    assert (
        await client.put(f"/occurrences/{MISSING_ID}/rsvp", json=RSVP_NO)
    ).status_code == 401
    assert (await client.get(f"/occurrences/{MISSING_ID}/rsvps")).status_code == 401


async def test_audience_matrix_and_the_404_posture(client, capsys):
    """Keeper/admin and invitee may RSVP and read; a stranger gets a 404
    byte-identical to a missing id on BOTH endpoints — a signed-in stranger
    must not learn an occurrence exists by RSVPing to it."""
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "host@example.com", "cousin@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    headers_stranger = await _signed_in_headers(client, capsys, "stranger@example.com")

    assert (
        await _put_rsvp(client, headers_admin, occurrence_id, RSVP_YES)
    ).status_code == 200
    assert (
        await _put_rsvp(client, headers_invitee, occurrence_id, RSVP_NO)
    ).status_code == 200
    assert (await _get_rsvps(client, headers_admin, occurrence_id)).status_code == 200
    assert (await _get_rsvps(client, headers_invitee, occurrence_id)).status_code == 200

    foreign_put = await _put_rsvp(client, headers_stranger, occurrence_id, RSVP_YES)
    missing_put = await _put_rsvp(client, headers_stranger, MISSING_ID, RSVP_YES)
    assert foreign_put.status_code == 404
    assert missing_put.status_code == 404
    assert foreign_put.content == missing_put.content

    foreign_get = await _get_rsvps(client, headers_stranger, occurrence_id)
    missing_get = await _get_rsvps(client, headers_stranger, MISSING_ID)
    assert foreign_get.status_code == 404
    assert missing_get.status_code == 404
    assert foreign_get.content == missing_get.content


async def test_upsert_updates_the_one_row(client, capsys, db_session_factory):
    """Changing your mind is the normal case: the second submission updates —
    exactly one row per (occurrence, person), never a 500, never a duplicate.
    (There is deliberately no delete endpoint: "no" IS the change of mind, and
    it keeps the record that they answered.)"""
    headers = await _signed_in_headers(client, capsys, "flipflop@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    first = await _put_rsvp(client, headers, occurrence_id, RSVP_YES)
    assert first.status_code == 200
    body = first.json()
    assert body["response"] == "yes"
    assert body["adult_count"] == 2
    assert body["child_count"] == 1

    second = await _put_rsvp(client, headers, occurrence_id, RSVP_NO)
    assert second.status_code == 200
    assert second.json()["response"] == "no"
    assert second.json()["id"] == body["id"]

    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(RSVP))) == 1
        row = (await db.execute(select(RSVP))).scalars().one()
        assert row.response.value == "no"
        # PUT replaces the whole answer: the omitted counts land as defaults.
        assert row.adult_count == 1
        assert row.child_count == 0


async def test_stay_included_never_affects_access(client, capsys):
    """THE pin the terminology record exists for: the keep-me-included flag
    changes interest, never access. Two invitees answer "no" — one with the
    flag, one without — and their read surfaces are identical, asserted
    directly."""
    headers_admin, headers_flagged, created = await _gathering_with_invitee(
        client, capsys, "organizer@example.com", "alaska@example.com"
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]
    token = await _invite_token(
        client, capsys, headers_admin, gathering_id, "plain@example.com"
    )
    headers_plain = await _signed_in_headers(client, capsys, "plain@example.com")
    await _accept(client, headers_plain, token)

    assert (
        await _put_rsvp(
            client, headers_flagged, occurrence_id,
            {"response": "no", "stay_included": True},
        )
    ).status_code == 200
    assert (
        await _put_rsvp(
            client, headers_plain, occurrence_id,
            {"response": "no", "stay_included": False},
        )
    ).status_code == 200

    # Identical read access, surface by surface: the detail body, the list,
    # and the RSVP roster (both admitted — the default visibility is INVITEES).
    flagged_detail = await client.get(f"/gatherings/{gathering_id}", headers=headers_flagged)
    plain_detail = await client.get(f"/gatherings/{gathering_id}", headers=headers_plain)
    assert flagged_detail.status_code == plain_detail.status_code == 200
    assert flagged_detail.json() == plain_detail.json()

    flagged_list = await client.get("/gatherings", headers=headers_flagged)
    plain_list = await client.get("/gatherings", headers=headers_plain)
    assert flagged_list.json() == plain_list.json()

    flagged_rsvps = await _get_rsvps(client, headers_flagged, occurrence_id)
    plain_rsvps = await _get_rsvps(client, headers_plain, occurrence_id)
    assert flagged_rsvps.status_code == plain_rsvps.status_code == 200
    assert flagged_rsvps.json()["rsvps"] == plain_rsvps.json()["rsvps"]

    # And the flag buys no mutation rights: still an invitee, still 404.
    assert (
        await client.patch(
            f"/gatherings/{gathering_id}", json={"title": "mine now"},
            headers=headers_flagged,
        )
    ).status_code == 404


async def test_stay_included_accompanies_a_no_only(client, capsys):
    # "Keep me included" says "I can't make it BUT..." — with any other
    # response it is meaningless, and a stored meaningless value is a second
    # representation waiting to disagree. Field-level 422, never stored.
    headers = await _signed_in_headers(client, capsys, "eager@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    for response_value in ("yes", "maybe"):
        refused = await _put_rsvp(
            client, headers, occurrence_id,
            {"response": response_value, "stay_included": True},
        )
        assert refused.status_code == 422
        assert "stay_included" in _field_errors(refused)

    accepted = await _put_rsvp(
        client, headers, occurrence_id, {"response": "no", "stay_included": True}
    )
    assert accepted.status_code == 200
    assert accepted.json()["stay_included"] is True


async def test_visibility_host_only(client, capsys):
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "quiet-host@example.com", "guest@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    await _set_visibility(client, headers_admin, created["id"], "HOST_ONLY")

    await _put_rsvp(client, headers_admin, occurrence_id, RSVP_YES)
    await _put_rsvp(client, headers_invitee, occurrence_id, RSVP_NO)

    admin_view = (await _get_rsvps(client, headers_admin, occurrence_id)).json()
    assert admin_view["visibility"] == "HOST_ONLY"
    assert len(admin_view["rsvps"]) == 2

    # Everyone else gets their own RSVP and nothing more.
    invitee_view = (await _get_rsvps(client, headers_invitee, occurrence_id)).json()
    assert invitee_view["rsvps"] == []
    assert invitee_view["own"] is not None
    assert invitee_view["own"]["response"] == "no"


async def test_visibility_invitees_shows_display_names_and_counts_only(client, capsys):
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "open-host@example.com", "aunt@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    await _put_rsvp(client, headers_admin, occurrence_id, RSVP_YES)
    await _put_rsvp(client, headers_invitee, occurrence_id, RSVP_NO)

    view = await _get_rsvps(client, headers_invitee, occurrence_id)
    body = view.json()
    assert body["visibility"] == "INVITEES"
    assert len(body["rsvps"]) == 2
    # Display names and the answer's substance — never an email, never a
    # person or account id (display names are the CK-25 roster rule, with
    # more force here because more people read this list).
    assert set(body["rsvps"][0]) == {
        "id", "display_name", "response", "stay_included",
        "adult_count", "child_count", "arrival_time",
    }
    assert {row["display_name"] for row in body["rsvps"]} == {"open-host", "aunt"}
    # No email address in ANY RSVP response body (display names are bare
    # localparts, so "@" appearing at all would mean an address leaked).
    assert "@" not in view.text


async def test_visibility_attendees(client, capsys):
    """ATTENDEES: those whose own response is yes see the list; a "no" (or an
    unanswered caller) sees only their own answer — and the ADMIN still sees
    everything without having answered at all: every mode includes the host,
    because a narrower setting must never show the host less than HOST_ONLY
    does."""
    headers_admin, headers_yes, created = await _gathering_with_invitee(
        client, capsys, "counter@example.com", "coming@example.com"
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]
    token = await _invite_token(
        client, capsys, headers_admin, gathering_id, "absent@example.com"
    )
    headers_no = await _signed_in_headers(client, capsys, "absent@example.com")
    await _accept(client, headers_no, token)
    await _set_visibility(client, headers_admin, gathering_id, "ATTENDEES")

    await _put_rsvp(client, headers_yes, occurrence_id, RSVP_YES)
    await _put_rsvp(client, headers_no, occurrence_id, RSVP_NO)

    yes_view = (await _get_rsvps(client, headers_yes, occurrence_id)).json()
    assert len(yes_view["rsvps"]) == 2

    no_view = (await _get_rsvps(client, headers_no, occurrence_id)).json()
    assert no_view["rsvps"] == []
    assert no_view["own"]["response"] == "no"

    # The admin has not RSVPed — and still sees the full list.
    admin_view = (await _get_rsvps(client, headers_admin, occurrence_id)).json()
    assert admin_view["own"] is None
    assert len(admin_view["rsvps"]) == 2


async def test_arrival_time_is_a_bare_time_and_round_trips_untouched(client, capsys):
    """arrival_time has no date and no zone — it is the clock time at the
    gathering, and the CK-17 profile-zone conversion must never touch it. The
    server stores and returns exactly the wall time sent (the frontend pin
    against a differing profile zone lives in lib/rsvps.test.ts)."""
    headers = await _signed_in_headers(client, capsys, "punctual@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    saved = await _put_rsvp(
        client, headers, occurrence_id, {"response": "yes", "arrival_time": "15:30"}
    )
    assert saved.status_code == 200
    assert saved.json()["arrival_time"] == "15:30:00"
    own = (await _get_rsvps(client, headers, occurrence_id)).json()["own"]
    assert own["arrival_time"] == "15:30:00"

    # Midnight is a real arrival time, not a falsy one.
    at_midnight = await _put_rsvp(
        client, headers, occurrence_id, {"response": "yes", "arrival_time": "00:00"}
    )
    assert at_midnight.json()["arrival_time"] == "00:00:00"

    # An offset-carrying value is refused, never silently normalized — the
    # zone arithmetic this column is designed to stay out of.
    zoned = await _put_rsvp(
        client, headers, occurrence_id,
        {"response": "yes", "arrival_time": "15:30:00+02:00"},
    )
    assert zoned.status_code == 422
    assert "arrival_time" in _field_errors(zoned)

    # Absent means none: the next full replacement clears it.
    cleared = await _put_rsvp(client, headers, occurrence_id, {"response": "yes"})
    assert cleared.json()["arrival_time"] is None


async def test_counts_default_to_one_and_zero_and_are_bounded(client, capsys):
    headers = await _signed_in_headers(client, capsys, "solo@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    body = (await _put_rsvp(client, headers, occurrence_id, {"response": "yes"})).json()
    assert body["adult_count"] == 1
    assert body["child_count"] == 0

    for bad in ({"adult_count": -1}, {"child_count": -2}, {"adult_count": 100}):
        refused = await _put_rsvp(
            client, headers, occurrence_id, {"response": "yes", **bad}
        )
        # Bounded at the model: an unbounded count is a SmallInteger overflow
        # surfacing as a 500.
        assert refused.status_code == 422


async def test_guest_columns_stay_null_after_every_operation(
    client, capsys, db_session_factory
):
    # Guest RSVPs are their own later phase: nothing this phase writes may
    # touch guest_name/guest_email, upsert included.
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "careful@example.com", "visitor@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    await _put_rsvp(client, headers_admin, occurrence_id, RSVP_YES)
    await _put_rsvp(client, headers_invitee, occurrence_id, RSVP_NO)
    await _put_rsvp(
        client, headers_invitee, occurrence_id,
        {"response": "no", "stay_included": True, "arrival_time": "12:00"},
    )

    async with db_session_factory() as db:
        rows = (await db.execute(select(RSVP))).scalars().all()
        assert len(rows) == 2
        for row in rows:
            assert row.guest_name is None
            assert row.guest_email is None
            assert row.person_id is not None


async def test_visibility_is_explicit_on_create_and_admin_patchable(
    client, capsys, db_session_factory
):
    """INVITEES on every create — set by application code, in the body and in
    the row (the requires_approval discipline: the server default backfilled
    0012 and is never relied on). The setting is the admin's alone: an
    invitee's PATCH is the uniform 404, and explicit null is refused — the
    list always has SOME visibility."""
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "setter@example.com", "reader@example.com"
    )
    assert created["rsvp_list_visibility"] == "INVITEES"
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.rsvp_list_visibility == RSVPListVisibility.INVITEES

    patched = await _set_visibility(client, headers_admin, created["id"], "ATTENDEES")
    assert patched["rsvp_list_visibility"] == "ATTENDEES"

    assert (
        await client.patch(
            f"/gatherings/{created['id']}",
            json={"rsvp_list_visibility": "HOST_ONLY"},
            headers=headers_invitee,
        )
    ).status_code == 404

    null_clear = await client.patch(
        f"/gatherings/{created['id']}",
        json={"rsvp_list_visibility": None},
        headers=headers_admin,
    )
    assert null_clear.status_code == 422
    assert "rsvp_list_visibility" in _field_errors(null_clear)

    garbage = await client.patch(
        f"/gatherings/{created['id']}",
        json={"rsvp_list_visibility": "EVERYONE"},
        headers=headers_admin,
    )
    assert garbage.status_code == 422


async def test_unanswered_is_unanswered_never_a_defaulted_no(client, capsys):
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "asker@example.com", "undecided@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    await _put_rsvp(client, headers_admin, occurrence_id, RSVP_YES)

    view = (await _get_rsvps(client, headers_invitee, occurrence_id)).json()
    # The invitee has not answered: own is null, and no row exists for them —
    # the roster shows only people who actually answered.
    assert view["own"] is None
    assert [row["display_name"] for row in view["rsvps"]] == ["asker"]
