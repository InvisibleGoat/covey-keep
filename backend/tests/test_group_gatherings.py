"""CK-76 — Groups 2a: a gathering in a group, the whole group invited
(decisions/2026-10-23-joining-a-group-and-co-admins.md §4;
decisions/2026-09-02-groups-as-homes.md §3;
decisions/2026-09-17-a-group-is-archived-never-deleted.md §6–§6.1, §9;
decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §9, §10;
migration 0033). The cast is tests/test_group_membership.py's — an ADMIN who
created the group (and so keeps it), a CO-ADMIN, a MEMBER, a STRANGER — and
every seat is signed in; no network anywhere.

The load-bearing pins:
- CREATION IN A GROUP: `owning_group_id` written and NO keeper of the
  gathering's own — the resolver answers GROUP with the group's keeper;
  one invitation row per OTHER live member, none for the creator, none for
  an anonymized member, each `invited_by` the creator; the body carries
  `group` and `caller_role` `host`; a non-member draws the GROUP's 404
  byte-identical to a missing group and nothing is written; a group of a
  refused type is a field-level 422 at `group_id`; a gathering never gains
  a group later (the PATCH refuses the field); a groupless create is
  unchanged in its shape and its facts;
- THE KEEPER IS LIVE THROUGH THE GROUP: an upload by an invited member
  charges the GROUP's keeper — the first real subject of the resolver's
  first rung at the gate (CK-50 tested it on constructed rows) — and a
  group whose keeper is NULL refuses with the keeperless copy;
- NEWCOMERS: joining by an approved request and by an accepted invitation
  each writes rows for the UPCOMING gatherings only — a past-only
  gathering gets none, a season with a date ahead gets one, a date in
  progress gets one — `invited_by` NULL, idempotent on a second admission;
  leaving and removal remove no row;
- MEMBERS ONLY: an emailed invitation to a group gathering is the 409
  `members_only`, before the channel check, with no pending row and no
  email sent; a groupless gathering's invitation is unchanged; a member is
  made a co-host by their materialized row's id;
- THE LIST is the read audience — a member who created a gathering in a
  group without keeping the group finds it; a host who is not the keeper
  of a STANDALONE gathering finds it (the CK-68 gap, closed); a co-host
  finds theirs; `group` on every item; the statement count does not scale;
- THE GROUP'S GATHERINGS: a member lists them; a non-member draws the
  group's 404; a member removed after a gathering was created still reads
  it, and leaving does not hide it;
- THE TEMPLATE RUNG: a group gathering resolves open with source TEMPLATE
  — in the facts the body reads, at publish (a photograph goes `live`
  through the real worker) and at restore (a non-host's restore lands
  `live`, and `pending` once the host's own setting gates); a groupless
  gathering is exactly today's (JOIN_SHAPE);
- THE BACKUP COLUMN is unmapped (CK-76) and GONE since 0034 (CK-77);
- THE 0033 ROUND TRIP, under the round-trip rider;
- the verifier's three new lines, fired by a plant each and by nothing
  else; nothing logged that these routes did not log before.
"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from sqlalchemy import event, select, text

from app.api import gatherings as gatherings_api
from app.api import invitations as invitations_api
from app.api.gatherings import _home_facts
from app.api.invitations import MEMBERS_ONLY
from app.db import engine
from app.models import (
    Gathering,
    GatheringInvitation,
    GatheringInvitationPending,
    Group,
    Media,
    MediaDerivative,
    MediaStatus,
    Person,
    PublicationState,
)
from app.services import keeping, publication
from app.services.groups import invite_newcomer_to_upcoming_gatherings
from app.services.storage import published_key, quarantine_key
from app.worker import Poll, poll_once
from tests.test_account_deletion import DELETE_BODY
from tests.test_destruction import _verifier
from tests.test_gatherings import _account_for, _create, _field_errors, _signed_in_headers
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _approve, _join, _make, _requests, _token_of
from tests.test_group_membership import (
    ADMIN,
    CO_ADMIN,
    MEMBER,
    STRANGER,
    Cast,
    _add_member,
    _cast,
    _group_404,
    _leave,
    _person_id,
    _remove,
)
from tests.test_groups import MISSING
from tests.test_invitations import _invite
from tests.test_media_intents import _intents, _item, _set_photo_count
from tests.test_media_reads import LAYER_SPECS
from tests.test_photo_count import HEAD, _migrate, at_head_afterwards  # noqa: F401 — the fixture
from tests.test_removal_attribution import _restore, _state
from tests.test_worker import (
    GPS_PHOTO,
    FakeStore,
    _media,
    worker,  # noqa: F401 — the fixture
    worker_settings,  # noqa: F401 — the fixture
)

GROUP_NAME = "Finch family"
INDEX = "ix_gatherings_owning_group_id"
# The verifier's total, pinned as a number (the CK-57 convention): 339 since
# CK-76's three lines on top of CK-75's 336; 361 since CK-77's twenty-three
# (the places table's shape, the type's labels, invitees_chosen and its CHECK,
# three data lines) less the one retired (CK-75's backup-NULL line, replaced
# by the 0009 block's is-gone line).
VERIFIER_TOTAL = 361


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    return instant.isoformat()


def _upcoming_date() -> dict:
    return {"starts_at": _iso(_now() + timedelta(days=30))}


async def _create_in_group(client, headers, group_id: str, **overrides) -> dict:
    body = {
        "gathering_type": "potluck",
        "title": "Sunday dinner",
        "occurrences": [_upcoming_date()],
        "group_id": group_id,
    }
    body.update(overrides)
    response = await client.post("/gatherings", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _row(db_session_factory, gathering_id: str) -> Gathering:
    async with db_session_factory() as db:
        return await db.get(Gathering, UUID(gathering_id))


async def _invitation_rows(db_session_factory, gathering_id: str) -> dict[UUID, UUID | None]:
    """{person_id: invited_by_person_id} for every person-targeted row on the
    gathering."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(GatheringInvitation.person_id, GatheringInvitation.invited_by_person_id).where(
                    GatheringInvitation.gathering_id == UUID(gathering_id),
                    GatheringInvitation.person_id.is_not(None),
                )
            )
        ).all()
    return {person: by for person, by in rows}


