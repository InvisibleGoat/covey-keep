from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import (
    MEDIA_FAILURE_REASON,
    MEDIA_STATUS,
    MediaFailureReason,
    MediaStatus,
)


class CoverImage(Base):
    """One cover picture uploaded from the device for a gathering or a group
    — and the job that processes it (CK-83b, migration 0036;
    decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3). THE ROW IS
    THE JOB, the media row's pattern (pipeline record §6.1): `status` is the
    rung, and `attempts`, `available_at`, `claimed_at` and `last_error` ride
    beside it exactly as they ride `media`.

    A SIBLING OF `media`, NEVER A KIND OF IT. Every reader of `media` means a
    photograph — the list, the search, both bins, the review queue, the
    quota, `photo_count`, `_visible_media` — and an uploaded cover is not
    one: it is in no photo list, counts against nobody's allowance, and is
    deleted when it is replaced (§1.3). A `kind` column on `media` would make
    every one of those readers remember to exclude it; a table of its own
    makes them right by construction (the CK-77 Gotcha's sibling-relation
    rule, applied to images).

    ITS SUBJECT is a gathering or a group — EXACTLY ONE (the CHECK). The
    subject's `cover_image_id` points back at the row once it is the cover;
    the worker writes that pointer at `ready` (services/cover_ingest.py),
    and only a `ready` row of that same subject may be pointed at
    (verifier-asserted).

    THE LATEST ACT WINS (services/covers.py). An upload intent, a set from a
    photograph and a clear each SUPERSEDE every upload still in flight for
    the subject — a `pending_upload` or `uploaded` row moves straight to
    `destroying`; a `processing` row is only flagged (`superseded_at`) and
    left to the worker, which never deletes an object it may still write —
    and RETIRE the uploaded cover the subject carries when it is replaced:
    that row moves `ready` → `destroying` in the transaction that writes the
    subject. A superseded upload never becomes the cover.

    THIS ROW STORES NO KEY. The quarantine original is `covers/<id>` and the
    two published objects `covers/<id>/web` and `covers/<id>/thumbnail` —
    derived from the id by services/storage.py, never stored (a stored
    pointer would be a second representation of "what exists"), and under a
    prefix of their own, so an uploaded cover's URL names no photograph.

    TWO LAYERS, NOT THREE: a cover is never printed, so no archival layer is
    rendered (processing.render_cover_layers — the photographs' own decode,
    orientation, stripping and derivation, with the web and thumbnail bytes
    equal to a photograph's for the same input). Their facts — content type
    and size — are COLUMNS here rather than a rows table: there are exactly
    two, fixed, and a sibling of `media_derivatives` would carry a layer
    discriminator for a set that never grows. Recorded at `ready`, kept
    while the row is `ready` or `destroying` (the record of what is owed a
    deletion) and cleared at `destroyed` — a tombstone carries no image.

    NOT A PERSON'S. `uploaded_by_person_id` is provenance and rides no body;
    deleting the uploader's account leaves the cover standing (Steven,
    2026-11-01), the person row anonymized and still pointed at, as a
    photograph's uploader is. Nothing here is counted: not `photo_count`,
    not `total_bytes`, not `account_usage`."""

    __tablename__ = "cover_images"
    __table_args__ = (
        # Exactly one subject: a gathering's cover or a group's, never both
        # and never neither.
        CheckConstraint("num_nonnulls(gathering_id, group_id) = 1", name="one_subject"),
        # The two layers' facts are one fact in four columns: all set (from
        # `ready`) or none (before it, and again at `destroyed`).
        CheckConstraint(
            "num_nonnulls(web_content_type, web_size_bytes, thumbnail_content_type,"
            " thumbnail_size_bytes) IN (0, 4)",
            name="layers_all_or_none",
        ),
        # The supersede statement's readers (services/covers.py — `WHERE
        # gathering_id = :id AND status IN …`, under the subject's lock).
        # Partial, because each row names one subject and leaves the other
        # NULL.
        Index(
            "ix_cover_images_gathering_id",
            "gathering_id",
            postgresql_where=text("gathering_id IS NOT NULL"),
        ),
        Index(
            "ix_cover_images_group_id",
            "group_id",
            postgresql_where=text("group_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # The subject — exactly one of the two (the CHECK). No delete rule, the
    # house habit: neither a gathering nor a group is ever deleted.
    gathering_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("gatherings.id"), nullable=True
    )
    group_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("groups.id"), nullable=True)
    # WHO uploaded it — provenance, in no body. Not NULL: the upload route
    # is the only writer and always has a person. A deleted account keeps
    # its anonymized person row, so this stays a pointer to a former member
    # and the cover stays (Steven, 2026-11-01).
    uploaded_by_person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    # Facts about the UPLOAD, fixed at intent and signed into the presigned
    # PUT (the type and Content-Length) — the media row's `upload_*` pair.
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The media ladder's own enum and rungs. No server default: a writer
    # states the rung (the media row's reason — a default of `processing`
    # would be reclaimed against an object that was never uploaded).
    status: Mapped[MediaStatus] = mapped_column(MEDIA_STATUS, nullable=False)
    # Job bookkeeping, as `media` has it. `last_error` means what it means
    # there (CK-57): why this row is not progressing RIGHT NOW, operator-
    # only, never in a body.
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    available_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    claimed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # WHY a `failed` upload failed, for the person — the media failure enum,
    # set iff `failed` (verifier-asserted), written in the same guarded
    # statement as the rung and never derived from `last_error`.
    failure_reason: Mapped[Optional[MediaFailureReason]] = mapped_column(
        MEDIA_FAILURE_REASON, nullable=True
    )
    # WHEN A LATER ACT SUPERSEDED THIS UPLOAD while it was in flight — an
    # upload intent, a set from a photograph or a clear on the same subject
    # (services/covers.py). Stamped on every superseded row: a `pending_upload`
    # or `uploaded` row moves to `destroying` with it in the same statement;
    # a `processing` row keeps its rung with the stamp, and the worker settles
    # it to `destroying` after its writes. So it is only ever on a row that
    # is `processing`, `destroying` or `destroyed` (verifier-asserted), and a
    # row carrying it never becomes the cover. A RETIRED cover — a `ready`
    # row replaced by a later act — is not superseded and carries none.
    superseded_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The two layers' facts, recorded at `ready` (see the class docstring;
    # the CHECK keeps the four together).
    web_content_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    web_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    thumbnail_content_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    thumbnail_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = created_at_col()
