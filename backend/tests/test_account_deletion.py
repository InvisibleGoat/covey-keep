from datetime import datetime, timezone

from sqlalchemy import func, select

from app.api.profile import ANONYMIZED_DISPLAY_NAME
from app.models import (
    Account,
    AccountKind,
    CapabilityProfile,
    Gathering,
    Group,
    MagicLinkToken,
    Membership,
    Occurrence,
    Person,
    Post,
    Session,
    TosAcceptance,
)
from app.models.enums import GatheringType, GroupType, PublicationState
from app.services.keeping import keep
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
    # (CK-12 translated the scaffolding below from Event/EventSeries to
    # Gathering/Occurrence when the keeper spine replaced them — every
    # anonymization assertion is unchanged in strength.)
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        person_id = person.id
        account_id = person.account_id
        profile = (
            await db.execute(
                select(CapabilityProfile).where(CapabilityProfile.name == "household-default")
            )
        ).scalars().one()
        group = Group(
            group_type=GroupType.HOUSEHOLD,
            capability_profile_id=profile.id,
            name="Finch family",
            admin_person_id=person_id,
        )
        db.add(group)
        await db.flush()
        gathering = Gathering(
            created_by_account_id=account_id,
            gathering_type=GatheringType.POTLUCK,
            title="August potluck",
            publication_state=PublicationState.LIVE,
        )
        db.add(gathering)
        await db.flush()
        occurrence = Occurrence(gathering_id=gathering.id, starts_at=now)
        db.add(occurrence)
        await db.flush()
        db.add(
            Post(
                gathering_id=gathering.id,
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
        # The gathering survives, still anchored to the anonymized person's
        # account (the accounts row is not PII and is never destroyed).
        gathering_row = (await db.execute(select(Gathering))).scalars().one()
        assert gathering_row.created_by_account_id == account_id
        occurrence_row = (await db.execute(select(Occurrence))).scalars().one()
        assert occurrence_row.gathering_id == gathering_row.id
        # The group row survives. (Edited at CK-45: this line pinned
        # `admin_person_id == person_id` — the row's SURVIVAL was the point
        # and the column was incidental; since CK-45 deletion relinquishes
        # group admin, so the row survives with its admin NULL — the leg
        # pinned in full by test_deletion_relinquishes_group_admin_and_
        # retains_memberships below.)
        group_row = (await db.execute(select(Group))).scalars().one()
        assert group_row.admin_person_id is None


async def test_deletion_lapses_kept_statuses(client, capsys, db_session_factory):
    """CK-13, keeper model §8: an anonymized person's kept statuses lapse —
    the keeper column goes NULL wherever their account held it, host is
    relinquished, and a gathering that just lost its keeper enters grace
    exactly as an unkeep would put it there. A gathering someone ELSE keeps
    — which the person merely hosted — keeps its keeper and stays out of
    grace: no single person's deletion can take an archive from the person
    who keeps it. (Since CK-49b the keeper is `keeper_account_id`, one per
    gathering; the old fixture's "kept by both" is the sponsorship shape
    now — host and keeper two different accounts.)"""
    address = "lastkeeper@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    now = datetime.now(timezone.utc)
    async with db_session_factory() as db:
        person = (
            await db.execute(select(Person).where(Person.email == address))
        ).scalars().one()
        account = (
            await db.execute(select(Account).where(Account.id == person.account_id))
        ).scalars().one()
        other = Account(kind=AccountKind.PERSON)
        db.add(other)
        await db.flush()
        # Kept, and hosted, by the person being deleted.
        solo = Gathering(
            created_by_account_id=account.id,
            host_account_id=account.id,
            gathering_type=GatheringType.POTLUCK,
            title="solo-kept",
            publication_state=PublicationState.LIVE,
        )
        # Hosted by the person, kept by someone else.
        sponsored = Gathering(
            created_by_account_id=account.id,
            host_account_id=account.id,
            gathering_type=GatheringType.POTLUCK,
            title="kept-by-another",
            publication_state=PublicationState.LIVE,
        )
        db.add_all([solo, sponsored])
        await db.flush()
        await keep(db, account, solo)
        await keep(db, other, sponsored)
        await db.commit()
        account_id, other_id = account.id, other.id
        solo_id, sponsored_id = solo.id, sponsored.id

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204

    async with db_session_factory() as db:
        # The deleted account keeps nothing; the other keeper's column stands.
        assert (
            await db.scalar(
                select(func.count())
                .select_from(Gathering)
                .where(Gathering.keeper_account_id == account_id)
            )
        ) == 0
        solo_row = (
            await db.execute(select(Gathering).where(Gathering.id == solo_id))
        ).scalars().one()
        sponsored_row = (
            await db.execute(select(Gathering).where(Gathering.id == sponsored_id))
        ).scalars().one()
        # The gathering the person kept lost its keeper: stamped into grace,
        # host relinquished (claimable, not held by a dead account).
        assert solo_row.keeper_account_id is None
        assert solo_row.last_keeper_left_at is not None
        assert solo_row.last_keeper_left_at >= now
        assert solo_row.host_account_id is None
        # The gathering someone else keeps lives on, unstamped, with its
        # keeper — and its host relinquished all the same (kept or not).
        assert sponsored_row.keeper_account_id == other_id
        assert sponsored_row.last_keeper_left_at is None
        assert sponsored_row.host_account_id is None
        # The accounts row itself survives (no PII; the gatherings still
        # reference it as their historical creator).
        assert (
            await db.scalar(
                select(func.count()).select_from(Account).where(Account.id == account_id)
            )
        ) == 1


async def test_deletion_relinquishes_group_admin_and_retains_memberships(
    client, capsys, db_session_factory
):
    """CK-45: the sixth deletion-path integration. A former member administers
    nothing — `admin_person_id` and `backup_admin_person_id` are set NULL
    wherever the deleted person held them (the nullable columns' documented
    "needs an admin" state, reachable for the first time), the backup admin
    is NOT promoted, and every `memberships` row is RETAINED, still
    attributed to the anonymized person — the retention default: nothing
    cascades from a person. `updated_at` is untouched: a relinquishment is
    not a rename. Since CK-49b the same leg relinquishes the group's KEEPER
    (`groups.keeper_account_id`, an account fact) wherever the deleted
    account held it — an anonymized account cannot answer for a home's
    bytes — and writes no stamp on the group (where a group's lapse stamp
    lives is Arc B's, with the first gathering that resolves through one);
    a group someone else keeps is untouched."""
    address = "groupadmin@example.com"
    other_address = "othermember@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    await _sign_in(client, capsys, other_address)
    # (1) A group the person created through the API: admin + first member.
    response = await client.post("/groups", json={"name": "Finch family"}, headers=headers)
    assert response.status_code == 201, response.text
    own_group_id = response.json()["id"]
    async with db_session_factory() as db:
        person_id = (
            await db.execute(select(Person.id).where(Person.email == address))
        ).scalar_one()
        other_id = (
            await db.execute(select(Person.id).where(Person.email == other_address))
        ).scalar_one()
        account_id = (
            await db.execute(select(Person.account_id).where(Person.id == person_id))
        ).scalar_one()
        other_account_id = (
            await db.execute(select(Person.account_id).where(Person.id == other_id))
        ).scalar_one()
        profile = (
            await db.execute(
                select(CapabilityProfile).where(CapabilityProfile.name == "household-default")
            )
        ).scalars().one()
        # The person keeps the group they created — the 0022 backfill's
        # shape (the creator is the first keeper); the router writes no
        # keeper yet, so it is set here.
        own = (await db.execute(select(Group).where(Group.id == own_group_id))).scalars().one()
        own.keeper_account_id = account_id
        # (2) A group someone else administers AND keeps, with the person as
        # BACKUP admin and a member — constructed directly (nothing sets the
        # backup column or adds a second member through the API yet).
        backed = Group(
            group_type=GroupType.HOUSEHOLD,
            capability_profile_id=profile.id,
            name="Other family",
            admin_person_id=other_id,
            backup_admin_person_id=person_id,
            keeper_account_id=other_account_id,
        )
        db.add(backed)
        await db.flush()
        db.add_all(
            [
                Membership(group_id=backed.id, person_id=other_id),
                Membership(group_id=backed.id, person_id=person_id),
            ]
        )
        await db.commit()
        backed_id = backed.id

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=headers)).status_code == 204

    async with db_session_factory() as db:
        own = (await db.execute(select(Group).where(Group.id == own_group_id))).scalars().one()
        # Relinquished: the group survives, administered by nobody — never
        # by "a former member" — and kept by nobody: the unkept state, with
        # no stamp anywhere on the group to say when.
        assert own.admin_person_id is None
        assert own.backup_admin_person_id is None
        assert own.keeper_account_id is None
        assert own.updated_at is None
        backed_row = (await db.execute(select(Group).where(Group.id == backed_id))).scalars().one()
        # The other person's admin and keeper stand; the deleted person's
        # backup slot is cleared and NOT promoted into anything.
        assert backed_row.admin_person_id == other_id
        assert backed_row.backup_admin_person_id is None
        assert backed_row.keeper_account_id == other_account_id
        assert backed_row.updated_at is None
        # Every membership row retained, still attributed to the anonymized
        # person (row counts, not trust).
        own_members = (
            await db.execute(select(Membership.person_id).where(Membership.group_id == own.id))
        ).scalars().all()
        assert own_members == [person_id]
        backed_members = set(
            (
                await db.execute(
                    select(Membership.person_id).where(Membership.group_id == backed_id)
                )
            ).scalars().all()
        )
        assert backed_members == {other_id, person_id}
        anonymized = (
            await db.execute(select(Person).where(Person.id == person_id))
        ).scalars().one()
        assert anonymized.anonymized_at is not None