async def _invitation_id(db_session_factory, gathering_id: str, address: str) -> str:
    async with db_session_factory() as db:
        return str(
            (
                await db.execute(
                    select(GatheringInvitation.id)
                    .join(Person, Person.id == GatheringInvitation.person_id)
                    .where(GatheringInvitation.gathering_id == UUID(gathering_id), Person.email == address)
                )
            ).scalar_one()
        )


async def _list(client, headers):
    response = await client.get("/gatherings", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["gatherings"]


async def _group_list(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/gatherings", headers=headers)


async def _gathering_404(client, headers) -> tuple[int, bytes]:
    response = await client.get(f"/gatherings/{MISSING}", headers=headers)
    return response.status_code, response.content


async def _index_present(db_session_factory) -> tuple[str, bool]:
    async with db_session_factory() as db:
        head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
        present = (
            await db.scalar(
                text("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = :n"),
                {"n": INDEX},
            )
        ) == 1
    return head, present


async def _photograph(
    db_session_factory,
    gathering_id: str,
    uploader_person_id: UUID,
    *,
    publication_state: PublicationState,
    removed_by_person_id: UUID | None = None,
) -> str:
    """A `ready` row by the uploader with its three derivative rows — the
    worker's output, without the worker (test_media_reads' shape)."""
    born = _now()
    async with db_session_factory() as db:
        row = Media(
            gathering_id=UUID(gathering_id),
            uploader_person_id=uploader_person_id,
            upload_content_type="image/jpeg",
            upload_size_bytes=1_300_000,
            status=MediaStatus.READY,
            publication_state=publication_state,
            removed_at=born if publication_state is PublicationState.REMOVED else None,
            removed_by_person_id=removed_by_person_id,
            created_at=born,
            uploaded_at=born,
        )
        db.add(row)
        await db.flush()
        for layer, (content_type, size, storage_class) in LAYER_SPECS.items():
            db.add(
                MediaDerivative(
                    media_id=row.id,
                    layer=layer,
                    storage_key=published_key(row.id, layer),
                    content_type=content_type,
                    size_bytes=size,
                    storage_class=storage_class,
                )
            )
        await db.commit()
        return str(row.id)


# --- creation in a group ------------------------------------------------------------


async def test_a_member_creates_a_gathering_in_the_group_and_every_other_live_member_is_invited_by_a_row(
    client, capsys, db_session_factory
):
    """The belongs-to link, written at last. The MEMBER — not the admin, not
    the keeper — creates a gathering in the group: `owning_group_id` is the
    group, the gathering's own keeper is NULL (the CHECK), and the resolver
    answers GROUP with the ADMIN's account, who created and so keeps the
    group. One invitation row per other member whose person is not
    anonymized — the admin and the co-admin — none for the creator (the
    host), none for the member who deleted their account, each
    `invited_by` the creator. The body carries `group` and `caller_role`
    `host`, and its key set is a groupless body's plus `group`; a groupless
    create is unchanged — `group` null, the keeper written, no invitation
    row."""
    cast = await _cast(client, capsys, db_session_factory)
    gone = "gone@example.com"
    gone_headers = await _signed_in_headers(client, capsys, gone)
    await _add_member(db_session_factory, cast.group_id, gone)
    gone_person = await _person_id(db_session_factory, gone)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204

    body = await _create_in_group(client, cast.member, cast.group_id)
    assert body["group"] == {"id": cast.group_id, "name": GROUP_NAME}
    assert body["caller_role"] == "host"
    assert body["requires_approval"] is False and body["requires_approval_override"] is None
    assert "owning_group_id" not in body and "keeper_account_id" not in body

    async with db_session_factory() as db:
        member_account = await _account_for(db, MEMBER)
        admin_account = await _account_for(db, ADMIN)
        gathering = await db.get(Gathering, UUID(body["id"]))
        assert gathering.owning_group_id == UUID(cast.group_id)
        assert gathering.keeper_account_id is None
        assert gathering.host_account_id == member_account.id
        assert gathering.created_by_account_id == member_account.id
        assert gathering.last_keeper_left_at is None
        assert gathering.requires_approval is None  # nobody decided; the ladder answers
        resolution = await keeping.resolved_keeper_of(db, gathering)
        assert resolution == keeping.KeeperResolution(
            keeper_account_id=admin_account.id, source=keeping.KeeperSource.GROUP
        )
    member_person = await _person_id(db_session_factory, MEMBER)
    admin_person = await _person_id(db_session_factory, ADMIN)
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    rows = await _invitation_rows(db_session_factory, body["id"])
    assert rows == {admin_person: member_person, co_admin_person: member_person}
    assert member_person not in rows and gone_person not in rows

    # Every invited member reads it, the creator reads it as host, and the
    # stranger draws the gathering 404 byte-identical to a missing id.
    for headers, role in ((cast.member, "host"), (cast.admin, None), (cast.co_admin, None)):
        detail = await client.get(f"/gatherings/{body['id']}", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["caller_role"] == role
        assert detail.json()["group"] == {"id": cast.group_id, "name": GROUP_NAME}
    refused = await client.get(f"/gatherings/{body['id']}", headers=cast.stranger)
    assert (refused.status_code, refused.content) == await _gathering_404(client, cast.stranger)

    # A groupless create, unchanged: the same key set, `group` null, the
    # creator the keeper, and no invitation row at all.
    standalone = await _create(client, cast.member, title="Just mine")
    assert set(standalone) == set(body)
    assert standalone["group"] is None and standalone["caller_role"] == "host"
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(standalone["id"]))
        assert gathering.owning_group_id is None
        assert gathering.keeper_account_id == member_account.id
    assert await _invitation_rows(db_session_factory, standalone["id"]) == {}


async def test_a_non_member_draws_the_groups_404_and_nothing_is_written_and_no_gathering_gains_a_group(
    client, capsys, db_session_factory
):
    """The stranger's create in the group is the GROUP's 404 — byte-identical
    to a missing group, so a probe learns nothing — and no gathering, no
    occurrence and no invitation row is written; a missing group id is the
    same 404. And `group_id` is not patchable: a gathering never gains a
    group after creation and never moves between groups (the archive
    record §9), so the PATCH refuses the field and the row is unchanged."""
    cast = await _cast(client, capsys, db_session_factory)
    expected = await _group_404(client, cast.stranger)

    async def counts() -> tuple[int, int]:
        async with db_session_factory() as db:
            gatherings = await db.scalar(text("SELECT count(*) FROM gatherings"))
            invitations = await db.scalar(text("SELECT count(*) FROM gathering_invitations"))
            return gatherings, invitations

    before = await counts()
    body = {"gathering_type": "potluck", "title": "Not yours", "occurrences": [_upcoming_date()]}
    refused = await client.post("/gatherings", json={**body, "group_id": cast.group_id}, headers=cast.stranger)
    assert (refused.status_code, refused.content) == expected
    missing = await client.post("/gatherings", json={**body, "group_id": MISSING}, headers=cast.member)
    assert (missing.status_code, missing.content) == expected
    assert await counts() == before

    created = await _create_in_group(client, cast.member, cast.group_id)
    standalone = await _create(client, cast.member)
    for gathering_id in (created["id"], standalone["id"]):
        patched = await client.patch(
            f"/gatherings/{gathering_id}", json={"group_id": cast.group_id}, headers=cast.member
        )
        assert patched.status_code == 422, patched.text
        assert _field_errors(patched) == {"group_id"}
    assert (await _row(db_session_factory, created["id"])).owning_group_id == UUID(cast.group_id)
    assert (await _row(db_session_factory, standalone["id"])).owning_group_id is None


async def test_a_gathering_in_a_group_of_a_refused_type_is_a_field_level_422_at_group_id(
    client, capsys, db_session_factory
):
    """Household groups only (record §4). No endpoint can make a TEAM group,
    so one is planted by raw SQL with the member in it; the create refuses
    at `group_id`, naming the rung-2 gate, and writes nothing."""
    cast = await _cast(client, capsys, db_session_factory)
    member_person = await _person_id(db_session_factory, MEMBER)
    async with db_session_factory() as db:
        profile_id = (
            await db.execute(
                text("INSERT INTO capability_profiles (group_type, name) VALUES ('TEAM', 'ck76-team-plant') RETURNING id")
            )
        ).scalar_one()
        team_id = (
            await db.execute(
                text(
                    "INSERT INTO groups (group_type, capability_profile_id, name, admin_person_id) "
                    "VALUES ('TEAM', :p, 'The Falcons', :a) RETURNING id"
                ),
                {"p": profile_id, "a": member_person},
            )
        ).scalar_one()
        await db.execute(
            text("INSERT INTO memberships (group_id, person_id) VALUES (:g, :p)"),
            {"g": team_id, "p": member_person},
        )
        await db.commit()
    body = {
        "gathering_type": "season",
        "title": "Spring season",
        "occurrences": [_upcoming_date()],
        "group_id": str(team_id),
    }
    refused = await client.post("/gatherings", json=body, headers=cast.member)
    assert refused.status_code == 422, refused.text
    (error,) = refused.json()["detail"]
    assert error["loc"] == ["body", "group_id"]
    assert error["msg"] == gatherings_api.GROUP_GATHERING_TYPE_GATE_MESSAGE
    assert "rung 2" in error["msg"] and "HOUSEHOLD" in error["msg"]
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM gatherings")) == 0
        # Undo the plant: the verifier's "every group is of its profile's
        # type" would hold, but a TEAM group must not outlive this test.
        await db.execute(text("DELETE FROM memberships WHERE group_id = :g"), {"g": team_id})
        await db.execute(text("DELETE FROM groups WHERE id = :g"), {"g": team_id})
        await db.execute(text("DELETE FROM capability_profiles WHERE id = :p"), {"p": profile_id})
        await db.commit()


# --- the keeper is live through the group -------------------------------------------


async def test_an_upload_to_a_group_gathering_charges_the_groups_keeper(
    client, capsys, db_session_factory, monkeypatch
):
    """The resolver's first rung at the upload gate, on a REAL subject for the
    first time (CK-50 proved the rung on constructed rows): the ADMIN
    keeps the group; the CO-ADMIN, an invited member, uploads to the
    MEMBER's group gathering, and the reservation lands on the ADMIN's
    usage — not the uploader's, not the host's. The admin's headroom
    decides in both directions, and a group whose keeper is NULL refuses
    with the keeperless copy, though the host stands."""
    monkeypatch.setattr(keeping, "FREE_TIER_PHOTOGRAPHS", 3)
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    admins_own = await _create(client, cast.admin, title="The keeper's own")

    async def usage(address: str) -> int:
        async with db_session_factory() as db:
            return await keeping.account_usage(db, await _account_for(db, address))

    # The group's keeper is full, through a gathering of their own: the
    # co-admin's upload to the group gathering is refused — the non-keeper
    # form, because the uploader is not the keeper (CK-51b.1) — and no row
    # is written.
    async with db_session_factory() as db:
        await _set_photo_count(db, admins_own["id"], 3)
        await db.commit()
    refused = await _intents(client, cast.co_admin, created["id"], [_item()])
    assert refused.status_code == 422, refused.text
    assert [e["loc"] for e in refused.json()["detail"]] == [["body", "items"]]
    assert refused.json()["detail"][0]["msg"] == "this space is full, so this photo can't be added"
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM media")) == 0
        await _set_photo_count(db, admins_own["id"], 0)
        await db.commit()
    # With headroom: the reservation lands on the group's keeper and on
    # nobody else — not the uploader (the co-admin), not the host (the member).
    accepted = await _intents(client, cast.co_admin, created["id"], [_item()])
    assert accepted.status_code == 201, accepted.text
    assert (await usage(ADMIN), await usage(CO_ADMIN), await usage(MEMBER)) == (1, 0, 0)
    # The keeper's own refusal, on their own upload to the group gathering,
    # is the room form carrying the code — the keeper is asking about their
    # own space (CK-74).
    async with db_session_factory() as db:
        await _set_photo_count(db, admins_own["id"], 3)
        await db.commit()
    keeper_refused = await _intents(client, cast.admin, created["id"], [_item()])
    assert keeper_refused.status_code == 422
    assert keeper_refused.json()["detail"][0]["type"] == "keeper_space_full"
    # The group's keeper going NULL leaves the gathering UNKEPT through the
    # first rung — refused as keeperless, with the exact copy, though its
    # host stands.
    async with db_session_factory() as db:
        group = await db.get(Group, UUID(cast.group_id))
        group.keeper_account_id = None
        await db.commit()
    unkept = await _intents(client, cast.member, created["id"], [_item()])
    assert unkept.status_code == 422
    assert [e["loc"] for e in unkept.json()["detail"]] == [["path", "gathering_id"]]
    assert unkept.json()["detail"][0]["msg"] == "nobody keeps this gathering, so photos can't be added to it"


# --- newcomers get the upcoming gatherings -----------------------------------------


async def _three_shapes(client, cast: Cast) -> dict[str, str]:
    """The group's gatherings by shape: a PAST-ONLY one (a date ten days
    ago), a SEASON with a date behind and a date ahead, a date IN PROGRESS
    (started two hours ago, ends in two), and a FUTURE one — created by the
    member, so the admin and the co-admin hold rows on each."""
    now = _now()
    shapes = {
        "past": [{"starts_at": _iso(now - timedelta(days=10))}],
        "season": [
            {"starts_at": _iso(now - timedelta(days=30))},
            {"starts_at": _iso(now + timedelta(days=30))},
        ],
        "in_progress": [
            {"starts_at": _iso(now - timedelta(hours=2)), "ends_at": _iso(now + timedelta(hours=2))}
        ],
        "future": [{"starts_at": _iso(now + timedelta(days=10))}],
    }
    ids = {}
    for key, occurrences in shapes.items():
        body = await _create_in_group(
            client,
            cast.member,
            cast.group_id,
            gathering_type="season" if key == "season" else "potluck",
            title=f"CK-76 {key}",
            occurrences=occurrences,
        )
        ids[key] = body["id"]
    return ids


async def _rows_for(db_session_factory, person_id: UUID) -> dict[UUID, UUID | None]:
    """{gathering_id: invited_by_person_id} for one person's rows."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(GatheringInvitation.gathering_id, GatheringInvitation.invited_by_person_id).where(
                    GatheringInvitation.person_id == person_id
                )
            )
        ).all()
    return {gathering: by for gathering, by in rows}


async def test_a_newcomer_is_invited_to_the_upcoming_gatherings_only_by_both_ways_in(
    client, capsys, db_session_factory
):
    """The 2026-10-04 record §9, both admission paths through ONE helper. A
    joins through the link and the admin approves; B accepts an emailed
    invitation. Each holds a row on the season, the date in progress and
    the future gathering — `invited_by` NULL, the group's rule invited them
    — and NONE on the past-only gathering. The helper is idempotent: a
    second call writes nothing. Leaving and removal remove no row (the
    archive record §6): A leaves, B is removed, and both still hold what
    they held and read what they read."""
    cast = await _cast(client, capsys, db_session_factory)
    ids = await _three_shapes(client, cast)
    upcoming = {UUID(ids[k]) for k in ("season", "in_progress", "future")}

    # A: the link, then the approval.
    a_address = "newcomer-a@example.com"
    a_headers = await _signed_in_headers(client, capsys, a_address)
    a_person = await _person_id(db_session_factory, a_address)
    assert await _rows_for(db_session_factory, a_person) == {}
    link = await _make(client, cast.admin, cast.group_id)
    assert link.status_code == 201, link.text
    joined = await _join(client, a_headers, _token_of(link.json()))
    assert joined.json()["status"] == "requested"
    (request,) = (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]
    approved = await _approve(client, cast.co_admin, cast.group_id, request["id"])
    assert approved.status_code == 200, approved.text
    a_rows = await _rows_for(db_session_factory, a_person)
    assert set(a_rows) == upcoming and set(a_rows.values()) == {None}
    assert UUID(ids["past"]) not in a_rows

    # B: the emailed invitation, accepted.
    b_address = "newcomer-b@example.com"
    b_headers = await _signed_in_headers(client, capsys, b_address)
    b_person = await _person_id(db_session_factory, b_address)
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, b_address)
    assert (await _accept_group_invitation(client, b_headers, token))["status"] == "accepted"
    b_rows = await _rows_for(db_session_factory, b_person)
    assert set(b_rows) == upcoming and set(b_rows.values()) == {None}

    # The creator's rows were written by a person; the newcomers' by the rule.
    member_person = await _person_id(db_session_factory, MEMBER)
    admin_person = await _person_id(db_session_factory, ADMIN)
    admin_rows = await _rows_for(db_session_factory, admin_person)
    assert set(admin_rows) == {UUID(g) for g in ids.values()}
    assert set(admin_rows.values()) == {member_person}

    # Idempotent: a second admission writes nothing.
    async with db_session_factory() as db:
        assert (
            await invite_newcomer_to_upcoming_gatherings(
                db, group_id=UUID(cast.group_id), person_id=a_person, now=_now()
            )
        ) == 0
        await db.commit()
    assert await _rows_for(db_session_factory, a_person) == a_rows

    # Both newcomers read the upcoming gatherings and not the past one; the
    # future gathering's body says it is the group's.
    for headers in (a_headers, b_headers):
        for key in ("season", "in_progress", "future"):
            detail = await client.get(f"/gatherings/{ids[key]}", headers=headers)
            assert detail.status_code == 200, (key, detail.text)
            assert detail.json()["group"]["id"] == cast.group_id
        refused = await client.get(f"/gatherings/{ids['past']}", headers=headers)
        assert (refused.status_code, refused.content) == await _gathering_404(client, headers)

    # Leaving and removal remove no row, and hide nothing they held.
    assert (await _leave(client, a_headers, cast.group_id)).status_code == 204
    async with db_session_factory() as db:
        b_membership = (
            await db.execute(
                text("SELECT id FROM memberships WHERE group_id = :g AND person_id = :p"),
                {"g": UUID(cast.group_id), "p": b_person},
            )
        ).scalar_one()
    assert (await _remove(client, cast.admin, cast.group_id, str(b_membership))).status_code == 204
    assert await _rows_for(db_session_factory, a_person) == a_rows
    assert await _rows_for(db_session_factory, b_person) == b_rows
    for headers in (a_headers, b_headers):
        assert (await client.get(f"/gatherings/{ids['future']}", headers=headers)).status_code == 200
        assert {g["id"] for g in await _list(client, headers)} == {ids[k] for k in ("season", "in_progress", "future")}
        # But the group's own list is the group's — a former member draws
        # the group 404 there.
        refused = await _group_list(client, headers, cast.group_id)
        assert (refused.status_code, refused.content) == await _group_404(client, headers)


# --- members only -------------------------------------------------------------------


async def test_an_emailed_invitation_to_a_group_gathering_is_refused_before_anything_is_written_or_sent(
    client, capsys, db_session_factory, monkeypatch
):
    """MEMBERS ONLY (record §9). The host's invitation to the group gathering
    is a 409 with the stable code `members_only` — before the channel
    check (an SMS body draws the same 409, not the 422), with no pending
    row and the email adapter never called; a groupless gathering's
    invitation is unchanged (201, one send). And a member IS made a
    co-host, by the materialized row's id — the handle the host reads."""
    sends: list[str] = []

    def record_send(*, to: str, subject: str, body: str) -> None:
        sends.append(to)

    monkeypatch.setattr(invitations_api, "send_email", record_send)
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    standalone = await _create(client, cast.member)

    for body in (
        {"channel": "EMAIL", "destination": "outsider@example.com"},
        {"channel": "SMS", "destination": "+15555550123"},
    ):
        refused = await client.post(
            f"/gatherings/{created['id']}/invitations", json=body, headers=cast.member
        )
        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"]["code"] == MEMBERS_ONLY
        assert "members" in refused.json()["detail"]["message"]
    assert sends == []
    async with db_session_factory() as db:
        assert await db.scalar(select(GatheringInvitationPending.id)) is None
    # The accepted list reads the materialized rows — the admin and the
    # co-admin — and the pending list is empty.
    roster = await client.get(f"/gatherings/{created['id']}/invitations", headers=cast.member)
    assert roster.status_code == 200, roster.text
    assert roster.json()["pending"] == []
    assert len(roster.json()["accepted"]) == 2

    # A groupless gathering: unchanged.
    accepted = await _invite(client, cast.member, standalone["id"], "outsider@example.com")
    assert accepted.status_code == 201, accepted.text
    assert sends == ["outsider@example.com"]

    # A member made a co-host by their row's id.
    handle = await _invitation_id(db_session_factory, created["id"], ADMIN)
    made = await client.post(
        f"/gatherings/{created['id']}/co-hosts", json={"invitation_id": handle}, headers=cast.member
    )
    assert made.status_code == 201, made.text
    detail = await client.get(f"/gatherings/{created['id']}", headers=cast.admin)
    assert detail.json()["caller_role"] == "co_host"


# --- the list and the group's gatherings --------------------------------------------


async def test_the_list_shows_what_the_caller_hosts_or_co_hosts_with_group_on_every_item(
    client, capsys, db_session_factory
):
    """The list's audience is the read audience (CK-76). The MEMBER, who
    keeps nothing of the group, finds the gathering they created in it —
    the gap CK-68 recorded, which a group gathering made real; the admin
    (the keeper, and invited) and the co-admin (invited) find it; the
    stranger does not. A host who is not the keeper of a STANDALONE
    gathering — the sponsorship shape, the keeper column moved — finds it
    too, with `caller_role` host, where until CK-76 the list lost it. A
    co-host finds theirs. `group` rides every item. The statement count
    does not scale with gatherings, and exactly one statement reads
    gatherings — the CK-20 pin, on the widened criterion."""
    cast = await _cast(client, capsys, db_session_factory)
    in_group = await _create_in_group(client, cast.member, cast.group_id)
    standalone = await _create(client, cast.member, title="Mine alone")
    # The sponsorship shape on the standalone gathering: the admin keeps it,
    # the member still hosts it and holds no invitation to it.
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(standalone["id"]))
        gathering.keeper_account_id = (await _account_for(db, ADMIN)).id
        await db.commit()

    member_items = {g["id"]: g for g in await _list(client, cast.member)}
    assert set(member_items) == {in_group["id"], standalone["id"]}
    assert member_items[in_group["id"]]["caller_role"] == "host"
    assert member_items[in_group["id"]]["group"] == {"id": cast.group_id, "name": GROUP_NAME}
    assert member_items[standalone["id"]]["caller_role"] == "host"
    assert member_items[standalone["id"]]["group"] is None

    admin_items = {g["id"]: g for g in await _list(client, cast.admin)}
    # Invited to the group gathering; KEEPS the standalone one — which since
    # CK-77 lists nothing (keeping lets no one in; until CK-77 both were
    # here). The pin moved with its reason.
    assert set(admin_items) == {in_group["id"]}
    assert admin_items[in_group["id"]]["caller_role"] is None
    co_admin_items = {g["id"]: g for g in await _list(client, cast.co_admin)}
    assert set(co_admin_items) == {in_group["id"]}
    assert await _list(client, cast.stranger) == []

    # A co-host finds theirs with the role.
    handle = await _invitation_id(db_session_factory, in_group["id"], CO_ADMIN)
    assert (
        await client.post(
            f"/gatherings/{in_group['id']}/co-hosts", json={"invitation_id": handle}, headers=cast.member
        )
    ).status_code == 201
    co_admin_items = {g["id"]: g for g in await _list(client, cast.co_admin)}
    assert co_admin_items[in_group["id"]]["caller_role"] == "co_host"

    # One statement, however many gatherings.
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count_statements(headers) -> int:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            assert (await client.get("/gatherings", headers=headers)).status_code == 200
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        return len(statements)

    at_two = await count_statements(cast.member)
    for n in range(3):
        await _create_in_group(client, cast.member, cast.group_id, title=f"More {n}")
    at_five = await count_statements(cast.member)
    assert at_five == at_two
    assert len([s for s in statements if "FROM gatherings" in s]) == 1


async def test_the_groups_gatherings_are_the_members_to_list_and_nobody_elses(
    client, capsys, db_session_factory
):
    """`GET /groups/{id}/gatherings`: the group's gatherings the caller can
    read, newest first, in the list's item shape with `group` on each —
    never a standalone gathering of a member's; the stranger draws the
    group's 404 byte-identical to a missing group. A member removed from
    the group after a gathering was created still reads that gathering
    (their row stands) and still lists it in `GET /gatherings`, and leaving
    hides it from nobody — only the group's own list closes to them. One
    statement reads gatherings, however many there are."""
    cast = await _cast(client, capsys, db_session_factory)
    first = await _create_in_group(client, cast.member, cast.group_id, title="First")
    second = await _create_in_group(client, cast.admin, cast.group_id, title="Second")
    await _create(client, cast.member, title="A standalone")

    for headers in (cast.admin, cast.co_admin, cast.member):
        listed = await _group_list(client, headers, cast.group_id)
        assert listed.status_code == 200, listed.text
        items = listed.json()["gatherings"]
        assert [g["title"] for g in items] == ["Second", "First"]
        assert all(g["group"] == {"id": cast.group_id, "name": GROUP_NAME} for g in items)
        assert all({"next_occurrence", "occurrence_count", "caller_role"} <= set(g) for g in items)
    refused = await _group_list(client, cast.stranger, cast.group_id)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.stranger)
    missing = await _group_list(client, cast.member, MISSING)
    assert (missing.status_code, missing.content) == await _group_404(client, cast.member)

    # Removed after the fact: the co-admin's rows stand.
    assert (await _remove(client, cast.admin, cast.group_id, cast.co_admin_membership)).status_code == 204
    for gathering_id in (first["id"], second["id"]):
        assert (await client.get(f"/gatherings/{gathering_id}", headers=cast.co_admin)).status_code == 200
    assert {g["id"] for g in await _list(client, cast.co_admin)} == {first["id"], second["id"]}
    refused = await _group_list(client, cast.co_admin, cast.group_id)
    assert (refused.status_code, refused.content) == await _group_404(client, cast.co_admin)
    # Leaving: the member still hosts the first and is invited to the second.
    assert (await _leave(client, cast.member, cast.group_id)).status_code == 204
    assert {g["id"] for g in await _list(client, cast.member)} >= {first["id"], second["id"]}
    assert (await client.get(f"/gatherings/{first['id']}", headers=cast.member)).status_code == 200

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def count_statements() -> int:
        statements.clear()
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        try:
            assert (await _group_list(client, cast.admin, cast.group_id)).status_code == 200
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        return len(statements)

    at_two = await count_statements()
    for n in range(3):
        await _create_in_group(client, cast.admin, cast.group_id, title=f"More {n}")
    at_five = await count_statements()
    assert at_five == at_two
    assert len([s for s in statements if "FROM gatherings" in s]) == 1


