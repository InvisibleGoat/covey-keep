"""Upload intents and the confirm step (CK-34) — the first surface that
writes a `media` row, and the one conceptual decision it makes: MAY THIS
UPLOAD BE ACCEPTED, and if so, issue the credential for it.

The shape (media pipeline record §1, §6.6, §9): the API never sees the
bytes. A caller declares what they intend to upload — a content type, a
byte size, optionally the date it belongs to — and for each accepted item
this router creates the media row at `pending_upload` and returns a
presigned PUT into the quarantine bucket with the declared size SIGNED IN
(storage.presign_upload — R2 itself rejects a body of another length; the
size limit is signed, not trusted). The caller PUTs directly to R2, then
calls confirm, which VERIFIES rather than trusts: it HEADs the key and moves
the row to `uploaded` only if the object exists at the declared size.

Everything here is part of the accept/refuse decision:

- THE AUDIENCE — INTERIM, and recorded as interim. Uploading is an ATTENDEE
  capability (participation-terminology record §5 — deliberately not a
  keeper one: "keeping is where the perks live, never the entry fee"), and
  attendance has no surface (attendance_records is unwritten). So the rule
  cannot be implemented yet, and this router takes _gathering_for_read's
  audience — host OR keeper OR accepted invitee — as the stand-in. It is
  NOT gated on keeping, in either direction (an invitee with no kept row
  may upload; pinned by test). REPLACED BY the phase that gives attendance
  a surface; an interim not written down as interim becomes the rule by
  default, which is why this paragraph and the api-reference both say it.
- THE DECLARED CONTENT TYPE — advisory here, enforced later. A `.mov`
  renamed `.jpg` passes any intent-time allowlist; the worker verifies the
  real type from the bytes (CK-36 — processing.DECODABLE_FORMATS is this
  list's real-bytes counterpart, and the two may never disagree). The allowlist is still worth having: it
  stops the honest mistake at the cheapest point and gives the file picker
  something to mirror (`accept`). Video is refused EXPLICITLY (record
  §6.4) — never accepted-then-failed — and the case that makes this the
  common path rather than the exotic one is a Live Photo: an iPhone share
  sheet hands over a paired HEIC and MOV from one gesture, so the MOV half
  arrives here as a matter of course and must draw a usable 422, not a
  dead-lettered job and a host with no idea why.
- THE SIZE — 25 MB per file, images only. The ~50 megapixel guard record
  §6.6 lists beside it is NOT this router's: at intent time there is a
  declared type and a signed byte count, and pixel dimensions are
  unknowable without the bytes. It is the worker's check (CK-36 —
  processing.MAX_PIXELS, refused from the header before any pixel).
- THE BATCH — at most 50 items per request, refused WHOLE if any item is
  invalid: partial acceptance would need a per-item error shape the
  frontend does not have and would leave the caller reconciling which
  intents exist.
- THE QUOTA — a RESERVATION, not a check (record §6.6): every in-flight
  upload's declared size counts inside services/keeping.py::account_usage,
  THE one quota path (a second one is the failure to avoid, for the reason
  CK-13 banned a second refcount). Gated on the gathering's HOST account —
  the standing keeper — and on nobody else: other keepers are allowed over
  quota rather than an upload being refused (blocking a grandmother's
  upload because a cousin is full turns one person's spending decision
  into everyone else's outage). The host account row is locked for the
  check-and-insert so two concurrent batches cannot both pass against the
  same headroom. A refusal states the limit and what would exceed it, and
  NEVER the host's usage — the caller may not be the host.
- THE MEMORIAL CEILING — 5 GB per memorial gathering (keeper record §9.4).
  Memorials are exempt from the ACCOUNT quota and are NOT exempt from their
  own ceiling; the comparison is against the memorial gathering's OWN bytes
  (keeping.gathering_bytes), never an account's — a different check from
  every other type, and therefore the one that is easy to omit by writing
  the exemption and stopping. This router is the only place it can ever be
  enforced.
- THE REAP — an abandoned intent is normal traffic (record §4) and holds a
  reservation; unreaped it leaks quota forever. purge_stale (CK-24) reaps
  `pending_upload` rows 24 hours after intent — the same number as the
  quarantine bucket's lifecycle ceiling, so the row and the object leave
  on one clock — at the top of this endpoint, its fifth customer, and THE
  FIRST CONTENT TABLE it has touched: the `where` criterion is what keeps
  it off ready, published photographs (retention.py's second invariant).
  The cost, stated: an abandoned batch holds its reservation for a day (up
  to 1.25 GB against a 10 GB free tier). No second state releases it
  earlier — `failed` means the retry ladder is spent and is not borrowed.

Nothing else moves. Confirm flips `pending_upload → uploaded` and stamps
`uploaded_at` (decided at CK-34, migration 0017: NULL until confirm) and
`available_at` (the claim predicate). `publication_state` stays `pending`
on every row this router creates — processing is not publishing, and
neither is uploading (record §5); `gatherings.total_bytes` moves at publish
and is untouched here; no derivative row is written here. Since CK-36 the
worker processes what confirm accepts within a poll (services/ingest.py —
decode, strip, three layers, `ready`, then the original deleted).

Non-enumeration, the gatherings posture: a gathering the caller may not
read draws the 404 byte-identical to a missing id; a media row that is not
the caller's own intent draws the media 404, identical to a missing id —
only the uploader ever received the id, so nobody else has a reason to
hold it.

DATA-HANDLING: the first bytes into the bucket that will hold photographs
of children move through URLs this router mints. A PRESIGNED URL IS A
BEARER CREDENTIAL (record §9, binding): it carries the upload Access Key ID
and a valid signature, and is NEVER LOGGED — not on success, not on the
error paths, which is where it would actually happen. Nothing in this
module logs at all; the response body is the only place a URL appears
(pinned by test), and storage.py's result types redact it from their repr.
The quarantine window opens here: an original with EXIF GPS intact
genuinely lands in R2, bounded by the lifecycle rule CK-33 verified — and,
since CK-36, closed within a poll by the worker that strips it and deletes
the original after the ready commit. Uploads on the dev deploy are Steven's
own test images only (private-alpha scope).
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import _field_422, _gathering_for_read
from app.config import settings
from app.models import (
    Account,
    Gathering,
    GatheringType,
    Media,
    MediaStatus,
    Occurrence,
    PublicationState,
)
# The module, not its names: the limits are read at call time, so a test
# can narrow FREE_TIER_BYTES / MEMORIAL_CEILING_BYTES on keeping itself.
from app.services import keeping
from app.services.retention import purge_stale
from app.services.storage import (
    UploadClient,
    head_quarantine_object,
    presign_upload,
    quarantine_key,
    upload_client,
)

router = APIRouter(prefix="", tags=["media"])

# 25 MB per file (record §6.6). Decimal, the convention keeping.py states
# for every byte figure. The value is signed into the presigned PUT as
# Content-Length, so R2 enforces it on the body; this check is the cheap
# early refusal, never the enforcement.
MAX_UPLOAD_BYTES = 25_000_000

# 50 intents per request (record §6.6).
MAX_INTENTS_PER_REQUEST = 50

# The image allowlist — what the pipeline INTENDS to process. Advisory at
# intent time (a renamed .mov passes it; the worker verifies the bytes); its
# job is to refuse the honest mistake early and to be mirrored by the file
# picker. HEIC/HEIF are here because a phone's library offers them as a
# matter of course (launch shape: phone-first); GIF, TIFF and BMP are not —
# none is a photograph a family takes, and every type admitted is a decoder
# path the worker must carry. Widening it is one line here plus one in
# processing.DECODABLE_FORMATS (the two may never disagree — pinned). Video is REFUSED — `video/quicktime` is the MOV half of
# a Live Photo, and it draws the 422 below rather than a dead-lettered job.
IMAGE_CONTENT_TYPES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
)

# Unconfirmed intents are reaped this long after intent — the quarantine
# bucket's own lifecycle ceiling (record §6.3), so the row and the object
# leave on ONE number. Must clear PRESIGN_TTL by a wide margin (CK-24's
# binding constraint: a reaper that deletes a row mid-upload is worse than
# no reaper); 24 hours against 15 minutes does. Pinned by test.
INTENT_REAP_AFTER = timedelta(hours=24)

# The stable markers on confirm's refusals (the CK-30 `confirmation_required`
# precedent): the frontend switches on these, never on wording.
NOT_PENDING = "not_pending"
OBJECT_MISSING = "object_missing"
SIZE_MISMATCH = "size_mismatch"
STORAGE_UNAVAILABLE = "storage_unavailable"

_upload: Optional[UploadClient] = None


def _upload_client() -> UploadClient:
    """One UploadClient per process, built on first use — client
    construction loads the S3 service model, which is not per-request
    work. storage.py deliberately caches nothing; this is the endpoint
    phase's decision about how to hold one."""
    global _upload
    if _upload is None:
        _upload = upload_client(settings)
    return _upload


