"""The media router. Upload intents and the confirm step (CK-34) — the
first surface that writes a `media` row, and the one conceptual decision it
makes: MAY THIS UPLOAD BE ACCEPTED, and if so, issue the credential for it.
And, since CK-37, reading a photograph back — which turns on a second,
consent-shaped question: WHO MAY SEE ONE THAT NO HOST HAS APPROVED (see
READING BACK, below the accept/refuse list).

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

READING BACK (CK-37; decisions/2026-09-09-who-may-see-an-unapproved-
photograph.md). Two endpoints: the list for a gathering
(`GET /gatherings/{id}/media`) and a presigned GET for one layer of one
photograph (`GET /media/{id}/url?layer=`). Both apply ONE rule — in SQL,
`_visible_media`, never in the response layer — and it has three cases, of
which only one is the gathering's ordinary read audience:

  live     the read audience (_gathering_for_read: host OR keeper OR
           accepted invitee). Nothing is `live` today; the branch exists
           so the publication phase never has to come back and widen an
           audience it should have found already correct.
  pending  THE UPLOADER AND THE HOST, AND NOBODY ELSE. Every row in the
           database is in this state. The machine finished (`ready`); the
           person did not approve. A keeper is not an approver, and an
           invitation grants visibility of the gathering, never of
           unreviewed media (record §5; the-book-model §10: publication is
           reserved to the host). Letting the read audience see pending
           rows "because the gate isn't built yet" would show unapproved
           photographs of children to an entire gathering — the precise
           failure the consent architecture exists to prevent, arriving as
           an omission rather than a decision.
  removed  the contributor-visible bin (keeper record §2.8): the uploader,
           for REMOVED_BIN after `removed_at`; nobody else, ever.

404-not-403 throughout. A photograph the caller may not see draws the
media 404 byte-identical to a missing id, on every per-object path and
BEFORE any other refusal (the archival refusal, the not-ready refusal),
so neither can confirm a row exists. The list requires the gathering's
read audience first (a stranger draws the gathering 404) and then filters
rows by the rule: a keeper who uploaded nothing sees an empty list, not an
error — the gathering is theirs to read; the photographs are not.

A URL is minted for `web` and `thumbnail` only — `archival` is the print
master on Infrequent Access, billed per retrieval, reached only by the book
pipeline and the export, neither of which exists — and only for a `ready`
row: every other rung appears in the list with its state and no link
(record §2: pending is a real state, not a spinner, and the list is where
it becomes visible). Each URL is one presigned GET through the SERVE
credential (storage.presign_read — the credential CK-33 proved cannot read
quarantine), PRESIGN_TTL long, issued only to a caller the rule has already
admitted, and NEVER LOGGED — this is the first endpoint that mints URLs at
volume, and record §9 bites hardest here; pinned with the root logger at
DEBUG on the success path and every refusal path. Nothing here moves
`publication_state`: publication is the host's, and it is not built.

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
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import _field_422, _gathering_for_read
from app.config import settings
from app.models import (
    Account,
    Gathering,
    GatheringInvitation,
    GatheringType,
    KeptGathering,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    Occurrence,
    Person,
    PublicationState,
)
# The module, not its names: the limits are read at call time, so a test
# can narrow FREE_TIER_BYTES / MEMORIAL_CEILING_BYTES on keeping itself.
from app.services import keeping
from app.services.retention import purge_stale
from app.services.storage import (
    ServeClient,
    UploadClient,
    head_quarantine_object,
    presign_read,
    presign_upload,
    quarantine_key,
    serve_client,
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
# The read side's one 409 (CK-37): the caller may see the row, but it is not
# `ready`, so there is no object to issue a URL for. Carries the rung.
NOT_READY = "not_ready"

# The contributor-visible bin (keeper record §2.8; consent doc, Revocation):
# a removed photograph stays visible to its UPLOADER for this long after
# `removed_at`, and to nobody else at any point; at the end of the window
# the three layers are deleted as a unit. Nothing removes anything yet —
# removal is the publication phase's — so this constant defines the READ
# window now, so the read rule is complete before the write that needs it
# exists. The deletion sweep, when built, reads the same constant.
REMOVED_BIN = timedelta(days=30)

# The layers a read may be issued for (CK-37). The archival layer is the
# print master on Infrequent Access (media-layers record §4): every
# retrieval is billed, and it is reached only by the book pipeline and the
# export, neither of which exists. Never a default; never widened to make a
# gallery "sharper".
SERVABLE_LAYERS = frozenset({MediaLayer.WEB, MediaLayer.THUMBNAIL})

_upload: Optional[UploadClient] = None
_serve: Optional[ServeClient] = None


def _upload_client() -> UploadClient:
    """One UploadClient per process, built on first use — client
    construction loads the S3 service model, which is not per-request
    work. storage.py deliberately caches nothing; this is the endpoint
    phase's decision about how to hold one."""
    global _upload
    if _upload is None:
        _upload = upload_client(settings)
    return _upload


def _serve_client() -> ServeClient:
    """One ServeClient per process, built on first use (the same holding
    rule as the upload client). The serve credential signs reads from the
    published bucket and nothing else — CK-33's verifier proves it is
    refused on quarantine, which is what lets "nothing is ever served from
    quarantine" rest on the credential rather than on this module."""
    global _serve
    if _serve is None:
        _serve = serve_client(settings)
    return _serve


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


# --- reading back (CK-37) ----------------------------------------------------


