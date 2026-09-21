"""CK-13 — the keeper lifecycle: keep and unkeep, derived grace, memorial
exemption, host relinquishment — rewritten at CK-49b against the keeper
COLUMN (keeper record v2 §3.1).

The keeper is `gatherings.keeper_account_id` (or the owning group's),
answered through `resolve_keeper`, and since CK-49c (migration 0023) it is
the only representation there is — the old kept relation is dropped, and
this file's shape probe of it went with it. Grace is derived from one timestamp plus policy
constants, and the 30/90 assertions below are UNCHANGED because the
constants are: the ladder is new behaviour and arrives with its surfaces
(v2 §5), and `grace_state` is inert — nothing but this file calls it.
Memorials are exempt by TYPE and gated by a named decedent. The
deletion-path half (keeping lapsing on anonymization) is pinned in
test_account_deletion.py, next to the rest of the deletion contract; the
resolver's group rung, the SQL form of the ladder and the cutover's own
pins are in test_keeper_shape.py.

Since CK-51b the quota is in PHOTOGRAPHS (the currency record §3): the
usage tests below plant `photo_count` where they planted `total_bytes`,
with the same numbers — the unit changed, the arithmetic did not — and two
tests are new: `gathering_units` (a memorial's own count, published plus in
flight) and `account_bin_count` (ready-and-removed rows over the gatherings
that resolve to the account, the refusal path's number and nothing else's).
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import (
    Account,
    AccountKind,
    Gathering,
    GatheringType,
    Media,
    MediaStatus,
    PublicationState,
)
from app.services import keeping
from app.services.keeping import (
    GraceState,
    KeeperSource,
    account_bin_count,
    account_usage,
    gathering_units,
    grace_state,
    keep,
    resolved_keeper_of,
    unkeep,
)

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
    photo_count: int = 0,
    memorial_decedent_name: str | None = None,
    host_account_id=None,
) -> Gathering:
    creator = await _mk_account(db)
    gathering = Gathering(
        created_by_account_id=creator.id,
        host_account_id=host_account_id,
        gathering_type=gathering_type,
        title="keeping test gathering",
        memorial_decedent_name=memorial_decedent_name,
        total_bytes=total_bytes,
        photo_count=photo_count,
        publication_state=PublicationState.LIVE,
    )
    db.add(gathering)
    await db.flush()
    return gathering


# --- one keeper -----------------------------------------------------------------


async def test_a_second_keep_is_refused_and_nothing_moves(db_session_factory):
    # The relation's unique constraint refused the same account twice; the
    # column refuses ANY second keep — a second account is a transfer (v2
    # §4), which has its own act and no surface yet. Nothing is written on
    # refusal: the keeper and the stamp read exactly as before it.
    async with db_session_factory() as db:
        account, another = await _mk_account(db), await _mk_account(db)
        gathering = await _mk_gathering(db)
        resolution = await keep(db, account, gathering)
        assert resolution.keeper_account_id == account.id
        assert resolution.source is KeeperSource.OWN
        with pytest.raises(ValueError):
            await keep(db, account, gathering)
        with pytest.raises(ValueError):
            await keep(db, another, gathering)
        assert gathering.keeper_account_id == account.id
        assert gathering.last_keeper_left_at is None


async def test_unkeep_by_a_non_keeper_is_loud(db_session_factory):
    async with db_session_factory() as db:
        account, another = await _mk_account(db), await _mk_account(db)
        gathering = await _mk_gathering(db)
        # Nobody keeps it: loud, as before.
        with pytest.raises(LookupError):
            await unkeep(db, account, gathering)
        # Somebody else keeps it: just as loud, and the keeper is untouched.
        await keep(db, account, gathering)
        with pytest.raises(LookupError):
            await unkeep(db, another, gathering)
        assert gathering.keeper_account_id == account.id


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


async def test_a_kept_gathering_never_carries_the_stamp_and_resolves_to_its_keeper(
    db_session_factory,
):
    # THE invariant, restated for one keeper: a keeper ⇒ last_keeper_left_at
    # IS NULL, and the resolver names that keeper (its own — rung 2); the
    # keeper leaving IS the last keeper leaving, so the stamp lands then and
    # the row resolves UNKEPT — a state, not an error.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = await _mk_gathering(db)
        await keep(db, account, gathering)
        assert gathering.last_keeper_left_at is None
        resolution = await resolved_keeper_of(db, gathering)
        assert resolution.keeper_account_id == account.id
        assert resolution.source is KeeperSource.OWN
        await unkeep(db, account, gathering, now=NOW)
        assert gathering.last_keeper_left_at == NOW
        assert gathering.keeper_account_id is None
        assert (await resolved_keeper_of(db, gathering)).source is KeeperSource.UNKEPT
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
        # The keeper just left — and the stamp stays NULL: a memorial never
        # enters grace.
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


# --- quota: computed fresh over the gatherings that resolve to the account ----
# In PHOTOGRAPHS since CK-51b: the same tests, the same numbers, the unit
# changed — `photo_count` where `total_bytes` stood.


async def test_account_usage_counts_only_gatherings_the_account_keeps_and_tracks_photo_count(
    db_session_factory,
):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        kept_small = await _mk_gathering(db, photo_count=100, total_bytes=1)
        kept_large = await _mk_gathering(db, photo_count=250, total_bytes=1)
        unkept = await _mk_gathering(db, photo_count=999)
        await keep(db, account, kept_small)
        await keep(db, account, kept_large)
        assert await account_usage(db, account) == 350
        # Computed fresh: a photo_count change shows up immediately, and an
        # unkeep frees the quota immediately — no stored balance to reconcile.
        kept_small.photo_count = 175
        assert await account_usage(db, account) == 425
        # The byte column is not read: moving it moves nothing here.
        kept_small.total_bytes = 10_000_000_000
        assert await account_usage(db, account) == 425
        await unkeep(db, account, kept_large)
        assert await account_usage(db, account) == 175
        await db.commit()
        assert unkept.photo_count == 999  # never counted against this account


async def test_memorial_is_excluded_from_account_usage(db_session_factory):
    async with db_session_factory() as db:
        account = await _mk_account(db)
        memorial = await _mk_gathering(
            db,
            gathering_type=GatheringType.MEMORIAL,
            memorial_decedent_name="Edith Hanson",
            photo_count=10_000,
        )
        potluck = await _mk_gathering(db, photo_count=100)
        await keep(db, account, memorial)
        await keep(db, account, potluck)
        assert await account_usage(db, account) == 100
        await db.commit()


def _row(gathering_id, status: MediaStatus, state: PublicationState, *, removed: bool = False) -> Media:
    now = datetime.now(timezone.utc)
    return Media(
        gathering_id=gathering_id,
        guest_name="fixture",
        upload_content_type="image/jpeg",
        upload_size_bytes=1_000,
        status=status,
        publication_state=state,
        removed_at=now if removed else None,
        created_at=now,
        uploaded_at=None if status == MediaStatus.PENDING_UPLOAD else now,
    )


async def test_the_quota_constants_are_photographs_and_the_byte_names_are_gone():
    # The currency record §3 and §8 at 2.4.0, and the one byte figure that
    # survives with a narrower job (§5, §7): a cost model the monitor reads
    # and nothing else — pinned against being a quota input in
    # test_media_intents.py's grep-style test.
    assert keeping.FREE_TIER_PHOTOGRAPHS == 10_000
    assert keeping.MEMORIAL_CEILING_PHOTOGRAPHS == 5_000
    assert keeping.PHOTOGRAPH_BYTES == 1_134_630
    for retired in ("FREE_TIER_BYTES", "MEMORIAL_CEILING_BYTES", "gathering_bytes", "_in_flight_bytes_of"):
        assert not hasattr(keeping, retired), retired
    assert keeping.IN_FLIGHT_STATUSES == (
        MediaStatus.PENDING_UPLOAD,
        MediaStatus.UPLOADED,
        MediaStatus.PROCESSING,
    )


async def test_gathering_units_is_the_gatherings_own_count_published_plus_in_flight(
    db_session_factory,
):
    # The memorial ceiling's subject: `photo_count` plus ONE per in-flight
    # row — pending_upload, uploaded, processing — whatever each declared.
    # A ready row is already in photo_count (not in flight); a failed row
    # is nothing. Its own count, never any account's.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        memorial = await _mk_gathering(
            db,
            gathering_type=GatheringType.MEMORIAL,
            memorial_decedent_name="Edith Hanson",
            photo_count=3,
            total_bytes=10_000_000_000,
        )
        await keep(db, account, memorial)
        db.add_all(
            [
                _row(memorial.id, MediaStatus.PENDING_UPLOAD, PublicationState.PENDING),
                _row(memorial.id, MediaStatus.UPLOADED, PublicationState.PENDING),
                _row(memorial.id, MediaStatus.PROCESSING, PublicationState.PENDING),
                _row(memorial.id, MediaStatus.READY, PublicationState.LIVE),
                _row(memorial.id, MediaStatus.FAILED, PublicationState.PENDING),
            ]
        )
        await db.flush()
        assert await gathering_units(db, memorial) == 6
        # A memorial's units touch no account's usage.
        assert await account_usage(db, account) == 0
        await db.commit()


async def test_account_bin_count_counts_only_ready_removed_rows_over_gatherings_resolving_to_the_account(
    db_session_factory,
):
    # The refusal path's number (bin record §5): ready AND removed, over the
    # same candidates account_usage counts — the gatherings that resolve to
    # the account, memorials exempt. Not a quota input: usage does not move
    # with it.
    from tests.test_keeper_shape import _mk_group

    async with db_session_factory() as db:
        account, other = await _mk_account(db), await _mk_account(db)
        own = await _mk_gathering(db, photo_count=5)
        theirs = await _mk_gathering(db, photo_count=5)
        memorial = await _mk_gathering(
            db, gathering_type=GatheringType.MEMORIAL, memorial_decedent_name="Edith Hanson", photo_count=5
        )
        await keep(db, account, own)
        await keep(db, other, theirs)
        await keep(db, account, memorial)
        group = await _mk_group(db)
        group.keeper_account_id = account.id
        in_group = await _mk_gathering(db, photo_count=5)
        in_group.owning_group_id = group.id
        await db.flush()
        db.add_all(
            [
                # own: two in the bin; the rest are not bin rows
                _row(own.id, MediaStatus.READY, PublicationState.REMOVED, removed=True),
                _row(own.id, MediaStatus.READY, PublicationState.REMOVED, removed=True),
                _row(own.id, MediaStatus.READY, PublicationState.LIVE),
                _row(own.id, MediaStatus.READY, PublicationState.PENDING),
                _row(own.id, MediaStatus.FAILED, PublicationState.REMOVED, removed=True),  # not ready
                _row(own.id, MediaStatus.UPLOADED, PublicationState.PENDING),
                # theirs: another account's bin
                _row(theirs.id, MediaStatus.READY, PublicationState.REMOVED, removed=True),
                # the memorial the account keeps: exempt from the account, bin included
                _row(memorial.id, MediaStatus.READY, PublicationState.REMOVED, removed=True),
                # the group gathering: the resolver's first rung
                _row(in_group.id, MediaStatus.READY, PublicationState.REMOVED, removed=True),
            ]
        )
        await db.flush()
        usage_before = await account_usage(db, account)
        assert await account_bin_count(db, account) == 3
        assert await account_bin_count(db, other) == 1
        # Not a quota input: counting the bin moves nothing.
        assert await account_usage(db, account) == usage_before == 5 + 1 + 5  # own + its uploaded row + in_group
        # Releasing a gathering releases its bin with it.
        await unkeep(db, account, own)
        assert await account_bin_count(db, account) == 1
        await db.commit()


# --- host and the claimable state ------------------------------------------------


async def test_unkeep_relinquishes_host_only_when_the_departing_account_held_it(
    db_session_factory,
):
    async with db_session_factory() as db:
        host, other = await _mk_account(db), await _mk_account(db)
        # Hosted by one account and kept by another — the sponsorship shape
        # (grandma keeps, her grandson hosts), legal under one keeper because
        # host and keeper are two facts.
        sponsored = await _mk_gathering(db, host_account_id=host.id)
        await keep(db, other, sponsored)
        await unkeep(db, other, sponsored, now=NOW)
        # The keeper leaving changes nothing about the host; the gathering
        # is stamped (its keeper left) and still hosted.
        assert sponsored.host_account_id == host.id
        assert sponsored.last_keeper_left_at == NOW
        # Hosted AND kept by the same account: the host reverting to
        # observer relinquishes the host in the same flush — NULL is the
        # claimable state.
        own = await _mk_gathering(db, host_account_id=host.id)
        await keep(db, host, own)
        await unkeep(db, host, own, now=NOW)
        assert own.host_account_id is None
        assert own.last_keeper_left_at == NOW
        await db.commit()


# --- schema shape -------------------------------------------------------------


async def test_0009_constraint_names_and_no_steward_orphans(db_session_factory):
    async with db_session_factory() as db:
        constraints = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT conname FROM pg_constraint WHERE conname IN "
                    "('ck_gatherings_memorial_decedent_name', "
                    " 'fk_gatherings_host_account_id', 'fk_gatherings_created_by_account_id', "
                    " 'fk_groups_admin_person_id', 'fk_groups_backup_admin_person_id')"
                )
            )
        }
        assert constraints == {
            "ck_gatherings_memorial_decedent_name",
            "fk_gatherings_host_account_id",
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
