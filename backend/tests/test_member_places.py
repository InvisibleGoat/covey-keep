"""CK-77 — Groups 2b: choosing who is invited — shared with, left out, and
keeping lets no one in (decisions/2026-10-04-a-groups-gathering-stays-in-the-
group.md §4, §9, §10, §11 items 3–4; decisions/2026-09-02-participation-
terminology.md §4, §5; decisions/2026-09-27-keeping-explained.md §5.11;
decisions/2026-10-23-joining-a-group-and-co-admins.md §6 — the backup slot;
migration 0034). The cast is tests/test_group_membership.py's — an ADMIN who
created the group (and so KEEPS it), a CO-ADMIN, a MEMBER, a STRANGER — plus
members added per test; every seat is signed in; no network anywhere.

The load-bearing pins:
- KEEPING LETS NO ONE IN: the group's keeper, left out of a gathering in
  their own group, draws the gathering's 404 on the detail, the media list
  and a photograph's URL, finds it in neither list, is refused the upload
  intent with the gathering's 404 — and is STILL CHARGED for a photograph an
  invitee uploads there; the same for the keeper of a standalone gathering
  in the sponsorship shape; and no router names `keeps_gathering`, the
  gatherings router names no keeper resolver at all;
- CHOOSING AT CREATE: `invited` and `left_out` as rows of the right kind with
  the right provenance, the rest shared with, `invitees_chosen` true;
  `left_out` alone invites everyone else; each refusal — `not_a_member`,
  `is_host`, `duplicate`, a list without a group — an item-level 422 with
  its code and NOTHING written; the whole-group create unchanged;
- THE THREE PLACES FROM EVERY SURFACE: invited reads the full body and every
  logistics route; shared with reads `caller_view: "memory"` with the four
  logistics fields null, finds the gathering in both lists with the summary
  null, sees the live photographs and mints their URLs, and is refused the
  upload intent, RSVP read and write, the invitation roster, the co-host
  list and the places list each with that route's 404; left out draws the
  gathering's 404 everywhere, byte-identical to a missing gathering;
- CHANGING PLACES: each transition writes and deletes the right rows,
  `invitees_chosen` moves only toward true, `updated_at` stamps a change;
  `is_co_host`, `has_answered`, `is_host` and the member 404 each refuse
  with nothing written; a non-organiser draws the gathering's 404; a
  groupless gathering `not_in_a_group`; a co-host may change places;
- NEWCOMERS: an invitation row on a whole-group upcoming gathering, a
  `shared_with` row on a chosen one, nothing on a past one, idempotent, by
  both admission paths;
- THE BACKUP COLUMN GONE, `alembic check` clean with no hook, the 0034
  round trip under the round-trip rider; the verifier's new lines, each
  fired by a plant; nothing logged that these routes did not log before.
"""

import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select, text

from app.api import gatherings as gatherings_api
from app.api.gatherings import (
    DUPLICATE,
    HAS_ANSWERED,
    IS_CO_HOST,
    IS_HOST,
    NOT_A_MEMBER,
    NOT_IN_A_GROUP,
    VIEW_FULL,
    VIEW_MEMORY,
)
from app.models import (
    Gathering,
    GatheringInvitation,
    GatheringMemberPlace,
    MemberPlace,
    PublicationState,
)
from app.services import keeping
from app.services.groups import invite_newcomer_to_upcoming_gatherings
from tests.test_destruction import _verifier
from tests.test_gatherings import _account_for, _create, _field_errors, _signed_in_headers
from tests.test_group_gatherings import (
    GROUP_NAME,
    _create_in_group,
    _gathering_404,
    _group_list,
    _invitation_id,
    _invitation_rows,
    _iso,
    _photograph,
    _upcoming_date,
)
from tests.test_group_gatherings import _list as _gathering_list
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
    _membership_id,
    _person_id,
)
from tests.test_groups import MISSING
from tests.test_media_intents import _intents, _item, _set_photo_count
from tests.test_media_reads import _ids, _url
from tests.test_media_reads import _list as _media_list
from tests.test_photo_count import HEAD, _migrate, at_head_afterwards  # noqa: F401 — the fixture
from tests.test_rsvps import _get_rsvps, _put_rsvp

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The verifier's total, pinned as a number (the CK-57 convention): 339 at
# CK-76; CK-77 adds twenty-three (the places table's shape — the table, four
# NOT NULLs, two nullables, the PK in key order, three FKs with their delete
# rules, the index — the type's labels, invitees_chosen's three shape lines,
# its CHECK, and three data lines) and retires one: CK-75's "backup column
# NULL on every row" line is REPLACED by the 0009 block's "is gone" line
# (one present line out, one absent line in), so 339 + 23 − 1 = 361.
VERIFIER_TOTAL = 361

LOGISTICS_FIELDS = ("occurrences", "rsvp_list_visibility")
SUMMARY_FIELDS = ("next_occurrence", "occurrence_count")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- helpers ---------------------------------------------------------------------


async def _places(client, headers, gathering_id: str):
    return await client.get(f"/gatherings/{gathering_id}/places", headers=headers)


async def _put_place(client, headers, gathering_id: str, membership_id: str, place: str):
    return await client.put(
        f"/gatherings/{gathering_id}/places/{membership_id}", json={"place": place}, headers=headers
    )


async def _place_rows(db_session_factory, gathering_id: str) -> dict[UUID, tuple]:
    """{person_id: (place, set_by_person_id, updated_at)} for every place row."""
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(GatheringMemberPlace).where(
                    GatheringMemberPlace.gathering_id == UUID(gathering_id)
                )
            )
        ).scalars().all()
        return {r.person_id: (r.place, r.set_by_person_id, r.updated_at) for r in rows}


async def _chosen(db_session_factory, gathering_id: str) -> bool:
    async with db_session_factory() as db:
        return (await db.get(Gathering, UUID(gathering_id))).invitees_chosen


async def _row_counts(db_session_factory) -> tuple[int, int, int]:
    async with db_session_factory() as db:
        return (
            await db.scalar(text("SELECT count(*) FROM gatherings")),
            await db.scalar(text("SELECT count(*) FROM gathering_invitations")),
            await db.scalar(text("SELECT count(*) FROM gathering_member_places")),
        )


