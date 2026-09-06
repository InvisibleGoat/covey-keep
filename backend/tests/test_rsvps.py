"""CK-27 — account-holder RSVPs: the "are you coming" half. CK-29 — you
RSVP for YOURSELF, with named companions instead of head counts.

The load-bearing pins: the audience is CK-25's exactly (keeper/admin/invitee
may RSVP and read; a stranger's 404 is byte-identical to a missing id); the
write is an UPSERT — a second submission updates the one row, never a 500,
never a duplicate — and since CK-29 the update path stamps updated_at while
the first write leaves it NULL (a stamp that merely mirrored created_at
would look like an answer and not be one); stay_included and companions
appear in NO authorization path — asserted directly; companions are NAMES,
not people — a write creates no person, no invitation, nothing — replaced
wholesale on every write (never appended), bounded, trimmed, blank-rejected,
and refused on a "no"; the roster's totals are computed from the names,
never stored or accepted; all three visibility settings behave, the caller
always sees their own answer, and the admin is never shown less than
HOST_ONLY would show; no email address appears in any RSVP response body;
arrival_time is a bare time that round-trips untouched; and the guest
columns stay NULL after every operation.

CK-30's pins: under ATTENDEES the roster keeps attendee names and computed
totals but carries companions: null for non-host callers (the names are a
second-order disclosure nobody opted into) — INVITEES and HOST_ONLY are
unchanged, the host's floor is unchanged, and `own` carries the caller's
companions in every mode; and removing a date that has RSVPs refuses ONCE
(409, the confirmation_required marker, the count) then obeys a
?confirm=true — the RSVPs and their companions genuinely gone via the 0015
cascade — while the last-occurrence refusal (a 422) ignores the flag
entirely and stays machine-distinguishable from it.
"""

from sqlalchemy import func, select

from app.models import (
    RSVP,
    Gathering,
    GatheringInvitation,
    Occurrence,
    Person,
    RSVPCompanion,
    RSVPListVisibility,
)
from tests.test_gatherings import _create, _field_errors, _signed_in_headers
from tests.test_invitations import _accept, _invite_token

MISSING_ID = "00000000-0000-0000-0000-000000000000"