# --- the template rung --------------------------------------------------------------


async def test_a_group_gathering_resolves_open_through_the_template_rung_in_the_body_at_publish_and_at_restore(
    client, capsys, db_session_factory, worker, monkeypatch
):
    """Rung 3 reached through the home group (consent-gate-defaults §1): the
    facts every body reads carry the household template, `false`, and the
    resolver answers open with source TEMPLATE — where a groupless
    gathering's template is None and it answers open from JOIN_SHAPE: the
    same answer, one rung higher. At publish the real worker moves the
    row `live` in a group gathering; at restore a NON-host's put-back lands
    `live` (the gate at restore time), and `pending` once the host's own
    setting — rung 1, above the template — gates the gathering."""
    cast = await _cast(client, capsys, db_session_factory)
    in_group = await _create_in_group(client, cast.member, cast.group_id)
    standalone = await _create(client, cast.member)

    async with db_session_factory() as db:
        grouped = await _home_facts(db, await db.get(Gathering, UUID(in_group["id"])))
        groupless = await _home_facts(db, await db.get(Gathering, UUID(standalone["id"])))
    assert grouped.template_default is False and grouped.group["id"] == cast.group_id
    assert groupless.template_default is None and groupless.group is None
    assert publication.resolve_gathering(
        host_setting=None, host_kind=grouped.host_kind, template_default=grouped.template_default
    ) == publication.Resolution(False, publication.Source.TEMPLATE)
    assert publication.resolve_gathering(
        host_setting=None, host_kind=groupless.host_kind, template_default=groupless.template_default
    ) == publication.Resolution(False, publication.Source.JOIN_SHAPE)
    # In the body: the effective value, open.
    for gathering_id in (in_group["id"], standalone["id"]):
        detail = await client.get(f"/gatherings/{gathering_id}", headers=cast.member)
        assert detail.json()["requires_approval"] is False

    # At publish: the real worker, the real decoder, the group gathering —
    # `pending` → `live` in the ready transaction.
    t0 = _now()
    async with db_session_factory() as db:
        row = _media(UUID(in_group["id"]), status=MediaStatus.UPLOADED, size=len(GPS_PHOTO), available_at=t0)
        db.add(row)
        await db.commit()
        media_id = row.id
    FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    async with db_session_factory() as db:
        published = await db.get(Media, media_id)
        assert (published.status, published.publication_state) == (MediaStatus.READY, PublicationState.LIVE)
        assert published.published_at is not None and published.published_by_person_id is None

    # At restore: the co-admin (an invitee, not the host) put their own
    # removed photograph back — the gate answers open through the template.
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    removed = await _photograph(
        db_session_factory,
        in_group["id"],
        co_admin_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=co_admin_person,
    )
    restored = await _restore(client, cast.co_admin, removed)
    assert restored.status_code == 200, restored.text
    assert (await _state(db_session_factory, removed))[:2] == (MediaStatus.READY, PublicationState.LIVE)
    # The host's own setting outranks the template: gated, the same restore
    # lands `pending`, back in the host's queue.
    assert (
        await client.patch(
            f"/gatherings/{in_group['id']}", json={"requires_approval_override": True}, headers=cast.member
        )
    ).status_code == 200
    gated = await _photograph(
        db_session_factory,
        in_group["id"],
        co_admin_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=co_admin_person,
    )
    assert (await _restore(client, cast.co_admin, gated)).status_code == 200
    assert (await _state(db_session_factory, gated))[:2] == (MediaStatus.READY, PublicationState.PENDING)