async def _extra_member(client, capsys, db_session_factory, cast: Cast, address: str) -> tuple[dict, str, UUID]:
    """A fourth live member of the cast's group: (headers, membership id,
    person id)."""
    headers = await _signed_in_headers(client, capsys, address)
    membership_id = await _add_member(db_session_factory, cast.group_id, address)
    return headers, membership_id, await _person_id(db_session_factory, address)


async def _member_404(client, headers, gathering_id: str) -> tuple[int, bytes]:
    """CK-75's member 404, as the places PUT draws it for a missing id."""
    response = await _put_place(client, headers, gathering_id, MISSING, "invited")
    assert response.status_code == 404, response.text
    return response.status_code, response.content


async def _usage(db_session_factory, address: str) -> int:
    async with db_session_factory() as db:
        return await keeping.account_usage(db, await _account_for(db, address))


def _item_error(response, field: str, index: int, code: str) -> None:
    assert response.status_code == 422, response.text
    (error,) = response.json()["detail"]
    assert error["loc"] == ["body", field, index], error
    assert error["code"] == code, error


def _code_409(response, code: str) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == code, response.text


async def _byte_identical_404s(client, headers, gathering_id: str) -> None:
    """The gathering's 404 on the detail and the media list, the media 404 on
    an upload intent — each byte-identical to a missing id — and the
    gathering absent from the caller's list."""
    missing = await _gathering_404(client, headers)
    detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
    assert (detail.status_code, detail.content) == missing
    media = await _media_list(client, headers, gathering_id)
    media_missing = await _media_list(client, headers, MISSING)
    assert (media.status_code, media.content) == (404, media_missing.content)
    intent = await _intents(client, headers, gathering_id, [_item()])
    intent_missing = await _intents(client, headers, MISSING, [_item()])
    assert (intent.status_code, intent.content) == (404, intent_missing.content)
    assert gathering_id not in {g["id"] for g in await _gathering_list(client, headers)}


# --- auth ----------------------------------------------------------------------------


async def test_the_places_routes_require_auth(client):
    assert (await client.get(f"/gatherings/{MISSING}/places")).status_code == 401
    assert (
        await client.put(f"/gatherings/{MISSING}/places/{MISSING}", json={"place": "invited"})
    ).status_code == 401


# --- keeping lets no one in ----------------------------------------------------------


async def test_the_groups_keeper_left_out_of_a_gathering_sees_no_trace_and_is_still_charged(
    client, capsys, db_session_factory
):
    """THE case the record exists for (§11 item 3; keeping-explained §5.11):
    in a family group the keeper is often the person the surprise is for.
    The ADMIN keeps the group; the MEMBER creates a gathering in it with the
    admin LEFT OUT and the co-admin invited. The admin draws the gathering's
    404 on the detail and the media list, the media 404 on a live
    photograph's URL and on the upload intent — every one byte-identical to
    a missing id — and finds the gathering in neither `/gatherings` nor the
    group's own list. And the admin's usage COUNTS the photograph the
    co-admin uploads there: charged for what they cannot see, their figure
    naming no gathering."""
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        invited=[cast.co_admin_membership],
        left_out=[cast.admin_membership],
    )
    gathering_id = created["id"]
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    live = await _photograph(db_session_factory, gathering_id, co_admin_person, publication_state=PublicationState.LIVE)
    async with db_session_factory() as db:
        await _set_photo_count(db, gathering_id, 1)

    # The invitee sees it; the keeper sees no trace.
    assert (await _url(client, cast.co_admin, live)).status_code == 200
    await _byte_identical_404s(client, cast.admin, gathering_id)
    url_missing = await _url(client, cast.admin, MISSING)
    refused = await _url(client, cast.admin, live)
    assert (refused.status_code, refused.content) == (404, url_missing.content)
    group_list = await _group_list(client, cast.admin, cast.group_id)
    assert group_list.status_code == 200
    assert gathering_id not in {g["id"] for g in group_list.json()["gatherings"]}

    # Charged all the same: the one published photograph, and the one the
    # co-admin reserves now — on the keeper's account, who sees neither.
    assert await _usage(db_session_factory, ADMIN) == 1
    assert (await _intents(client, cast.co_admin, gathering_id, [_item()])).status_code == 201
    assert await _usage(db_session_factory, ADMIN) == 2
    assert await _usage(db_session_factory, CO_ADMIN) == 0
    assert await _usage(db_session_factory, MEMBER) == 0


async def test_the_keeper_of_a_standalone_gathering_in_the_sponsorship_shape_is_outside_its_audience(
    client, capsys, db_session_factory
):
    """The same rule off the group: a standalone gathering whose keeper
    column was MOVED to another account (host ≠ keeper — the sponsorship
    shape every audience test built the keeper seat from). The keeper, who
    is neither host, co-host nor invited, draws the gathering's 404 on
    every read and on the upload intent and finds it in no list, while the
    host and an invitee read it in the full view — and the keeper's usage
    still counts an invitee's upload."""
    host = await _signed_in_headers(client, capsys, "sponsored-host@example.com")
    keeper_address = "sponsor@example.com"
    keeper = await _signed_in_headers(client, capsys, keeper_address)
    created = await _create(client, host, title="Sponsored")
    gathering_id = created["id"]
    from tests.test_invitations import _accept, _invite_token

    invitee_address = "sponsored-invitee@example.com"
    token = await _invite_token(client, capsys, host, gathering_id, invitee_address)
    invitee = await _signed_in_headers(client, capsys, invitee_address)
    await _accept(client, invitee, token)
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(gathering_id))
        gathering.keeper_account_id = (await _account_for(db, keeper_address)).id
        await db.commit()

    await _byte_identical_404s(client, keeper, gathering_id)
    for headers in (host, invitee):
        detail = await client.get(f"/gatherings/{gathering_id}", headers=headers)
        assert detail.status_code == 200 and detail.json()["caller_view"] == VIEW_FULL
    assert await _usage(db_session_factory, keeper_address) == 0
    assert (await _intents(client, invitee, gathering_id, [_item(), _item()])).status_code == 201
    assert await _usage(db_session_factory, keeper_address) == 2


