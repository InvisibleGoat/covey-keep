"""CK-13 — the keeper lifecycle: kept relation, derived grace, memorial
exemption, admin relinquishment.

`kept_gatherings` is the single source of truth for the refcount and the
quota arithmetic; grace is derived from one timestamp plus policy constants;
memorials are exempt by TYPE and gated by a named decedent. The deletion-path
half of the lifecycle (kept statuses lapsing on anonymization) is pinned in
test_account_deletion.py, next to the rest of the deletion contract.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.models import Account, AccountKind, Gathering, GatheringType, KeptGathering, PublicationState
from app.services.keeping import GraceState, account_usage, grace_state, keep, unkeep

NOW = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)


async def _mk_account(db) -> Account:
    account = Account(kind=AccountKind.PERSON)
    db.add(account)
    await db.flush()
    return account


async def _mk_gathering(
    db,
    *,
    gathering_type: GatheringType = GatheringType.POTLUCK,
    total_bytes: int = 0,
    memorial_decedent_name: str | None = None,
    admin_account_id=None,
) -> Gathering:
    creator = await _mk_account(db)
    gathering = Gathering(
        created_by_account_id=creator.id,
        admin_account_id=admin_account_id,
        gathering_type=gathering_type,
        title="keeping test gathering",
        memorial_decedent_name=memorial_decedent_name,
        total_bytes=total_bytes,
        publication_state=PublicationState.LIVE,
    )
    db.add(gathering)
    await db.flush()
    return gathering


# --- the kept relation --------------------------------------------------------


async def test_keeping_twice_is_rejected_by_the_unique_constraint(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = await _mk_gathering(db)
        await keep(db, account, gathering)
        with pytest.raises(IntegrityError):
            await keep(db, account, gathering)


async def test_unkeep_without_a_kept_row_is_loud(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = await _mk_gathering(db)
        with pytest.raises(LookupError):
            await unkeep(db, account, gathering)


# --- grace: one timestamp, derived state -------------------------------------


async def test_last_unkeep_stamps_and_a_new_keep_clears(db_session_factory):
    async with db_session_factory() as db:
        first, second = await _mk_account(db), await _mk_account(db)
        gathering = await _mk_gathering(db)
        await keep(db, first, gathering)
        assert gathering.last_keeper_left_at is None
        await unkeep(db, first, gathering, now=NOW)
        assert gathering.last_keeper_left_at == NOW
        # Anyone keeping again ends grace — the stamp clears.
        await keep(db, second, gathering)
        assert gathering.last_keeper_left_at is None
        await db.commit()


async def test_a_gathering_with_keepers_never_carries_the_stamp(db_session_factory):
    # THE invariant: at least one keeper ⇒ last_keeper_left_at IS NULL.
    async with db_session_factory() as db:
        first, second = await _mk_account(db), await _mk_account(db)
        gathering = await _mk_gathering(db)
        await keep(db, first, gathering)
        await keep(db, second, gathering)
        assert gathering.last_keeper_left_at is None
        # One keeper leaving is not the LAST keeper leaving.
        await unkeep(db, first, gathering, now=NOW)
        assert gathering.last_keeper_left_at is None
        await unkeep(db, second, gathering, now=NOW)
        assert gathering.last_keeper_left_at == NOW
        await db.commit()


async def test_grace_state_is_derived_from_the_stamp(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = await _mk_gathering(db)
        await keep(db, account, gathering)
        # Kept: live, at any distance.
        assert grace_state(gathering, NOW + timedelta(days=400)) is GraceState.LIVE
        await unkeep(db, account, gathering, now=NOW)
        # Derived thresholds: recoverable-but-live inside 30 days, archived
        # from day 30, due for deletion from day 90. Nothing is persisted —
        # the same row answers differently as `now` moves.
        assert grace_state(gathering, NOW + timedelta(days=10)) is GraceState.LIVE
        assert grace_state(gathering, NOW + timedelta(days=31)) is GraceState.ARCHIVED
        assert grace_state(gathering, NOW + timedelta(days=91)) is GraceState.DUE_FOR_DELETION


# --- memorials: exempt by type, gated by a decedent ---------------------------


async def test_memorial_never_enters_grace(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        memorial = await _mk_gathering(
            db,
            gathering_type=GatheringType.MEMORIAL,
            memorial_decedent_name="Edith Hanson",
        )
        await keep(db, account, memorial)
        await unkeep(db, account, memorial, now=NOW)
        # The last keeper just left — and the stamp stays NULL: a memorial
        # never enters grace, whatever its keeper count.
        assert memorial.last_keeper_left_at is None
        assert grace_state(memorial, NOW + timedelta(days=200)) is GraceState.LIVE
        await db.commit()


async def test_memorial_requires_a_decedent_and_a_non_memorial_rejects_one(
    db_session_factory,
):
    # The abuse gate: without a named decedent, everything becomes a memorial.
    async with db_session_factory() as db:
        with pytest.raises(IntegrityError):
            await _mk_gathering(db, gathering_type=GatheringType.MEMORIAL)
    async with db_session_factory() as db:
        # A blank name is no name.
        with pytest.raises(IntegrityError):
            await _mk_gathering(
                db, gathering_type=GatheringType.MEMORIAL, memorial_decedent_name="   "
            )
    async with db_session_factory() as db:
        with pytest.raises(IntegrityError):
            await _mk_gathering(
                db, gathering_type=GatheringType.POTLUCK, memorial_decedent_name="Edith Hanson"
            )
    async with db_session_factory() as db:
        memorial = await _mk_gathering(
            db, gathering_type=GatheringType.MEMORIAL, memorial_decedent_name="Edith Hanson"
        )
        await db.commit()
        assert memorial.id is not None


# --- quota: computed fresh over kept gatherings -------------------------------


async def test_account_usage_sums_only_kept_gatherings_and_tracks_total_bytes(
    db_session_factory,
):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        kept_small = await _mk_gathering(db, total_bytes=100)
        kept_large = await _mk_gathering(db, total_bytes=250)
        unkept = await _mk_gathering(db, total_bytes=999)
        await keep(db, account, kept_small)
        await keep(db, account, kept_large)
        assert await account_usage(db, account) == 350
        # Computed fresh: a total_bytes change shows up immediately, and an
        # unkeep frees the quota immediately — no stored balance to reconcile.
        kept_small.total_bytes = 175
        assert await account_usage(db, account) == 425
        await unkeep(db, account, kept_large)
        assert await account_usage(db, account) == 175
        await db.commit()
        assert unkept.total_bytes == 999  # never counted against this account


async def test_memorial_is_excluded_from_account_usage(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        memorial = await _mk_gathering(
            db,
            gathering_type=GatheringType.MEMORIAL,
            memorial_decedent_name="Edith Hanson",
            total_bytes=10_000_000_000,
        )
        potluck = await _mk_gathering(db, total_bytes=100)
        await keep(db, account, memorial)
        await keep(db, account, potluck)
        assert await account_usage(db, account) == 100
        await db.commit()


# --- admin and the claimable state --------------------------------------------


async def test_unkeep_relinquishes_admin_only_when_the_departing_account_held_it(
    db_session_factory,
):
    async with db_session_factory() as db:
        admin, other = await _mk_account(db), await _mk_account(db)
        gathering = await _mk_gathering(db, admin_account_id=admin.id)
        await keep(db, admin, gathering)
        await keep(db, other, gathering)
        # A non-admin keeper leaving changes nothing about admin.
        await unkeep(db, other, gathering, now=NOW)
        assert gathering.admin_account_id == admin.id
        await keep(db, other, gathering)
        # The admin reverting to observer relinquishes admin in the same
        # transaction — NULL is the claimable state, and `other` (still a
        # keeper) is who the later claim flow will offer it to.
        await unkeep(db, admin, gathering, now=NOW)
        assert gathering.admin_account_id is None
        assert gathering.last_keeper_left_at is None  # other still keeps it
        await db.commit()


# --- schema shape -------------------------------------------------------------


async def test_0009_constraint_names_and_no_steward_orphans(db_session_factory):
    async with db_session_factory() as db:
        constraints = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT conname FROM pg_constraint WHERE conname IN "
                    "('uq_kept_gatherings_account_id_gathering_id', "
                    " 'fk_kept_gatherings_account_id', 'fk_kept_gatherings_gathering_id', "
                    " 'ck_gatherings_memorial_decedent_name', "
                    " 'fk_gatherings_admin_account_id', 'fk_gatherings_created_by_account_id', "
                    " 'fk_groups_admin_person_id', 'fk_groups_backup_admin_person_id')"
                )
            )
        }
        assert constraints == {
            "uq_kept_gatherings_account_id_gathering_id",
            "fk_kept_gatherings_account_id",
            "fk_kept_gatherings_gathering_id",
            "ck_gatherings_memorial_decedent_name",
            "fk_gatherings_admin_account_id",
            "fk_gatherings_created_by_account_id",
            "fk_groups_admin_person_id",
            "fk_groups_backup_admin_person_id",
        }
        # Nothing orphaned from the renames: the old steward constraint names,
        # the old gatherings FK/index names, and the old columns are all gone.
        leftovers = (
            await db.execute(
                text(
                    "SELECT count(*) FROM pg_constraint WHERE conname IN "
                    "('fk_groups_steward_person_id', 'fk_groups_backup_steward_person_id', "
                    " 'fk_gatherings_account_id')"
                )
            )
        ).scalar_one()
        assert leftovers == 0
        old_index = (
            await db.execute(
                text("SELECT count(*) FROM pg_indexes WHERE indexname = 'ix_gatherings_account_id'")
            )
        ).scalar_one()
        assert old_index == 0
        group_columns = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'groups'"
                )
            )
        }
        assert "admin_person_id" in group_columns
        assert "backup_admin_person_id" in group_columns
        assert "steward_person_id" not in group_columns
        assert "backup_steward_person_id" not in group_columns


async def test_kept_at_defaults_server_side(db_session_factory):
    # The service always sets kept_at explicitly; the server default exists so
    # the column can never silently be NULL through any other write path.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = await _mk_gathering(db)
        db.add(KeptGathering(account_id=account.id, gathering_id=gathering.id))
        await db.flush()
        row = (
            await db.execute(
                select(KeptGathering).where(
                    KeptGathering.account_id == account.id,
                    KeptGathering.gathering_id == gathering.id,
                )
            )
        ).scalar_one()
        assert row.kept_at is not None
        await db.rollback()
