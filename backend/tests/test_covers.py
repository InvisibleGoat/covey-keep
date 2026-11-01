"""CK-83a — covers from photographs: "Use as cover" for a gathering and a
group, the cover cleared when its photograph stops being published, and
covers on the bodies (decisions/2026-10-31-the-design-and-how-it-is-merged.md
§1.3, §3 item 3; migration 0035).

THE WORLD (`_world`): tests/test_group_membership.py's group — an ADMIN who
created it, a CO-ADMIN, a MEMBER, a STRANGER — plus two more members, one
SHARED with the gathering and one LEFT out of it; and ONE GATHERING IN THE
GROUP, hosted by the admin, with the co-admin invited and made its CO-HOST,
the member INVITED (the uploader), the shared member SHARED WITH it (the
photos-only view) and the left member LEFT OUT. One published photograph in
it, uploaded by the member. Every seat is signed in; no network anywhere
(presigning is local, the conftest's reserved TLD).

The load-bearing pins:
- SETTING, BY SEAT: a gathering's host and co-host set its cover; an
  invitee, a member who only sees the photos, a left-out member and a
  stranger draw the gathering 404, byte-identical; a group's admin and
  co-admin set its cover; an ordinary member and a stranger draw the group
  404, byte-identical — and nothing is written on any refusal;
- EVERY REFUSAL IN ITS ORDER: a photograph the caller cannot see → the media
  404, byte-identical to `read_url`'s (before `not_in_*`, which comes before
  `not_published`); another gathering's photograph → `not_in_gathering`; a
  standalone gathering's or another group's → `not_in_group`; pending,
  removed, failed or in flight → `not_published`; a malformed body → 422;
  and the admin of a group LEFT OUT of one of its gatherings cannot make
  that gathering's photograph the group's cover (`_visible_media` is never
  widened to set one);
- THE SAME PHOTOGRAPH TWICE leaves `cover_set_at` and its setter where they
  were;
- READING, BY SEAT: the cover URL for every reader of the subject, the
  presigned answer through the serve credential carrying no media id; A
  GROUP MEMBER LEFT OUT OF THE COVER PHOTOGRAPH'S GATHERING READS THE GROUP'S
  COVER URL and still draws the media 404 on the photograph itself (the
  rule, pinned both ways); a non-member draws the group 404; `archival` →
  422 in the media router's words; no cover → 409 `no_cover`;
- CLEARING: removing the photograph clears both covers it was; destroying a
  live cover photograph clears both, through `mark_for_destruction` (the
  sweep's copy too); a restore after a removal leaves them cleared; an
  organiser losing the role, and the uploader deleting their account, leave
  the cover as it was;
- THE BODIES: `cover` on create, detail, list, patch and the memory view; NO
  GROUP BODY CARRIES A MEDIA ID, over every group route's body; who set a
  cover in no body; a cover change stamps no `updated_at`;
- THE RACE, BOTH ORDERS, STAGED AND NEVER TIMED (the CK-77.1 discipline): a
  removal committed before the set reads the photograph → 409
  `not_published`, no cover written; a set holding the photograph's lock
  while a removal runs → the removal waits (an ungranted lock in `pg_locks`,
  CK-77.2's watcher), then clears the cover. Mutation-checked (the report):
  with the set path's `FOR SHARE` dropped the second case fails;
- no presigned URL in any log record with the root at DEBUG; the import
  boundary; a cover pointing anywhere but a published photograph of its own
  is never served; the verifier's four data lines, each fired by a plant.
"""

import ast
import asyncio
import logging
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.sql import Select

from app.api.covers import NO_COVER, NOT_IN_GATHERING, NOT_IN_GROUP, NOT_PUBLISHED
from app.api.media import ARCHIVAL_NOT_SERVED
from app.config import settings
from app.models import (
    Gathering,
    Group,
    Media,
    MediaDerivative,
    MediaFailureReason,
    MediaLayer,
    MediaStatus,
    PublicationState,
)
from app.services import destruction
from app.services.storage import PRESIGN_TTL, published_key
from tests.test_destruction import _resync_counts, _verifier
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_gatherings import _create as _create_standalone
from tests.test_gatherings import _signed_in_headers
from tests.test_group_gatherings import _create_in_group, _invitation_id
from tests.test_group_membership import (
    ADMIN,
    CO_ADMIN,
    MEMBER,
    STRANGER,
    _add_member,
    _cast,
    _membership_id,
    _person_id,
)
from tests.test_groups import _create as _create_group
from tests.test_media_reads import LAYER_SPECS
from tests.test_media_reads import _url as _media_url
from tests.test_race_backstops import _sql, _stage

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
MISSING = "00000000-0000-0000-0000-000000000000"
SHARED = "shared@example.com"
LEFT = "left@example.com"
GATHERINGS, GROUPS = "gatherings", "groups"
URL_KEYS = {"layer", "content_type", "size_bytes", "url", "method", "expires_in"}
# The verifier's total at 0035: 361 at CK-77, and CK-83a's twenty-four — the
# six cover columns' shapes on gatherings and groups (nullability, the two
# FKs each with no delete rule, cover_set_at's type, the CHECKs and the
# partial indexes: ten a table) and four data lines; 438 since CK-83b's fifty-three — cover_images' shape (the table, its eighteen columns' nullability, the PK, three FKs with their delete rules, the two enum types, two CHECKs, two partial indexes), each subject's cover_image_id (nullability, FK and delete rule, partial index, the widened CHECK's definition), and eleven data lines.
VERIFIER_TOTAL = 438


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class World:
    group_id: str
    gathering_id: str
    admin: dict  # the group's admin; the gathering's host
    co_admin: dict  # the group's co-admin; the gathering's co-host
    member: dict  # an ordinary member; invited to the gathering; the uploader
    shared: dict  # an ordinary member; SHARED WITH the gathering (photos only)
    left: dict  # an ordinary member; LEFT OUT of the gathering
    stranger: dict  # in nothing
    co_admin_membership: str
    member_membership: str
    co_host_handle: str  # the co-admin's invitation id on the gathering
    admin_person: UUID
    co_admin_person: UUID
    member_person: UUID
    photo: str  # ready + live, in the gathering, uploaded by the member