def test_no_router_names_keeps_gathering_and_the_gatherings_router_resolves_no_keeper():
    """Keeping lets no one in, pinned at the source: the SQL ladder
    (`keeps_gathering`) is named by no module under app/api/ — it was the
    list statement's and `_visible_media`'s term from CK-49b to CK-77 — and
    the gatherings router, which decides every read audience, imports
    neither it nor `resolved_keeper_of`. The one router that resolves the
    keeper is media.py, for the quota's subject alone. Code tokens, not
    prose: comments and docstrings say the names on purpose."""
    import ast
    import pathlib

    api_dir = pathlib.Path(gatherings_api.__file__).parent
    names_by_module: dict[str, set[str]] = {}
    for path in sorted(api_dir.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Attribute):
                names.add(node.attr)
            elif isinstance(node, ast.ImportFrom):
                names.update(alias.name for alias in node.names)
        names_by_module[path.name] = names
    assert all("keeps_gathering" not in names for names in names_by_module.values()), [
        m for m, n in names_by_module.items() if "keeps_gathering" in n
    ]
    assert "resolved_keeper_of" not in names_by_module["gatherings.py"]
    assert "resolved_keeper_of" in names_by_module["media.py"]  # the quota's subject, and nothing else
    assert {m for m, n in names_by_module.items() if "resolved_keeper_of" in n} == {"media.py"}


# --- choosing at create ---------------------------------------------------------------


async def test_choosing_at_create_writes_each_members_place_as_a_row_of_the_right_kind(
    client, capsys, db_session_factory
):
    """The MEMBER creates with the co-admin INVITED and the admin LEFT OUT; a
    fourth member, E, named in neither list, is SHARED WITH automatically
    (Steven's model). Rows of the right kind with the right provenance —
    the invitation row `invited_by` the creator, the two place rows
    `set_by` the creator, `updated_at` NULL — `invitees_chosen` true, the
    body `caller_view` `full`. Then `left_out` alone: every other live
    member is invited. Then `invited: []`: nobody invited, everyone else
    shared with. A member who deleted their account gets no row of any
    kind. And the whole-group create is unchanged: invitation rows for
    everyone, no place row, `invitees_chosen` false."""
    cast = await _cast(client, capsys, db_session_factory)
    _, e_membership, e_person = await _extra_member(client, capsys, db_session_factory, cast, "e@example.com")
    gone_headers, _, gone_person = await _extra_member(client, capsys, db_session_factory, cast, "gone@example.com")
    from tests.test_account_deletion import DELETE_BODY

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    member_person = await _person_id(db_session_factory, MEMBER)
    admin_person = await _person_id(db_session_factory, ADMIN)
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)

    body = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        invited=[cast.co_admin_membership],
        left_out=[cast.admin_membership],
    )
    assert body["caller_view"] == VIEW_FULL and body["caller_role"] == "host"
    assert body["group"] == {"id": cast.group_id, "name": GROUP_NAME}
    assert "invitees_chosen" not in body and "invited" not in body and "left_out" not in body
    assert await _invitation_rows(db_session_factory, body["id"]) == {co_admin_person: member_person}
    places = await _place_rows(db_session_factory, body["id"])
    assert places == {
        admin_person: (MemberPlace.LEFT_OUT, member_person, None),
        e_person: (MemberPlace.SHARED_WITH, member_person, None),
    }
    assert gone_person not in places
    assert await _chosen(db_session_factory, body["id"]) is True

    # `left_out` alone: everyone else is invited.
    alone = await _create_in_group(client, cast.member, cast.group_id, left_out=[cast.admin_membership])
    assert set(await _invitation_rows(db_session_factory, alone["id"])) == {co_admin_person, e_person}
    assert await _place_rows(db_session_factory, alone["id"]) == {
        admin_person: (MemberPlace.LEFT_OUT, member_person, None)
    }
    assert await _chosen(db_session_factory, alone["id"]) is True

    # `invited: []`: nobody invited; every other live member shared with.
    nobody = await _create_in_group(client, cast.member, cast.group_id, invited=[])
    assert await _invitation_rows(db_session_factory, nobody["id"]) == {}
    assert {p: place for p, (place, _, _) in (await _place_rows(db_session_factory, nobody["id"])).items()} == {
        admin_person: MemberPlace.SHARED_WITH,
        co_admin_person: MemberPlace.SHARED_WITH,
        e_person: MemberPlace.SHARED_WITH,
    }
    assert await _chosen(db_session_factory, nobody["id"]) is True

    # The whole-group create: CK-76's, byte for byte.
    whole = await _create_in_group(client, cast.member, cast.group_id)
    assert set(await _invitation_rows(db_session_factory, whole["id"])) == {admin_person, co_admin_person, e_person}
    assert await _place_rows(db_session_factory, whole["id"]) == {}
    assert await _chosen(db_session_factory, whole["id"]) is False
    assert set(whole) == set(body)
    assert whole["caller_view"] == VIEW_FULL


async def test_each_create_refusal_is_an_item_level_422_with_its_code_and_nothing_is_written(
    client, capsys, db_session_factory
):
    """`not_a_member` — a membership of ANOTHER group, a missing id, and a
    member who deleted their account, one code for all three (a probe
    learns nothing about other groups); `is_host` — the creator's own
    membership; `duplicate` — an id twice in one list, and an id in both
    lists; and either list on a create with no `group_id`, a 422 at the
    list. Each on the entry that provoked it, the batch refused whole, and
    no gathering, no invitation row and no place row written."""
    cast = await _cast(client, capsys, db_session_factory)
    gone_headers, gone_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, "gone@example.com")
    from tests.test_account_deletion import DELETE_BODY

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    # A membership of another group — the stranger's own.
    other_group = (await client.post("/groups", json={"name": "Elsewhere"}, headers=cast.stranger)).json()
    stranger_membership = await _membership_id(db_session_factory, other_group["id"], STRANGER)
    before = await _row_counts(db_session_factory)

    def body(**lists) -> dict:
        return {
            "gathering_type": "potluck",
            "title": "Refused",
            "occurrences": [_upcoming_date()],
            "group_id": cast.group_id,
            **lists,
        }

    async def refused(**lists):
        return await client.post("/gatherings", json=body(**lists), headers=cast.member)

    _item_error(await refused(invited=[cast.co_admin_membership, stranger_membership]), "invited", 1, NOT_A_MEMBER)
    _item_error(await refused(left_out=[MISSING]), "left_out", 0, NOT_A_MEMBER)
    _item_error(await refused(invited=[gone_membership]), "invited", 0, NOT_A_MEMBER)
    _item_error(await refused(invited=[cast.member_membership]), "invited", 0, IS_HOST)
    _item_error(await refused(left_out=[cast.admin_membership, cast.member_membership]), "left_out", 1, IS_HOST)
    _item_error(
        await refused(invited=[cast.co_admin_membership, cast.co_admin_membership]), "invited", 1, DUPLICATE
    )
    _item_error(
        await refused(invited=[cast.co_admin_membership], left_out=[cast.co_admin_membership]),
        "left_out",
        0,
        DUPLICATE,
    )
    for field in ("invited", "left_out"):
        groupless = {k: v for k, v in body(**{field: [cast.admin_membership]}).items() if k != "group_id"}
        response = await client.post("/gatherings", json=groupless, headers=cast.member)
        assert response.status_code == 422, response.text
        assert _field_errors(response) == {field}
    assert await _row_counts(db_session_factory) == before