RSVP_YES = {"response": "yes", "companions": ["Nana Pearl", "Milo"]}
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
    exactly one row per (occurrence, person), never a 500, never a duplicate —
    and the companions reflect the LATEST write, never both writes appended.
    (There is deliberately no delete endpoint: "no" IS the change of mind, and
    it keeps the record that they answered.)"""
    headers = await _signed_in_headers(client, capsys, "flipflop@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    first = await _put_rsvp(client, headers, occurrence_id, RSVP_YES)
    assert first.status_code == 200
    body = first.json()
    assert body["response"] == "yes"
    assert body["companions"] == ["Nana Pearl", "Milo"]

    second = await _put_rsvp(client, headers, occurrence_id, RSVP_NO)
    assert second.status_code == 200
    assert second.json()["response"] == "no"
    assert second.json()["companions"] == []
    assert second.json()["id"] == body["id"]

    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(RSVP))) == 1
        row = (await db.execute(select(RSVP))).scalars().one()
        assert row.response.value == "no"
        # Wholesale replacement: the "no" carried no companions, so none
        # remain — no orphans for the withdrawn names either.
        assert (
            await db.scalar(select(func.count()).select_from(RSVPCompanion))
        ) == 0


async def test_companions_replace_wholesale_never_append(
    client, capsys, db_session_factory
):
    """Each write's list IS the value: rewriting ["Nana Pearl", "Milo"] as
    ["Auntie Jo"] leaves exactly one companion row, at position 0 — and no
    orphan row for a name no longer listed."""
    headers = await _signed_in_headers(client, capsys, "reviser@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    await _put_rsvp(client, headers, occurrence_id, RSVP_YES)
    revised = await _put_rsvp(
        client, headers, occurrence_id, {"response": "yes", "companions": ["Auntie Jo"]}
    )
    assert revised.status_code == 200
    assert revised.json()["companions"] == ["Auntie Jo"]

    async with db_session_factory() as db:
        rows = (await db.execute(select(RSVPCompanion))).scalars().all()
        assert [(row.position, row.name) for row in rows] == [(0, "Auntie Jo")]


async def test_updated_at_moves_on_change_and_only_on_change(
    client, capsys, db_session_factory
):
    """The first answer leaves updated_at NULL; a changed answer stamps it and
    leaves created_at alone. A column that always equalled created_at would be
    the failure mode — it looks like an answer and isn't."""
    headers = await _signed_in_headers(client, capsys, "minded@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    first = await _put_rsvp(client, headers, occurrence_id, RSVP_YES)
    assert first.json()["updated_at"] is None
    async with db_session_factory() as db:
        row = (await db.execute(select(RSVP))).scalars().one()
        created_at_before = row.created_at
        assert row.updated_at is None

    second = await _put_rsvp(client, headers, occurrence_id, RSVP_NO)
    assert second.json()["updated_at"] is not None
    async with db_session_factory() as db:
        row = (await db.execute(select(RSVP))).scalars().one()
        assert row.updated_at is not None
        assert row.updated_at >= created_at_before
        assert row.created_at == created_at_before


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


async def test_visibility_invitees_shows_names_and_computed_totals_only(client, capsys):
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
    # Display names, companion names, and the answer's substance — never an
    # email, never a person or account id (display names are the CK-25 roster
    # rule, with more force here because more people read this list).
    assert set(body["rsvps"][0]) == {
        "id", "display_name", "response", "stay_included",
        "companions", "total", "arrival_time",
    }
    assert {row["display_name"] for row in body["rsvps"]} == {"open-host", "aunt"}
    # The total is COMPUTED from the named people — the row's person plus
    # their companions — never stored, never typed by anyone.
    by_name = {row["display_name"]: row for row in body["rsvps"]}
    assert by_name["open-host"]["companions"] == ["Nana Pearl", "Milo"]
    assert by_name["open-host"]["total"] == 3
    assert by_name["aunt"]["companions"] == []
    assert by_name["aunt"]["total"] == 1
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


async def test_companions_default_empty_trimmed_bounded_and_blank_rejected(
    client, capsys
):
    """You RSVP for yourself: no companions is the normal case and costs
    nothing. Names are trimmed and blank-rejected (the CK-20 discipline, with
    the 422 landing on the entry that provoked it), the list is bounded, and
    the dropped counts are no longer accepted anywhere in the body."""
    headers = await _signed_in_headers(client, capsys, "solo@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    body = (await _put_rsvp(client, headers, occurrence_id, {"response": "yes"})).json()
    assert body["companions"] == []
    assert "adult_count" not in body
    assert "child_count" not in body

    trimmed = await _put_rsvp(
        client, headers, occurrence_id,
        {"response": "yes", "companions": ["  Auntie Jo  "]},
    )
    assert trimmed.status_code == 200
    assert trimmed.json()["companions"] == ["Auntie Jo"]

    for blank in ("", "   "):
        refused = await _put_rsvp(
            client, headers, occurrence_id,
            {"response": "yes", "companions": ["Auntie Jo", blank]},
        )
        assert refused.status_code == 422
        # Item-level loc: ("body", "companions", 1) — the entry that provoked it.
        assert any(
            err["loc"][1] == "companions" and err["loc"][-1] == 1
            for err in refused.json()["detail"]
        )

    over_bound = await _put_rsvp(
        client, headers, occurrence_id,
        {"response": "yes", "companions": [f"Cousin {n}" for n in range(11)]},
    )
    assert over_bound.status_code == 422
    assert "companions" in _field_errors(over_bound)

    # The dropped counts draw the model's extra="forbid" refusal, never a
    # silent ignore — a client still sending them must hear about it.
    stale_client = await _put_rsvp(
        client, headers, occurrence_id, {"response": "yes", "adult_count": 2}
    )
    assert stale_client.status_code == 422


async def test_companions_go_with_yes_or_maybe_never_a_no(client, capsys):
    """"Two people are not coming with me" is not information — the noise the
    dropped head counts manufactured on declined rows (the deployed evidence
    that started CK-29). Refused at the model, stay_included's shape; an empty
    list rides a "no" fine (it is the wholesale-replace clearing path)."""
    headers = await _signed_in_headers(client, capsys, "decliner@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    refused = await _put_rsvp(
        client, headers, occurrence_id,
        {"response": "no", "companions": ["Nana Pearl"]},
    )
    assert refused.status_code == 422
    assert "companions" in _field_errors(refused)

    for ok_body in (
        {"response": "no", "companions": []},
        {"response": "maybe", "companions": ["Nana Pearl"]},
    ):
        accepted = await _put_rsvp(client, headers, occurrence_id, ok_body)
        assert accepted.status_code == 200


async def test_companions_are_names_never_people_and_never_permission(
    client, capsys, db_session_factory
):
    """A companion is something an attendee DECLARED, not somebody the system
    knows: writing one creates no person and no invitation, notifies nobody,
    and buys the writer nothing — the stay_included discipline, asserted the
    same way."""
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "thorough-host@example.com", "bringer@example.com"
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]

    async with db_session_factory() as db:
        people_before = await db.scalar(select(func.count()).select_from(Person))
        invitations_before = await db.scalar(
            select(func.count()).select_from(GatheringInvitation)
        )

    assert (
        await _put_rsvp(
            client, headers_invitee, occurrence_id,
            {"response": "yes", "companions": ["Cousin Ada", "Little Sam"]},
        )
    ).status_code == 200

    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(Person))
        ) == people_before
        assert (
            await db.scalar(select(func.count()).select_from(GatheringInvitation))
        ) == invitations_before

    # And no mutation rights came with the declaration: still an invitee,
    # still the uniform 404.
    assert (
        await client.patch(
            f"/gatherings/{gathering_id}", json={"title": "mine now"},
            headers=headers_invitee,
        )
    ).status_code == 404


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