async def _plant(
    db_session_factory,
    gathering_id: str,
    uploader_person_id: UUID,
    *,
    status: MediaStatus = MediaStatus.READY,
    publication_state: PublicationState = PublicationState.LIVE,
    removed_by_person_id: UUID | None = None,
) -> str:
    """One media row — the worker's output without the worker (test_media_reads'
    shape): `ready` rows carry their three derivative rows; a `removed` row
    carries `removed_at` and the remover the test names; a `failed` row says
    why, as every dead-letter does."""
    born = _now()
    failed = status is MediaStatus.FAILED
    async with db_session_factory() as db:
        row = Media(
            gathering_id=UUID(gathering_id),
            uploader_person_id=uploader_person_id,
            upload_content_type="image/jpeg",
            upload_size_bytes=1_300_000,
            status=status,
            publication_state=publication_state,
            removed_at=born if publication_state is PublicationState.REMOVED else None,
            removed_by_person_id=removed_by_person_id,
            failure_reason=MediaFailureReason.UNREADABLE if failed else None,
            last_error="planted: undecodable" if failed else None,
            created_at=born,
            uploaded_at=None if status is MediaStatus.PENDING_UPLOAD else born,
        )
        db.add(row)
        await db.flush()
        if status is MediaStatus.READY:
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


async def _world(client, capsys, db_session_factory) -> World:
    cast = await _cast(client, capsys, db_session_factory)
    shared = await _signed_in_headers(client, capsys, SHARED)
    left = await _signed_in_headers(client, capsys, LEFT)
    await _add_member(db_session_factory, cast.group_id, SHARED)
    left_membership = await _add_member(db_session_factory, cast.group_id, LEFT)
    created = await _create_in_group(
        client,
        cast.admin,
        cast.group_id,
        invited=[cast.co_admin_membership, cast.member_membership],
        left_out=[left_membership],
    )
    gathering_id = created["id"]
    handle = await _invitation_id(db_session_factory, gathering_id, CO_ADMIN)
    made = await client.post(
        f"/gatherings/{gathering_id}/co-hosts", json={"invitation_id": handle}, headers=cast.admin
    )
    assert made.status_code == 201, made.text
    member_person = await _person_id(db_session_factory, MEMBER)
    photo = await _plant(db_session_factory, gathering_id, member_person)
    await _resync_counts(db_session_factory, gathering_id)
    world = World(
        group_id=cast.group_id,
        gathering_id=gathering_id,
        admin=cast.admin,
        co_admin=cast.co_admin,
        member=cast.member,
        shared=shared,
        left=left,
        stranger=cast.stranger,
        co_admin_membership=cast.co_admin_membership,
        member_membership=cast.member_membership,
        co_host_handle=handle,
        admin_person=await _person_id(db_session_factory, ADMIN),
        co_admin_person=await _person_id(db_session_factory, CO_ADMIN),
        member_person=member_person,
        photo=photo,
    )
    # The world is honest: every seat stands where its name says, so a 404
    # below is the rule and never a broken setup.
    views = {}
    for name in ("admin", "co_admin", "member", "shared"):
        response = await client.get(f"/gatherings/{gathering_id}", headers=getattr(world, name))
        assert response.status_code == 200, (name, response.text)
        views[name] = (response.json()["caller_role"], response.json()["caller_view"])
    assert views == {
        "admin": ("host", "full"),
        "co_admin": ("co_host", "full"),
        "member": (None, "full"),
        "shared": (None, "memory"),
    }
    for headers in (world.left, world.stranger):
        assert (await client.get(f"/gatherings/{gathering_id}", headers=headers)).status_code == 404
    for name in ("admin", "co_admin", "member", "shared", "left"):
        assert (await client.get(f"/groups/{cast.group_id}", headers=getattr(world, name))).status_code == 200
    assert (await client.get(f"/groups/{cast.group_id}", headers=world.stranger)).status_code == 404
    return world


def _subject(world: World, kind: str) -> str:
    return world.gathering_id if kind == GATHERINGS else world.group_id


async def _set(client, headers, kind: str, subject_id: str, media_id: str):
    return await client.put(f"/{kind}/{subject_id}/cover", json={"media_id": media_id}, headers=headers)


async def _clear(client, headers, kind: str, subject_id: str):
    return await client.delete(f"/{kind}/{subject_id}/cover", headers=headers)


async def _cover_url(client, headers, kind: str, subject_id: str, layer: str = "web"):
    return await client.get(f"/{kind}/{subject_id}/cover/url", params={"layer": layer}, headers=headers)


async def _stored(db_session_factory, kind: str, subject_id: str) -> tuple:
    """(cover_media_id, cover_set_at, cover_set_by_person_id), read by SQL."""
    model = Gathering if kind == GATHERINGS else Group
    async with db_session_factory() as db:
        return tuple(
            (
                await db.execute(
                    select(model.cover_media_id, model.cover_set_at, model.cover_set_by_person_id).where(
                        model.id == UUID(subject_id)
                    )
                )
            ).one()
        )


async def _subject_404(client, headers, kind: str) -> bytes:
    response = await client.get(f"/{kind}/{MISSING}", headers=headers)
    assert response.status_code == 404
    return response.content


async def _media_404(client, headers) -> bytes:
    response = await _media_url(client, headers, MISSING)
    assert response.status_code == 404
    return response.content


def _code(response, status: int) -> str:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    if status == 422:
        (error,) = detail
        assert error["loc"] == ["body", "media_id"]
        return error["code"]
    return detail["code"]


async def _standalone_photo(client, db_session_factory, headers, uploader: UUID, **plant) -> str:
    created = await _create_standalone(client, headers)
    photo = await _plant(db_session_factory, created["id"], uploader, **plant)
    await _resync_counts(db_session_factory, created["id"])
    return photo


def _query(url: str) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


# --- auth -------------------------------------------------------------------------------


async def test_the_cover_routes_require_auth(client):
    body = {"media_id": MISSING}
    for kind in (GATHERINGS, GROUPS):
        assert (await client.put(f"/{kind}/{MISSING}/cover", json=body)).status_code == 401
        assert (await client.delete(f"/{kind}/{MISSING}/cover")).status_code == 401
        assert (await client.get(f"/{kind}/{MISSING}/cover/url", params={"layer": "web"})).status_code == 401


# --- setting, by seat -----------------------------------------------------------------------