# --- the three places, read from every surface ------------------------------------------


async def test_invited_shared_with_and_left_out_from_every_surface(client, capsys, db_session_factory):
    """One gathering, three places. INVITED (the co-admin): the full body —
    `caller_view` `full`, the dates and the RSVP setting — and every
    logistics route: an RSVP answered, an upload intent accepted. SHARED
    WITH (E): `caller_view` `memory` with `occurrences` and
    `rsvp_list_visibility` NULL — null, never `[]` — everything else the
    host's body (the two caller-relative fields set aside); in both lists
    with `next_occurrence` and `occurrence_count` NULL; the live
    photographs listed and their URLs minted, the pending one not; and
    refused — with that route's own 404, byte-identical to a missing id —
    on the upload intent, RSVP read and write, the invitation roster, the
    co-host list and the places list. LEFT OUT (the admin): the gathering's
    404 on the detail and the media list, absent from both lists, every
    response byte-identical to a missing gathering."""
    cast = await _cast(client, capsys, db_session_factory)
    e_headers, e_membership, e_person = await _extra_member(client, capsys, db_session_factory, cast, "e@example.com")
    created = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        invited=[cast.co_admin_membership],
        left_out=[cast.admin_membership],
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    live = await _photograph(db_session_factory, gathering_id, co_admin_person, publication_state=PublicationState.LIVE)
    pending = await _photograph(db_session_factory, gathering_id, co_admin_person, publication_state=PublicationState.PENDING)

    # INVITED: the full body and the logistics.
    host_body = (await client.get(f"/gatherings/{gathering_id}", headers=cast.member)).json()
    invited_body = (await client.get(f"/gatherings/{gathering_id}", headers=cast.co_admin)).json()
    assert invited_body["caller_view"] == VIEW_FULL and invited_body["caller_role"] is None
    assert [o["id"] for o in invited_body["occurrences"]] == [occurrence_id]
    assert invited_body["rsvp_list_visibility"] == "INVITEES"
    assert (await _put_rsvp(client, cast.co_admin, occurrence_id, {"response": "yes"})).status_code == 200
    assert (await _get_rsvps(client, cast.co_admin, occurrence_id)).status_code == 200
    assert (await _intents(client, cast.co_admin, gathering_id, [_item()])).status_code == 201
    (item,) = [g for g in await _gathering_list(client, cast.co_admin) if g["id"] == gathering_id]
    assert item["caller_view"] == VIEW_FULL and item["occurrence_count"] == 1
    assert item["next_occurrence"]["id"] == occurrence_id

    # SHARED WITH: the memory view.
    memory = await client.get(f"/gatherings/{gathering_id}", headers=e_headers)
    assert memory.status_code == 200, memory.text
    memory_body = memory.json()
    assert memory_body["caller_view"] == VIEW_MEMORY and memory_body["caller_role"] is None
    assert memory_body["occurrences"] is None and memory_body["rsvp_list_visibility"] is None
    assert "occurrences" in memory_body and "rsvp_list_visibility" in memory_body  # carried, null
    for field in LOGISTICS_FIELDS + ("caller_view", "caller_role"):
        host_body.pop(field)
        memory_body.pop(field)
    assert memory_body == host_body  # everything else as the full body
    for listed in (await _gathering_list(client, e_headers), (await _group_list(client, e_headers, cast.group_id)).json()["gatherings"]):
        (item,) = [g for g in listed if g["id"] == gathering_id]
        assert item["caller_view"] == VIEW_MEMORY
        assert item["next_occurrence"] is None and item["occurrence_count"] is None
        assert "next_occurrence" in item and "occurrence_count" in item
        assert item["rsvp_list_visibility"] is None
    assert _ids(await _media_list(client, e_headers, gathering_id)) == [live]
    assert (await _url(client, e_headers, live)).status_code == 200
    url_missing = await _url(client, e_headers, MISSING)
    refused = await _url(client, e_headers, pending)
    assert (refused.status_code, refused.content) == (404, url_missing.content)
    # Refused, each with its own route's 404: no logistics, no uploads.
    gathering_missing = await _gathering_404(client, e_headers)
    intent = await _intents(client, e_headers, gathering_id, [_item()])
    intent_missing = await _intents(client, e_headers, MISSING, [_item()])
    assert (intent.status_code, intent.content) == (404, intent_missing.content)
    put = await _put_rsvp(client, e_headers, occurrence_id, {"response": "yes"})
    put_missing = await _put_rsvp(client, e_headers, MISSING, {"response": "yes"})
    assert (put.status_code, put.content) == (404, put_missing.content)
    get = await _get_rsvps(client, e_headers, occurrence_id)
    get_missing = await _get_rsvps(client, e_headers, MISSING)
    assert (get.status_code, get.content) == (404, get_missing.content)
    for path in ("invitations", "co-hosts", "places"):
        response = await client.get(f"/gatherings/{gathering_id}/{path}", headers=e_headers)
        assert (response.status_code, response.content) == gathering_missing, path
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM media WHERE uploader_person_id = :p"), {"p": e_person}) == 0

    # LEFT OUT: no trace.
    await _byte_identical_404s(client, cast.admin, gathering_id)
    group_list = await _group_list(client, cast.admin, cast.group_id)
    assert gathering_id not in {g["id"] for g in group_list.json()["gatherings"]}
    url_missing = await _url(client, cast.admin, MISSING)
    for media_id in (live, pending):
        refused = await _url(client, cast.admin, media_id)
        assert (refused.status_code, refused.content) == (404, url_missing.content)
    # And the stranger's 404 is the same 404.
    stranger_missing = await _gathering_404(client, cast.stranger)
    assert stranger_missing[1] == (await _gathering_404(client, cast.admin))[1]