# --- CK-30: companions out of ATTENDEES; a date that can be removed ----------


async def test_attendees_suppresses_companion_names_but_keeps_totals(client, capsys):
    """Under ATTENDEES every attendee reads the roster — and since CK-29 its
    companions are NAMES, children's first names among them: a second-order
    disclosure nobody opted into under a setting written when the field held
    integers (decided 2026-09-06). The roster stays (who answered), the
    totals stay ("three going" is the information the mode exists to give),
    the names go: companions is null — never [], which would claim "brought
    nobody" about a row whose names are merely withheld. The host still sees
    everything (the HOST_ONLY floor), INVITEES and HOST_ONLY are unchanged,
    and the caller's own names ride `own` in EVERY mode — they typed them."""
    headers_admin, headers_invitee, created = await _gathering_with_invitee(
        client, capsys, "narrow-host@example.com", "attendee@example.com"
    )
    occurrence_id = created["occurrences"][0]["id"]
    await _put_rsvp(
        client, headers_admin, occurrence_id,
        {"response": "yes", "companions": ["Nana Pearl", "Milo"]},
    )
    await _put_rsvp(
        client, headers_invitee, occurrence_id,
        {"response": "yes", "companions": ["Junie"]},
    )
    await _set_visibility(client, headers_admin, created["id"], "ATTENDEES")

    view = await _get_rsvps(client, headers_invitee, occurrence_id)
    body = view.json()
    by_name = {row["display_name"]: row for row in body["rsvps"]}
    # The roster and its computed totals survive the narrowing…
    assert set(by_name) == {"narrow-host", "attendee"}
    assert by_name["narrow-host"]["total"] == 3
    assert by_name["attendee"]["total"] == 2
    # …the names do not: null on every row (the caller's own included — their
    # names ride `own`), and the OTHER attendee's companion names appear
    # nowhere in the response text.
    assert by_name["narrow-host"]["companions"] is None
    assert by_name["attendee"]["companions"] is None
    assert "Nana Pearl" not in view.text and "Milo" not in view.text
    # `own` is deliberately ungated — the caller typed these.
    assert body["own"]["companions"] == ["Junie"]

    # The host's floor: full list, names included, in this mode as in every
    # other — a narrower setting must never show the host less.
    host_view = (await _get_rsvps(client, headers_admin, occurrence_id)).json()
    host_by_name = {row["display_name"]: row for row in host_view["rsvps"]}
    assert host_by_name["narrow-host"]["companions"] == ["Nana Pearl", "Milo"]
    assert host_by_name["attendee"]["companions"] == ["Junie"]

    # HOST_ONLY unchanged: no roster for the invitee, own still complete.
    await _set_visibility(client, headers_admin, created["id"], "HOST_ONLY")
    hidden = (await _get_rsvps(client, headers_invitee, occurrence_id)).json()
    assert hidden["rsvps"] == []
    assert hidden["own"]["companions"] == ["Junie"]

    # INVITEES unchanged: the suppression is ATTENDEES-only, so the names
    # come back — a suppression leaking into this mode fails here.
    await _set_visibility(client, headers_admin, created["id"], "INVITEES")
    wide = (await _get_rsvps(client, headers_invitee, occurrence_id)).json()
    wide_by_name = {row["display_name"]: row for row in wide["rsvps"]}
    assert wide_by_name["narrow-host"]["companions"] == ["Nana Pearl", "Milo"]
    assert wide["own"]["companions"] == ["Junie"]


