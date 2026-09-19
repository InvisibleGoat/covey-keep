"""CK-16 — gathering and occurrence CRUD, the keeper schema's first surface.

The load-bearing pins: creation births the gathering, its occurrences, and the
creator written as its keeper (`keeper_account_id`, since CK-49b — a
`kept_gatherings` row until then) in ONE transaction (creator = keeper +
admin, keeper record §9.2); `requires_approval` is NULL because the
application set NOTHING (CK-41 — nobody has decided; the publication ladder
resolves the effective value the body carries, and the column has no server
default to fall back on: the pin the inherit rule depends on);
non-permitted access is a 404 indistinguishable from a missing row; and the
CK-13 deletion lapse now has a real, API-created subject instead of a fixture.
"""

from datetime import datetime, timezone

from sqlalchemy import event, func, select

from app.db import engine
from app.models import (
    Account,
    AccountKind,
    Gathering,
    GatheringType,
    Occurrence,
    Person,
    PublicationState,
    RSVPListVisibility,
)
from app.services.keeping import account_usage, keep
from tests.test_auth import _sign_in

DELETE_BODY = {"confirm": "DELETE"}


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


def _field_errors(response) -> set[str]:
    """The field names the 422 body points at (loc: [..., <field>]) — same
    shape for FastAPI validation errors and the router's app-layer 422s."""
    return {tuple(err["loc"])[-1] for err in response.json()["detail"]}


async def _create(client, headers, **overrides) -> dict:
    body = {
        "gathering_type": "potluck",
        "title": "August potluck",
        "occurrences": [{"starts_at": "2026-09-01T18:00:00+00:00"}],
    }
    body.update(overrides)
    response = await client.post("/gatherings", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _account_for(db, address: str) -> Account:
    person = (
        await db.execute(select(Person).where(Person.email == address))
    ).scalars().one()
    return (
        await db.execute(select(Account).where(Account.id == person.account_id))
    ).scalars().one()


async def test_gatherings_require_auth(client):
    some_id = "00000000-0000-0000-0000-000000000000"
    assert (await client.post("/gatherings", json={})).status_code == 401
    assert (await client.get("/gatherings")).status_code == 401
    assert (await client.get(f"/gatherings/{some_id}")).status_code == 401
    assert (await client.patch(f"/gatherings/{some_id}", json={"title": "x"})).status_code == 401
    assert (
        await client.post(f"/gatherings/{some_id}/occurrences", json={})
    ).status_code == 401
    assert (await client.patch(f"/occurrences/{some_id}", json={})).status_code == 401
    assert (await client.delete(f"/occurrences/{some_id}")).status_code == 401


# --- creation: one transaction, three facts -----------------------------------


async def test_create_births_gathering_keeper_and_admin_together(
    client, capsys, db_session_factory
):
    address = "creator@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    body = await _create(
        client,
        headers,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00", "location": "the park"}
        ],
    )
    assert body["title"] == "August potluck"
    assert len(body["occurrences"]) == 1
    assert body["occurrences"][0]["location"] == "the park"

    async with db_session_factory() as db:
        account = await _account_for(db, address)
        gathering = (await db.execute(select(Gathering))).scalars().one()
        # The three facts of the creation transaction (keeper record §9.2):
        # the creator as keeper (the column, since CK-49b), host held by the
        # creator, and no grace stamp — the gathering was never keeperless,
        # even transiently.
        assert gathering.keeper_account_id == account.id
        assert gathering.host_account_id == account.id
        assert gathering.created_by_account_id == account.id
        assert gathering.last_keeper_left_at is None
        # The gathering itself is live — requires_approval moderates
        # contributions within it, never its own visibility.
        assert gathering.publication_state.value == "live"
        assert gathering.updated_at is None


async def test_create_leaves_the_gate_undecided_and_the_body_reads_the_effective_value(
    client, capsys, db_session_factory
):
    """CK-41: creation writes NOTHING to `requires_approval` — the column is
    NULL, "nobody has decided", and there is no server default to fall back
    on (0019 dropped it), so a value here can only mean the create path
    started deciding again — the inversion of decision 22, and exactly what
    it must not do. The body carries the EFFECTIVE value through the
    ladder (a person's groupless, private gathering resolves open: false)
    beside the host's own setting (null = inherited), on create, detail,
    list and patch alike."""
    headers = await _signed_in_headers(client, capsys, "undecided@example.com")
    body = await _create(client, headers)
    assert body["requires_approval"] is False
    assert body["requires_approval_override"] is None
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is None

    detail = await client.get(f"/gatherings/{body['id']}", headers=headers)
    assert detail.json()["requires_approval"] is False
    assert detail.json()["requires_approval_override"] is None
    (item,) = (await client.get("/gatherings", headers=headers)).json()["gatherings"]
    assert item["requires_approval"] is False
    assert item["requires_approval_override"] is None
    patched = await client.patch(
        f"/gatherings/{body['id']}", json={"title": "Renamed"}, headers=headers
    )
    assert patched.json()["requires_approval"] is False
    assert patched.json()["requires_approval_override"] is None

    # The host's own setting, once one exists, is rung 1: the body's
    # effective value follows it and the override field carries it. Written
    # directly — no endpoint writes it until CK-44.
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        gathering.requires_approval = True
        await db.commit()
    detail = await client.get(f"/gatherings/{body['id']}", headers=headers)
    assert detail.json()["requires_approval"] is True
    assert detail.json()["requires_approval_override"] is True


