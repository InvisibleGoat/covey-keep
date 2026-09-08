"""CK-12 — the keeper spine, structural half.

Schema-shape tests for migration 0008: the accounts supertype, gatherings +
occurrences, the invitation many-to-many, and the re-pointed children. The
lifecycle half (kept relation, refcounts, grace) is CK-13 and deliberately
absent here.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.models import (
    Account,
    AccountKind,
    AttendanceRecord,
    Gathering,
    GatheringInvitation,
    GatheringType,
    Group,
    GroupType,
    ItemClaim,
    ItemSlot,
    Media,
    MediaStatus,
    Occurrence,
    Organization,
    Person,
    Post,
    PublicationState,
    RSVP,
    RSVPResponse,
)
from tests.test_auth import _sign_in

NOW = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)


async def _mk_account(db, kind: AccountKind = AccountKind.PERSON) -> Account:
    account = Account(kind=kind)
    db.add(account)
    await db.flush()
    return account


async def _mk_gathering(
    db, gathering_type: GatheringType = GatheringType.POTLUCK, occurrence_count: int = 1
):
    """A gathering with its owning account and n occurrences."""
    account = await _mk_account(db)
    gathering = Gathering(
        created_by_account_id=account.id,
        gathering_type=gathering_type,
        title="test gathering",
        publication_state=PublicationState.LIVE,
    )
    db.add(gathering)
    await db.flush()
    occurrences = []
    for n in range(occurrence_count):
        occ = Occurrence(gathering_id=gathering.id, starts_at=NOW + timedelta(days=7 * n))
        db.add(occ)
        occurrences.append(occ)
    await db.flush()
    return gathering, occurrences


async def _household_group(db) -> Group:
    profile_id = (
        await db.execute(text("SELECT id FROM capability_profiles WHERE name = 'household-default'"))
    ).scalar_one()
    group = Group(
        group_type=GroupType.HOUSEHOLD, capability_profile_id=profile_id, name="Hansons"
    )
    db.add(group)
    await db.flush()
    return group


# --- accounts supertype -----------------------------------------------------


async def test_sign_up_creates_an_account_for_the_person(client, capsys, db_session_factory):
    await _sign_in(client, capsys, "keeper@example.com")
    async with db_session_factory() as db:
        person = (
            await db.execute(select(Person).where(Person.email == "keeper@example.com"))
        ).scalar_one()
        assert person.account_id is not None
        account = (
            await db.execute(select(Account).where(Account.id == person.account_id))
        ).scalar_one()
        assert account.kind == AccountKind.PERSON


async def test_returning_sign_in_creates_no_second_account(client, capsys, db_session_factory):
    await _sign_in(client, capsys, "returning@example.com")
    async with db_session_factory() as db:
        before = (await db.execute(select(Account))).scalars().all()
    await _sign_in(client, capsys, "returning@example.com")
    async with db_session_factory() as db:
        after = (await db.execute(select(Account))).scalars().all()
        assert len(after) == len(before)


async def test_person_requires_an_account(db_session_factory):
    async with db_session_factory() as db:
        db.add(Person(display_name="orphan", email="orphan@example.com"))
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_organization_requires_and_gets_an_account(db_session_factory):
    async with db_session_factory() as db:
        db.add(Organization(name="First Baptist"))
        with pytest.raises(IntegrityError):
            await db.flush()
    async with db_session_factory() as db:
        account = await _mk_account(db, AccountKind.ORGANIZATION)
        db.add(Organization(name="First Baptist", account_id=account.id))
        await db.commit()
        org = (
            await db.execute(select(Organization).where(Organization.name == "First Baptist"))
        ).scalar_one()
        assert org.account_id == account.id


async def test_an_account_is_never_shared(db_session_factory):
    # people.account_id is UNIQUE: the account IS the person's quota anchor,
    # never a pool two people draw from.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        db.add(Person(display_name="one", email="one@example.com", account_id=account.id))
        await db.flush()
        db.add(Person(display_name="two", email="two@example.com", account_id=account.id))
        with pytest.raises(IntegrityError):
            await db.flush()


# --- gatherings + occurrences ----------------------------------------------


async def test_season_is_structurally_identical_to_a_one_off(db_session_factory):
    """A gathering with three occurrences takes exactly the operations a
    single-occurrence gathering takes — nothing in the schema treats a season
    as a special case (that uniformity is the point of collapsing
    event_series)."""
    async with db_session_factory() as db:
        one_off, one_occs = await _mk_gathering(db, GatheringType.POTLUCK, occurrence_count=1)
        season, season_occs = await _mk_gathering(db, GatheringType.SEASON, occurrence_count=3)

        for gathering, occs in ((one_off, one_occs), (season, season_occs)):
            for occ in occs:
                # You RSVP to a date, attend a date, and bring a dish to a date.
                db.add(RSVP(occurrence_id=occ.id, guest_name="guest", response=RSVPResponse.YES))
                db.add(AttendanceRecord(occurrence_id=occ.id, display_name="guest"))
                slot = ItemSlot(occurrence_id=occ.id, title="rolls")
                db.add(slot)
                await db.flush()
                db.add(ItemClaim(occurrence_id=occ.id, item_slot_id=slot.id, guest_name="guest"))
            # Discussion and media belong to the gathering, whole.
            db.add(
                Post(
                    gathering_id=gathering.id,
                    guest_name="guest",
                    body="hello",
                    publication_state=PublicationState.LIVE,
                )
            )
            db.add(
                Media(
                    gathering_id=gathering.id,
                    guest_name="guest",
                    upload_content_type="image/jpeg",
                    upload_size_bytes=1,
                    status=MediaStatus.READY,
                    publication_state=PublicationState.LIVE,
                )
            )
        await db.commit()

        for gathering, expected in ((one_off, 1), (season, 3)):
            count = (
                await db.execute(
                    select(func.count())
                    .select_from(Occurrence)
                    .where(Occurrence.gathering_id == gathering.id)
                )
            ).scalar_one()
            assert count == expected


# --- gathering_invitations --------------------------------------------------


async def test_invitation_accepts_exactly_one_target(db_session_factory):
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        group = await _household_group(db)
        account = await _mk_account(db)
        db.add(Person(display_name="invitee", email="invitee@example.com", account_id=account.id))
        person = (
            await db.execute(select(Person).where(Person.email == "invitee@example.com"))
        ).scalar_one()

        db.add(GatheringInvitation(gathering_id=gathering.id, group_id=group.id))
        db.add(GatheringInvitation(gathering_id=gathering.id, person_id=person.id))
        await db.commit()

    # Zero targets: rejected.
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        db.add(GatheringInvitation(gathering_id=gathering.id))
        with pytest.raises(IntegrityError):
            await db.flush()

    # Two targets in one row: rejected — a two-family gathering is two rows.
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        group = await _household_group(db)
        account = await _mk_account(db)
        db.add(Person(display_name="p", email="p@example.com", account_id=account.id))
        person = (
            await db.execute(select(Person).where(Person.email == "p@example.com"))
        ).scalar_one()
        db.add(
            GatheringInvitation(
                gathering_id=gathering.id, group_id=group.id, person_id=person.id
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_invitation_unique_per_gathering_and_target(db_session_factory):
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        group = await _household_group(db)
        db.add(GatheringInvitation(gathering_id=gathering.id, group_id=group.id))
        await db.flush()
        db.add(GatheringInvitation(gathering_id=gathering.id, group_id=group.id))
        with pytest.raises(IntegrityError):
            await db.flush()


# --- the re-pointed children ------------------------------------------------


async def test_children_attach_at_the_right_level(db_session_factory):
    """Media and posts hang off the gathering (the keeping/storage unit) with
    the occurrence as an optional label; RSVP and attendance hang off the
    occurrence. Pinned against the live schema, not just the models."""
    async with db_session_factory() as db:
        cols = {}
        for table in ("rsvps", "attendance_records", "item_slots", "item_claims", "posts", "media"):
            rows = await db.execute(
                text(
                    "SELECT column_name, is_nullable FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = :t"
                ),
                {"t": table},
            )
            cols[table] = {r[0]: r[1] for r in rows}

        for table in ("rsvps", "attendance_records", "item_slots", "item_claims"):
            assert cols[table]["occurrence_id"] == "NO", table  # NOT NULL
            assert "gathering_id" not in cols[table], table
            assert "event_id" not in cols[table], table
        for table in ("posts", "media"):
            assert cols[table]["gathering_id"] == "NO", table  # NOT NULL owner
            assert cols[table]["occurrence_id"] == "YES", table  # optional label
            assert "event_id" not in cols[table], table


async def test_media_and_post_may_carry_an_occurrence_label(db_session_factory):
    async with db_session_factory() as db:
        gathering, (occ,) = await _mk_gathering(db)
        db.add(
            Media(
                gathering_id=gathering.id,
                occurrence_id=occ.id,
                guest_name="guest",
                upload_content_type="image/jpeg",
                upload_size_bytes=1,
                status=MediaStatus.READY,
                publication_state=PublicationState.LIVE,
            )
        )
        db.add(
            Post(
                gathering_id=gathering.id,
                occurrence_id=occ.id,
                guest_name="guest",
                body="about the second night",
                publication_state=PublicationState.LIVE,
            )
        )
        await db.commit()


async def test_guest_identity_checks_survived_the_restructure(db_session_factory):
    # The 0001 identity_present CHECKs must ride through the re-pointing —
    # losing provenance in a restructure would break the book pipeline.
    async with db_session_factory() as db:
        gathering, (occ,) = await _mk_gathering(db)
        db.add(
            Media(
                gathering_id=gathering.id,
                upload_content_type="image/jpeg",
                upload_size_bytes=1,
                status=MediaStatus.READY,
                publication_state=PublicationState.LIVE,
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()
    async with db_session_factory() as db:
        gathering, (occ,) = await _mk_gathering(db)
        db.add(RSVP(occurrence_id=occ.id, response=RSVPResponse.YES))
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_one_rsvp_per_person_per_occurrence(db_session_factory):
    async with db_session_factory() as db:
        gathering, (occ,) = await _mk_gathering(db)
        account = await _mk_account(db)
        db.add(Person(display_name="r", email="r@example.com", account_id=account.id))
        person = (
            await db.execute(select(Person).where(Person.email == "r@example.com"))
        ).scalar_one()
        db.add(RSVP(occurrence_id=occ.id, person_id=person.id, response=RSVPResponse.YES))
        await db.flush()
        db.add(RSVP(occurrence_id=occ.id, person_id=person.id, response=RSVPResponse.NO))
        with pytest.raises(IntegrityError):
            await db.flush()


# --- events are gone; conventions hold --------------------------------------


async def test_events_and_event_series_no_longer_exist(db_session_factory):
    async with db_session_factory() as db:
        for name in ("events", "event_series"):
            assert (
                await db.execute(text("SELECT to_regclass(:n)"), {"n": f"public.{name}"})
            ).scalar_one() is None
        # The event_type enum went with them; gathering_type extends its values.
        typenames = {
            r[0]
            for r in await db.execute(
                text("SELECT typname FROM pg_type WHERE typname IN ('event_type', 'gathering_type', 'account_kind')")
            )
        }
        assert typenames == {"gathering_type", "account_kind"}
        labels = [
            r[0]
            for r in await db.execute(
                text(
                    "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid "
                    "WHERE typname = 'gathering_type' ORDER BY enumsortorder"
                )
            )
        ]
        assert labels == [
            "potluck", "hosted", "hosted_with_help", "simple", "wedding",
            "season", "memorial", "church_gathering",
        ]


async def test_constraints_follow_the_0001_naming_convention(db_session_factory):
    async with db_session_factory() as db:
        constraints = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT conname FROM pg_constraint WHERE conname IN "
                    "('ck_gathering_invitations_exactly_one_target', "
                    " 'fk_gatherings_created_by_account_id', 'fk_occurrences_gathering_id', "
                    " 'uq_people_account_id', 'uq_organizations_account_id', "
                    " 'fk_media_gathering_id', 'fk_posts_gathering_id', "
                    " 'fk_rsvps_occurrence_id')"
                )
            )
        }
        # (CK-13 renamed gatherings.account_id → created_by_account_id; the
        # constraint and index names below track the rename.)
        assert constraints == {
            "ck_gathering_invitations_exactly_one_target",
            "fk_gatherings_created_by_account_id",
            "fk_occurrences_gathering_id",
            "uq_people_account_id",
            "uq_organizations_account_id",
            "fk_media_gathering_id",
            "fk_posts_gathering_id",
            "fk_rsvps_occurrence_id",
        }
        indexes = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT indexname FROM pg_indexes WHERE indexname IN "
                    "('uq_gathering_invitations_gathering_group', "
                    " 'uq_gathering_invitations_gathering_sub_group', "
                    " 'uq_gathering_invitations_gathering_person', "
                    " 'uq_rsvps_occurrence_person', 'ix_gatherings_created_by_account_id', "
                    " 'ix_occurrences_gathering_id')"
                )
            )
        }
        assert len(indexes) == 6