async def test_delete_occurrence_with_rsvps_refuses_once_then_obeys(
    client, capsys, db_session_factory
):
    """Removing a date somebody answered used to 500 (a bare db.delete against
    an FK with no ondelete — live since CK-27). Now it refuses ONCE — a 409
    carrying the confirmation_required marker and how many answers would be
    discarded — and a repeat with ?confirm=true proceeds: the occurrence,
    its RSVPs, and (transitively) their companions genuinely gone, with the
    other dates' answers untouched. A date with NO answers deletes without
    any confirmation step — the warning appears only when there is something
    to warn about."""
    headers_admin = await _signed_in_headers(client, capsys, "remover@example.com")
    created = await _create(
        client,
        headers_admin,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-09-08T18:00:00+00:00"},
            {"starts_at": "2026-09-15T18:00:00+00:00"},
        ],
    )
    token = await _invite_token(
        client, capsys, headers_admin, created["id"], "answered@example.com"
    )
    headers_invitee = await _signed_in_headers(client, capsys, "answered@example.com")
    await _accept(client, headers_invitee, token)
    first_id, second_id, third_id = (o["id"] for o in created["occurrences"])

    # Two answers on the first date, one on the second, none on the third.
    await _put_rsvp(
        client, headers_admin, first_id,
        {"response": "yes", "companions": ["Nana Pearl", "Milo"]},
    )
    await _put_rsvp(
        client, headers_invitee, first_id, {"response": "yes", "companions": ["Junie"]}
    )
    await _put_rsvp(
        client, headers_admin, second_id, {"response": "yes", "companions": ["Milo"]}
    )

    # No answers: no confirmation step — deletes as it always has.
    assert (
        await client.delete(f"/occurrences/{third_id}", headers=headers_admin)
    ).status_code == 204

    # Answers: refused once, with the marker and the count — and nothing
    # deleted by the refusal.
    refused = await client.delete(f"/occurrences/{first_id}", headers=headers_admin)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "confirmation_required"
    assert refused.json()["detail"]["rsvp_count"] == 2
    async with db_session_factory() as db:
        surviving = (await db.execute(select(Occurrence))).scalars().all()
        assert first_id in {str(o.id) for o in surviving}
        assert (await db.scalar(select(func.count()).select_from(RSVP))) == 3
        assert (
            await db.scalar(select(func.count()).select_from(RSVPCompanion))
        ) == 4

    # Confirmed: the date goes, its answers and their companions with it —
    # and ONLY its: the second date's answer and companion survive.
    assert (
        await client.delete(
            f"/occurrences/{first_id}?confirm=true", headers=headers_admin
        )
    ).status_code == 204
    async with db_session_factory() as db:
        surviving = (await db.execute(select(Occurrence))).scalars().all()
        assert first_id not in {str(o.id) for o in surviving}
        remaining_rsvps = (await db.execute(select(RSVP))).scalars().all()
        assert [str(r.occurrence_id) for r in remaining_rsvps] == [second_id]
        remaining_companions = (
            (await db.execute(select(RSVPCompanion))).scalars().all()
        )
        assert [c.name for c in remaining_companions] == ["Milo"]


async def test_last_occurrence_refusal_ignores_confirmation_and_stays_distinct(
    client, capsys
):
    """The endpoint's OTHER refusal is not confirmable: a gathering with no
    dates is not a state this product has. The last-occurrence check runs
    before anything reads the flag, so on a date that is both the last one
    AND has answers, the 422 fires — never the 409 — and ?confirm=true
    changes nothing. The two refusals stay machine-distinguishable: 422
    field error vs 409 marker, never wording."""
    headers = await _signed_in_headers(client, capsys, "lone-date@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]
    await _put_rsvp(client, headers, occurrence_id, RSVP_YES)

    # Both refusals' preconditions hold; the last-occurrence one wins.
    unconfirmed = await client.delete(f"/occurrences/{occurrence_id}", headers=headers)
    assert unconfirmed.status_code == 422
    assert "occurrence_id" in _field_errors(unconfirmed)

    # The flag never reaches it.
    confirmed = await client.delete(
        f"/occurrences/{occurrence_id}?confirm=true", headers=headers
    )
    assert confirmed.status_code == 422
    assert "occurrence_id" in _field_errors(confirmed)

    # And nothing was deleted by either attempt.
    own = (await _get_rsvps(client, headers, occurrence_id)).json()["own"]
    assert own is not None and own["response"] == "yes"