def _visible_media(ctx: AuthContext, now: datetime):
    """WHO MAY SEE THIS PHOTOGRAPH — the decision record's rule as ONE SQL
    criterion over `Media` joined to its `Gathering` (the join is the
    caller's; `Gathering.host_account_id` is read here). Used by both read
    endpoints, so the list and the per-object read can never disagree, and
    evaluated in the database rather than in the response layer, so a row
    the caller may not see is never even fetched.

    Three cases, and only `live` is the gathering's read audience:
      - `live`    → host, keeper, or accepted invitee (the CK-25 audience,
                    as EXISTS subqueries — list_gatherings' shape).
      - `pending` → the UPLOADER or the HOST, and nobody else. A keeper is
                    not an approver; an invitation is visibility of the
                    gathering, not of unreviewed media.
      - `removed` → the uploader alone, within REMOVED_BIN of `removed_at`.
                    A removed row with no `removed_at` is malformed and is
                    visible to nobody (the strict direction).
    Nothing here consults `status`: a `pending_upload` row is as visible to
    its uploader as a `ready` one — the list shows the rung; the URL
    endpoint refuses to mint for anything but `ready` separately."""
    account_id = ctx.person.account_id
    person_id = ctx.person.id
    is_host = Gathering.host_account_id == account_id
    is_uploader = Media.uploader_person_id == person_id
    keeps = exists(
        select(KeptGathering.id).where(
            KeptGathering.account_id == account_id,
            KeptGathering.gathering_id == Media.gathering_id,
        )
    )
    invited = exists(
        select(GatheringInvitation.id).where(
            GatheringInvitation.person_id == person_id,
            GatheringInvitation.gathering_id == Media.gathering_id,
        )
    )
    return or_(
        and_(Media.publication_state == PublicationState.LIVE, or_(is_host, keeps, invited)),
        and_(Media.publication_state == PublicationState.PENDING, or_(is_uploader, is_host)),
        and_(
            Media.publication_state == PublicationState.REMOVED,
            is_uploader,
            Media.removed_at.is_not(None),
            Media.removed_at > now - REMOVED_BIN,
        ),
    )


def _list_item(row: Media, display_name: Optional[str], ctx: AuthContext) -> dict:
    # The media body plus who uploaded it (a display name, never an email,
    # never a person id — the RSVP roster's rule), whether it is the
    # caller's own, and the bin clock when it is in the bin. `last_error`
    # is deliberately absent: it is operator terms (record §6.5 — copy names
    # the outcome, never the file), and `status: "failed"` is the fact.
    body = _media_body(row)
    body["uploader_display_name"] = display_name if display_name is not None else row.guest_name
    body["is_own"] = row.uploader_person_id == ctx.person.id
    body["removed_at"] = row.removed_at.isoformat() if row.removed_at is not None else None
    return body


@router.get("/gatherings/{gathering_id}/media")
async def list_media(
    gathering_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The photographs of this gathering THE CALLER MAY SEE — filtered by
    `_visible_media` in the query, newest first. The gathering itself must
    be readable (a stranger draws the gathering 404); within it, a caller
    who is neither the host nor an uploader sees exactly the `live` rows,
    which today is none. Every rung appears (`pending_upload` through
    `failed`) with its state; no URL is in this body — one is minted per
    object, per layer, on request."""
    gathering = await _gathering_for_read(db, ctx, gathering_id)
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(Media, Person.display_name)
            .join(Gathering, Gathering.id == Media.gathering_id)
            # Outer: a guest upload (a later phase) has no person row.
            .outerjoin(Person, Person.id == Media.uploader_person_id)
            .where(Media.gathering_id == gathering.id, _visible_media(ctx, now))
            .order_by(Media.created_at.desc(), Media.id)
        )
    ).all()
    return {"media": [_list_item(row, display_name, ctx) for row, display_name in rows]}


@router.get("/media/{media_id}/url")
async def read_url(
    media_id: UUID,
    layer: MediaLayer,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """A presigned GET for ONE layer of ONE photograph, issued only to a
    caller `_visible_media` admits. The order of refusals is the point:
    visibility first (404, byte-identical to a missing id — a photograph's
    existence is not public information), then the layer (422: `archival`
    is never served), then the rung (409 `not_ready`: the caller may see
    the row, and there is no object yet — or ever, for `failed`)."""
    now = datetime.now(timezone.utc)
    row = (
        await db.execute(
            select(Media)
            .join(Gathering, Gathering.id == Media.gathering_id)
            .where(Media.id == media_id, _visible_media(ctx, now))
        )
    ).scalar_one_or_none()
    if row is None:
        raise _media_not_found()
    if layer not in SERVABLE_LAYERS:
        raise _field_422(
            "layer",
            "only the web and thumbnail layers can be viewed — the archival layer "
            "is the print master and isn't served",
            where="query",
        )
    if row.status != MediaStatus.READY:
        raise HTTPException(
            409,
            detail={
                "code": NOT_READY,
                "status": row.status.value,
                "message": "this photo isn't ready to view yet"
                if row.status != MediaStatus.FAILED
                else "this photo couldn't be processed, so there is nothing to view",
            },
        )
    derivative = await db.scalar(
        select(MediaDerivative).where(
            MediaDerivative.media_id == row.id, MediaDerivative.layer == layer
        )
    )
    if derivative is None:
        # The publish transaction writes all three rows with `ready` in one
        # commit and the verifier asserts it; a ready row without its layer
        # is an integrity failure, not a client error.
        raise RuntimeError(f"media {row.id} is ready with no {layer.value} derivative row")
    presigned = presign_read(_serve_client(), key=derivative.storage_key)
    # DO NOT LOG `presigned.url` — a bearer credential for one read of one
    # published object, carrying the serve Access Key ID and a valid
    # signature (record §9). The response body is the only place it goes.
    return {
        "media_id": str(row.id),
        "layer": layer.value,
        "content_type": derivative.content_type,
        "size_bytes": derivative.size_bytes,
        "url": presigned.url,
        "method": presigned.method,
        "expires_in": presigned.expires_in,
    }