async def test_a_gatherings_host_and_co_host_set_its_cover_and_nobody_else_can(
    client, capsys, db_session_factory
):
    """The organisers — the host and a co-host (`may_administer`) — and
    nobody else: an invitee, a member who sees the photos only, a left-out
    member and a stranger each draw the gathering 404 byte-identical to a
    missing id, on the set and on the clear, and nothing is written."""
    w = await _world(client, capsys, db_session_factory)
    second = await _plant(db_session_factory, w.gathering_id, w.member_person)

    for headers in (w.member, w.shared, w.left, w.stranger):
        refused = await _set(client, headers, GATHERINGS, w.gathering_id, w.photo)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, GATHERINGS)
    assert await _stored(db_session_factory, GATHERINGS, w.gathering_id) == (None, None, None)

    set_by_host = await _set(client, w.admin, GATHERINGS, w.gathering_id, w.photo)
    assert set_by_host.status_code == 200, set_by_host.text
    cover = set_by_host.json()["cover"]
    assert set(cover) == {"source", "media_id", "set_at"}
    assert cover["source"] == "photo" and cover["media_id"] == w.photo
    media_id, set_at, set_by = await _stored(db_session_factory, GATHERINGS, w.gathering_id)
    assert (str(media_id), set_by) == (w.photo, w.admin_person)
    assert cover["set_at"] == set_at.isoformat()

    set_by_co_host = await _set(client, w.co_admin, GATHERINGS, w.gathering_id, second)
    assert set_by_co_host.status_code == 200, set_by_co_host.text
    assert set_by_co_host.json()["cover"]["media_id"] == second
    media_id, _, set_by = await _stored(db_session_factory, GATHERINGS, w.gathering_id)
    assert (str(media_id), set_by) == (second, w.co_admin_person)

    for headers in (w.member, w.shared, w.left, w.stranger):
        refused = await _clear(client, headers, GATHERINGS, w.gathering_id)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, GATHERINGS)
    assert (await _stored(db_session_factory, GATHERINGS, w.gathering_id))[0] == UUID(second)

    assert (await _clear(client, w.admin, GATHERINGS, w.gathering_id)).status_code == 204
    assert await _stored(db_session_factory, GATHERINGS, w.gathering_id) == (None, None, None)
    # 204 whether or not a cover was set: the state asked for holds.
    assert (await _clear(client, w.co_admin, GATHERINGS, w.gathering_id)).status_code == 204


async def test_a_groups_admin_and_co_admin_set_its_cover_and_nobody_else_can(
    client, capsys, db_session_factory
):
    """The organisers — the admin and a co-admin (`may_administer_group`) —
    and nobody else: an ordinary member (the uploader included) and a
    stranger draw the group 404 byte-identical to a missing id, on the set
    and on the clear. The answer never names the photograph."""
    w = await _world(client, capsys, db_session_factory)
    second = await _plant(db_session_factory, w.gathering_id, w.member_person)

    for headers in (w.member, w.shared, w.left, w.stranger):
        refused = await _set(client, headers, GROUPS, w.group_id, w.photo)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, GROUPS)
    assert await _stored(db_session_factory, GROUPS, w.group_id) == (None, None, None)

    set_by_admin = await _set(client, w.admin, GROUPS, w.group_id, w.photo)
    assert set_by_admin.status_code == 200, set_by_admin.text
    cover = set_by_admin.json()["cover"]
    assert set(cover) == {"source", "set_at"} and cover["source"] == "photo"
    assert w.photo not in set_by_admin.text
    media_id, set_at, set_by = await _stored(db_session_factory, GROUPS, w.group_id)
    assert (str(media_id), set_by) == (w.photo, w.admin_person)
    assert cover["set_at"] == set_at.isoformat()

    set_by_co_admin = await _set(client, w.co_admin, GROUPS, w.group_id, second)
    assert set_by_co_admin.status_code == 200, set_by_co_admin.text
    assert second not in set_by_co_admin.text
    media_id, _, set_by = await _stored(db_session_factory, GROUPS, w.group_id)
    assert (str(media_id), set_by) == (second, w.co_admin_person)

    for headers in (w.member, w.shared, w.left, w.stranger):
        refused = await _clear(client, headers, GROUPS, w.group_id)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, GROUPS)
    assert (await _stored(db_session_factory, GROUPS, w.group_id))[0] == UUID(second)

    assert (await _clear(client, w.co_admin, GROUPS, w.group_id)).status_code == 204
    assert await _stored(db_session_factory, GROUPS, w.group_id) == (None, None, None)
    assert (await _clear(client, w.admin, GROUPS, w.group_id)).status_code == 204


# --- every refusal, in its order ------------------------------------------------------------


async def test_a_gatherings_refusals_come_in_their_order(client, capsys, db_session_factory):
    """After the gathering 404: the media 404 for a photograph the caller
    cannot see (byte-identical to `read_url`'s, and before anything else is
    said about it), then `not_in_gathering`, then `not_published` — pending,
    removed, failed and in flight — then a malformed body is a 422; nothing
    is written on any of them."""
    w = await _world(client, capsys, db_session_factory)
    stranger_person = await _person_id(db_session_factory, STRANGER)

    # (1) Not visible to the caller: the media 404, byte-identical to a
    # missing id at `read_url`. A pending photograph is the uploader's and
    # the host's alone — a co-host is not an approver (reserved).
    pending = await _plant(
        db_session_factory, w.gathering_id, w.member_person, publication_state=PublicationState.PENDING
    )
    refused = await _set(client, w.co_admin, GATHERINGS, w.gathering_id, pending)
    assert refused.status_code == 404
    assert refused.content == await _media_404(client, w.co_admin)
    # A stranger's gathering's published photograph: the media 404 before
    # `not_in_gathering` — the refusal never confirms the photograph exists.
    foreign = await _standalone_photo(client, db_session_factory, w.stranger, stranger_person)
    refused = await _set(client, w.admin, GATHERINGS, w.gathering_id, foreign)
    assert refused.status_code == 404
    assert refused.content == await _media_404(client, w.admin)
    assert (await _set(client, w.admin, GATHERINGS, w.gathering_id, MISSING)).content == await _media_404(
        client, w.admin
    )

    # (2) Another gathering's photograph the caller CAN see — before
    # `not_published`: a pending one in the host's own standalone gathering
    # is `not_in_gathering`, not 409.
    elsewhere = await _standalone_photo(client, db_session_factory, w.admin, w.admin_person)
    assert _code(await _set(client, w.admin, GATHERINGS, w.gathering_id, elsewhere), 422) == NOT_IN_GATHERING
    elsewhere_pending = await _standalone_photo(
        client, db_session_factory, w.admin, w.admin_person, publication_state=PublicationState.PENDING
    )
    assert (
        _code(await _set(client, w.admin, GATHERINGS, w.gathering_id, elsewhere_pending), 422)
        == NOT_IN_GATHERING
    )

    # (3) Not published: every other state the host can see, each carrying
    # its rung and state.
    removed = await _plant(
        db_session_factory,
        w.gathering_id,
        w.member_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=w.admin_person,  # the gathering's bin: the host still sees it
    )
    in_flight = await _plant(
        db_session_factory,
        w.gathering_id,
        w.member_person,
        status=MediaStatus.PROCESSING,
        publication_state=PublicationState.PENDING,
    )
    failed = await _plant(  # the host's own failed upload — visible to its uploader alone
        db_session_factory,
        w.gathering_id,
        w.admin_person,
        status=MediaStatus.FAILED,
        publication_state=PublicationState.PENDING,
    )
    for media_id, status, state in (
        (pending, "ready", "pending"),
        (removed, "ready", "removed"),
        (in_flight, "processing", "pending"),
        (failed, "failed", "pending"),
    ):
        response = await _set(client, w.admin, GATHERINGS, w.gathering_id, media_id)
        assert _code(response, 409) == NOT_PUBLISHED, media_id
        detail = response.json()["detail"]
        assert (detail["status"], detail["publication_state"]) == (status, state)

    # (4) A malformed body: the model's 422.
    for body in ({}, {"media_id": "not-an-id"}, {"media_id": w.photo, "extra": True}):
        response = await client.put(f"/gatherings/{w.gathering_id}/cover", json=body, headers=w.admin)
        assert response.status_code == 422, body

    assert await _stored(db_session_factory, GATHERINGS, w.gathering_id) == (None, None, None)