async def test_an_org_hosted_gathering_reads_gated_by_the_backstop(
    client, capsys, db_session_factory
):
    """The ladder's org backstop through the router's wiring — the detail
    body and the list's one-statement join both carry the host's kind.
    No endpoint can create an org-hosted gathering yet (no organization
    account can exist), so the gathering is constructed directly: the
    branch's real subject arrives with the church layer, and this pin
    exercises the WIRING, not a user flow (handoff §7.2 — an assertion
    needs a subject; this is the wiring's)."""
    address = "congregant@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        church = Account(kind=AccountKind.ORGANIZATION)
        db.add(church)
        await db.flush()
        gathering = Gathering(
            created_by_account_id=church.id,
            host_account_id=church.id,
            gathering_type=GatheringType.CHURCH_GATHERING,
            title="VBS week",
            rsvp_list_visibility=RSVPListVisibility.INVITEES,
            publication_state=PublicationState.LIVE,
        )
        db.add(gathering)
        await db.flush()
        db.add(Occurrence(gathering_id=gathering.id, starts_at=datetime(2026, 9, 1, 18, tzinfo=timezone.utc)))
        # The caller keeps it, so they are in the read audience.
        await keep(db, await _account_for(db, address), gathering)
        await db.commit()
        gathering_id = str(gathering.id)
        assert gathering.requires_approval is None  # nobody decided

    detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["requires_approval"] is True  # the backstop
    assert detail.json()["requires_approval_override"] is None
    (item,) = (await client.get("/gatherings", headers=headers)).json()["gatherings"]
    assert item["id"] == gathering_id
    assert item["requires_approval"] is True
    assert item["requires_approval_override"] is None


# --- the memorial gate, both directions ---------------------------------------


