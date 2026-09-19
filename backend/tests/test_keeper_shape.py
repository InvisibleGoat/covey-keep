"""CK-49a — the keeper shape arrives, and nothing reads it yet.

Migration 0022 added `gatherings.owning_group_id` (no writer), `groups.
keeper_account_id` and `gatherings.keeper_account_id`, backfilled the two
keeper columns once from `kept_gatherings`, and added the CHECK that keeps a
group gathering's keeper out of its own row; `services/keeping.py` gained
`resolve_keeper`, which nothing calls. THE ONE RULE OF THE PHASE — it changes
no behavior — is pinned here from both sides: the resolver's two rungs and
its refusals, the CHECK refused on a real row (an unexercised constraint is
a comment), the three constraint names, and the negative fact that creation
still writes a kept row and NOTHING to the new column. Every other test file
is byte-identical to CK-46's; `kept_gatherings` is still the truth.
"""

import inspect
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.api.groups import HOUSEHOLD_PROFILE_NAME
from app.models import (
    Account,
    AccountKind,
    CapabilityProfile,
    Gathering,
    GatheringType,
    Group,
    GroupType,
    KeptGathering,
    PublicationState,
)
from app.services.keeping import (
    KeeperResolution,
    KeeperSource,
    keep,
    resolve_keeper,
)
from tests.test_auth import _sign_in

CHECK_NAME = "ck_gatherings_group_gathering_has_no_keeper"


# --- the resolver: facts in, an answer and its rung out ------------------------


def test_a_standalone_gathering_resolves_to_its_own_keeper():
    keeper = uuid4()
    resolution = resolve_keeper(group_keeper_account_id=None, own_keeper_account_id=keeper)
    assert resolution == KeeperResolution(keeper_account_id=keeper, source=KeeperSource.OWN)


def test_a_group_gathering_resolves_through_its_group_with_its_own_column_null():
    # The gathering's own column is NULL (the CHECK sees to that) and the
    # answer comes from the group — the record's first rung, and the reason
    # the gathering row never carries a second copy of the group's keeper.
    keeper = uuid4()
    resolution = resolve_keeper(group_keeper_account_id=keeper, own_keeper_account_id=None)
    assert resolution == KeeperResolution(keeper_account_id=keeper, source=KeeperSource.GROUP)


def test_both_null_is_unkept_and_not_an_error():
    # §5's Unkept rung — the deploy's "Test Event" is one. A state, never a
    # default invented on its behalf.
    resolution = resolve_keeper(group_keeper_account_id=None, own_keeper_account_id=None)
    assert resolution.keeper_account_id is None
    assert resolution.source is KeeperSource.UNKEPT


def test_the_resolver_refuses_the_row_the_check_forbids():
    # Both set is not "the group rung wins" — it is a caller that read the
    # wrong columns, or a database where the CHECK is gone. The publication
    # ladder's pass-over-None discipline would hide exactly that.
    with pytest.raises(ValueError):
        resolve_keeper(group_keeper_account_id=uuid4(), own_keeper_account_id=uuid4())


def test_an_archived_group_resolves_identically_and_the_archive_state_is_not_an_input():
    # Record §3.1 (added at 1.2.2): an archived group still keeps its
    # gatherings, and the resolver never reads `groups.archived_at`. The
    # resolver is pure, so "archived resolves identically to active" is
    # true by construction — the two facts an archived group presents are
    # the same two facts — and the thing to PIN is that nothing can make it
    # otherwise: the signature carries exactly the two facts, keyword-only,
    # and no parameter for the archive state. A later phase that "fixes"
    # this by threading `archived_at` through fails here before it ships.
    params = inspect.signature(resolve_keeper).parameters
    assert set(params) == {"group_keeper_account_id", "own_keeper_account_id"}
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in params.values())
    assert not any("archiv" in name for name in params)
    with pytest.raises(TypeError):
        resolve_keeper(
            group_keeper_account_id=uuid4(),
            own_keeper_account_id=None,
            archived_at=None,  # type: ignore[call-arg]
        )
    # And the same facts give the same answer, however the group is flagged
    # elsewhere: an archived group's keeper is still its keeper.
    keeper = uuid4()
    active = resolve_keeper(group_keeper_account_id=keeper, own_keeper_account_id=None)
    archived = resolve_keeper(group_keeper_account_id=keeper, own_keeper_account_id=None)
    assert active == archived
    assert active.source is KeeperSource.GROUP


# --- the CHECK, exercised on real rows ------------------------------------------


async def _mk_account(db) -> Account:
    account = Account(kind=AccountKind.PERSON)
    db.add(account)
    await db.flush()
    return account


async def _mk_group(db) -> Group:
    profile = (
        await db.execute(
            select(CapabilityProfile).where(CapabilityProfile.name == HOUSEHOLD_PROFILE_NAME)
        )
    ).scalar_one()
    group = Group(
        group_type=GroupType.HOUSEHOLD,
        capability_profile_id=profile.id,
        name="keeper shape test group",
    )
    db.add(group)
    await db.flush()
    return group