async def test_a_groups_refusals_come_in_their_order(client, capsys, db_session_factory):
    """After the group 404: the media 404 for a photograph the caller cannot
    see — including the admin's own group's gathering they were LEFT OUT of
    (`_visible_media` is not widened to set a cover) — then `not_in_group`
    for a standalone gathering's photograph or another group's, then
    `not_published`, then a malformed body is a 422."""
    w = await _world(client, capsys, db_session_factory)

    pending = await _plant(
        db_session_factory, w.gathering_id, w.member_person, publication_state=PublicationState.PENDING
    )
    refused = await _set(client, w.co_admin, GROUPS, w.group_id, pending)
    assert refused.status_code == 404
    assert refused.content == await _media_404(client, w.co_admin)
    # A gathering in the admin's own group that the admin is LEFT OUT of:
    # its published photograph is not the admin's to see, so not theirs to
    # make the group's cover.
    hidden = await _create_in_group(
        client, w.member, w.group_id, left_out=[await _membership_id(db_session_factory, w.group_id, ADMIN)]
    )
    hidden_photo = await _plant(db_session_factory, hidden["id"], w.member_person)
    refused = await _set(client, w.admin, GROUPS, w.group_id, hidden_photo)
    assert refused.status_code == 404
    assert refused.content == await _media_404(client, w.admin)

    standalone = await _standalone_photo(client, db_session_factory, w.admin, w.admin_person)
    assert _code(await _set(client, w.admin, GROUPS, w.group_id, standalone), 422) == NOT_IN_GROUP
    other_group = await _create_group(client, w.admin, name="Another family")
    other_gathering = await _create_in_group(client, w.admin, other_group["id"])
    other_photo = await _plant(db_session_factory, other_gathering["id"], w.admin_person)
    assert _code(await _set(client, w.admin, GROUPS, w.group_id, other_photo), 422) == NOT_IN_GROUP
    # ...and that photograph IS the other group's to use, by its organiser.
    assert (await _set(client, w.admin, GROUPS, other_group["id"], other_photo)).status_code == 200

    removed = await _plant(
        db_session_factory,
        w.gathering_id,
        w.member_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=w.admin_person,
    )
    in_flight = await _plant(
        db_session_factory, w.gathering_id, w.member_person, status=MediaStatus.UPLOADED,
        publication_state=PublicationState.PENDING,
    )
    failed = await _plant(
        db_session_factory, w.gathering_id, w.admin_person, status=MediaStatus.FAILED,
        publication_state=PublicationState.PENDING,
    )
    for media_id in (pending, removed, in_flight, failed):
        assert _code(await _set(client, w.admin, GROUPS, w.group_id, media_id), 409) == NOT_PUBLISHED

    for body in ({}, {"media_id": 7}, {"media_id": w.photo, "group_id": w.group_id}):
        response = await client.put(f"/groups/{w.group_id}/cover", json=body, headers=w.admin)
        assert response.status_code == 422, body

    assert await _stored(db_session_factory, GROUPS, w.group_id) == (None, None, None)


async def test_setting_the_photograph_that_is_already_the_cover_changes_nothing(
    client, capsys, db_session_factory
):
    """`cover_set_at` is the cover's version: setting the same photograph
    again — by the same organiser or another — writes nothing, so the
    version and the setter stay, and a client's cached image stays valid.
    A different photograph moves both."""
    w = await _world(client, capsys, db_session_factory)
    second = await _plant(db_session_factory, w.gathering_id, w.member_person)
    for kind in (GATHERINGS, GROUPS):
        subject = _subject(w, kind)
        first = await _set(client, w.admin, kind, subject, w.photo)
        assert first.status_code == 200
        stored = await _stored(db_session_factory, kind, subject)
        again = await _set(client, w.co_admin, kind, subject, w.photo)
        assert again.status_code == 200
        assert again.json() == first.json()
        assert await _stored(db_session_factory, kind, subject) == stored  # the setter too
        moved = await _set(client, w.co_admin, kind, subject, second)
        assert moved.status_code == 200
        after = await _stored(db_session_factory, kind, subject)
        # A different photograph is written: the setter moves, and the
        # version with it (>=, so a coarse clock's tie cannot fail it).
        assert (str(after[0]), after[2]) == (second, w.co_admin_person) and after[1] >= stored[1]
        assert moved.json()["cover"]["set_at"] == after[1].isoformat()


# --- reading, by seat ---------------------------------------------------------------------------


async def test_a_gatherings_cover_url_reaches_its_read_audience_and_names_no_photograph(
    client, capsys, db_session_factory
):
    """The gathering's read audience — the memory tier: the host, the
    co-host, an invitee, and a member who sees the photos only — reads a
    presigned GET for the cover's web and thumbnail layers through the serve
    credential, from the published bucket, for the derivative's own key, and
    the answer names no photograph. A left-out member and a stranger draw
    the gathering 404 byte-identical; `archival` is the media router's 422,
    word for word; no cover is 409 `no_cover`."""
    w = await _world(client, capsys, db_session_factory)
    assert _code(await _cover_url(client, w.admin, GATHERINGS, w.gathering_id), 409) == NO_COVER
    assert (await _set(client, w.admin, GATHERINGS, w.gathering_id, w.photo)).status_code == 200

    for headers in (w.admin, w.co_admin, w.member, w.shared):
        for layer in (MediaLayer.WEB, MediaLayer.THUMBNAIL):
            response = await _cover_url(client, headers, GATHERINGS, w.gathering_id, layer.value)
            assert response.status_code == 200, response.text
            body = response.json()
            assert set(body) == URL_KEYS
            content_type, size, _ = LAYER_SPECS[layer]
            assert (body["layer"], body["content_type"], body["size_bytes"]) == (layer.value, content_type, size)
            assert body["method"] == "GET" and body["expires_in"] == int(PRESIGN_TTL.total_seconds())
            parts = urllib.parse.urlsplit(body["url"])
            assert parts.path == f"/{settings.r2_bucket_published}/{published_key(UUID(w.photo), layer)}"
            assert _query(body["url"])["X-Amz-Credential"].startswith(settings.r2_serve_access_key_id + "/")
            # The photograph's id is in the object KEY (the URL's path), as
            # every published key is; it is never a field of the answer.
            assert "media_id" not in body

    for headers in (w.left, w.stranger):
        refused = await _cover_url(client, headers, GATHERINGS, w.gathering_id)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, GATHERINGS)

    archival = await _cover_url(client, w.member, GATHERINGS, w.gathering_id, "archival")
    assert archival.status_code == 422
    assert [e["loc"] for e in archival.json()["detail"]] == [["query", "layer"]]
    assert archival.json()["detail"][0]["msg"] == ARCHIVAL_NOT_SERVED
    assert archival.json() == (await _media_url(client, w.member, w.photo, "archival")).json()
    assert (await _cover_url(client, w.member, GATHERINGS, w.gathering_id, "original")).status_code == 422

    assert (await _clear(client, w.admin, GATHERINGS, w.gathering_id)).status_code == 204
    assert _code(await _cover_url(client, w.shared, GATHERINGS, w.gathering_id), 409) == NO_COVER