# --- changing places ------------------------------------------------------------------


async def test_changing_a_members_place_writes_and_deletes_the_right_rows(
    client, capsys, db_session_factory
):
    """On a whole-group gathering (chosen false) the MEMBER moves E to
    SHARED WITH: the place row written (`set_by` the member), the
    invitation row deleted, `invitees_chosen` true, the entry read back —
    and E now reads the memory view. To LEFT OUT: the row's place changes,
    `updated_at` stamps, nothing else moves. Back to INVITED: the
    invitation row written (`invited_by` the member), the place row gone,
    `invitees_chosen` STILL true — once chosen, chosen. Asking for the
    place a member already holds writes nothing and answers 200. The list
    carries every live member but the host, in joining order, with their
    place and the co-host flag; and a CO-HOST may change places — the act
    is delegable."""
    cast = await _cast(client, capsys, db_session_factory)
    e_headers, e_membership, e_person = await _extra_member(client, capsys, db_session_factory, cast, "e@example.com")
    created = await _create_in_group(client, cast.member, cast.group_id)
    gathering_id = created["id"]
    member_person = await _person_id(db_session_factory, MEMBER)
    assert await _chosen(db_session_factory, gathering_id) is False

    listed = await _places(client, cast.member, gathering_id)
    assert listed.status_code == 200, listed.text
    assert listed.json()["invitees_chosen"] is False
    entries = listed.json()["members"]
    assert [e["membership_id"] for e in entries] == [cast.admin_membership, cast.co_admin_membership, e_membership]
    assert all(set(e) == {"membership_id", "display_name", "place", "co_host"} for e in entries)
    assert {e["place"] for e in entries} == {"invited"}
    assert not any(e["co_host"] for e in entries)
    assert cast.member_membership not in {e["membership_id"] for e in entries}  # the host has no place
    assert "@" not in listed.text

    # To shared with.
    moved = await _put_place(client, cast.member, gathering_id, e_membership, "shared_with")
    assert moved.status_code == 200, moved.text
    assert moved.json() == {"membership_id": e_membership, "display_name": moved.json()["display_name"], "place": "shared_with", "co_host": False}
    assert e_person not in await _invitation_rows(db_session_factory, gathering_id)
    places = await _place_rows(db_session_factory, gathering_id)
    assert places[e_person][:2] == (MemberPlace.SHARED_WITH, member_person) and places[e_person][2] is None
    assert await _chosen(db_session_factory, gathering_id) is True
    assert (await client.get(f"/gatherings/{gathering_id}", headers=e_headers)).json()["caller_view"] == VIEW_MEMORY
    # Idempotent: the same place again writes nothing.
    again = await _put_place(client, cast.member, gathering_id, e_membership, "shared_with")
    assert again.status_code == 200 and again.json()["place"] == "shared_with"
    assert (await _place_rows(db_session_factory, gathering_id))[e_person] == places[e_person]

    # To left out: the row changes and is stamped.
    t0 = _now()
    assert (await _put_place(client, cast.member, gathering_id, e_membership, "left_out")).json()["place"] == "left_out"
    place, set_by, updated_at = (await _place_rows(db_session_factory, gathering_id))[e_person]
    assert (place, set_by) == (MemberPlace.LEFT_OUT, member_person)
    assert updated_at is not None and abs((updated_at - t0).total_seconds()) < 60
    assert e_person not in await _invitation_rows(db_session_factory, gathering_id)
    await _byte_identical_404s(client, e_headers, gathering_id)

    # Back to invited: once chosen, chosen.
    assert (await _put_place(client, cast.member, gathering_id, e_membership, "invited")).json()["place"] == "invited"
    assert (await _invitation_rows(db_session_factory, gathering_id))[e_person] == member_person
    assert e_person not in await _place_rows(db_session_factory, gathering_id)
    assert await _chosen(db_session_factory, gathering_id) is True
    assert (await client.get(f"/gatherings/{gathering_id}", headers=e_headers)).json()["caller_view"] == VIEW_FULL
    listed = await _places(client, cast.member, gathering_id)
    assert listed.json()["invitees_chosen"] is True
    assert {e["membership_id"]: e["place"] for e in listed.json()["members"]}[e_membership] == "invited"

    # A co-host may change places: the co-admin, made a co-host by the host.
    handle = await _invitation_id(db_session_factory, gathering_id, CO_ADMIN)
    assert (
        await client.post(f"/gatherings/{gathering_id}/co-hosts", json={"invitation_id": handle}, headers=cast.member)
    ).status_code == 201
    assert (await _places(client, cast.co_admin, gathering_id)).status_code == 200
    assert (await _put_place(client, cast.co_admin, gathering_id, e_membership, "shared_with")).status_code == 200
    assert (await _place_rows(db_session_factory, gathering_id))[e_person][:2] == (
        MemberPlace.SHARED_WITH,
        await _person_id(db_session_factory, CO_ADMIN),
    )
    (co_host_entry,) = [e for e in (await _places(client, cast.member, gathering_id)).json()["members"] if e["membership_id"] == cast.co_admin_membership]
    assert co_host_entry["co_host"] is True and co_host_entry["place"] == "invited"


