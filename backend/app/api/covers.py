"""Covers (CK-83a) — "Use as cover": an organiser makes one of the published
photographs a gathering's cover, or a group's
(decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 3).
The backend only; CK-84 puts covers on the surface, and CK-83b adds the
second source, a cover uploaded from the device.

SIX ROUTES:

  PUT    /gatherings/{id}/cover       {"media_id"} — the host or a co-host
  PUT    /groups/{id}/cover           {"media_id"} — the admin or a co-admin
  DELETE /gatherings/{id}/cover       the same organisers; 204, set or not
  DELETE /groups/{id}/cover           the same organisers; 204, set or not
  GET    /gatherings/{id}/cover/url   ?layer=web|thumbnail — the gathering's
                                      read audience (the memory tier)
  GET    /groups/{id}/cover/url       ?layer=web|thumbnail — the group's
                                      read audience (a member or the admin)

WHO SETS ONE: THE ORGANISERS, the same people who can rename the subject
(§1.3) — `_gathering_for_organiser` (`may_administer`: the host or a
co-host) and `_group_for_organiser` (`may_administer_group`: the admin or a
co-admin). Setting and clearing a cover are DELEGABLE; nothing about them is
reserved. Everyone else draws the subject's 404 byte-identical to a missing
id, before anything else is asked.

WHAT MAY BE ONE: A PUBLISHED PHOTOGRAPH THE CALLER CAN SEE, OF THE SUBJECT'S
OWN. The refusals, in order, after the subject's 404:
  - the photograph is one the caller may see — `api/media.py::_visible_media`,
    THE one criterion, never a second beside it and never widened — else the
    media 404, byte-identical to `read_url`'s (a photograph the caller cannot
    see is not confirmed to exist by this route either);
  - it belongs to THIS gathering — else 422 `not_in_gathering`; for a group,
    its gathering belongs to THIS group (`owning_group_id`) — else 422
    `not_in_group` (§2's 2026-10-13 row as amended by §1.3: a group's cover
    comes from the group's own photographs);
  - it is `ready` and `live` — else 409 `not_published`, carrying the rung
    and the state (the caller can see the row, so neither discloses
    anything).
Then the three columns are written in one guarded statement — `cover_set_at`
now, `cover_set_by_person_id` the caller — and the answer is 200
`{"cover": …}`, the subject's cover body. SETTING THE PHOTOGRAPH THAT IS
ALREADY THE COVER CHANGES NOTHING (`WHERE cover_media_id IS DISTINCT FROM`):
`cover_set_at` is the cover's version, and a client's cached image stays
valid. A cover change never stamps `updated_at`, which stays PATCH's.

THE LOCK ORDER, AND WHY THE SET PATH TAKES THE PHOTOGRAPH'S LOCK. A cover
clears in the transaction that stops its photograph being published
(services/covers.py::clear_covers_of, called by `remove_media` and
`mark_for_destruction`). Under READ COMMITTED that clearing UPDATE cannot see
a cover another transaction has written and not committed, so a set and a
removal of the same photograph in the same instant could each miss the
other and commit a cover pointing at a removed photograph. So the set path
reads the photograph `FOR SHARE` — in the same SELECT that applies
`_visible_media` — before it writes the subject: the order removal and
destruction already take (the photograph `FOR UPDATE`, then the subject), so
the two never deadlock, and WHICHEVER TAKES THE PHOTOGRAPH'S LOCK FIRST
WINS. A set that wins is cleared by the removal waiting behind it; a
removal that wins makes the set read a removed photograph and refuse —
`not_published` where the caller can still see it (the gathering's bin,
for an organiser), the media 404 where they cannot (an uploader's own bin).

WHO SEES ONE: THE SUBJECT'S READ AUDIENCE, AND THE URL ROUTES DO NOT ASK
`_visible_media`. The cover is the subject's, not the photograph's audience
widened: a gathering's cover reaches its memory tier (`_gathering_for_memory`
— a member who sees the photographs only sees the cover too, and that
audience is exactly who the `live` branch already admits); A GROUP'S COVER
REACHES EVERY MEMBER OF THE GROUP, including a member who cannot see the
gathering it came from (§1.3 — the organiser's judgement, and CK-84's
confirming step says so in one line). That is the one place a photograph is
served to someone `_visible_media` does not admit, and it is served through
these URL routes ALONE: every list, search and photo URL is unchanged. So a
group body never names the photograph (api/groups.py), and the URL answer
carries no media id. A URL route serves a `ready` + `live` photograph and
nothing else: a cover pointing anywhere else is an INTEGRITY FAILURE — the
set path cannot write one and the clearing statement cannot leave one — so
the route raises rather than serving, and the verifier's lines name it.
The cover, the photograph's state and the layer's derivative row are read
in ONE statement, so a removal committing between two reads can never turn
into a false integrity failure: a statement sees the removal (the cover
gone, 409 `no_cover`) or not (the photograph still live).

DATA-HANDLING: `cover_set_by_person_id` is provenance — which person set a
cover, like the publisher — and rides no body. A presigned URL is a bearer
credential and is NEVER LOGGED (record §9, the CK-37 rule); the response
body is the only place one appears. This module has no logger: no URL, no
media id and no person id leaves it except in a response body.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import media as media_api
from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import (
    _cover_body as _gathering_cover,
    _field_422,
    _gathering_for_memory,
    _gathering_for_organiser,
)
from app.api.groups import (
    _cover_body as _group_cover,
    _group_for_organiser,
    _group_for_read,
)
from app.api.media import (
    ARCHIVAL_NOT_SERVED,
    SERVABLE_LAYERS,
    _media_not_found,
    _visible_media,
)
from app.models import (
    Gathering,
    Group,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    PublicationState,
)
from app.services.storage import presign_read

router = APIRouter(prefix="", tags=["covers"])

# The stable codes (the CK-30 marker precedent): the frontend switches on
# these, never on the wording.
NOT_IN_GATHERING = "not_in_gathering"  # 422: the photograph is another gathering's
NOT_IN_GROUP = "not_in_group"  # 422: the photograph's gathering is not this group's
NOT_PUBLISHED = "not_published"  # 409: the photograph is not `ready` + `live`
NO_COVER = "no_cover"  # 409: the subject has no cover to serve


class CoverIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The photograph's id — the handle every reader of the media list holds.
    media_id: UUID


def _cover_refusal(code: str, message: str) -> HTTPException:
    # Field-level, on the one field the body has, carrying the code beside
    # the message (the CK-68 co-host shape), so the frontend renders it from
    # the one mapper and switches on the code.
    return HTTPException(
        422,
        detail=[{"loc": ["body", "media_id"], "msg": message, "type": "value_error", "code": code}],
    )


def _not_published(photo: Media) -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": NOT_PUBLISHED,
            "status": photo.status.value,
            "publication_state": photo.publication_state.value,
            "message": "only a published photo can be used as a cover",
        },
    )


def _published(photo: Media) -> bool:
    return photo.status == MediaStatus.READY and photo.publication_state == PublicationState.LIVE


async def _candidate(
    db: AsyncSession, ctx: AuthContext, media_id: UUID, now: datetime
) -> tuple[Media, Optional[UUID]]:
    """The photograph a set names, with its gathering's group — VISIBLE to the
    caller under `_visible_media` (the one criterion, in the WHERE, so a
    photograph the caller may not see is never fetched and draws the media
    404 byte-identical to a missing id) and LOCKED `FOR SHARE` in the same
    statement: the photograph's lock before the subject's write, the order
    removal and destruction take (the module docstring). `FOR SHARE` and not
    `FOR UPDATE`: the set changes nothing on the photograph, and two sets of
    the same photograph need not wait for each other — only a removal or a
    destruction, which take it `FOR UPDATE`, must."""
    found = (
        await db.execute(
            select(Media, Gathering.owning_group_id)
            .join(Gathering, Gathering.id == Media.gathering_id)
            .where(Media.id == media_id, _visible_media(ctx, now))
            .with_for_update(read=True, of=Media)
        )
    ).first()
    if found is None:
        raise _media_not_found()
    photo, owning_group_id = found
    return photo, owning_group_id


def _cover_values(photo: Media, ctx: AuthContext, now: datetime) -> dict:
    # All three or none (0035's CHECK): the photograph, the cover's version,
    # and who chose it — provenance, never in a body.
    return dict(cover_media_id=photo.id, cover_set_at=now, cover_set_by_person_id=ctx.person.id)


def _cleared() -> dict:
    return dict(cover_media_id=None, cover_set_at=None, cover_set_by_person_id=None)


def _servable(layer: MediaLayer) -> None:
    # The media router's refusal, word for word: the archival layer is the
    # print master and is never served, a cover included.
    if layer not in SERVABLE_LAYERS:
        raise _field_422("layer", ARCHIVAL_NOT_SERVED, where="query")


def _no_cover() -> HTTPException:
    return HTTPException(
        409, detail={"code": NO_COVER, "message": "there's no cover to show yet"}
    )


def _presigned(derivative: MediaDerivative, layer: MediaLayer) -> dict:
    presigned = presign_read(media_api._serve_client(), key=derivative.storage_key)
    # DO NOT LOG `presigned.url` — a bearer credential for one read of one
    # published object (record §9). The response body is the only place it
    # goes, and it names no photograph: a group's cover may come from a
    # gathering its reader is not in.
    return {
        "layer": layer.value,
        "content_type": derivative.content_type,
        "size_bytes": derivative.size_bytes,
        "url": presigned.url,
        "method": presigned.method,
        "expires_in": presigned.expires_in,
    }


def _integrity_failure(subject: str) -> RuntimeError:
    # Raised, never served (the module docstring): the set path cannot write
    # such a pointer and the clearing statement cannot leave one, so this is
    # the verifier's to name. No id in the message — this module puts no
    # media id or person id anywhere but a response body.
    return RuntimeError(
        f"a {subject}'s cover is not a ready, published photograph of its own with a "
        "derivative for the layer — an integrity failure; run scripts/verify_schema.py"
    )


# --- a gathering's cover --------------------------------------------------------------


@router.put("/gatherings/{gathering_id}/cover")
async def set_gathering_cover(
    gathering_id: UUID,
    body: CoverIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """USE AS COVER, for a gathering: the host or a co-host makes one of its
    published photographs its cover. Refusals in order: the gathering 404
    for anyone who does not organise it; the media 404 for a photograph the
    caller cannot see; 422 `not_in_gathering` for another gathering's
    photograph; 409 `not_published` for one that is not `ready` and `live`.
    200 `{"cover": {"source": "photo", "media_id", "set_at"}}`."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    now = datetime.now(timezone.utc)
    photo, _owning_group_id = await _candidate(db, ctx, body.media_id, now)
    if photo.gathering_id != gathering.id:
        raise _cover_refusal(NOT_IN_GATHERING, "that photo belongs to another gathering")
    if not _published(photo):
        raise _not_published(photo)
    # Guarded: the photograph that is already the cover writes nothing, so
    # `cover_set_at` — the cover's version — does not move.
    await db.execute(
        update(Gathering)
        .where(Gathering.id == gathering.id, Gathering.cover_media_id.is_distinct_from(photo.id))
        .values(**_cover_values(photo, ctx, now))
        .execution_options(synchronize_session=False)
    )
    # Read back inside the transaction, while the photograph is still held
    # `FOR SHARE`, so nothing can have cleared it before the body is built.
    await db.refresh(gathering)
    cover = _gathering_cover(gathering)
    await db.commit()
    return {"cover": cover}