async def test_a_groups_cover_reaches_every_member_even_one_left_out_of_its_gathering(
    client, capsys, db_session_factory
):
    """§1.3, PINNED BOTH WAYS: a group's cover chosen from a photograph is
    seen by EVERY member, including one left out of the gathering it came
    from — who reads the group's cover URL and STILL draws the media 404 on
    the photograph itself, and the gathering 404 on its gathering. A
    non-member draws the group 404 byte-identical; `archival` 422; no cover
    409."""
    w = await _world(client, capsys, db_session_factory)
    assert _code(await _cover_url(client, w.left, GROUPS, w.group_id), 409) == NO_COVER
    assert (await _set(client, w.admin, GROUPS, w.group_id, w.photo)).status_code == 200

    for headers in (w.admin, w.co_admin, w.member, w.shared, w.left):
        response = await _cover_url(client, headers, GROUPS, w.group_id)
        assert response.status_code == 200, response.text
        assert set(response.json()) == URL_KEYS
        assert urllib.parse.urlsplit(response.json()["url"]).path.endswith(
            published_key(UUID(w.photo), MediaLayer.WEB)
        )
    thumbnail = await _cover_url(client, w.left, GROUPS, w.group_id, "thumbnail")
    assert thumbnail.status_code == 200 and thumbnail.json()["layer"] == "thumbnail"

    # The other way: the photograph itself stays outside the left member's
    # sight — `_visible_media` is untouched.
    refused = await _media_url(client, w.left, w.photo)
    assert refused.status_code == 404
    assert refused.content == await _media_404(client, w.left)
    assert (await client.get(f"/gatherings/{w.gathering_id}", headers=w.left)).status_code == 404
    assert (await client.get(f"/gatherings/{w.gathering_id}/media", headers=w.left)).status_code == 404

    refused = await _cover_url(client, w.stranger, GROUPS, w.group_id)
    assert refused.status_code == 404
    assert refused.content == await _subject_404(client, w.stranger, GROUPS)

    archival = await _cover_url(client, w.left, GROUPS, w.group_id, "archival")
    assert archival.status_code == 422 and archival.json()["detail"][0]["msg"] == ARCHIVAL_NOT_SERVED

    assert (await _clear(client, w.admin, GROUPS, w.group_id)).status_code == 204
    assert _code(await _cover_url(client, w.left, GROUPS, w.group_id), 409) == NO_COVER


# --- clearing ---------------------------------------------------------------------------------


async def _both_covers(client, w: World, media_id: str) -> None:
    for kind in (GATHERINGS, GROUPS):
        assert (await _set(client, w.admin, kind, _subject(w, kind), media_id)).status_code == 200


async def _no_covers(client, db_session_factory, w: World) -> None:
    for kind in (GATHERINGS, GROUPS):
        assert await _stored(db_session_factory, kind, _subject(w, kind)) == (None, None, None)
        assert (await client.get(f"/{kind}/{_subject(w, kind)}", headers=w.admin)).json()["cover"] is None
        assert _code(await _cover_url(client, w.admin, kind, _subject(w, kind)), 409) == NO_COVER


async def test_removing_the_photograph_clears_both_covers_and_a_restore_does_not_bring_them_back(
    client, capsys, db_session_factory
):
    """A photograph that stops being published never lives on as a cover:
    the host's removal (to the gathering's bin) clears the gathering's cover
    and the group's cover it was, in the removal's transaction; putting it
    back leaves both cleared — a pointer, cleared, never resolved through
    liveness. The same when the uploader takes back their own."""
    w = await _world(client, capsys, db_session_factory)
    await _both_covers(client, w, w.photo)
    assert (await client.post(f"/media/{w.photo}/remove", headers=w.admin)).status_code == 200
    await _no_covers(client, db_session_factory, w)
    restored = await client.post(f"/media/{w.photo}/restore", headers=w.admin)
    assert restored.status_code == 200 and restored.json()["publication_state"] == "live"
    await _no_covers(client, db_session_factory, w)

    # The uploader's own removal, and their own restore.
    await _both_covers(client, w, w.photo)
    assert (await client.post(f"/media/{w.photo}/remove", headers=w.member)).status_code == 200
    await _no_covers(client, db_session_factory, w)
    restored = await client.post(f"/media/{w.photo}/restore", headers=w.member)
    assert restored.status_code == 200 and restored.json()["publication_state"] == "live"
    await _no_covers(client, db_session_factory, w)

    # A removal of some OTHER photograph clears nothing.
    other = await _plant(db_session_factory, w.gathering_id, w.member_person)
    await _both_covers(client, w, w.photo)
    assert (await client.post(f"/media/{other}/remove", headers=w.admin)).status_code == 200
    for kind in (GATHERINGS, GROUPS):
        assert (await _stored(db_session_factory, kind, _subject(w, kind)))[0] == UUID(w.photo)


async def test_destroying_a_live_cover_photograph_clears_both_covers(client, capsys, db_session_factory):
    """`POST /media/{id}/destroy` marks through `mark_for_destruction`, and
    the clearing rides that one copy: both covers go in the destroy's
    transaction."""
    w = await _world(client, capsys, db_session_factory)
    await _both_covers(client, w, w.photo)
    destroyed = await client.post(f"/media/{w.photo}/destroy", headers=w.admin)
    assert destroyed.status_code == 200 and destroyed.json()["status"] == "destroying"
    await _no_covers(client, db_session_factory, w)


async def test_the_marking_statement_clears_the_covers_for_the_sweep_too(client, capsys, db_session_factory):
    """The sweep marks through the same `mark_for_destruction` as the
    endpoint (services/destruction.py), so the clearing is in the one copy:
    called on a cover photograph's row it marks, uncounts and clears both
    covers; called again it marks nothing and touches nothing."""
    w = await _world(client, capsys, db_session_factory)
    await _both_covers(client, w, w.photo)
    async with db_session_factory() as db:
        row = await db.get(Media, UUID(w.photo))
        assert await destruction.mark_for_destruction(db, row) is True
        await db.commit()
    for kind in (GATHERINGS, GROUPS):
        assert await _stored(db_session_factory, kind, _subject(w, kind)) == (None, None, None)
    async with db_session_factory() as db:
        row = await db.get(Media, UUID(w.photo))
        assert await destruction.mark_for_destruction(db, row) is False
        await db.commit()


