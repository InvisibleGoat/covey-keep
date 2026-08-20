from datetime import datetime

from sqlalchemy import select

from app.models import Person
from tests.test_auth import _sign_in


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


def _field_errors(response) -> set[str]:
    """The field names FastAPI's 422 body points at (loc: ['body', <field>])."""
    return {tuple(err["loc"])[-1] for err in response.json()["detail"]}


async def test_profile_requires_auth(client):
    assert (await client.get("/me/profile")).status_code == 401
    assert (
        await client.patch("/me/profile", json={"display_name": "x"})
    ).status_code == 401


async def test_get_profile_starts_with_defaults(client, capsys):
    headers = await _signed_in_headers(client, capsys, "fresh@example.com")
    response = await client.get("/me/profile", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "fresh"
    assert body["email"] == "fresh@example.com"
    # No value can be invented server-side: a new account has no timezone and
    # has never been edited.
    assert body["timezone"] is None
    assert body["updated_at"] is None


async def test_patch_display_name_trims_and_stamps_updated_at(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "renamer@example.com")
    response = await client.patch(
        "/me/profile", json={"display_name": "  Maya Finch  "}, headers=headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Maya Finch"
    first_stamp = datetime.fromisoformat(body["updated_at"])

    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.display_name == "Maya Finch"
        assert person.updated_at == first_stamp

    # updated_at moves on EVERY successful patch, not just the first.
    again = await client.patch(
        "/me/profile", json={"display_name": "Maya"}, headers=headers
    )
    assert again.status_code == 200
    assert datetime.fromisoformat(again.json()["updated_at"]) > first_stamp

    # The edit shows up on /auth/me — the payload the signed-in shell renders.
    me = await client.get("/auth/me", headers=headers)
    assert me.json()["display_name"] == "Maya"


async def test_patch_valid_iana_timezone(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "traveler@example.com")
    response = await client.patch(
        "/me/profile", json={"timezone": "America/Chicago"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["timezone"] == "America/Chicago"
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.timezone == "America/Chicago"
    # /auth/me carries it too — the client's "already captured?" check.
    me = await client.get("/auth/me", headers=headers)
    assert me.json()["timezone"] == "America/Chicago"


async def test_patch_rejects_non_iana_timezone(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "offset@example.com")
    await client.patch("/me/profile", json={"timezone": "Europe/Berlin"}, headers=headers)

    # Fantasy zones AND raw UTC offsets are field-level 422s, never a 500 —
    # offsets are the exact mistake the IANA-name rule exists to prevent.
    for bad in ("Mars/Olympus", "-05:00", "UTC-5", "CST", ""):
        response = await client.patch(
            "/me/profile", json={"timezone": bad}, headers=headers
        )
        assert response.status_code == 422, bad
        assert "timezone" in _field_errors(response), bad

    # The stored value is untouched by any of the rejected patches.
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.timezone == "Europe/Berlin"


async def test_patch_rejects_blank_display_name(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "blank@example.com")
    for bad in ("", "   ", "\t\n", "x" * 121):
        response = await client.patch(
            "/me/profile", json={"display_name": bad}, headers=headers
        )
        assert response.status_code == 422, repr(bad)
        assert "display_name" in _field_errors(response), repr(bad)
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.display_name == "blank"
        assert person.updated_at is None


async def test_patch_rejects_email_and_unknown_fields(client, capsys, db_session_factory):
    # Email change is CK-8 (its own security surface) and nothing else on
    # people is patchable — a 422, never a silent no-op.
    headers = await _signed_in_headers(client, capsys, "sneaky@example.com")
    response = await client.patch(
        "/me/profile", json={"email": "other@example.com"}, headers=headers
    )
    assert response.status_code == 422
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.email == "sneaky@example.com"


async def test_empty_patch_rejected(client, capsys):
    headers = await _signed_in_headers(client, capsys, "noop@example.com")
    assert (await client.patch("/me/profile", json={}, headers=headers)).status_code == 422


async def test_patch_both_fields_at_once(client, capsys):
    # The settings form submits both fields together.
    headers = await _signed_in_headers(client, capsys, "both@example.com")
    response = await client.patch(
        "/me/profile",
        json={"display_name": "Both Fields", "timezone": "Pacific/Auckland"},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Both Fields"
    assert body["timezone"] == "Pacific/Auckland"
    assert body["updated_at"] is not None


async def test_invalid_field_rolls_nothing_back_partially(client, capsys, db_session_factory):
    # A patch that mixes a valid display_name with an invalid timezone must
    # apply NEITHER — validation happens before any write.
    headers = await _signed_in_headers(client, capsys, "atomic@example.com")
    response = await client.patch(
        "/me/profile",
        json={"display_name": "Half Applied", "timezone": "Mars/Olympus"},
        headers=headers,
    )
    assert response.status_code == 422
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.display_name == "atomic"
        assert person.timezone is None
        assert person.updated_at is None