# --- the backup column, unmapped and present --------------------------------------


async def test_the_backup_admin_column_is_unmapped_and_gone(db_session_factory):
    """CK-76 unmapped `groups.backup_admin_person_id` — the model has no such
    attribute and the table object no such column, so no SELECT the ORM
    builds names it — and CK-77's 0034 DROPPED it with its FK (the contract
    step; until CK-77 this test asserted the column still present, nullable,
    with its FK, waiting for the drop). tests/test_member_places.py pins the
    hook's deletion and `alembic check` clean."""
    assert not hasattr(Group, "backup_admin_person_id")
    assert "backup_admin_person_id" not in Group.__table__.columns
    async with db_session_factory() as db:
        shape = (
            await db.execute(
                text(
                    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                    "AND table_name = 'groups' AND column_name = 'backup_admin_person_id'"
                )
            )
        ).first()
        assert shape is None
        assert (
            await db.scalar(
                text("SELECT count(*) FROM pg_constraint WHERE conname = 'fk_groups_backup_admin_person_id'")
            )
        ) == 0


# --- the 0033 round trip ---------------------------------------------------------------


async def test_0033_round_trip_adds_the_index_and_the_downgrade_is_genuine(
    db_session_factory, capsys, at_head_afterwards
):
    """One index and nothing else. Down to 0032: the index gone, the column
    standing. Up: back. Down and up once more: idempotent. Under the
    round-trip rider — a failure here leaves the next test at head."""
    assert await _index_present(db_session_factory) == (HEAD, True)
    lines = await _migrate("downgrade", "0032", capsys)
    assert any(m.startswith("Running downgrade 0033 -> 0032") for m in lines), lines
    assert await _index_present(db_session_factory) == ("0032", False)
    async with db_session_factory() as db:
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM information_schema.columns "
                    "WHERE table_name = 'gatherings' AND column_name = 'owning_group_id'"
                )
            )
        ) == 1
    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0032 -> 0033") for m in lines), lines
    assert await _index_present(db_session_factory) == (HEAD, True)
    await _migrate("downgrade", "0032", capsys)
    await _migrate("upgrade", "head", capsys)
    assert await _index_present(db_session_factory) == (HEAD, True)