def _gathering(creator: Account, **columns) -> Gathering:
    return Gathering(
        created_by_account_id=creator.id,
        gathering_type=GatheringType.POTLUCK,
        title="keeper shape test gathering",
        publication_state=PublicationState.LIVE,
        **columns,
    )


async def test_the_check_refuses_a_gathering_with_both_a_group_and_its_own_keeper(
    db_session_factory,
):
    # An unexercised constraint is a comment. The row the record forbids —
    # a group gathering carrying a second copy of a keeper beside its group
    # — is refused by the database, by name.
    async with db_session_factory() as db:
        creator = await _mk_account(db)
        keeper = await _mk_account(db)
        group = await _mk_group(db)
        await db.commit()
    async with db_session_factory() as db:
        db.add(_gathering(creator, owning_group_id=group.id, keeper_account_id=keeper.id))
        with pytest.raises(IntegrityError) as refused:
            await db.flush()
        assert CHECK_NAME in str(refused.value)


async def test_the_check_admits_each_alone_and_neither(db_session_factory):
    # The three legal shapes: a standalone gathering with its own keeper, a
    # group gathering with none of its own, and the Unkept rung — both NULL
    # (the shape "Test Event" holds on the deploy, and it is legal).
    async with db_session_factory() as db:
        creator = await _mk_account(db)
        keeper = await _mk_account(db)
        group = await _mk_group(db)
        own = _gathering(creator, keeper_account_id=keeper.id)
        in_group = _gathering(creator, owning_group_id=group.id)
        unkept = _gathering(creator)
        db.add_all([own, in_group, unkept])
        await db.commit()
        assert own.keeper_account_id == keeper.id and own.owning_group_id is None
        assert in_group.owning_group_id == group.id and in_group.keeper_account_id is None
        assert unkept.owning_group_id is None and unkept.keeper_account_id is None


# --- the shape, by name -----------------------------------------------------------


async def test_0022_constraint_names_and_the_three_nullable_columns(db_session_factory):
    async with db_session_factory() as db:
        constraints = {
            r[0]
            for r in await db.execute(
                text(
                    "SELECT conname FROM pg_constraint WHERE conname IN "
                    f"('{CHECK_NAME}', "
                    " 'fk_gatherings_owning_group_id', "
                    " 'fk_gatherings_keeper_account_id', "
                    " 'fk_groups_keeper_account_id')"
                )
            )
        }
        assert constraints == {
            CHECK_NAME,
            "fk_gatherings_owning_group_id",
            "fk_gatherings_keeper_account_id",
            "fk_groups_keeper_account_id",
        }
        shape = {
            (r[0], r[1]): (r[2], r[3], r[4])
            for r in await db.execute(
                text(
                    "SELECT table_name, column_name, data_type, is_nullable, column_default "
                    "FROM information_schema.columns WHERE table_schema = 'public' AND "
                    "(table_name, column_name) IN "
                    "(('gatherings', 'owning_group_id'), ('gatherings', 'keeper_account_id'), "
                    " ('groups', 'keeper_account_id'))"
                )
            )
        }
        # Nullable, no default, on all three: NULL is a state on each (the
        # unkept rung; "belongs to no group"), and a default would invent one.
        assert shape == {
            ("gatherings", "owning_group_id"): ("uuid", "YES", None),
            ("gatherings", "keeper_account_id"): ("uuid", "YES", None),
            ("groups", "keeper_account_id"): ("uuid", "YES", None),
        }


# --- the one rule: nothing writes the new columns, and kept_gatherings is the truth


async def test_creation_still_writes_a_kept_row_and_nothing_to_the_keeper_column(
    client, capsys, db_session_factory
):
    # The phase's one rule from the write side. After 0022 the backfill is
    # a snapshot: creation goes through keep(), which writes a kept row and
    # NOTHING to keeper_account_id — so the two representations diverge on
    # every gathering created between 0022 and the cutover, and CK-49b's
    # 0023 must re-run the backfill before it drops the relation. Pinned
    # so that the divergence is a known fact, not a surprise, and so that
    # a "helpful" write to the new column in keep() (a behavior change
    # this phase forbids) fails here.
    jwt = await _sign_in(client, capsys, "keeper-shape@example.com")
    response = await client.post(
        "/gatherings",
        json={
            "gathering_type": "potluck",
            "title": "After 0022",
            "occurrences": [{"starts_at": "2026-10-01T18:00:00+00:00"}],
        },
        headers={"Authorization": f"Bearer {jwt}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert "keeper_account_id" not in body and "owning_group_id" not in body
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, body["id"])
        kept = (
            await db.execute(
                select(KeptGathering).where(KeptGathering.gathering_id == gathering.id)
            )
        ).scalar_one()
        assert kept.account_id == gathering.created_by_account_id
        assert gathering.keeper_account_id is None
        assert gathering.owning_group_id is None


async def test_keep_writes_the_relation_and_not_the_column(db_session_factory):
    # The service-level half of the same pin, without the router.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = _gathering(await _mk_account(db))
        db.add(gathering)
        await db.flush()
        await keep(db, account, gathering)
        await db.commit()
        assert gathering.keeper_account_id is None
        assert gathering.last_keeper_left_at is None