async def test_losing_the_role_and_the_uploader_deleting_their_account_leave_the_cover(
    client, capsys, db_session_factory
):
    """The cover is the subject's: the co-admin who set the group's cover and
    the co-host who set the gathering's (the same person) losing both roles
    leaves each as it was, setter included — and so does the photograph's
    uploader deleting their account (the photograph stays published, so the
    cover still serves)."""
    w = await _world(client, capsys, db_session_factory)
    for kind in (GATHERINGS, GROUPS):
        assert (await _set(client, w.co_admin, kind, _subject(w, kind), w.photo)).status_code == 200
    before = {kind: await _stored(db_session_factory, kind, _subject(w, kind)) for kind in (GATHERINGS, GROUPS)}
    assert all(stored[2] == w.co_admin_person for stored in before.values())

    removed = await client.delete(f"/groups/{w.group_id}/co-admins/{w.co_admin_membership}", headers=w.admin)
    assert removed.status_code == 204
    removed = await client.delete(f"/gatherings/{w.gathering_id}/co-hosts/{w.co_host_handle}", headers=w.admin)
    assert removed.status_code == 204
    assert (await client.get(f"/gatherings/{w.gathering_id}", headers=w.co_admin)).json()["caller_role"] is None
    for kind in (GATHERINGS, GROUPS):
        assert await _stored(db_session_factory, kind, _subject(w, kind)) == before[kind]

    deleted = await client.post("/me/delete", json={"confirm": "DELETE"}, headers=w.member)
    assert deleted.status_code == 204, deleted.text
    for kind in (GATHERINGS, GROUPS):
        assert await _stored(db_session_factory, kind, _subject(w, kind)) == before[kind]
        assert (await _cover_url(client, w.admin, kind, _subject(w, kind))).status_code == 200


# --- the bodies -------------------------------------------------------------------------------


async def test_cover_rides_every_gathering_body_the_memory_view_included(client, capsys, db_session_factory):
    """`cover` on create (null), detail, the list, the group's list, patch —
    and the memory view, because a cover is not logistics. The setter's
    person id is in no body, and a cover change stamps no `updated_at`."""
    w = await _world(client, capsys, db_session_factory)
    standalone = await _create_standalone(client, w.admin)
    assert standalone["cover"] is None
    in_group = await _create_in_group(client, w.admin, w.group_id)
    assert in_group["cover"] is None
    assert (await client.get(f"/gatherings/{w.gathering_id}", headers=w.admin)).json()["cover"] is None

    set_response = await _set(client, w.co_admin, GATHERINGS, w.gathering_id, w.photo)
    cover = set_response.json()["cover"]
    for headers in (w.admin, w.co_admin, w.member, w.shared):
        detail = await client.get(f"/gatherings/{w.gathering_id}", headers=headers)
        assert detail.json()["cover"] == cover
        assert detail.json()["updated_at"] is None  # a cover change is not a PATCH
        for path in ("/gatherings", f"/groups/{w.group_id}/gatherings"):
            listed = await client.get(path, headers=headers)
            (item,) = [g for g in listed.json()["gatherings"] if g["id"] == w.gathering_id]
            assert item["cover"] == cover
    shared_view = (await client.get(f"/gatherings/{w.gathering_id}", headers=w.shared)).json()
    assert shared_view["caller_view"] == "memory" and shared_view["occurrences"] is None

    patched = await client.patch(f"/gatherings/{w.gathering_id}", json={"title": "Renamed"}, headers=w.admin)
    assert patched.status_code == 200 and patched.json()["cover"] == cover

    for headers in (w.admin, w.co_admin, w.member, w.shared):
        for path in (f"/gatherings/{w.gathering_id}", "/gatherings", f"/groups/{w.group_id}/gatherings"):
            body = (await client.get(path, headers=headers)).text
            assert str(w.co_admin_person) not in body and "set_by" not in body, path


async def test_no_group_body_names_the_photograph(client, capsys, db_session_factory):
    """`cover` on every group body — create, the list, the detail, the
    patch, the hand-over and the set's own answer — as `{"source", "set_at"}`
    or null, and NO GROUP BODY CARRIES THE PHOTOGRAPH'S ID: it may come from
    a gathering the reader is not in. The left-out member finds the id in
    nothing they can read. Who set it is in no body; no `updated_at` moves."""
    w = await _world(client, capsys, db_session_factory)
    fresh = await client.post("/groups", json={"name": "A new family"}, headers=w.admin)
    assert fresh.status_code == 201 and fresh.json()["cover"] is None
    set_response = await _set(client, w.co_admin, GROUPS, w.group_id, w.photo)
    cover = set_response.json()["cover"]
    assert set(cover) == {"source", "set_at"}

    bodies = [fresh, set_response]
    for headers in (w.admin, w.co_admin, w.member, w.shared, w.left):
        detail = await client.get(f"/groups/{w.group_id}", headers=headers)
        assert detail.json()["cover"] == cover and detail.json()["updated_at"] is None
        listed = await client.get("/groups", headers=headers)
        (item,) = [g for g in listed.json()["groups"] if g["id"] == w.group_id]
        assert item["cover"] == cover
        bodies += [detail, listed, await client.get(f"/groups/{w.group_id}/members", headers=headers)]
    patched = await client.patch(f"/groups/{w.group_id}", json={"name": "Finches"}, headers=w.co_admin)
    assert patched.status_code == 200 and patched.json()["cover"] == cover
    handed = await client.post(
        f"/groups/{w.group_id}/hand-over",
        json={"membership_id": w.member_membership},
        headers=w.admin,
    )
    assert handed.status_code == 200 and handed.json()["cover"] == cover
    bodies += [patched, handed]
    for response in bodies:
        assert w.photo not in response.text, response.request.url
        # Who set it — the co-admin — rides no body (the admin's id is the
        # group's own `admin_person_id`, the member's after the hand-over).
        assert str(w.co_admin_person) not in response.text, response.request.url
        assert "set_by" not in response.text

    # The left-out member: the group's gatherings list carries every
    # gathering they can read with ITS cover, and the photograph's id in
    # none of what they can read.
    for path in (
        f"/groups/{w.group_id}",
        "/groups",
        f"/groups/{w.group_id}/gatherings",
        f"/groups/{w.group_id}/members",
        "/gatherings",
    ):
        assert w.photo not in (await client.get(path, headers=w.left)).text, path
    # The cover URL answer carries no media id FIELD; its presigned URL's
    # path is the object key, `media/<id>/<layer>` (storage.published_key),
    # as every published key is — recorded in the report, and harmless: the
    # id opens nothing, every per-photograph route asks `_visible_media`.
    assert set((await _cover_url(client, w.left, GROUPS, w.group_id)).json()) == URL_KEYS