async def test_memorial_requires_decedent_name_both_directions(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "memorialist@example.com")
    occurrences = [{"starts_at": "2026-09-01T18:00:00+00:00"}]

    # A memorial without a decedent name is a field-level 422 from the
    # Pydantic layer — never the CHECK constraint surfacing as a 500.
    response = await client.post(
        "/gatherings",
        json={"gathering_type": "memorial", "title": "For Edith", "occurrences": occurrences},
        headers=headers,
    )
    assert response.status_code == 422
    assert "memorial_decedent_name" in _field_errors(response)

    # A blank name is no name.
    response = await client.post(
        "/gatherings",
        json={
            "gathering_type": "memorial",
            "title": "For Edith",
            "memorial_decedent_name": "   ",
            "occurrences": occurrences,
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert "memorial_decedent_name" in _field_errors(response)

    # And only a memorial carries one.
    response = await client.post(
        "/gatherings",
        json={
            "gathering_type": "potluck",
            "title": "August potluck",
            "memorial_decedent_name": "Edith Hanson",
            "occurrences": occurrences,
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert "memorial_decedent_name" in _field_errors(response)

    body = await _create(
        client,
        headers,
        gathering_type="memorial",
        title="For Edith",
        memorial_decedent_name="Edith Hanson",
    )
    assert body["memorial_decedent_name"] == "Edith Hanson"

    # The CK-13 exemptions hold untouched for an API-created memorial: kept,
    # yet excluded from usage and never stamped into grace.
    async with db_session_factory() as db:
        account = await _account_for(db, "memorialist@example.com")
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.last_keeper_left_at is None
        assert await account_usage(db, account) == 0


# --- the season cap -----------------------------------------------------------


async def test_season_cap_at_create(client, capsys):
    headers = await _signed_in_headers(client, capsys, "coach@example.com")

    # 366 days from earliest starts_at: rejected, and the message names the span.
    response = await client.post(
        "/gatherings",
        json={
            "gathering_type": "season",
            "title": "Bowling 2026-27",
            "occurrences": [
                {"starts_at": "2026-09-01T18:00:00+00:00"},
                {"starts_at": "2027-09-02T18:00:00+00:00"},
            ],
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert "occurrences" in _field_errors(response)
    assert "366 days" in response.text

    # Exactly one year is the boundary, inclusive.
    await _create(
        client,
        headers,
        gathering_type="season",
        title="Bowling 2026-27",
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2027-09-01T18:00:00+00:00"},
        ],
    )

    # The cap is a SEASON rule: nothing else in the product treats a season
    # specially, and no other type gets the cap.
    await _create(
        client,
        headers,
        title="Decade reunion pair",
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2030-09-01T18:00:00+00:00"},
        ],
    )


async def test_season_cap_at_occurrence_add(client, capsys):
    headers = await _signed_in_headers(client, capsys, "leaguerunner@example.com")
    season = await _create(
        client,
        headers,
        gathering_type="season",
        title="Bowling 2026-27",
        occurrences=[{"starts_at": "2026-09-01T18:00:00+00:00"}],
    )
    season_id = season["id"]

    # Within the year: fine.
    response = await client.post(
        f"/gatherings/{season_id}/occurrences",
        json={"starts_at": "2027-03-01T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 201

    # Beyond one year of the earliest date: rejected, span named.
    response = await client.post(
        f"/gatherings/{season_id}/occurrences",
        json={"starts_at": "2027-09-02T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "starts_at" in _field_errors(response)
    assert "366 days" in response.text

    # The span is symmetric: an occurrence far EARLIER than the earliest
    # existing date breaches it just the same.
    response = await client.post(
        f"/gatherings/{season_id}/occurrences",
        json={"starts_at": "2025-08-01T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 422

    # A non-season takes an occurrence years out without complaint.
    potluck = await _create(client, headers, title="Annual-ish potluck")
    response = await client.post(
        f"/gatherings/{potluck['id']}/occurrences",
        json={"starts_at": "2030-09-01T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 201


# --- reads: the keeper's list, and 404-not-403 --------------------------------


async def test_list_shows_only_kept_gatherings_newest_first(client, capsys):
    headers_a = await _signed_in_headers(client, capsys, "lister@example.com")
    headers_b = await _signed_in_headers(client, capsys, "other@example.com")
    first = await _create(client, headers_a, title="First created")
    second = await _create(client, headers_a, title="Second created")
    await _create(client, headers_b, title="Someone else's")

    response = await client.get("/gatherings", headers=headers_a)
    assert response.status_code == 200
    titles = [g["title"] for g in response.json()["gatherings"]]
    assert titles == ["Second created", "First created"]
    ids = {g["id"] for g in response.json()["gatherings"]}
    assert ids == {first["id"], second["id"]}

    response = await client.get("/gatherings", headers=headers_b)
    assert [g["title"] for g in response.json()["gatherings"]] == ["Someone else's"]


async def test_get_gathering_includes_occurrences_sorted_and_stamps_nothing(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "reader@example.com")
    created = await _create(
        client,
        headers,
        occurrences=[
            {"starts_at": "2026-10-01T18:00:00+00:00"},
            {"starts_at": "2026-09-01T18:00:00+00:00", "location": "the park"},
        ],
    )
    response = await client.get(f"/gatherings/{created['id']}", headers=headers)
    assert response.status_code == 200
    body = response.json()
    starts = [o["starts_at"] for o in body["occurrences"]]
    assert starts == sorted(starts)
    assert body["occurrences"][0]["location"] == "the park"
    # A read is not an edit: updated_at stays unstamped.
    assert body["updated_at"] is None
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.updated_at is None


async def test_non_permitted_read_is_404_indistinguishable_from_missing(
    client, capsys
):
    headers_a = await _signed_in_headers(client, capsys, "owner@example.com")
    headers_b = await _signed_in_headers(client, capsys, "prober@example.com")
    created = await _create(client, headers_a)

    foreign = await client.get(f"/gatherings/{created['id']}", headers=headers_b)
    missing = await client.get(
        "/gatherings/00000000-0000-0000-0000-000000000000", headers=headers_b
    )
    # 404, not 403 — and byte-identical to a genuinely missing id: the
    # existence of a gathering is not public information.
    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.content == missing.content


# --- mutations: admin only, field-limited, stamped ----------------------------


async def test_patch_gathering_stamps_updated_at_and_limits_the_surface(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "editor@example.com")
    created = await _create(client, headers)
    gathering_id = created["id"]

    response = await client.patch(
        f"/gatherings/{gathering_id}", json={"title": "  Renamed potluck  "}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Renamed potluck"
    assert response.json()["updated_at"] is not None
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.title == "Renamed potluck"
        assert gathering.updated_at is not None

    # The patchable surface is title + memorial_decedent_name +
    # rsvp_list_visibility + requires_approval_override ONLY — unknown
    # fields are a 422, never a silent no-op (the /me/profile convention).
    # `requires_approval` — the EFFECTIVE value — is readable and NOT
    # writable (CK-41): one writable representation of the gate, never
    # two. (Narrowed at CK-44: `requires_approval_override` left this
    # refused list the day it became the host's to write; its own pins are
    # under "the host's switch" below. The effective field stays here.)
    for bad in (
        {"requires_approval": False},
        {"requires_approval": True},
        {"publication_state": "removed"},
        {"host_account_id": None},
        {"gathering_type": "memorial"},
        {},
        {"title": ""},
    ):
        response = await client.patch(
            f"/gatherings/{gathering_id}", json=bad, headers=headers
        )
        assert response.status_code == 422, bad
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is None  # still nobody's decision
        assert gathering.title == "Renamed potluck"


async def test_patch_decedent_name_only_on_a_memorial(client, capsys):
    headers = await _signed_in_headers(client, capsys, "corrector@example.com")
    memorial = await _create(
        client,
        headers,
        gathering_type="memorial",
        title="For Edith",
        memorial_decedent_name="Edith Hansen",
    )
    response = await client.patch(
        f"/gatherings/{memorial['id']}",
        json={"memorial_decedent_name": "Edith Hanson"},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["memorial_decedent_name"] == "Edith Hanson"

    # On any other type the name is rejected at the app layer — the CHECK
    # constraint stays the backstop, never the UX.
    potluck = await _create(client, headers)
    response = await client.patch(
        f"/gatherings/{potluck['id']}",
        json={"memorial_decedent_name": "Edith Hanson"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "memorial_decedent_name" in _field_errors(response)


async def test_mutations_are_admin_only_and_404_for_others(client, capsys):
    headers_a = await _signed_in_headers(client, capsys, "admin@example.com")
    headers_b = await _signed_in_headers(client, capsys, "stranger@example.com")
    created = await _create(
        client,
        headers_a,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-10-01T18:00:00+00:00"},
        ],
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]

    # Every mutation, same answer for a non-admin: 404, never 403.
    assert (
        await client.patch(
            f"/gatherings/{gathering_id}", json={"title": "hijacked"}, headers=headers_b
        )
    ).status_code == 404
    assert (
        await client.post(
            f"/gatherings/{gathering_id}/occurrences",
            json={"starts_at": "2026-11-01T18:00:00+00:00"},
            headers=headers_b,
        )
    ).status_code == 404
    assert (
        await client.patch(
            f"/occurrences/{occurrence_id}",
            json={"location": "hijacked"},
            headers=headers_b,
        )
    ).status_code == 404
    assert (
        await client.delete(f"/occurrences/{occurrence_id}", headers=headers_b)
    ).status_code == 404

    # The admin's view is untouched by any of it.
    response = await client.get(f"/gatherings/{gathering_id}", headers=headers_a)
    assert response.json()["title"] == "August potluck"
    assert len(response.json()["occurrences"]) == 2


async def test_patch_occurrence_updates_fields(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "scheduler@example.com")
    created = await _create(client, headers)
    occurrence_id = created["occurrences"][0]["id"]

    response = await client.patch(
        f"/occurrences/{occurrence_id}",
        json={
            "starts_at": "2026-09-05T17:00:00+00:00",
            "ends_at": "2026-09-05T21:00:00+00:00",
            "location": "the backyard",
            "map_url": "https://maps.example.com/backyard",
        },
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["location"] == "the backyard"
    assert body["ends_at"] is not None

    # An empty patch and a zoneless timestamp are both 422s, never a 500.
    assert (
        await client.patch(f"/occurrences/{occurrence_id}", json={}, headers=headers)
    ).status_code == 422
    response = await client.patch(
        f"/occurrences/{occurrence_id}",
        json={"starts_at": "2026-09-05T17:00:00"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "starts_at" in _field_errors(response)

    async with db_session_factory() as db:
        occurrence = (await db.execute(select(Occurrence))).scalars().one()
        assert occurrence.location == "the backyard"
        assert occurrence.starts_at == datetime(2026, 9, 5, 17, 0, tzinfo=timezone.utc)


async def test_patch_occurrence_respects_the_season_cap(client, capsys):
    # Moving a date is the third way a season's span can grow — the cap holds
    # here exactly as at create and at add.
    headers = await _signed_in_headers(client, capsys, "rescheduler@example.com")
    season = await _create(
        client,
        headers,
        gathering_type="season",
        title="Bowling 2026-27",
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2027-03-01T18:00:00+00:00"},
        ],
    )
    late_id = season["occurrences"][1]["id"]
    response = await client.patch(
        f"/occurrences/{late_id}",
        json={"starts_at": "2027-09-02T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "starts_at" in _field_errors(response)
    # Within the year the move is fine.
    response = await client.patch(
        f"/occurrences/{late_id}",
        json={"starts_at": "2027-08-01T18:00:00+00:00"},
        headers=headers,
    )
    assert response.status_code == 200


async def test_delete_occurrence_refuses_the_last_one(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "pruner@example.com")
    created = await _create(
        client,
        headers,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-10-01T18:00:00+00:00"},
        ],
    )
    first_id = created["occurrences"][0]["id"]
    second_id = created["occurrences"][1]["id"]

    assert (
        await client.delete(f"/occurrences/{first_id}", headers=headers)
    ).status_code == 204

    # A gathering with no dates is not a state this product has.
    response = await client.delete(f"/occurrences/{second_id}", headers=headers)
    assert response.status_code == 422
    async with db_session_factory() as db:
        remaining = (await db.execute(select(Occurrence))).scalars().all()
        assert [str(o.id) for o in remaining] == [second_id]


# --- the list's occurrence summary (CK-20) ------------------------------------


async def test_list_carries_next_occurrence_and_count(client, capsys):
    headers = await _signed_in_headers(client, capsys, "planner@example.com")

    # All future: the lead is the EARLIEST upcoming date.
    future = await _create(
        client,
        headers,
        title="All future",
        occurrences=[
            {"starts_at": "2035-06-01T18:00:00+00:00"},
            {"starts_at": "2035-01-01T18:00:00+00:00"},
        ],
    )
    # All past: nothing upcoming, so the lead is the LATEST past date.
    past = await _create(
        client,
        headers,
        title="All past",
        occurrences=[
            {"starts_at": "2020-01-01T18:00:00+00:00"},
            {"starts_at": "2020-06-01T18:00:00+00:00"},
        ],
    )
    # Mixed: any upcoming date outranks every past one, however recent.
    mixed = await _create(
        client,
        headers,
        title="Mixed",
        occurrences=[
            {"starts_at": "2020-06-01T18:00:00+00:00"},
            {"starts_at": "2035-06-01T18:00:00+00:00"},
            {"starts_at": "2035-01-01T18:00:00+00:00"},
        ],
    )

    response = await client.get("/gatherings", headers=headers)
    assert response.status_code == 200
    items = {g["title"]: g for g in response.json()["gatherings"]}
    # Newest first, unchanged by the summary.
    assert list(items) == ["Mixed", "All past", "All future"]

    # Creation echoes occurrences sorted by starts_at, so the expected lead is
    # addressable by index; comparing id AND starts_at pins the whole shape.
    assert items["All future"]["next_occurrence"] == {
        "id": future["occurrences"][0]["id"],
        "starts_at": future["occurrences"][0]["starts_at"],
    }
    assert items["All future"]["occurrence_count"] == 2

    assert items["All past"]["next_occurrence"] == {
        "id": past["occurrences"][1]["id"],
        "starts_at": past["occurrences"][1]["starts_at"],
    }
    assert items["All past"]["occurrence_count"] == 2

    assert items["Mixed"]["next_occurrence"] == {
        "id": mixed["occurrences"][1]["id"],
        "starts_at": mixed["occurrences"][1]["starts_at"],
    }
    assert items["Mixed"]["occurrence_count"] == 3


async def test_list_statement_count_does_not_scale_with_gatherings(client, capsys):
    """The occurrence summary rides ONE query — moving CK-17's client-side N+1
    into a server-side per-gathering loop would not have been a fix. Pinned by
    counting the statements a list request executes at two very different
    gathering counts: the counts must be equal, and exactly one statement in
    the request may read gatherings."""
    headers = await _signed_in_headers(client, capsys, "counter@example.com")
    await _create(client, headers, title="One")

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert (await client.get("/gatherings", headers=headers)).status_code == 200
        at_one_gathering = len(statements)

        for n in range(3):
            await _create(client, headers, title=f"More {n}")
        statements.clear()
        assert (await client.get("/gatherings", headers=headers)).status_code == 200
        at_four_gatherings = len(statements)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert at_four_gatherings == at_one_gathering
    assert len([s for s in statements if "FROM gatherings" in s]) == 1


# --- occurrence text: one representation of "no value" (CK-20) ----------------


async def test_occurrence_location_and_map_url_reject_blank_and_trim(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "placekeeper@example.com")

    # Valid values are trimmed on the way in.
    body = await _create(
        client,
        headers,
        occurrences=[
            {
                "starts_at": "2026-09-01T18:00:00+00:00",
                "location": "  the park  ",
                "map_url": "  https://maps.example.com/park  ",
            }
        ],
    )
    occ = body["occurrences"][0]
    assert occ["location"] == "the park"
    assert occ["map_url"] == "https://maps.example.com/park"

    # Blank or whitespace-only is a field-level 422 at create: NULL is the one
    # representation of "no value", and a blank is not a second one.
    for bad in ({"location": ""}, {"location": "   "}, {"map_url": ""}, {"map_url": "   "}):
        response = await client.post(
            "/gatherings",
            json={
                "gathering_type": "potluck",
                "title": "August potluck",
                "occurrences": [{"starts_at": "2026-09-01T18:00:00+00:00", **bad}],
            },
            headers=headers,
        )
        assert response.status_code == 422, bad
        assert set(bad) <= _field_errors(response)

    # The same on occurrence-add...
    response = await client.post(
        f"/gatherings/{body['id']}/occurrences",
        json={"starts_at": "2026-10-01T18:00:00+00:00", "location": "   "},
        headers=headers,
    )
    assert response.status_code == 422
    assert "location" in _field_errors(response)

    # ...and on patch.
    for bad in ({"location": "  "}, {"map_url": ""}):
        response = await client.patch(
            f"/occurrences/{occ['id']}", json=bad, headers=headers
        )
        assert response.status_code == 422, bad
        assert set(bad) <= _field_errors(response)

    # A patched value is trimmed like a created one, and the caps hold.
    response = await client.patch(
        f"/occurrences/{occ['id']}", json={"location": "  the backyard  "}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["location"] == "the backyard"

    assert (
        await client.patch(
            f"/occurrences/{occ['id']}", json={"location": "x" * 201}, headers=headers
        )
    ).status_code == 422
    assert (
        await client.patch(
            f"/occurrences/{occ['id']}",
            json={"map_url": "https://" + "x" * 2000},
            headers=headers,
        )
    ).status_code == 422

    # The stored row holds the trimmed values; nothing stored a blank.
    async with db_session_factory() as db:
        occurrence = (await db.execute(select(Occurrence))).scalars().one()
        assert occurrence.location == "the backyard"
        assert occurrence.map_url == "https://maps.example.com/park"


# --- map_url scheme allowlist (CK-21) -----------------------------------------


async def test_map_url_rejects_non_http_schemes_on_create_add_and_patch(
    client, capsys, db_session_factory
):
    """A map_url is rendered as a link href, so a stored javascript: value is
    script execution in a reader's browser — the scheme is allowlisted to
    http/https everywhere an occurrence body is accepted. The scheme is
    parsed, not prefix-matched: the obfuscated java\\tscript: case is why."""
    headers = await _signed_in_headers(client, capsys, "mapkeeper@example.com")
    created = await _create(client, headers)
    occ_id = created["occurrences"][0]["id"]

    bad_values = [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "//evil.example/map",
        "java\tscript:alert(1)",
    ]
    for bad in bad_values:
        # Create (OccurrenceIn under GatheringCreate)...
        response = await client.post(
            "/gatherings",
            json={
                "gathering_type": "potluck",
                "title": "August potluck",
                "occurrences": [
                    {"starts_at": "2026-09-01T18:00:00+00:00", "map_url": bad}
                ],
            },
            headers=headers,
        )
        assert response.status_code == 422, bad
        assert "map_url" in _field_errors(response)
        # ...occurrence-add (OccurrenceIn standalone)...
        response = await client.post(
            f"/gatherings/{created['id']}/occurrences",
            json={"starts_at": "2026-10-01T18:00:00+00:00", "map_url": bad},
            headers=headers,
        )
        assert response.status_code == 422, bad
        assert "map_url" in _field_errors(response)
        # ...and patch (OccurrencePatch).
        response = await client.patch(
            f"/occurrences/{occ_id}", json={"map_url": bad}, headers=headers
        )
        assert response.status_code == 422, bad
        assert "map_url" in _field_errors(response)
        # The message names the http/https requirement and never echoes the
        # rejected value back (a reflecting rejection message is itself a
        # small injection surface).
        messages = [err["msg"] for err in response.json()["detail"]]
        assert any("http://" in m for m in messages)
        assert all(bad not in m for m in messages)

    # Nothing above stored anything.
    async with db_session_factory() as db:
        stored = (await db.execute(select(Occurrence.map_url))).scalars().all()
        assert stored == [None]


async def test_map_url_accepts_http_and_https_and_still_trims(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "mapmaker@example.com")
    created = await _create(
        client,
        headers,
        occurrences=[
            {
                "starts_at": "2026-09-01T18:00:00+00:00",
                # Trimming still applies, and the scheme check reads the
                # trimmed value (a leading space never defeats the allowlist).
                "map_url": "  https://maps.example.com/park  ",
            }
        ],
    )
    occ = created["occurrences"][0]
    assert occ["map_url"] == "https://maps.example.com/park"

    # Plain http is allowed too — the allowlist is http AND https.
    response = await client.patch(
        f"/occurrences/{occ['id']}",
        json={"map_url": "http://maps.example.com/park"},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["map_url"] == "http://maps.example.com/park"

    async with db_session_factory() as db:
        occurrence = (await db.execute(select(Occurrence))).scalars().one()
        assert occurrence.map_url == "http://maps.example.com/park"


# --- clearing an optional field: explicit null means remove (CK-22) -----------


async def test_occurrence_patch_absent_null_and_blank_are_three_different_things(
    client, capsys, db_session_factory
):
    """The merge-patch contract on OccurrencePatch, all three legs: an ABSENT
    field leaves the stored value alone, an explicit NULL clears it (a real
    NULL, never ""), and "" stays a field-level 422 — blank is never a clear
    (decisions/2026-08-27-optional-field-clearing.md)."""
    headers = await _signed_in_headers(client, capsys, "clearer@example.com")
    created = await _create(
        client,
        headers,
        occurrences=[
            {
                "starts_at": "2026-09-01T18:00:00+00:00",
                "ends_at": "2026-09-01T21:00:00+00:00",
                "location": "the park",
                "map_url": "https://maps.example.com/park",
            }
        ],
    )
    occ_id = created["occurrences"][0]["id"]

    # Blank is not a clear: still the CK-20 field-level 422, nothing stored.
    response = await client.patch(
        f"/occurrences/{occ_id}", json={"location": ""}, headers=headers
    )
    assert response.status_code == 422
    assert "location" in _field_errors(response)

    # A patch containing ONLY an explicit null is a real patch, not "empty" —
    # the regression the model_fields_set rewrite exists to prevent: every
    # value in this body is None, and the old all-values-None emptiness test
    # would have wrongly rejected it.
    response = await client.patch(
        f"/occurrences/{occ_id}", json={"location": None}, headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # The null cleared its field; the ABSENT fields kept their stored values —
    # the leg a merge-patch bug breaks silently by nulling what wasn't sent.
    assert body["location"] is None
    assert body["ends_at"] == "2026-09-01T21:00:00+00:00"
    assert body["map_url"] == "https://maps.example.com/park"

    response = await client.patch(
        f"/occurrences/{occ_id}",
        json={"ends_at": None, "map_url": None},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["ends_at"] is None
    assert response.json()["map_url"] is None
    assert response.json()["starts_at"] == "2026-09-01T18:00:00+00:00"

    # starts_at is NOT NULL: a date can be moved, never removed.
    response = await client.patch(
        f"/occurrences/{occ_id}", json={"starts_at": None}, headers=headers
    )
    assert response.status_code == 422
    assert "starts_at" in _field_errors(response)

    # The stored row holds real NULLs — never "" (CK-20's verifier assertion
    # is the deployed backstop for exactly this).
    async with db_session_factory() as db:
        occurrence = (await db.execute(select(Occurrence))).scalars().one()
        assert occurrence.location is None
        assert occurrence.ends_at is None
        assert occurrence.map_url is None
        assert occurrence.starts_at == datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)


async def test_gathering_patch_refuses_explicit_null_on_both_fields(
    client, capsys, db_session_factory
):
    """GatheringPatch has NO clearable field, and the refusals are usable
    422s: title is NOT NULL, and the memorial CHECK requires the decedent's
    name present iff the type is memorial — clearing it on a memorial would
    violate the constraint (an IntegrityError-turned-500 without the model's
    refusal), and it is already NULL on everything else. The absent leg holds
    too: a title-only patch leaves the decedent's name alone."""
    headers = await _signed_in_headers(client, capsys, "keeper@example.com")
    memorial = await _create(
        client,
        headers,
        gathering_type="memorial",
        title="For Edith",
        memorial_decedent_name="Edith Hanson",
    )

    response = await client.patch(
        f"/gatherings/{memorial['id']}",
        json={"memorial_decedent_name": None},
        headers=headers,
    )
    assert response.status_code == 422
    assert "memorial_decedent_name" in _field_errors(response)

    response = await client.patch(
        f"/gatherings/{memorial['id']}", json={"title": None}, headers=headers
    )
    assert response.status_code == 422
    assert "title" in _field_errors(response)

    # Absent means leave alone: a title-only patch does not touch the name.
    response = await client.patch(
        f"/gatherings/{memorial['id']}", json={"title": "For Edith Hanson"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["memorial_decedent_name"] == "Edith Hanson"

    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.title == "For Edith Hanson"
        assert gathering.memorial_decedent_name == "Edith Hanson"


# --- the deletion lapse, with a real subject at last --------------------------


async def test_account_deletion_lapses_an_api_created_gathering(
    client, capsys, db_session_factory
):
    """CK-13 recorded the behaviour against fixtures; this is the first time
    the path has a REAL subject — a gathering born through POST /gatherings.
    The keeper column goes NULL, admin is relinquished, grace is stamped, and
    the gathering itself (and its dates) survive: deletion is anonymization,
    never cascade."""
    address = "departing@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    created = await _create(client, headers)
    now = datetime.now(timezone.utc)

    assert (
        await client.post("/me/delete", json=DELETE_BODY, headers=headers)
    ).status_code == 204

    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert str(gathering.id) == created["id"]
        assert gathering.keeper_account_id is None
        assert gathering.host_account_id is None
        assert gathering.last_keeper_left_at is not None
        assert gathering.last_keeper_left_at >= now
        # The gathering and its occurrence outlive their creator's account.
        occurrence = (await db.execute(select(Occurrence))).scalars().one()
        assert str(occurrence.gathering_id) == created["id"]


# --- the host's switch (CK-44): the override, written by a person ---------------


async def test_the_host_writes_the_override_in_all_three_values_and_absent_leaves_it_alone(
    client, capsys, db_session_factory
):
    """CK-44: rung 1 of the publication ladder gets its writer. `true` gates,
    `false` opens, an explicit `null` clears to inherit (the merge-patch
    clearing convention — decisions/2026-08-27-optional-field-clearing.md),
    and an absent field leaves the stored value alone. Every response carries
    the EFFECTIVE value re-resolved beside the stored override, so a caller
    sees what the ladder now says without a second request; `updated_at` is
    stamped like every patch. Nothing here touches a media row."""
    headers = await _signed_in_headers(client, capsys, "switch@example.com")
    created = await _create(client, headers)
    gathering_id = created["id"]
    assert created["requires_approval"] is False
    assert created["requires_approval_override"] is None

    # On: a person's choice, for the first time in the column's life.
    on = await client.patch(
        f"/gatherings/{gathering_id}",
        json={"requires_approval_override": True},
        headers=headers,
    )
    assert on.status_code == 200, on.text
    assert on.json()["requires_approval_override"] is True
    assert on.json()["requires_approval"] is True  # rung 1 beats everything
    assert on.json()["updated_at"] is not None
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is True
        stamped_at = gathering.updated_at
        assert stamped_at is not None

    # Absent leaves it alone: a title-only patch does not touch the gate.
    renamed = await client.patch(
        f"/gatherings/{gathering_id}", json={"title": "Renamed"}, headers=headers
    )
    assert renamed.status_code == 200
    assert renamed.json()["requires_approval_override"] is True
    assert renamed.json()["requires_approval"] is True

    # The detail and the list read what the patch body read.
    detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert detail.json()["requires_approval"] is True
    assert detail.json()["requires_approval_override"] is True
    (item,) = (await client.get("/gatherings", headers=headers)).json()["gatherings"]
    assert item["requires_approval"] is True
    assert item["requires_approval_override"] is True

    # Explicit false: open regardless — accepted by the API, produced by no
    # surface today (consent-gate-defaults 2.3.0 §8: the third state waits
    # for rung 2, the first thing it could differ from).
    off = await client.patch(
        f"/gatherings/{gathering_id}",
        json={"requires_approval_override": False},
        headers=headers,
    )
    assert off.status_code == 200
    assert off.json()["requires_approval_override"] is False
    assert off.json()["requires_approval"] is False
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is False

    # Explicit null: inherit — NULL in the column, and the ladder answering
    # again (a person's groupless private gathering resolves open). The
    # all-None body is a real patch, never "nothing to update".
    cleared = await client.patch(
        f"/gatherings/{gathering_id}",
        json={"requires_approval_override": None},
        headers=headers,
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["requires_approval_override"] is None
    assert cleared.json()["requires_approval"] is False
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is None
        assert gathering.updated_at is not None
        assert gathering.updated_at > stamped_at
        assert gathering.title == "Renamed"


async def test_the_switch_is_the_hosts_alone_and_the_refusal_is_the_gathering_404(
    client, capsys, db_session_factory
):
    """The switch is host-only like the rest of the PATCH surface: a keeper
    who is not the host, and a stranger, each draw the gathering 404
    byte-identical to a missing id (never a 403 — that the gate exists is
    not information the audience gets), and the column does not move. The
    keeper can still READ the gathering: the refusal is about the act."""
    host_headers = await _signed_in_headers(client, capsys, "host@example.com")
    keeper_address = "keeper@example.com"
    keeper_headers = await _signed_in_headers(client, capsys, keeper_address)
    stranger_headers = await _signed_in_headers(client, capsys, "stranger@example.com")
    created = await _create(client, host_headers)
    gathering_id = created["id"]
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        # Under one keeper (CK-49b) the creator is already the keeper, so a
        # keeper who is not the host is made by MOVING the column — host ≠
        # keeper, the sponsorship shape; keep() refuses a second keeper and
        # transfer has no surface yet.
        gathering.keeper_account_id = (await _account_for(db, keeper_address)).id
        await db.commit()

    body = {"requires_approval_override": True}
    missing = await client.patch(
        "/gatherings/00000000-0000-0000-0000-000000000000",
        json=body,
        headers=keeper_headers,
    )
    assert missing.status_code == 404
    for headers in (keeper_headers, stranger_headers):
        refused = await client.patch(
            f"/gatherings/{gathering_id}", json=body, headers=headers
        )
        assert refused.status_code == 404
        assert refused.content == missing.content
    assert (
        await client.get(f"/gatherings/{gathering_id}", headers=keeper_headers)
    ).status_code == 200
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is None  # still nobody's decision
        assert gathering.updated_at is None