async def test_each_refused_move_leaves_nothing_written(client, capsys, db_session_factory):
    """`is_co_host` — a co-host cannot be moved away from invited; remove
    them as a co-host first. `has_answered` — a member who has answered any
    of the gathering's dates stays invited. `is_host` — the host's own
    membership, a 422 on the path's `membership_id`. The member 404 —
    CK-75's shape — for an id that is not a live membership of this
    gathering's group: a missing id, another group's, a deleted account's.
    Each with nothing written: no row of either kind moves, and
    `invitees_chosen` stays false. A non-organiser — an invitee, a member
    shared with, a stranger — draws the gathering's 404 on both routes; a
    groupless gathering answers 409 `not_in_a_group` to both."""
    cast = await _cast(client, capsys, db_session_factory)
    e_headers, e_membership, e_person = await _extra_member(client, capsys, db_session_factory, cast, "e@example.com")
    gone_headers, gone_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, "gone@example.com")
    from tests.test_account_deletion import DELETE_BODY

    created = await _create_in_group(client, cast.member, cast.group_id)
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=gone_headers)).status_code == 204
    other_group = (await client.post("/groups", json={"name": "Elsewhere"}, headers=cast.stranger)).json()
    stranger_membership = await _membership_id(db_session_factory, other_group["id"], STRANGER)
    # The co-admin a co-host; the admin has answered a date.
    handle = await _invitation_id(db_session_factory, gathering_id, CO_ADMIN)
    assert (
        await client.post(f"/gatherings/{gathering_id}/co-hosts", json={"invitation_id": handle}, headers=cast.member)
    ).status_code == 201
    assert (await _put_rsvp(client, cast.admin, occurrence_id, {"response": "no"})).status_code == 200

    invitations_before = await _invitation_rows(db_session_factory, gathering_id)
    assert await _place_rows(db_session_factory, gathering_id) == {}

    for place in ("shared_with", "left_out"):
        _code_409(await _put_place(client, cast.member, gathering_id, cast.co_admin_membership, place), IS_CO_HOST)
        _code_409(await _put_place(client, cast.member, gathering_id, cast.admin_membership, place), HAS_ANSWERED)
    for place in ("invited", "shared_with", "left_out"):
        own = await _put_place(client, cast.member, gathering_id, cast.member_membership, place)
        assert own.status_code == 422, own.text
        (error,) = own.json()["detail"]
        assert error["loc"] == ["path", "membership_id"] and error["code"] == IS_HOST
    missing = await _member_404(client, cast.member, gathering_id)
    for membership_id in (stranger_membership, gone_membership):
        refused = await _put_place(client, cast.member, gathering_id, membership_id, "shared_with")
        assert (refused.status_code, refused.content) == missing
    assert "No such member" in missing[1].decode()

    # Nothing moved.
    assert await _invitation_rows(db_session_factory, gathering_id) == invitations_before
    assert await _place_rows(db_session_factory, gathering_id) == {}
    assert await _chosen(db_session_factory, gathering_id) is False

    # Non-organisers: the gathering's 404 on both routes. E is moved to
    # shared with first, so the memory tier is tried too.
    assert (await _put_place(client, cast.member, gathering_id, e_membership, "shared_with")).status_code == 200
    for headers in (cast.admin, e_headers, cast.stranger):
        expected = await _gathering_404(client, headers)
        listed = await _places(client, headers, gathering_id)
        assert (listed.status_code, listed.content) == expected
        moved = await _put_place(client, headers, gathering_id, e_membership, "invited")
        assert (moved.status_code, moved.content) == expected
    assert (await _place_rows(db_session_factory, gathering_id))[e_person][0] is MemberPlace.SHARED_WITH

    # A groupless gathering has no places.
    standalone = await _create(client, cast.member, title="Mine alone")
    _code_409(await _places(client, cast.member, standalone["id"]), NOT_IN_A_GROUP)
    _code_409(await _put_place(client, cast.member, standalone["id"], e_membership, "shared_with"), NOT_IN_A_GROUP)
    assert await _chosen(db_session_factory, standalone["id"]) is False
    # And the body validates the place: an unknown value is FastAPI's 422.
    assert (
        await client.put(
            f"/gatherings/{gathering_id}/places/{e_membership}", json={"place": "attending"}, headers=cast.member
        )
    ).status_code == 422


# --- newcomers ---------------------------------------------------------------------------


async def test_a_newcomers_place_follows_the_hosts_choice(client, capsys, db_session_factory):
    """The record §9, both admission paths through the ONE helper. Three
    upcoming gatherings and a past one: WHOLE-GROUP → the newcomer gets an
    invitation row (`invited_by` NULL); CHOSEN → a `shared_with` place row
    (`set_by` NULL), exactly the place every other uninvited member has;
    PAST and chosen → nothing. A joins by the link and is approved; B
    accepts an emailed invitation. The helper is idempotent — a second call
    writes nothing — and the host may invite a newcomer afterwards through
    the places route."""
    cast = await _cast(client, capsys, db_session_factory)
    whole = await _create_in_group(client, cast.member, cast.group_id, title="Whole group")
    chosen = await _create_in_group(
        client, cast.member, cast.group_id, title="Chosen", invited=[cast.co_admin_membership]
    )
    past = await _create_in_group(
        client,
        cast.member,
        cast.group_id,
        title="Past and chosen",
        occurrences=[{"starts_at": _iso(_now() - timedelta(days=10))}],
        invited=[cast.co_admin_membership],
    )

    async def rows_for(person: UUID) -> tuple[dict, dict]:
        async with db_session_factory() as db:
            invitations = {
                g: by
                for g, by in (
                    await db.execute(
                        select(GatheringInvitation.gathering_id, GatheringInvitation.invited_by_person_id).where(
                            GatheringInvitation.person_id == person
                        )
                    )
                ).all()
            }
            places = {
                g: (place, by)
                for g, place, by in (
                    await db.execute(
                        select(
                            GatheringMemberPlace.gathering_id,
                            GatheringMemberPlace.place,
                            GatheringMemberPlace.set_by_person_id,
                        ).where(GatheringMemberPlace.person_id == person)
                    )
                ).all()
            }
        return invitations, places

    # A: the link, then the approval.
    a_headers = await _signed_in_headers(client, capsys, "newcomer-a@example.com")
    a_person = await _person_id(db_session_factory, "newcomer-a@example.com")
    link = await _make(client, cast.admin, cast.group_id)
    assert (await _join(client, a_headers, _token_of(link.json()))).json()["status"] == "requested"
    (request,) = (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]
    assert (await _approve(client, cast.co_admin, cast.group_id, request["id"])).status_code == 200
    invitations, places = await rows_for(a_person)
    assert invitations == {UUID(whole["id"]): None}
    assert places == {UUID(chosen["id"]): (MemberPlace.SHARED_WITH, None)}
    assert UUID(past["id"]) not in invitations and UUID(past["id"]) not in places

    # B: the emailed invitation.
    b_headers = await _signed_in_headers(client, capsys, "newcomer-b@example.com")
    b_person = await _person_id(db_session_factory, "newcomer-b@example.com")
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, "newcomer-b@example.com")
    assert (await _accept_group_invitation(client, b_headers, token))["status"] == "accepted"
    assert await rows_for(b_person) == ({UUID(whole["id"]): None}, {UUID(chosen["id"]): (MemberPlace.SHARED_WITH, None)})

    # Idempotent.
    async with db_session_factory() as db:
        assert (
            await invite_newcomer_to_upcoming_gatherings(
                db, group_id=UUID(cast.group_id), person_id=a_person, now=_now()
            )
        ) == 0
        await db.commit()
    assert await rows_for(a_person) == (invitations, places)

    # What each newcomer reads: the whole-group gathering in full, the
    # chosen one in the memory view, the past one not at all.
    for headers in (a_headers, b_headers):
        assert (await client.get(f"/gatherings/{whole['id']}", headers=headers)).json()["caller_view"] == VIEW_FULL
        assert (await client.get(f"/gatherings/{chosen['id']}", headers=headers)).json()["caller_view"] == VIEW_MEMORY
        refused = await client.get(f"/gatherings/{past['id']}", headers=headers)
        assert (refused.status_code, refused.content) == await _gathering_404(client, headers)

    # The host invites A to the chosen gathering afterwards.
    a_membership = await _membership_id(db_session_factory, cast.group_id, "newcomer-a@example.com")
    assert (await _put_place(client, cast.member, chosen["id"], a_membership, "invited")).json()["place"] == "invited"
    assert (await client.get(f"/gatherings/{chosen['id']}", headers=a_headers)).json()["caller_view"] == VIEW_FULL