# --- the race: setting a cover against removing its photograph -------------------------------------


def _cover_read(statement) -> bool:
    """The set path's photograph read — the first SELECT FROM media the set
    route issues (its loaders read the subject, the co-admin or co-host row
    and the session, never `media`). Keyed on the STATEMENT and never on its
    `FOR SHARE`: a hook keyed on the lock clause stops firing when the lock
    is dropped, and the mutation would fail on the staging instead of on
    the behaviour the second race pins (the first mutation run did exactly
    that — the report)."""
    return isinstance(statement, Select) and bool(re.search(r"\bFROM media\b", _sql(statement)))


@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_a_removal_that_takes_the_photographs_lock_first_makes_the_set_refuse(
    kind, client, capsys, db_session_factory, monkeypatch
):
    """STAGED, NEVER TIMED: the host's removal of the photograph — the real
    route, from a second request — commits BEFORE the set reads the
    photograph. The set then reads it removed (in the gathering's bin, which
    the host can see) and refuses: 409 `not_published`, and no cover is
    written."""
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)

    async def removal() -> None:
        response = await client.post(f"/media/{w.photo}/remove", headers=w.admin)
        assert response.status_code == 200, response.text

    state = _stage(monkeypatch, when=_cover_read, competitor=removal, before=True)
    response = await _set(client, w.admin, kind, subject, w.photo)
    assert state["fired"], "the race was not staged — the hook never fired"
    assert _code(response, 409) == NOT_PUBLISHED
    assert response.json()["detail"]["publication_state"] == "removed"
    assert await _stored(db_session_factory, kind, subject) == (None, None, None)


@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_a_set_holding_the_photographs_lock_is_cleared_by_the_removal_waiting_behind_it(
    kind, client, capsys, db_session_factory, monkeypatch
):
    """STAGED, NEVER TIMED: the set has read the photograph `FOR SHARE` when
    the host's removal — the real route, as a concurrent request — starts.
    The removal WAITS on the photograph's lock (a third connection sees its
    ungranted lock in `pg_locks`, CK-77.2's watcher); the set writes the
    cover and commits; the removal then goes through and its clearing
    statement — a new statement, so it sees the committed cover — clears
    it. Without the set path's lock the removal would not wait, would clear
    nothing, and the set would commit a cover on a removed photograph: the
    mutation run in the report drops `read=True … FOR SHARE` and this test
    fails on `seen`."""
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    removals: list[asyncio.Task] = []
    seen: dict[str, str] = {}

    async def removal_behind() -> None:
        task = asyncio.create_task(client.post(f"/media/{w.photo}/remove", headers=w.admin))
        removals.append(task)
        seen["removal"] = await _until_the_route_waits_or_finishes(db_session_factory, task)

    state = _stage(monkeypatch, when=_cover_read, competitor=removal_behind)
    response = await _set(client, w.admin, kind, subject, w.photo)
    (task,) = removals
    removed = await task
    assert state["fired"], "the race was not staged — the hook never fired"
    assert seen["removal"] == "waiting", f"the removal never waited on the photograph's lock ({seen})"
    assert response.status_code == 200, response.text  # the set won the lock, and committed first
    assert removed.status_code == 200, removed.text
    assert await _stored(db_session_factory, kind, subject) == (None, None, None)


# --- logs, the boundary, integrity ----------------------------------------------------------------


async def test_no_presigned_url_reaches_a_log_even_at_debug(client, capsys, db_session_factory, caplog):
    """The CK-37 rule on the new router: with the ROOT logger at DEBUG, the
    set, the clear, both URL routes and every refusal path put no URL, no
    signature, no key and no key id into any log record — and the router
    logs nothing of its own."""
    w = await _world(client, capsys, db_session_factory)
    caplog.clear()
    urls = []
    with caplog.at_level(logging.DEBUG):
        for kind in (GATHERINGS, GROUPS):
            subject = _subject(w, kind)
            assert (await _cover_url(client, w.admin, kind, subject)).status_code == 409
            assert (await _set(client, w.admin, kind, subject, w.photo)).status_code == 200
            for layer in ("web", "thumbnail"):
                urls.append((await _cover_url(client, w.member, kind, subject, layer)).json()["url"])
            assert (await _cover_url(client, w.member, kind, subject, "archival")).status_code == 422
            assert (await _cover_url(client, w.stranger, kind, subject)).status_code == 404
            assert (await _set(client, w.stranger, kind, subject, w.photo)).status_code == 404
            assert (await _set(client, w.admin, kind, subject, MISSING)).status_code == 404
            assert (await _clear(client, w.admin, kind, subject)).status_code == 204
    assert len(urls) == 4
    logged = caplog.text
    for url in urls:
        assert url not in logged and _query(url)["X-Amz-Signature"] not in logged
    assert "X-Amz" not in logged and "Signature:" not in logged
    assert settings.r2_serve_access_key_id not in logged
    for layer in MediaLayer:
        assert published_key(UUID(w.photo), layer) not in logged
    assert not [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]


def _imports(path: pathlib.Path) -> set[str]:
    imported = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    return imported