async def _head(upload: UploadClient, key: str) -> Optional[tuple[int, str]]:
    """The confirm step's question — did the declared bytes land? — run off
    the event loop (botocore blocks on the network). Tests stub this name."""
    return await asyncio.to_thread(head_quarantine_object, upload, key=key)


def _media_not_found() -> HTTPException:
    # One body for "no such row" and "not your intent" — the uploader alone
    # ever received the id, and a photograph's existence is not public
    # information (the gatherings posture).
    return HTTPException(404, "No such photograph.")


def _item_422(index: int, field: str, message: str) -> HTTPException:
    # An item-level field error, landing on the offending entry — the shape
    # FastAPI's own list validation errors have (loc: body, items, N, field),
    # so the frontend renders it from the one mapper.
    return HTTPException(
        422,
        detail=[{"loc": ["body", "items", index, field], "msg": message, "type": "value_error"}],
    )


def _human_bytes(value: int) -> str:
    # Decimal units, the keeping.py convention; the largest unit that reads
    # as a whole-ish number. Copy, not arithmetic: nothing parses this.
    for unit, size in (("GB", 1_000_000_000), ("MB", 1_000_000), ("KB", 1_000)):
        if value >= size:
            scaled = value / size
            return f"{scaled:.0f} {unit}" if scaled >= 10 else f"{scaled:.1f} {unit}"
    return f"{value} bytes"