# --- the backup column, the hook, and the 0034 round trip ---------------------------------


async def test_the_backup_admin_column_is_gone_and_alembic_check_is_clean_with_no_hook(db_session_factory):
    """The contract step (CK-75 retired it, CK-76 unmapped it, CK-77 drops
    it): `groups.backup_admin_person_id` is absent from the catalog with
    its FK; alembic/env.py carries no `include_object` hook (the one CK-76
    added for exactly this column); and `alembic check`, run as the
    operator runs it against the test database at head, finds nothing
    outside the models."""
    async with db_session_factory() as db:
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' "
                    "AND table_name = 'groups' AND column_name = 'backup_admin_person_id'"
                )
            )
        ) == 0
        assert (
            await db.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname = 'fk_groups_backup_admin_person_id'"))
        ) == 0
    env_source = open(os.path.join(BACKEND_DIR, "alembic", "env.py"), encoding="utf-8").read()
    assert "include_object=" not in env_source
    assert "UNMAPPED_COLUMNS" not in env_source
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "check"], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=180
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "No new upgrade operations detected" in proc.stdout + proc.stderr


async def _schema_0034(db_session_factory) -> dict:
    async with db_session_factory() as db:
        head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
        places_table = await db.scalar(
            text("SELECT count(*) FROM information_schema.tables WHERE table_name = 'gathering_member_places'")
        )
        place_type = await db.scalar(text("SELECT count(*) FROM pg_type WHERE typname = 'member_place'"))
        chosen = await db.scalar(
            text(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = 'gatherings' "
                "AND column_name = 'invitees_chosen'"
            )
        )
        check = await db.scalar(
            text("SELECT count(*) FROM pg_constraint WHERE conname = 'ck_gatherings_invitees_chosen_needs_group'")
        )
        backup = (
            await db.execute(
                text(
                    "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'groups' "
                    "AND column_name = 'backup_admin_person_id'"
                )
            )
        ).first()
        backup_fk = await db.scalar(
            text("SELECT count(*) FROM pg_constraint WHERE conname = 'fk_groups_backup_admin_person_id'")
        )
    return {
        "head": head,
        "places_table": places_table == 1,
        "place_type": place_type == 1,
        "invitees_chosen": chosen == 1,
        "check": check == 1,
        "backup": None if backup is None else backup[0],
        "backup_fk": backup_fk == 1,
    }


AT_0034 = {"head": HEAD, "places_table": True, "place_type": True, "invitees_chosen": True, "check": True, "backup": None, "backup_fk": False}
AT_0033 = {"head": "0033", "places_table": False, "place_type": False, "invitees_chosen": False, "check": False, "backup": "YES", "backup_fk": True}


async def test_0034_round_trip_and_the_downgrade_is_genuine(client, capsys, db_session_factory, at_head_afterwards):
    """Down to 0033: the table, the type, the column and its CHECK gone, the
    backup column back nullable with its FK (every value NULL — all it ever
    held). Up: the shape back; a place row and a chosen flag planted at
    head LOST and not resurrected (the host chooses again), the gathering
    whole-group once more. Down and up again: idempotent. Under the
    round-trip rider — a failure here leaves the next test at head."""
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id, left_out=[cast.admin_membership])
    assert await _schema_0034(db_session_factory) == AT_0034
    assert len(await _place_rows(db_session_factory, created["id"])) == 1
    assert await _chosen(db_session_factory, created["id"]) is True

    lines = await _migrate("downgrade", "0033", capsys)
    assert any(m.startswith("Running downgrade 0034 -> 0033") for m in lines), lines
    assert await _schema_0034(db_session_factory) == AT_0033
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM groups WHERE backup_admin_person_id IS NOT NULL")) == 0
        assert await db.scalar(text("SELECT count(*) FROM gatherings WHERE id = :g"), {"g": UUID(created["id"])}) == 1

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0033 -> 0034") for m in lines), lines
    assert await _schema_0034(db_session_factory) == AT_0034
    assert await _place_rows(db_session_factory, created["id"]) == {}  # lost with the table
    assert await _chosen(db_session_factory, created["id"]) is False  # the default, not the plant

    await _migrate("downgrade", "0033", capsys)
    await _migrate("upgrade", "head", capsys)
    assert await _schema_0034(db_session_factory) == AT_0034


# --- the verifier ------------------------------------------------------------------------