@router.delete("/gatherings/{gathering_id}/cover", status_code=204)
async def clear_gathering_cover(
    gathering_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """The organisers clear a gathering's cover — the empty cover shows
    again. 204 whether or not one was set: the state asked for is the state
    that holds. Everyone else draws the gathering 404."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    await db.execute(
        update(Gathering)
        .where(Gathering.id == gathering.id, Gathering.cover_media_id.is_not(None))
        .values(**_cleared())
        .execution_options(synchronize_session=False)
    )
    await db.commit()


@router.get("/gatherings/{gathering_id}/cover/url")
async def gathering_cover_url(
    gathering_id: UUID,
    layer: MediaLayer,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """A presigned GET for one layer of a gathering's cover, for its READ
    AUDIENCE — the memory tier: the host, a co-host, an invitee, or a
    member shared with it. Refusals in order: the gathering 404 for anyone
    else; 422 for `archival`; 409 `no_cover`. No media id in the answer."""
    gathering, _view = await _gathering_for_memory(db, ctx, gathering_id)
    _servable(layer)
    found = (
        await db.execute(
            select(Media, MediaDerivative)
            .select_from(Gathering)
            .join(Media, Media.id == Gathering.cover_media_id)
            .outerjoin(
                MediaDerivative,
                and_(MediaDerivative.media_id == Media.id, MediaDerivative.layer == layer),
            )
            .where(Gathering.id == gathering.id)
        )
    ).first()
    if found is None:
        raise _no_cover()
    photo, derivative = found
    if not _published(photo) or photo.gathering_id != gathering.id or derivative is None:
        raise _integrity_failure("gathering")
    return _presigned(derivative, layer)


# --- a group's cover --------------------------------------------------------------------


@router.put("/groups/{group_id}/cover")
async def set_group_cover(
    group_id: UUID,
    body: CoverIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """USE AS COVER, for a group: the admin or a co-admin makes a published
    photograph from one of the group's own gatherings the group's cover —
    seen by EVERY member, including one who cannot see that gathering (the
    module docstring). Refusals in order: the group 404 for anyone who does
    not organise it; the media 404 for a photograph the caller cannot see;
    422 `not_in_group` for a photograph whose gathering is not this
    group's; 409 `not_published`. 200 `{"cover": {"source": "photo",
    "set_at"}}` — never the photograph's id."""
    group = await _group_for_organiser(db, ctx, group_id)
    now = datetime.now(timezone.utc)
    photo, owning_group_id = await _candidate(db, ctx, body.media_id, now)
    if owning_group_id != group.id:
        raise _cover_refusal(NOT_IN_GROUP, "that photo isn't from one of this group's gatherings")
    if not _published(photo):
        raise _not_published(photo)
    await db.execute(
        update(Group)
        .where(Group.id == group.id, Group.cover_media_id.is_distinct_from(photo.id))
        .values(**_cover_values(photo, ctx, now))
        .execution_options(synchronize_session=False)
    )
    await db.refresh(group)
    cover = _group_cover(group)
    await db.commit()
    return {"cover": cover}


@router.delete("/groups/{group_id}/cover", status_code=204)
async def clear_group_cover(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """The organisers clear a group's cover. 204 whether or not one was set.
    Everyone else draws the group 404."""
    group = await _group_for_organiser(db, ctx, group_id)
    await db.execute(
        update(Group)
        .where(Group.id == group.id, Group.cover_media_id.is_not(None))
        .values(**_cleared())
        .execution_options(synchronize_session=False)
    )
    await db.commit()


@router.get("/groups/{group_id}/cover/url")
async def group_cover_url(
    group_id: UUID,
    layer: MediaLayer,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """A presigned GET for one layer of a group's cover, for EVERY MEMBER —
    the group's read audience, a member or the admin — whether or not they
    can see the gathering the photograph came from (§1.3). Refusals in
    order: the group 404 for anyone else; 422 for `archival`; 409
    `no_cover`. No media id in the answer."""
    group = await _group_for_read(db, ctx, group_id)
    _servable(layer)
    found = (
        await db.execute(
            select(Media, Gathering.owning_group_id, MediaDerivative)
            .select_from(Group)
            .join(Media, Media.id == Group.cover_media_id)
            # The photograph's own gathering, for the integrity check: a
            # group's cover is from one of the group's gatherings.
            .join(Gathering, Gathering.id == Media.gathering_id)
            .outerjoin(
                MediaDerivative,
                and_(MediaDerivative.media_id == Media.id, MediaDerivative.layer == layer),
            )
            .where(Group.id == group.id)
        )
    ).first()
    if found is None:
        raise _no_cover()
    photo, owning_group_id, derivative = found
    if not _published(photo) or owning_group_id != group.id or derivative is None:
        raise _integrity_failure("group")
    return _presigned(derivative, layer)
