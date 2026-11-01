"""Covers (CK-83a, CK-83b) — a gathering's or a group's cover, from one of
its published photographs ("Use as cover") or uploaded from the device
(decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 3).
The backend only; CK-84 puts covers on the surface.

NINE ROUTES:

  PUT    /gatherings/{id}/cover          {"media_id"} — the host or a co-host
  PUT    /groups/{id}/cover              {"media_id"} — the admin or a co-admin
  DELETE /gatherings/{id}/cover          the same organisers; 204, set or not
  DELETE /groups/{id}/cover              the same organisers; 204, set or not
  GET    /gatherings/{id}/cover/url      ?layer=web|thumbnail — the gathering's
                                         read audience (the memory tier)
  GET    /groups/{id}/cover/url          ?layer=web|thumbnail — the group's
                                         read audience (a member or the admin)
  POST   /gatherings/{id}/cover/upload   {"content_type", "size_bytes"} — the
                                         gathering's organisers (CK-83b)
  POST   /groups/{id}/cover/upload       the same, the group's organisers
  POST   /cover-images/{id}/confirm      the uploader alone
  GET    /cover-images/{id}              the uploader alone

WHO SETS ONE: THE ORGANISERS, the same people who can rename the subject
(§1.3) — `_gathering_for_organiser` (`may_administer`: the host or a
co-host) and `_group_for_organiser` (`may_administer_group`: the admin or a
co-admin). Setting, uploading and clearing a cover are DELEGABLE; nothing
about them is reserved. Everyone else draws the subject's 404 byte-identical
to a missing id, before anything else is asked.

WHAT MAY BE ONE — A PHOTOGRAPH: A PUBLISHED PHOTOGRAPH THE CALLER CAN SEE,
OF THE SUBJECT'S OWN. The refusals, in order, after the subject's 404:
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
Then the subject is written — `cover_set_at` now, `cover_set_by_person_id`
the caller — and the answer is 200 `{"cover": …}`, the subject's cover body.
SETTING THE PHOTOGRAPH THAT IS ALREADY THE COVER CHANGES NOTHING ON THE
SUBJECT (`WHERE cover_media_id IS DISTINCT FROM`): `cover_set_at` is the
cover's version, and a client's cached image stays valid. A cover change
never stamps `updated_at`, which stays PATCH's.

— OR AN UPLOADED COVER (CK-83b): a picture from the device, the way a new
group or gathering gets a cover before it has photographs. The upload route
takes the photographs' allowlist and 25 MB cap, through the media router's
own validators and words (`_clean_content_type`, `_clean_size_bytes`), and
no filename; it writes a `cover_images` row at `pending_upload` and answers
201 with a presigned PUT into quarantine, under `covers/<id>`, through the
upload credential. The uploader confirms it (`/cover-images/{id}/confirm`,
the HEAD-then-believe of the photo confirm), the worker processes it through
the photographs' own code path and, at `ready`, makes it the subject's cover
(services/cover_ingest.py). AN UPLOADED COVER IS NOT A PHOTOGRAPH: it is in
no media list, search, bin or queue, counts against nobody's allowance, and
is deleted when it is replaced or cleared.

THE LATEST ACT WINS (services/covers.py has the long form). On one subject,
an upload intent, a set from a photograph and a clear each SUPERSEDE every
upload still in flight — the unheld ones (`pending_upload`, `uploaded`) to
`destroying`, a `processing` one flagged for the worker, which never deletes
an object it may still write — and a set or a clear RETIRES the uploaded
cover the subject carries (`ready` → `destroying`) in the transaction that
writes the subject. An upload intent retires nothing: until the upload is
`ready`, the old cover, or none, stands. A superseded upload never becomes
the cover; a confirm on one is refused (409 `superseded`), and an object a
PUT lands after its destruction ran is the quarantine bucket's 24-hour rule's
to take, the backstop that rule exists for.

THE LOCK ORDER IS THE PHOTOGRAPH, THEN THE SUBJECT, THEN COVER IMAGES. A
cover from a photograph clears in the transaction that stops the photograph
being published (services/covers.py::clear_covers_of, called by
`remove_media` and `mark_for_destruction`). Under READ COMMITTED that
clearing UPDATE cannot see a cover another transaction has written and not
committed, so a set and a removal of the same photograph in the same instant
could each miss the other and commit a cover pointing at a removed
photograph. So the set path reads the photograph `FOR SHARE` — in the same
SELECT that applies `_visible_media` — before it locks the subject: the
order removal and destruction already take (the photograph `FOR UPDATE`,
then the subject), so the two never deadlock, and WHICHEVER TAKES THE
PHOTOGRAPH'S LOCK FIRST WINS. A set that wins is cleared by the removal
waiting behind it; a removal that wins makes the set read a removed
photograph and refuse — `not_published` where the caller can still see it
(the gathering's bin, for an organiser), the media 404 where they cannot (an
uploader's own bin). EVERY COVER WRITER THEN TAKES THE SUBJECT'S ROW LOCK
(`lock_subject`, `SELECT … FOR UPDATE`) BEFORE IT TOUCHES `cover_images` —
the set, the clear, the upload intent, and the worker's `ready` — so they
take turns there; NEVER A SUBJECT'S LOCK BEFORE A PHOTOGRAPH'S. The confirm
touches its own `cover_images` row and nothing else.

WHO SEES ONE: THE SUBJECT'S READ AUDIENCE, AND THE URL ROUTES DO NOT ASK
`_visible_media`. The cover is the subject's, not the photograph's audience
widened: a gathering's cover reaches its memory tier (`_gathering_for_memory`
— a member who sees the photographs only sees the cover too, and that
audience is exactly who the `live` branch already admits); A GROUP'S COVER
REACHES EVERY MEMBER OF THE GROUP, including a member who cannot see the
gathering a photograph cover came from (§1.3 — the organiser's judgement,
and CK-84's confirming step says so in one line). That is the one place a
photograph is served to someone `_visible_media` does not admit, and it is
served through these URL routes ALONE: every list, search and photo URL is
unchanged. So a group body never names the photograph (api/groups.py), and
the URL answer carries no media id. AN UPLOADED COVER IS SERVED FROM
`covers/<id>/<layer>` — its own keyspace, so its URL names no photograph —
and no body names its id either, on either subject. A URL route serves a
`ready` + `live` photograph of the subject's own, or a `ready` cover image of
the subject's own, and nothing else: a cover pointing anywhere else is an
INTEGRITY FAILURE — no writer can leave one — so the route raises rather
than serving, and the verifier's lines name it. The cover, its source's
state and the layer's facts are read in ONE statement, so a change
committing between two reads can never turn into a false integrity failure.

DATA-HANDLING: `cover_set_by_person_id` and `uploaded_by_person_id` are
provenance — which person set or uploaded a cover, like the publisher — and
ride no body. A presigned URL is a bearer credential and is NEVER LOGGED
(record §9, the CK-37 rule); the response body is the only place one
appears. This module has no logger: no URL, no media id, no cover image id
and no person id leaves it except in a response body.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import and_, or_, select, update
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
    INTENT_REAP_AFTER,
    NOT_PENDING,
    SERVABLE_LAYERS,
    SIZE_MISMATCH,
    _clean_content_type,
    _clean_size_bytes,
    _media_not_found,
    _visible_media,
)
from app.models import (
    CoverImage,
    Gathering,
    Group,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    PublicationState,
)
from app.services.covers import lock_subject, retire_cover_image, supersede_uploads
from app.services.retention import purge_stale
from app.services.storage import (
    cover_published_key,
    cover_quarantine_key,
    presign_read,
    presign_upload,
)

router = APIRouter(prefix="", tags=["covers"])

# The stable codes (the CK-30 marker precedent): the frontend switches on
# these, never on the wording.
NOT_IN_GATHERING = "not_in_gathering"  # 422: the photograph is another gathering's
NOT_IN_GROUP = "not_in_group"  # 422: the photograph's gathering is not this group's
NOT_PUBLISHED = "not_published"  # 409: the photograph is not `ready` + `live`
NO_COVER = "no_cover"  # 409: the subject has no cover to serve
# The cover confirm's two of its own (CK-83b). `not_pending` and
# `size_mismatch` are the photo confirm's, reused: a code is a stable marker.
SUPERSEDED = "superseded"  # 409: a later act on the subject superseded this upload
NOT_UPLOADED = "not_uploaded"  # 409: the bytes the intent signed for have not arrived


class CoverIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The photograph's id — the handle every reader of the media list holds.
    media_id: UUID


class CoverUploadIn(BaseModel):
    """An uploaded cover's intent (CK-83b): the type and the size, both
    SIGNED into the presigned PUT, through the photographs' own validators —
    the same allowlist, the same 25 MB cap, the same words. No filename: a
    cover is not a photograph and is never listed by one."""

    model_config = ConfigDict(extra="forbid")

    content_type: str
    size_bytes: int

    @field_validator("content_type")
    @classmethod
    def _content_type(cls, value: str) -> str:
        return _clean_content_type(value)

    @field_validator("size_bytes")
    @classmethod
    def _size(cls, value: int) -> int:
        return _clean_size_bytes(value)


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
    statement: the photograph's lock before the subject's, the order removal
    and destruction take (the module docstring). `FOR SHARE` and not
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
    # One source and its two stamps (0036's CHECK): the photograph, the
    # cover's version, and who chose it — provenance, never in a body. The
    # uploaded source is cleared in the same statement.
    return dict(
        cover_media_id=photo.id,
        cover_image_id=None,
        cover_set_at=now,
        cover_set_by_person_id=ctx.person.id,
    )


def _cleared() -> dict:
    return dict(cover_media_id=None, cover_image_id=None, cover_set_at=None, cover_set_by_person_id=None)


async def _make_way(db: AsyncSession, subject, subject_id: UUID) -> None:
    """A SET OR A CLEAR, UNDER THE SUBJECT'S LOCK: take the lock (the caller
    has already taken any photograph's), supersede every upload in flight,
    and retire the uploaded cover the subject carries — the latest act wins
    (services/covers.py). The caller then writes the subject in the same
    transaction."""
    replaced = await lock_subject(db, subject, subject_id)
    await supersede_uploads(db, subject, subject_id)
    if replaced is not None:
        await retire_cover_image(db, replaced)


def _servable(layer: MediaLayer) -> None:
    # The media router's refusal, word for word: the archival layer is the
    # print master and is never served, a cover included (an uploaded cover
    # has none at all).
    if layer not in SERVABLE_LAYERS:
        raise _field_422("layer", ARCHIVAL_NOT_SERVED, where="query")


def _no_cover() -> HTTPException:
    return HTTPException(
        409, detail={"code": NO_COVER, "message": "there's no cover to show yet"}
    )


def _presigned(key: str, layer: MediaLayer, content_type: str, size_bytes: int) -> dict:
    presigned = presign_read(media_api._serve_client(), key=key)
    # DO NOT LOG `presigned.url` — a bearer credential for one read of one
    # published object (record §9). The response body is the only place it
    # goes, and it names no photograph in a field: a group's cover may come
    # from a gathering its reader is not in.
    return {
        "layer": layer.value,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "url": presigned.url,
        "method": presigned.method,
        "expires_in": presigned.expires_in,
    }


def _image_layer(image: CoverImage, layer: MediaLayer) -> tuple[Optional[str], Optional[int]]:
    """The facts the worker recorded for one layer of a `ready` cover image."""
    if layer == MediaLayer.WEB:
        return image.web_content_type, image.web_size_bytes
    return image.thumbnail_content_type, image.thumbnail_size_bytes


def _serve_image(image: CoverImage, of_subject: bool, layer: MediaLayer, subject: str) -> dict:
    """An uploaded cover's URL — from `covers/<id>/<layer>`, its own keyspace —
    for a `ready` cover image of this subject with the layer's facts, and
    nothing else: anything else is an integrity failure, raised, never
    served."""
    content_type, size_bytes = _image_layer(image, layer)
    if image.status != MediaStatus.READY or not of_subject or content_type is None or size_bytes is None:
        raise _integrity_failure(subject)
    return _presigned(cover_published_key(image.id, layer), layer, content_type, size_bytes)


def _integrity_failure(subject: str) -> RuntimeError:
    # Raised, never served (the module docstring): no writer can leave such a
    # pointer, so this is the verifier's to name. No id in the message — this
    # module puts no id anywhere but a response body.
    return RuntimeError(
        f"a {subject}'s cover is not a ready, published photograph of its own with a "
        "derivative for the layer, nor a ready cover image of its own with the layer's "
        "facts — an integrity failure; run scripts/verify_schema.py"
    )


# --- an uploaded cover: the intent, the confirm, the read (CK-83b) ----------------


def _cover_image_not_found() -> HTTPException:
    # One body for "no such row" and "not your upload" — the uploader alone
    # ever received the id (the media 404's posture).
    return HTTPException(404, "No such cover image.")


def _cover_image_body(row: CoverImage) -> dict:
    # The uploader following their own upload to `ready` or `failed`. Never
    # the subject, never the uploader, never a key, never `last_error`.
    return {
        "id": str(row.id),
        "status": row.status.value,
        "failure_reason": row.failure_reason.value if row.failure_reason is not None else None,
    }


async def _upload(
    db: AsyncSession, ctx: AuthContext, subject, subject_id: UUID, body: CoverUploadIn
) -> dict:
    """The upload intent, once the organiser's loader has admitted the caller.
    One transaction, under the subject's lock: the reap, the supersede, the
    row, the presigned PUT — committed after presigning, so a presign failure
    leaves no row behind."""
    now = datetime.now(timezone.utc)
    # The subject's lock FIRST — before the reap too, whose DELETE locks
    # other rows of this table: a writer that waited for a row of ours while
    # we waited for its subject would be a deadlock.
    await lock_subject(db, subject, subject_id)
    # The reap (CK-24's mechanism; the intent reap's shape and its one
    # number, the quarantine bucket's 24-hour ceiling): an intent whose PUT
    # never happened, or that nobody confirmed and nothing superseded, is
    # deleted a day after its creation. `pending_upload` ONLY — the
    # criterion is what keeps the reaper off every cover.
    await purge_stale(
        db,
        CoverImage,
        CoverImage.created_at,
        now,
        grace=INTENT_REAP_AFTER,
        where=[CoverImage.status == MediaStatus.PENDING_UPLOAD],
    )
    # The latest act wins: every upload in flight is superseded. The cover
    # itself — a photograph, an uploaded picture, or none — stands until
    # this upload is `ready`.
    await supersede_uploads(db, subject, subject_id)
    row = CoverImage(
        gathering_id=subject_id if subject is Gathering else None,
        group_id=subject_id if subject is Group else None,
        uploaded_by_person_id=ctx.person.id,
        content_type=body.content_type,
        size_bytes=body.size_bytes,
        # The rung, stated (no default).
        status=MediaStatus.PENDING_UPLOAD,
    )
    db.add(row)
    # Flush for the id: the quarantine key is derived from it.
    await db.flush()
    presigned = presign_upload(
        media_api._upload_client(),
        key=cover_quarantine_key(row.id),
        content_length=row.size_bytes,
        content_type=row.content_type,
    )
    # DO NOT LOG `presigned.url` — a bearer credential for one write into the
    # bucket that holds unprocessed uploads (record §9). The response body is
    # the only place it goes.
    answer = {
        "cover_image": {"id": str(row.id), "status": row.status.value},
        "upload": {
            "url": presigned.url,
            "method": presigned.method,
            "headers": presigned.headers,
            "expires_in": presigned.expires_in,
        },
    }
    await db.commit()
    return answer


@router.post("/gatherings/{gathering_id}/cover/upload", status_code=201)
async def upload_gathering_cover(
    gathering_id: UUID,
    body: CoverUploadIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """UPLOAD A COVER, for a gathering: the host or a co-host. Everyone else
    draws the gathering 404. Supersedes every upload in flight for the
    gathering and answers 201 `{"cover_image": {"id", "status"}, "upload":
    {"url", "method", "headers", "expires_in"}}`."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    return await _upload(db, ctx, Gathering, gathering.id, body)