async def test_the_verifier_asserts_the_places_shape_and_the_three_invariants(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's CK-77 lines, run as the operator runs it — a
    fresh interpreter against the test database — on a clean baseline
    holding a real chosen gathering, then on the plant each data line exists
    to catch, one at a time: a person with a row of EACH kind on one
    gathering; a place row on a standalone gathering; a standalone gathering
    marked chosen (the CHECK refuses it, so the constraint is DROPPED for
    the plant and recreated after — the 0031 pattern — and the shape line
    fails beside the data line). A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS IT (CK-56's lesson)."""
    both_line = "no person holds both an invitation row and a place row for one gathering (one place each)"
    standalone_line = "every member place row sits on a gathering that belongs to a group"
    chosen_line = "no standalone gathering carries invitees_chosen"
    check_line = "CHECK ck_gatherings_invitees_chosen_needs_group exists"
    gone_line = "groups.backup_admin_person_id is gone"
    cast = await _cast(client, capsys, db_session_factory)
    created = await _create_in_group(client, cast.member, cast.group_id, left_out=[cast.admin_membership])
    standalone = await _create(client, cast.member)
    admin_person = await _person_id(db_session_factory, ADMIN)
    member_person = await _person_id(db_session_factory, MEMBER)

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    for line in (
        "table gathering_member_places exists",
        "gathering_member_places primary key is (gathering_id, person_id)",
        "gathering_member_places.set_by_person_id has no delete rule",
        "index ix_gathering_member_places_person_id exists on gathering_member_places.person_id",
        "member_place carries exactly 'shared_with', 'left_out'",
        "gatherings.invitees_chosen is NOT NULL",
        "gatherings.invitees_chosen defaults to false",
        check_line,
        both_line,
        standalone_line,
        chosen_line,
        gone_line,
    ):
        assert f"PASS  {line}" in out, line
    assert "backup_admin_person_id is NULL" not in out
    assert "INFO  gathering_member_places rows: 1" in out

    async def plant(expected_failures: tuple[str, ...], sql: str, confirm: str, undo: str, params: dict) -> None:
        async with db_session_factory() as db:
            await db.execute(text(sql), params)
            await db.commit()
            assert await db.scalar(text(confirm), params) == 1, f"the plant did not land: {expected_failures}"
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - len(expected_failures), len(expected_failures), 1), out
        for label in expected_failures:
            assert f"FAIL  {label}" in out, out
        async with db_session_factory() as db:
            await db.execute(text(undo), params)
            await db.commit()
        assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # (1) A row of each kind: an invitation row for the left-out admin.
    await plant(
        (both_line,),
        "INSERT INTO gathering_invitations (gathering_id, person_id, invited_by_person_id) VALUES (:g, :p, :m)",
        "SELECT count(*) FROM gathering_invitations i JOIN gathering_member_places pl "
        "ON pl.gathering_id = i.gathering_id AND pl.person_id = i.person_id WHERE i.gathering_id = :g AND i.person_id = :p",
        "DELETE FROM gathering_invitations WHERE gathering_id = :g AND person_id = :p",
        {"g": UUID(created["id"]), "p": admin_person, "m": member_person},
    )
    # (2) A place row on a standalone gathering.
    await plant(
        (standalone_line,),
        "INSERT INTO gathering_member_places (gathering_id, person_id, place, set_by_person_id) "
        "VALUES (:g, :p, 'shared_with', :m)",
        "SELECT count(*) FROM gathering_member_places pl JOIN gatherings g ON g.id = pl.gathering_id "
        "WHERE pl.gathering_id = :g AND g.owning_group_id IS NULL",
        "DELETE FROM gathering_member_places WHERE gathering_id = :g AND person_id = :p",
        {"g": UUID(standalone["id"]), "p": admin_person, "m": member_person},
    )
    # (3) A standalone gathering marked chosen — the CHECK dropped for the
    # plant and recreated after, so both its lines fail while it is down
    # (the data line on the row, the shape line on the constraint).
    params = {"g": UUID(standalone["id"])}
    async with db_session_factory() as db:
        await db.execute(text("ALTER TABLE gatherings DROP CONSTRAINT ck_gatherings_invitees_chosen_needs_group"))
        await db.execute(text("UPDATE gatherings SET invitees_chosen = true WHERE id = :g"), params)
        await db.commit()
        confirmed = await db.scalar(
            text("SELECT count(*) FROM gatherings WHERE id = :g AND invitees_chosen AND owning_group_id IS NULL"),
            params,
        )
    assert confirmed == 1, "the plant did not land"
    try:
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 2, 2, 1), out
        assert f"FAIL  {chosen_line}" in out and f"FAIL  {check_line}" in out, out
    finally:
        async with db_session_factory() as db:
            await db.execute(text("UPDATE gatherings SET invitees_chosen = false WHERE id = :g"), params)
            await db.execute(
                text(
                    "ALTER TABLE gatherings ADD CONSTRAINT ck_gatherings_invitees_chosen_needs_group "
                    "CHECK (owning_group_id IS NOT NULL OR NOT invitees_chosen)"
                )
            )
            await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)


# --- nothing logged -----------------------------------------------------------------------


async def test_the_places_routes_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """With the root logger at DEBUG, a chosen create, the places list, a
    move, and three refusals put no group name, no title, no display name,
    no address and no id into any APPLICATION log record — the router has
    no logger, as before (the httpx client's records carry the request
    line; excluded, and shown non-empty)."""
    cast = await _cast(client, capsys, db_session_factory)
    e_headers, e_membership, _ = await _extra_member(client, capsys, db_session_factory, cast, "quiet-e@example.com")
    assert not hasattr(gatherings_api, "logger")
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        created = await _create_in_group(
            client, cast.member, cast.group_id, title="Quiet surprise", left_out=[cast.admin_membership]
        )
        assert (await _places(client, cast.member, created["id"])).status_code == 200
        assert (await _put_place(client, cast.member, created["id"], e_membership, "shared_with")).status_code == 200
        assert (await _put_place(client, cast.member, created["id"], cast.member_membership, "left_out")).status_code == 422
        assert (await _put_place(client, cast.member, created["id"], MISSING, "invited")).status_code == 404
        assert (await _places(client, e_headers, created["id"])).status_code == 404
    application = [r for r in caplog.records if not r.name.startswith("httpx")]
    assert any(r.name.startswith("httpx") for r in caplog.records)
    assert not [r for r in application if r.name.startswith(("app", "covey-keep"))]
    joined = "\n".join(r.getMessage() for r in application)
    for word in (GROUP_NAME, "Quiet surprise", "quiet-e@example.com", created["id"], cast.group_id, e_membership):
        assert word not in joined, word
