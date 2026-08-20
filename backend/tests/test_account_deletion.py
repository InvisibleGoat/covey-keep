from datetime import datetime, timezone

from sqlalchemy import func, select

from app.api.profile import ANONYMIZED_DISPLAY_NAME
from app.models import (
    CapabilityProfile,
    Event,
    EventSeries,
    Group,
    MagicLinkToken,
    Person,
    Post,
    Session,
    TosAcceptance,
)
from app.models.enums import EventType, GroupType, PublicationState
from tests.test_auth import _capture_link, _sign_in

DELETE_BODY = {"confirm": "DELETE"}


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


async def test_delete_requires_auth(client):
    assert (await client.post("/me/delete", json=DELETE_BODY)).status_code == 401


async def test_delete_anonymizes_and_destroys_auth_material(
    client, capsys, db_session_factory
):
    address = "leaving@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    # A second device session, a set profile, and an outstanding (unconsumed)
    # magic link — deletion must clear ALL of it, not just this request's session.
    await _sign_in(client, capsys, address)
    await client.patch(
        "/me/profile",
        json={"display_name": "Maya Finch", "timezone": "America/Chicago"},
        headers=headers,
    )
    await _capture_link(client, capsys, address)

    response = await client.post("/me/delete", json=DELETE_BODY, headers=headers)
    assert response.status_code == 204

    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        # Identity destroyed: no email, neutral label, no timezone.
        assert person.email is None
        assert person.display_name == ANONYMIZED_DISPLAY_NAME
        assert person.timezone is None
        assert person.anonymized_at is not None
        assert person.updated_at is not None
        # Auth material HARD-deleted: every session (both devices) and every
        # magic-link token row carrying the old address, consumed or not.
        assert (await db.scalar(select(func.count()).select_from(Session))) == 0
        assert (await db.scalar(select(func.count()).select_from(MagicLinkToken))) == 0
        # The ToS acceptance is deliberately RETAINED: the audit record of
        # contract formation, now pointing at a row that carries no PII.
        tos = (await db.execute(select(TosAcceptance))).scalars().one()
        assert tos.person_id == person.id


async def test_jwt_minted_before_deletion_rejected(client, capsys):
    headers = await _signed_in_headers(client, capsys, "tokenkeeper@example.com")
    assert (await client.get("/me/profile", headers=headers)).status_code == 200
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204
    # The signature is still valid and the JWT unexpired — the deleted
    # sessions row (and the anonymized-person gate behind it) must reject it.
    assert (await client.get("/me/profile", headers=headers)).status_code == 401
    assert (await client.get("/auth/me", headers=headers)).status_code == 401


async def test_anonymized_person_rejected_even_with_live_session(
    client, capsys, db_session_factory
):
    # Defence in depth: /me/delete hard-deletes sessions, so this state should
    # never occur — but the auth gate must 401 on anonymized_at alone, so the
    # guarantee doesn't depend on the deletion transaction being the only path.
    headers = await _signed_in_headers(client, capsys, "raced@example.com")
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        person.anonymized_at = datetime.now(timezone.utc)
        await db.commit()
        # The session row is deliberately still live.
        assert (await db.scalar(select(func.count()).select_from(Session))) == 1
    assert (await client.get("/me/profile", headers=headers)).status_code == 401
    assert (await client.get("/auth/me", headers=headers)).status_code == 401


async def test_resignup_creates_new_unrelated_person(client, capsys, db_session_factory):
    address = "phoenix@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        old_id = (await db.execute(select(Person))).scalars().one().id
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204

    # Same address, fresh sign-up: a NEW person with no tie to the old one —
    # this is what email = NULL on the anonymized row buys.
    new_jwt = await _sign_in(client, capsys, address)
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {new_jwt}"})
    assert me.status_code == 200
    assert me.json()["id"] != str(old_id)
    assert me.json()["display_name"] == "phoenix"

    async with db_session_factory() as db:
        people = (await db.execute(select(Person))).scalars().all()
        assert len(people) == 2
        old = next(p for p in people if p.id == old_id)
        new = next(p for p in people if p.id != old_id)
        # The old row stays anonymized and untouched by the re-signup.
        assert old.email is None
        assert old.display_name == ANONYMIZED_DISPLAY_NAME
        assert old.anonymized_at is not None
        # The new account is a genuinely fresh start, with its own acceptance.
        assert new.email == address
        assert new.anonymized_at is None
        acceptances = (await db.execute(select(TosAcceptance))).scalars().all()
        assert {a.person_id for a in acceptances} == {old.id, new.id}


async def test_wrong_confirmation_changes_nothing(client, capsys, db_session_factory):
    address = "hesitant@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    # Case, whitespace, emptiness, absence, extra fields: all 4xx, no effect.
    for bad_body in (
        {"confirm": "delete"},
        {"confirm": "Delete"},
        {"confirm": " DELETE "},
        {"confirm": ""},
        {},
        {"confirm": "DELETE", "extra": True},
    ):
        response = await client.post("/me/delete", json=bad_body, headers=headers)
        assert response.status_code == 422, bad_body
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.email == address
        assert person.anonymized_at is None
        assert (await db.scalar(select(func.count()).select_from(Session))) == 1
    # The session survived every rejected attempt.
    assert (await client.get("/me/profile", headers=headers)).status_code == 200


async def test_contributions_survive_deletion(client, capsys, db_session_factory):
    # The schema has no ON DELETE CASCADE anywhere by design, so retention is
    # the default — asserted here rather than trusted (kickoff STEP 2).
    headers = await _signed_in_headers(client, capsys, "contributor@example.com")
    now = datetime.now(timezone.utc)
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        person_id = person.id
        profile = (
            await db.execute(
                select(CapabilityProfile).where(CapabilityProfile.name == "household-default")
            )
        ).scalars().one()
        group = Group(
            group_type=GroupType.HOUSEHOLD,
            capability_profile_id=profile.id,
            name="Finch family",
            steward_person_id=person_id,
        )
        db.add(group)
        await db.flush()
        series = EventSeries(
            group_id=group.id, title="Sunday dinners", created_by_person_id=person_id
        )
        db.add(series)
        await db.flush()
        event = Event(
            series_id=series.id,
            event_type=EventType.POTLUCK,
            title="August potluck",
            starts_at=now,
            created_by_person_id=person_id,
            publication_state=PublicationState.LIVE,
        )
        db.add(event)
        await db.flush()
        db.add(
            Post(
                event_id=event.id,
                author_person_id=person_id,
                body="What a day!",
                publication_state=PublicationState.LIVE,
            )
        )
        await db.commit()

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204

    async with db_session_factory() as db:
        # Every contribution row survives, still attributed to the (now
        # anonymized) person — provenance intact for the book pipeline.
        post = (await db.execute(select(Post))).scalars().one()
        assert post.author_person_id == person_id
        series_row = (await db.execute(select(EventSeries))).scalars().one()
        assert series_row.created_by_person_id == person_id
        event_row = (await db.execute(select(Event))).scalars().one()
        assert event_row.created_by_person_id == person_id
        group_row = (await db.execute(select(Group))).scalars().one()
        assert group_row.steward_person_id == person_id