def test_the_import_boundary_holds():
    """`services/covers.py` imports the models and SQLAlchemy and nothing
    else — `services/destruction.py` calls it, and that module may never
    pull `ingest`, `processing`, `storage` or botocore into the web process
    (the code-root CLAUDE.md Gotcha) — and `import app.main` loads no image
    stack. The new router has no logger."""
    imported = _imports(BACKEND_DIR / "app" / "services" / "covers.py")
    assert imported == {"__future__", "uuid", "sqlalchemy", "sqlalchemy.ext.asyncio", "app.models"}, imported
    router = BACKEND_DIR / "app" / "api" / "covers.py"
    assert not {m for m in _imports(router) if m.split(".")[0] in ("logging", "botocore")}
    assert "getLogger" not in router.read_text(encoding="utf-8")

    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    for name in (
        "DATABASE_URL", "SESSION_SECRET", "APP_BASE_URL", "API_BASE_URL",
        "R2_ENDPOINT_URL", "R2_BUCKET_QUARANTINE", "R2_BUCKET_PUBLISHED",
        "R2_UPLOAD_ACCESS_KEY_ID", "R2_UPLOAD_SECRET_ACCESS_KEY",
        "R2_SERVE_ACCESS_KEY_ID", "R2_SERVE_SECRET_ACCESS_KEY",
        "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_LOOKUP_100K", "STRIPE_PRICE_LOOKUP_300K",
    ):
        env[name] = os.environ[name]
    probe = (
        "import sys, app.main; "
        "loaded = sorted(m for m in sys.modules if m in ('app.services.processing', 'app.services.ingest') "
        "or m == 'PIL' or m.startswith('PIL.')); "
        "print('app.api.covers' in sys.modules, 'app.services.covers' in sys.modules, loaded)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True True []", result.stdout


async def test_a_cover_on_anything_but_a_published_photograph_of_its_own_is_never_served(
    client, capsys, db_session_factory
):
    """A pointer the product cannot write — planted around the set path — is
    an integrity failure: the URL route raises rather than serving, the
    message naming no id, and the verifier names it (the next test)."""
    w = await _world(client, capsys, db_session_factory)
    pending = await _plant(
        db_session_factory, w.gathering_id, w.member_person, publication_state=PublicationState.PENDING
    )
    other = await _standalone_photo(client, db_session_factory, w.admin, w.admin_person)
    for kind, media_id in ((GATHERINGS, pending), (GATHERINGS, other), (GROUPS, pending), (GROUPS, other)):
        await _plant_cover(db_session_factory, kind, _subject(w, kind), media_id, w.admin_person)
        with pytest.raises(RuntimeError) as raised:
            await _cover_url(client, w.admin, kind, _subject(w, kind))
        assert media_id not in str(raised.value) and "integrity" in str(raised.value)
        await _plant_cover(db_session_factory, kind, _subject(w, kind), None, None)


async def _plant_cover(db_session_factory, kind: str, subject_id: str, media_id, person_id) -> None:
    """Write a subject's cover columns directly — around the set path — and
    confirm the plant landed with its own SELECT (CK-56's lesson)."""
    table = GATHERINGS if kind == GATHERINGS else GROUPS
    async with db_session_factory() as db:
        await db.execute(
            text(
                f"UPDATE {table} SET cover_media_id = :m, "
                "cover_set_at = CASE WHEN CAST(:m AS uuid) IS NULL THEN NULL ELSE now() END, "
                "cover_set_by_person_id = :p WHERE id = :s"
            ),
            {"m": UUID(media_id) if media_id else None, "p": person_id, "s": UUID(subject_id)},
        )
        await db.commit()
        landed = await db.scalar(
            text(f"SELECT count(*) FROM {table} WHERE id = :s AND cover_media_id IS NOT DISTINCT FROM :m"),
            {"s": UUID(subject_id), "m": UUID(media_id) if media_id else None},
        )
        assert landed == 1, "the plant did not land"


async def test_the_verifier_asserts_every_cover_is_a_published_photograph_of_its_own_and_whole(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's four CK-83a data lines, run as the operator
    runs it, each fired by a plant written around the set path and confirmed
    by its own SELECT: a gathering's cover on its own pending photograph and
    on another gathering's; a group's cover on a removed photograph and on a
    standalone gathering's; and part of a cover on each table, for which the
    CHECK is dropped and recreated after (its shape line fails beside the
    data line). Clean before, between and after."""
    w = await _world(client, capsys, db_session_factory)
    pending = await _plant(
        db_session_factory, w.gathering_id, w.member_person, publication_state=PublicationState.PENDING
    )
    removed = await _plant(
        db_session_factory,
        w.gathering_id,
        w.member_person,
        publication_state=PublicationState.REMOVED,
        removed_by_person_id=w.admin_person,
    )
    await _resync_counts(db_session_factory, w.gathering_id)
    standalone = await _standalone_photo(client, db_session_factory, w.admin, w.admin_person)
    for kind in (GATHERINGS, GROUPS):
        assert (await _set(client, w.admin, kind, _subject(w, kind), w.photo)).status_code == 200

    gathering_line = "every gathering's cover is a ready, published photograph of that gathering"
    group_line = "every group's cover is a ready, published photograph from one of that group's gatherings"
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    assert f"PASS  {gathering_line}" in out and f"PASS  {group_line}" in out

    for kind, media_id, line in (
        (GATHERINGS, pending, gathering_line),
        (GATHERINGS, standalone, gathering_line),
        (GROUPS, removed, group_line),
        (GROUPS, standalone, group_line),
    ):
        await _plant_cover(db_session_factory, kind, _subject(w, kind), media_id, w.admin_person)
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 1, 1, 1), (kind, media_id, out)
        assert f"FAIL  {line}" in out
        await _plant_cover(db_session_factory, kind, _subject(w, kind), w.photo, w.admin_person)
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    for table in (GATHERINGS, GROUPS):
        constraint = f"ck_{table}_cover_all_or_none"
        subject_id = w.gathering_id if table == GATHERINGS else w.group_id
        async with db_session_factory() as db:
            with pytest.raises(Exception):  # the CHECK stands: part of a cover is refused
                await db.execute(
                    text(f"UPDATE {table} SET cover_set_by_person_id = NULL WHERE id = :s"), {"s": UUID(subject_id)}
                )
            await db.rollback()
        async with db_session_factory() as db:
            await db.execute(text(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}"))
            await db.execute(text(f"UPDATE {table} SET cover_set_by_person_id = NULL WHERE id = :s"), {"s": UUID(subject_id)})
            await db.commit()
            assert await db.scalar(
                text(f"SELECT count(*) FROM {table} WHERE id = :s AND cover_media_id IS NOT NULL "
                     "AND cover_set_by_person_id IS NULL"),
                {"s": UUID(subject_id)},
            ) == 1, "the plant did not land"
        # Three FAILs since CK-83b (the pin moved with this reason): the data
        # line and the CHECK's existence line, both relabelled for the widened
        # rule, and the line reading the CHECK's definition (0036's form).
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 3, 3, 1), (table, out)
        assert (
            f"FAIL  no {table} row carries part of a cover, or two sources "
            "(one source with its version and setter, or nothing)"
        ) in out
        assert (
            f"FAIL  CHECK {constraint} exists (at most one cover source, set iff its version and setter are)"
        ) in out
        assert f"FAIL  CHECK {constraint} admits the uploaded source (0036's widened form)" in out
        async with db_session_factory() as db:
            await db.execute(
                text(f"UPDATE {table} SET cover_set_by_person_id = :p WHERE id = :s"),
                {"p": w.admin_person, "s": UUID(subject_id)},
            )
            # Restored in 0036's WIDENED form (CK-83b): the 0035 form would
            # refuse every uploaded cover for the rest of the session.
            await db.execute(
                text(
                    f"ALTER TABLE {table} ADD CONSTRAINT {constraint} CHECK "
                    "(num_nonnulls(cover_media_id, cover_image_id) <= 1 AND "
                    "num_nonnulls(cover_media_id, cover_image_id, cover_set_at, cover_set_by_person_id) IN (0, 3))"
                )
            )
            await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)