@router.post("/groups/{group_id}/cover/upload", status_code=201)
async def upload_group_cover(
    group_id: UUID,
    body: CoverUploadIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """UPLOAD A COVER, for a group: the admin or a co-admin. Everyone else
    draws the group 404. The answer is the gathering route's."""
    group = await _group_for_organiser(db, ctx, group_id)
    return await _upload(db, ctx, Group, group.id, body)


async def _own_cover_image(db: AsyncSession, ctx: AuthContext, cover_image_id: UUID) -> CoverImage:
    row = await db.get(CoverImage, cover_image_id)
    if row is None or row.uploaded_by_person_id != ctx.person.id:
        raise _cover_image_not_found()
    return row


def _superseded() -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": SUPERSEDED,
            "message": "a newer cover was chosen after this upload started, so it won't be used",
        },
    )


def _already_confirmed() -> HTTPException:
    return HTTPException(
        409, detail={"code": NOT_PENDING, "message": "this upload has already been confirmed"}
    )


@router.post("/cover-images/{cover_image_id}/confirm")
async def confirm_cover_upload(
    cover_image_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The uploader saying "done" — believed only after a HEAD finds the
    object at exactly the declared size (the photo confirm's discipline);
    then `pending_upload` → `uploaded`, claimable by the worker. THE UPLOADER
    ALONE: anyone else draws the 404 byte-identical to a missing id.
    Refusals: 409 `superseded` for an upload a later act superseded (whatever
    its rung now), 409 `not_pending` for one already confirmed, 409
    `not_uploaded` for an object that has not arrived, 409 `size_mismatch`,
    503 `storage_unavailable`. TOUCHES ITS OWN ROW ONLY: the HEAD holds no
    lock, and the move is one guarded UPDATE — so a supersede committing
    while the HEAD is in flight makes the UPDATE match nothing and the
    answer `superseded`. 200 `{"id", "status", "failure_reason"}`."""
    row = await _own_cover_image(db, ctx, cover_image_id)
    if row.superseded_at is not None:
        raise _superseded()
    if row.status != MediaStatus.PENDING_UPLOAD:
        raise _already_confirmed()
    found = await media_api._head_or_unavailable(cover_quarantine_key(row.id))
    if found is None:
        raise HTTPException(
            409,
            detail={
                "code": NOT_UPLOADED,
                "message": "the upload hasn't arrived — send the picture to the upload URL first",
            },
        )
    size, _content_type = found
    if size != row.size_bytes:
        # R2 refuses a body whose length differs from the signed
        # Content-Length; this is the belt on top of those braces.
        raise HTTPException(
            409,
            detail={
                "code": SIZE_MISMATCH,
                "message": "the uploaded picture isn't the size that was declared — upload it again",
            },
        )
    now = datetime.now(timezone.utc)
    moved = await db.execute(
        update(CoverImage)
        .where(
            CoverImage.id == row.id,
            CoverImage.status == MediaStatus.PENDING_UPLOAD,
            CoverImage.superseded_at.is_(None),
        )
        # Claimable from now (the claim predicate reads `available_at`).
        .values(status=MediaStatus.UPLOADED, available_at=now)
        .execution_options(synchronize_session=False)
    )
    # A new statement, so it sees whatever committed while the HEAD ran.
    await db.refresh(row)
    if moved.rowcount != 1:
        # Lost to a supersede (or to a second confirm) while the HEAD ran:
        # nothing was written by this request, and nothing is left to undo.
        raise _superseded() if row.superseded_at is not None else _already_confirmed()
    body = _cover_image_body(row)
    await db.commit()
    return body


@router.get("/cover-images/{cover_image_id}")
async def read_cover_image(
    cover_image_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The uploader following their own upload to `ready` or `failed`: the
    rung and, for a failure, why — `{"id", "status", "failure_reason"}`.
    Anyone else draws the 404 byte-identical to a missing id."""
    return _cover_image_body(await _own_cover_image(db, ctx, cover_image_id))


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
    Supersedes every upload in flight and retires an uploaded cover the
    gathering carries. 200 `{"cover": {"source": "photo", "media_id",
    "set_at"}}`."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    now = datetime.now(timezone.utc)
    photo, _owning_group_id = await _candidate(db, ctx, body.media_id, now)
    if photo.gathering_id != gathering.id:
        raise _cover_refusal(NOT_IN_GATHERING, "that photo belongs to another gathering")
    if not _published(photo):
        raise _not_published(photo)
    # The photograph is held FOR SHARE; now the subject, then cover images.
    await _make_way(db, Gathering, gathering.id)
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
    again. Supersedes every upload in flight and retires an uploaded cover.
    204 whether or not one was set: the state asked for is the state that
    holds. Everyone else draws the gathering 404."""
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    await _make_way(db, Gathering, gathering.id)
    await db.execute(
        update(Gathering)
        .where(
            Gathering.id == gathering.id,
            or_(Gathering.cover_media_id.is_not(None), Gathering.cover_image_id.is_not(None)),
        )
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
    else; 422 for `archival`; 409 `no_cover`. No id in the answer."""
    gathering, _view = await _gathering_for_memory(db, ctx, gathering_id)
    _servable(layer)
    # ONE statement: the pointer, either source's state, and the layer's
    # facts — so nothing committing between two reads can pass for an
    # integrity failure.
    media_id, image_id, photo, derivative, image = (
        await db.execute(
            select(Gathering.cover_media_id, Gathering.cover_image_id, Media, MediaDerivative, CoverImage)
            .select_from(Gathering)
            .outerjoin(Media, Media.id == Gathering.cover_media_id)
            .outerjoin(
                MediaDerivative,
                and_(MediaDerivative.media_id == Media.id, MediaDerivative.layer == layer),
            )
            .outerjoin(CoverImage, CoverImage.id == Gathering.cover_image_id)
            .where(Gathering.id == gathering.id)
        )
    ).one()
    if media_id is None and image_id is None:
        raise _no_cover()
    if image_id is not None:
        if image is None:
            raise _integrity_failure("gathering")
        return _serve_image(image, image.gathering_id == gathering.id, layer, "gathering")
    if photo is None or not _published(photo) or photo.gathering_id != gathering.id or derivative is None:
        raise _integrity_failure("gathering")
    return _presigned(derivative.storage_key, layer, derivative.content_type, derivative.size_bytes)


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
    group's; 409 `not_published`. Supersedes every upload in flight and
    retires an uploaded cover. 200 `{"cover": {"source": "photo",
    "set_at"}}` — never the photograph's id."""
    group = await _group_for_organiser(db, ctx, group_id)
    now = datetime.now(timezone.utc)
    photo, owning_group_id = await _candidate(db, ctx, body.media_id, now)
    if owning_group_id != group.id:
        raise _cover_refusal(NOT_IN_GROUP, "that photo isn't from one of this group's gatherings")
    if not _published(photo):
        raise _not_published(photo)
    await _make_way(db, Group, group.id)
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
    """The organisers clear a group's cover. Supersedes every upload in
    flight and retires an uploaded cover. 204 whether or not one was set.
    Everyone else draws the group 404."""
    group = await _group_for_organiser(db, ctx, group_id)
    await _make_way(db, Group, group.id)
    await db.execute(
        update(Group)
        .where(Group.id == group.id, or_(Group.cover_media_id.is_not(None), Group.cover_image_id.is_not(None)))
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
    can see the gathering a photograph cover came from (§1.3). Refusals in
    order: the group 404 for anyone else; 422 for `archival`; 409
    `no_cover`. No id in the answer."""
    group = await _group_for_read(db, ctx, group_id)
    _servable(layer)
    media_id, image_id, photo, owning_group_id, derivative, image = (
        await db.execute(
            select(
                Group.cover_media_id,
                Group.cover_image_id,
                Media,
                Gathering.owning_group_id,
                MediaDerivative,
                CoverImage,
            )
            .select_from(Group)
            .outerjoin(Media, Media.id == Group.cover_media_id)
            # The photograph's own gathering, for the integrity check: a
            # group's photograph cover is from one of the group's gatherings.
            .outerjoin(Gathering, Gathering.id == Media.gathering_id)
            .outerjoin(
                MediaDerivative,
                and_(MediaDerivative.media_id == Media.id, MediaDerivative.layer == layer),
            )
            .outerjoin(CoverImage, CoverImage.id == Group.cover_image_id)
            .where(Group.id == group.id)
        )
    ).one()
    if media_id is None and image_id is None:
        raise _no_cover()
    if image_id is not None:
        if image is None:
            raise _integrity_failure("group")
        return _serve_image(image, image.group_id == group.id, layer, "group")
    if photo is None or not _published(photo) or owning_group_id != group.id or derivative is None:
        raise _integrity_failure("group")
    return _presigned(derivative.storage_key, layer, derivative.content_type, derivative.size_bytes)