def _clean_content_type(value: str) -> str:
    # Exact match on a lowercased, trimmed MIME type; a parameter
    # (`image/jpeg; charset=…`) is not a type and is refused. The value is
    # signed into the PUT as Content-Type, so what is stored is exactly what
    # the browser must send.
    value = value.strip().lower()
    if value not in IMAGE_CONTENT_TYPES:
        raise ValueError(
            "only photos can be uploaded (JPEG, PNG, WebP, or HEIC) — videos, "
            "including the video half of a Live Photo, aren't supported yet"
        )
    return value


class MediaIntentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_type: str
    # Declared, then SIGNED into the presigned PUT — never trusted on its
    # own (record §6.6). Required: an intent without a size cannot be
    # signed and reserves nothing.
    size_bytes: int
    # The optional date label (a label, never an owner — SET NULL at 0016).
    # Validated against the gathering in the endpoint: it needs the row.
    occurrence_id: Optional[UUID] = None

    @field_validator("content_type")
    @classmethod
    def _content_type(cls, value: str) -> str:
        return _clean_content_type(value)

    @field_validator("size_bytes")
    @classmethod
    def _size(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("a photo's size must be a positive number of bytes")
        if value > MAX_UPLOAD_BYTES:
            raise ValueError(
                f"each photo is limited to {_human_bytes(MAX_UPLOAD_BYTES)}"
            )
        return value


class MediaIntentsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # min/max on the list: an empty batch and an over-long one are both
    # field-level 422s at ["body", "items"] from the model itself.
    items: list[MediaIntentIn] = Field(min_length=1, max_length=MAX_INTENTS_PER_REQUEST)


def _media_body(row: Media) -> dict:
    # Never the uploader's email, never a URL. `uploaded_at` is null until
    # confirm (0017).
    return {
        "id": str(row.id),
        "gathering_id": str(row.gathering_id),
        "occurrence_id": str(row.occurrence_id) if row.occurrence_id else None,
        "status": row.status.value,
        "publication_state": row.publication_state.value,
        "upload_content_type": row.upload_content_type,
        "upload_size_bytes": row.upload_size_bytes,
        "uploaded_at": row.uploaded_at.isoformat() if row.uploaded_at is not None else None,
        "created_at": row.created_at.isoformat(),
    }


async def _enforce_limits(
    db: AsyncSession, gathering: Gathering, batch_bytes: int, count: int
) -> None:
    """The quota reservation and the memorial ceiling, against DB state.
    Field-level 422s on the batch (["body", "items"]) — the refusal is about
    the batch as a whole, and it names the limit and what would exceed it,
    never the host's usage (the caller may not be the host)."""
    if gathering.host_account_id is None:
        # The claimable state (keeper record §9.2): no host means no quota
        # to charge, and bytes with no quota subject is the failure the
        # keeper model exists to prevent. Refused; whether a hostless
        # gathering should accept uploads is the claim flow's question.
        raise _field_422(
            "gathering_id",
            "this gathering has no host, so photos can't be added until someone takes it on",
            where="path",
        )
    # Serialise the check-and-insert per host account: two concurrent
    # batches must not both pass against the same headroom. The lock is
    # released by the caller's commit (or rollback on a refusal).
    host = (
        await db.execute(
            select(Account).where(Account.id == gathering.host_account_id).with_for_update()
        )
    ).scalar_one()
    noun = "this photo" if count == 1 else f"these {count} photos"
    if gathering.gathering_type == GatheringType.MEMORIAL:
        # Exempt from the account quota; bounded by its own ceiling — the
        # gathering's own bytes, published plus in flight.
        own = await keeping.gathering_bytes(db, gathering)
        ceiling = keeping.MEMORIAL_CEILING_BYTES
        if own + batch_bytes > ceiling:
            raise _field_422(
                "items",
                f"a memorial holds up to {_human_bytes(ceiling)} of photos, and "
                f"{noun} ({_human_bytes(batch_bytes)}) would go past it",
            )
        return
    usage = await keeping.account_usage(db, host)
    quota = await keeping.account_quota(db, host)
    if usage + batch_bytes > quota:
        raise _field_422(
            "items",
            f"the host's storage is limited to {_human_bytes(quota)}, and {noun} "
            f"({_human_bytes(batch_bytes)}) would go past it",
        )


@router.post("/gatherings/{gathering_id}/media/intents", status_code=201)
async def create_intents(
    gathering_id: UUID,
    body: MediaIntentsIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Decide whether these uploads may be accepted and, if so, issue one
    presigned PUT per item. All or nothing: the rows are created and
    presigned inside one transaction, and any refusal — a foreign date, the
    quota, the ceiling — leaves no row behind."""
    gathering = await _gathering_for_read(db, ctx, gathering_id)
    now = datetime.now(timezone.utc)

    # Reap abandoned intents (CK-24's mechanism, fifth customer — see the
    # module docstring). `pending_upload` ONLY: the criterion is what keeps
    # the reaper off ready photographs. Keyed off created_at, the intent
    # instant; the presigned URL died PRESIGN_TTL after it.
    await purge_stale(
        db,
        Media,
        Media.created_at,
        now,
        grace=INTENT_REAP_AFTER,
        where=[Media.status == MediaStatus.PENDING_UPLOAD],
    )

    # The date label must be this gathering's. One query for the whole
    # batch; an item naming another gathering's date (or no date at all)
    # draws an item-level 422 and the batch is refused whole.
    labelled = [(i, item.occurrence_id) for i, item in enumerate(body.items) if item.occurrence_id]
    if labelled:
        own_dates = set(
            (await db.scalars(select(Occurrence.id).where(Occurrence.gathering_id == gathering.id))).all()
        )
        for index, occurrence_id in labelled:
            if occurrence_id not in own_dates:
                raise _item_422(index, "occurrence_id", "that date isn't part of this gathering")

    batch_bytes = sum(item.size_bytes for item in body.items)
    await _enforce_limits(db, gathering, batch_bytes, len(body.items))

    rows = [
        Media(
            gathering_id=gathering.id,
            occurrence_id=item.occurrence_id,
            uploader_person_id=ctx.person.id,
            upload_content_type=item.content_type,
            upload_size_bytes=item.size_bytes,
            # The rung, stated (0016: no default). uploaded_at stays NULL
            # until confirm (0017).
            status=MediaStatus.PENDING_UPLOAD,
            # The host's gate, untouched by anything in this router.
            publication_state=PublicationState.PENDING,
        )
        for item in body.items
    ]
    db.add_all(rows)
    # Flush for the ids: the quarantine key is derived from them.
    await db.flush()

    upload = _upload_client()
    intents = []
    for row in rows:
        presigned = presign_upload(
            upload,
            key=quarantine_key(row.id),
            content_length=row.upload_size_bytes,
            content_type=row.upload_content_type,
        )
        # DO NOT LOG `presigned.url` — a bearer credential for one write into
        # the bucket that holds unprocessed photographs, carrying the upload
        # Access Key ID and a valid signature (record §9). The response body
        # is the only place it goes.
        intents.append(
            {
                "media": _media_body(row),
                "upload": {
                    "url": presigned.url,
                    "method": presigned.method,
                    "headers": presigned.headers,
                    "expires_in": presigned.expires_in,
                },
            }
        )
    # Commit AFTER presigning: a presign failure (misconfiguration) leaves no
    # row behind, and the batch is atomic either way.
    await db.commit()
    return {"intents": intents}


@router.post("/media/{media_id}/confirm")
async def confirm_upload(
    media_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The client saying "done" is not evidence. HEAD the quarantine key and
    require the object present at exactly the declared size; only then move
    `pending_upload → uploaded`, stamping uploaded_at and available_at. A
    missing object, a size mismatch, or a row not in pending_upload is a
    refusal that changes nothing — a 409 with a stable code (the CK-30
    marker precedent), so a second confirm is refused rather than absorbed.
    Nothing else moves: `uploaded` means claimable by the worker, and
    publication_state stays pending (record §5)."""
    row = await db.get(Media, media_id)
    if row is None or row.uploader_person_id != ctx.person.id:
        raise _media_not_found()
    if row.status != MediaStatus.PENDING_UPLOAD:
        raise HTTPException(
            409,
            detail={
                "code": NOT_PENDING,
                "message": "this upload has already been confirmed",
            },
        )
    key = quarantine_key(row.id)
    try:
        found = await _head(_upload_client(), key)
    except (ClientError, BotoCoreError) as exc:
        # The store answered with something other than present/absent (or
        # did not answer). Nothing about the request is logged here — the
        # exception class alone rides the response, never a URL, a key id,
        # or the message.
        raise HTTPException(
            503,
            detail={
                "code": STORAGE_UNAVAILABLE,
                "message": f"storage did not answer ({exc.__class__.__name__}); try again",
            },
        )
    if found is None:
        raise HTTPException(
            409,
            detail={
                "code": OBJECT_MISSING,
                "message": "the upload hasn't arrived — send the photo to the upload URL first",
            },
        )
    size, _content_type = found
    if size != row.upload_size_bytes:
        # R2 refuses a body whose length differs from the signed
        # Content-Length, so this is the belt on top of those braces: a row
        # is never marked uploaded against an object of another size.
        raise HTTPException(
            409,
            detail={
                "code": SIZE_MISMATCH,
                "message": "the uploaded photo isn't the size that was declared — upload it again",
            },
        )
    now = datetime.now(timezone.utc)
    row.status = MediaStatus.UPLOADED
    row.uploaded_at = now
    # Claimable from now (record §6.2: the claim predicate is
    # `available_at <= now()`); the worker moves it along the backoff
    # ladder on a transient failure.
    row.available_at = now
    await db.commit()
    return _media_body(row)
