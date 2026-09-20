"""CK-49a — the keeper shape; CK-49b — the cutover onto it; CK-49c — the
only representation left.

Migration 0022 (CK-49a) added `gatherings.owning_group_id` (no writer),
`groups.keeper_account_id` and `gatherings.keeper_account_id`, backfilled the
two keeper columns once from the old kept relation, and added the CHECK that
keeps a group gathering's keeper out of its own row; `services/keeping.py`
gained `resolve_keeper`, then called by nothing. Pinned here from that
phase: the resolver's two rungs and its refusals, the CHECK refused on a
real row (an unexercised constraint is a comment), the three constraint
names.

CK-49b made the column the truth — every consumer asks the resolver — and
CK-49c (migration 0023) re-ran 0022's backfill under the release guard and
dropped the relation, so the column is now the only representation there
is. The pins at the bottom, from the cutover: creation and `keep()` write
the column (the "and no kept row" half of each died with the table — there
is no longer a second place a keep could land); a gathering whose keeper
is set is fully visible to its keeper through the keeper rung ALONE; the
SQL form of the ladder agrees with the Python
resolver on every legal shape and correlates correctly with a `Gathering`
in the outer FROM; and a gathering that belongs to a group (constructed —
`owning_group_id` still has no writer) is seen, listed and counted by the
group's keeper and by nobody through its own NULL column.
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
    Media,
    MediaStatus,
    Person,
    PublicationState,
)
from app.services.keeping import (
    KeeperResolution,
    KeeperSource,
    account_usage,
    keep,
    keeps_gathering,
    resolve_keeper,
    resolved_keeper_of,
)
from tests.test_auth import _sign_in
from tests.test_gatherings import _account_for, _create, _signed_in_headers

CHECK_NAME = "ck_gatherings_group_gathering_has_no_keeper"
MISSING_ID = "00000000-0000-0000-0000-000000000000"


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


# --- the cutover (CK-49b): the column is written, the relation is not -----------


async def test_creation_writes_the_keeper_column_and_no_kept_row(
    client, capsys, db_session_factory
):
    # CK-49a's negative pin, inverted at CK-49b — the cutover's signature
    # from the write side: creation goes through keep(), which writes
    # keeper_account_id, and since CK-49c (0023) there is nothing else it
    # could write — the old kept relation is dropped. What survives is the
    # behaviour: the creator's account on the column, no owning group, no
    # stamp, and neither column in the response body.
    jwt = await _sign_in(client, capsys, "keeper-shape@example.com")
    response = await client.post(
        "/gatherings",
        json={
            "gathering_type": "potluck",
            "title": "After the cutover",
            "occurrences": [{"starts_at": "2026-10-01T18:00:00+00:00"}],
        },
        headers={"Authorization": f"Bearer {jwt}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert "keeper_account_id" not in body and "owning_group_id" not in body
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, body["id"])
        assert gathering.keeper_account_id == gathering.created_by_account_id
        assert gathering.owning_group_id is None
        assert gathering.last_keeper_left_at is None


async def test_keep_writes_the_column_and_never_the_relation(db_session_factory):
    # The service-level half of the same pin, without the router.
    async with db_session_factory() as db:
        account = await _mk_account(db)
        gathering = _gathering(await _mk_account(db))
        db.add(gathering)
        await db.flush()
        await keep(db, account, gathering)
        await db.commit()
        assert gathering.keeper_account_id == account.id
        assert gathering.last_keeper_left_at is None


async def test_a_keeper_with_no_kept_row_sees_everything(client, capsys, db_session_factory):
    # THE test CK-49b's correctness depended on, and still the audience's
    # spine. A gathering whose keeper_account_id is set — the state every
    # gathering created since the cutover is in, and since CK-49c (0023)
    # the only shape a kept gathering can have — is visible to its keeper
    # through the resolver. First the deployed shape exactly
    # (creator = host = keeper): the detail, the list, the
    # media list and an upload intent all answer. Then the host is set to
    # NULL — the claimable state, legal — so that ONLY the keeper rung can
    # admit the creator, and the detail, the list and the media list
    # (including a live photograph) still answer through it. And the
    # audience did not widen: a signed-in account that keeps nothing, hosts
    # nothing and was never invited draws the 404 byte-identical to a
    # missing id, before and after.
    address = "keeper-only@example.com"
    headers = await _signed_in_headers(client, capsys, address)
    outsider = await _signed_in_headers(client, capsys, "outsider@example.com")
    created = await _create(client, headers, title="Kept by a column")
    gathering_id = created["id"]
    async with db_session_factory() as db:
        account = await _account_for(db, address)
        gathering = await db.get(Gathering, gathering_id)
        assert gathering.keeper_account_id == account.id
        # A live, ready photograph by the keeper's own person, planted the
        # way the read tests plant them (the worker's output, without the
        # worker) — the media audience's keeper rung has a subject.
        person_id = (
            await db.execute(select(Person.id).where(Person.email == address))
        ).scalar_one()
        photo = Media(
            gathering_id=gathering.id,
            uploader_person_id=person_id,
            upload_content_type="image/jpeg",
            upload_size_bytes=1_000,
            status=MediaStatus.UPLOADED,
            publication_state=PublicationState.LIVE,
        )
        db.add(photo)
        await db.commit()
        photo_id = str(photo.id)

    async def _everything_answers():
        detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
        assert detail.status_code == 200, detail.text
        listed = await client.get("/gatherings", headers=headers)
        assert [g["id"] for g in listed.json()["gatherings"]] == [gathering_id]
        media = await client.get(f"/gatherings/{gathering_id}/media", headers=headers)
        assert media.status_code == 200, media.text
        # `in`, not `==`: the intent in (1) adds a pending row its uploader
        # may also see, and that is the audience rule, not this test's.
        assert photo_id in [m["id"] for m in media.json()["media"]]

    async def _the_outsider_is_refused():
        missing = await client.get(f"/gatherings/{MISSING_ID}", headers=outsider)
        refused = await client.get(f"/gatherings/{gathering_id}", headers=outsider)
        assert missing.status_code == refused.status_code == 404
        assert refused.content == missing.content
        assert (await client.get("/gatherings", headers=outsider)).json()["gatherings"] == []
        media_missing = await client.get(f"/gatherings/{MISSING_ID}/media", headers=outsider)
        media_refused = await client.get(f"/gatherings/{gathering_id}/media", headers=outsider)
        assert media_missing.status_code == media_refused.status_code == 404
        assert media_refused.content == media_missing.content

    # (1) The deployed shape: creator = host = keeper.
    await _everything_answers()
    await _the_outsider_is_refused()
    intent = await client.post(
        f"/gatherings/{gathering_id}/media/intents",
        json={"items": [{"content_type": "image/jpeg", "size_bytes": 4096}]},
        headers=headers,
    )
    assert intent.status_code == 201, intent.text

    # (2) The keeper rung alone: host NULL (claimable), keeper still set.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, gathering_id)
        gathering.host_account_id = None
        await db.commit()
    await _everything_answers()
    await _the_outsider_is_refused()


async def test_the_sql_ladder_agrees_with_the_resolver_on_every_legal_shape(
    db_session_factory,
):
    # keeps_gathering is resolve_keeper's ladder as SQL, for the WHERE
    # clauses that decide which rows are fetched at all. The two must never
    # drift: on the three legal shapes — a gathering with its own keeper, a
    # group gathering with its group's, and the Unkept rung — for every
    # account in sight, the SQL answer equals "the resolver's answer is this
    # account". And the SQL form correlates correctly when a Gathering is in
    # the outer FROM (its aliases are the point): a select over gatherings
    # filtered by it returns exactly the rows that resolve to the account.
    async with db_session_factory() as db:
        own_keeper, group_keeper, nobody = (
            await _mk_account(db),
            await _mk_account(db),
            await _mk_account(db),
        )
        group = await _mk_group(db)
        group.keeper_account_id = group_keeper.id
        own = _gathering(await _mk_account(db), keeper_account_id=own_keeper.id)
        in_group = _gathering(await _mk_account(db), owning_group_id=group.id)
        unkept = _gathering(await _mk_account(db))
        db.add_all([own, in_group, unkept])
        await db.commit()
        for gathering in (own, in_group, unkept):
            resolution = await resolved_keeper_of(db, gathering)
            for account in (own_keeper, group_keeper, nobody):
                in_sql = await db.scalar(select(keeps_gathering(account.id, gathering.id)))
                assert in_sql is (resolution.keeper_account_id == account.id), (
                    gathering.title,
                    resolution,
                    account.id,
                )
        assert (await resolved_keeper_of(db, own)).source is KeeperSource.OWN
        assert (await resolved_keeper_of(db, in_group)).source is KeeperSource.GROUP
        assert (await resolved_keeper_of(db, unkept)).source is KeeperSource.UNKEPT
        # Correlation with `Gathering` in the outer FROM.
        for account, expected in (
            (own_keeper, {own.id}),
            (group_keeper, {in_group.id}),
            (nobody, set()),
        ):
            rows = (
                await db.scalars(
                    select(Gathering.id).where(keeps_gathering(account.id, Gathering.id))
                )
            ).all()
            assert set(rows) == expected


async def test_a_group_gathering_is_seen_listed_and_counted_by_the_groups_keeper(
    client, capsys, db_session_factory
):
    # The resolver's first rung, live for the first time — against a
    # constructed subject, because `owning_group_id` still has no writer
    # (Arc B's). A gathering created through the API is moved into a group
    # whose keeper is a second account, its own keeper column NULLed (the
    # CHECK insists) and its host NULLed so nothing but the group rung can
    # admit anyone: the group's keeper reads it, lists it and is charged
    # its bytes; the creator — not host, not keeper, never invited — draws
    # the 404 byte-identical to a missing id and is charged nothing.
    creator_address, keeper_address = "creator@example.com", "group-keeper@example.com"
    creator = await _signed_in_headers(client, capsys, creator_address)
    keeper = await _signed_in_headers(client, capsys, keeper_address)
    created = await _create(client, creator, title="Belongs to a group")
    gathering_id = created["id"]
    async with db_session_factory() as db:
        keeper_account = await _account_for(db, keeper_address)
        creator_account = await _account_for(db, creator_address)
        group = await _mk_group(db)
        group.keeper_account_id = keeper_account.id
        gathering = await db.get(Gathering, gathering_id)
        gathering.keeper_account_id = None
        gathering.owning_group_id = group.id
        gathering.host_account_id = None
        gathering.total_bytes = 321
        await db.commit()
        resolution = await resolved_keeper_of(db, gathering)
        assert resolution == KeeperResolution(
            keeper_account_id=keeper_account.id, source=KeeperSource.GROUP
        )
        assert await account_usage(db, keeper_account) == 321
        assert await account_usage(db, creator_account) == 0
        # And the group's keeper going NULL leaves the gathering Unkept —
        # counted for nobody, without anything on the gathering changing.
        group.keeper_account_id = None
        await db.flush()
        assert (await resolved_keeper_of(db, gathering)).source is KeeperSource.UNKEPT
        assert await account_usage(db, keeper_account) == 0
        group.keeper_account_id = keeper_account.id
        await db.commit()

    detail = await client.get(f"/gatherings/{gathering_id}", headers=keeper)
    assert detail.status_code == 200, detail.text
    assert [g["id"] for g in (await client.get("/gatherings", headers=keeper)).json()["gatherings"]] == [
        gathering_id
    ]
    assert (await client.get(f"/gatherings/{gathering_id}/media", headers=keeper)).status_code == 200
    missing = await client.get(f"/gatherings/{MISSING_ID}", headers=creator)
    refused = await client.get(f"/gatherings/{gathering_id}", headers=creator)
    assert missing.status_code == refused.status_code == 404
    assert refused.content == missing.content
    assert (await client.get("/gatherings", headers=creator)).json()["gatherings"] == []