# --- the verifier -----------------------------------------------------------------------


async def test_the_verifier_asserts_the_index_and_the_two_group_gathering_invariants(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's three CK-76 lines, run as the operator runs
    it — a fresh interpreter against the test database — on a clean baseline
    holding a real group gathering, then on the plant each line exists to
    catch, one at a time: the index dropped; a pending (destination)
    invitation row written around the `members_only` refusal onto a group
    gathering; a gathering under a TEAM group. A PLANT IS NOT EVIDENCE
    UNTIL SOMETHING INDEPENDENT OF THE ASSERTION CONFIRMS IT (CK-56's
    lesson), so each is confirmed by its own SELECT first."""
    index_line = f"index {INDEX} exists on gatherings.owning_group_id"
    pending_line = "no pending (destination) invitation sits on a gathering that belongs to a group"
    household_line = "every gathering that belongs to a group belongs to a HOUSEHOLD group"
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id)
    member_person = await _person_id(db_session_factory, MEMBER)

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    for line in (index_line, pending_line, household_line):
        assert f"PASS  {line}" in out, line

    async def expect_one_failure(label: str) -> None:
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 1, 1, 1), (label, out)
        assert f"FAIL  {label}" in out, out

    # (1) The index dropped.
    async with db_session_factory() as db:
        await db.execute(text(f"DROP INDEX {INDEX}"))
        await db.commit()
        assert await db.scalar(text("SELECT count(*) FROM pg_indexes WHERE indexname = :n"), {"n": INDEX}) == 0
    await expect_one_failure(index_line)
    async with db_session_factory() as db:
        await db.execute(text(f"CREATE INDEX {INDEX} ON gatherings (owning_group_id)"))
        await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # (2) A pending invitation on a group gathering, written around the refusal.
    async with db_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO gathering_invitations_pending (gathering_id, channel, destination, token_hash, "
                "expires_at, invited_by_person_id) VALUES (:g, 'EMAIL', 'planted@example.com', 'ck76-plant', "
                "now() + interval '1 day', :p)"
            ),
            {"g": UUID(created["id"]), "p": member_person},
        )
        await db.commit()
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM gathering_invitations_pending p JOIN gatherings g ON g.id = p.gathering_id "
                    "WHERE g.owning_group_id IS NOT NULL"
                )
            )
        ) == 1
    await expect_one_failure(pending_line)
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM gathering_invitations_pending WHERE token_hash = 'ck76-plant'"))
        await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # (3) A gathering under a TEAM group (its own TEAM profile, so the
    # profile-of-own-type line holds; created by an EXISTING account, so the
    # 0008 accounts-integrity line holds too — and only this line fires).
    async with db_session_factory() as db:
        account_id = (await _account_for(db, MEMBER)).id
        profile_id = (
            await db.execute(
                text("INSERT INTO capability_profiles (group_type, name) VALUES ('TEAM', 'ck76-verifier-plant') RETURNING id")
            )
        ).scalar_one()
        team_id = (
            await db.execute(
                text(
                    "INSERT INTO groups (group_type, capability_profile_id, name) "
                    "VALUES ('TEAM', :p, 'planted team') RETURNING id"
                ),
                {"p": profile_id},
            )
        ).scalar_one()
        planted = (
            await db.execute(
                text(
                    "INSERT INTO gatherings (created_by_account_id, owning_group_id, gathering_type, title, publication_state) "
                    "VALUES (:a, :g, 'season', 'planted season', 'live') RETURNING id"
                ),
                {"a": account_id, "g": team_id},
            )
        ).scalar_one()
        await db.commit()
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM gatherings g JOIN groups gr ON gr.id = g.owning_group_id "
                    "WHERE gr.group_type <> 'HOUSEHOLD'"
                )
            )
        ) == 1
    await expect_one_failure(household_line)
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM gatherings WHERE id = :g"), {"g": planted})
        await db.execute(text("DELETE FROM groups WHERE id = :g"), {"g": team_id})
        await db.execute(text("DELETE FROM capability_profiles WHERE id = :p"), {"p": profile_id})
        await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)


# --- nothing logged ----------------------------------------------------------------------


async def test_group_gathering_routes_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """With the root logger at DEBUG, creating a gathering in a group, listing
    the group's gatherings, a newcomer's approval (the rows written) and
    the members-only refusal put no group name, no title, no address and no
    id into any APPLICATION log record — the routers have no logger, as
    before (the httpx client's records carry the request line, as every
    access log does; excluded, and shown non-empty)."""
    cast = await _cast(client, capsys, db_session_factory)
    assert not hasattr(gatherings_api, "logger") and not hasattr(invitations_api, "logger")
    newcomer = "quiet-newcomer@example.com"
    newcomer_headers = await _signed_in_headers(client, capsys, newcomer)
    link = await _make(client, cast.admin, cast.group_id)
    assert (await _join(client, newcomer_headers, _token_of(link.json()))).json()["status"] == "requested"
    (request,) = (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        created = await _create_in_group(client, cast.member, cast.group_id, title="Quiet dinner")
        assert (await _group_list(client, cast.member, cast.group_id)).status_code == 200
        assert (await _approve(client, cast.admin, cast.group_id, request["id"])).status_code == 200
        refused = await client.post(
            f"/gatherings/{created['id']}/invitations",
            json={"channel": "EMAIL", "destination": "outsider@example.com"},
            headers=cast.member,
        )
        assert refused.status_code == 409
    application = [r for r in caplog.records if not r.name.startswith("httpx")]
    assert any(r.name.startswith("httpx") for r in caplog.records)
    assert not [r for r in application if r.name.startswith(("app", "covey-keep"))]
    joined = "\n".join(r.getMessage() for r in application)
    for word in (GROUP_NAME, "Quiet dinner", "outsider@example.com", newcomer, created["id"], cast.group_id):
        assert word not in joined, word
