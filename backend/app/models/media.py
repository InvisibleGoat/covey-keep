from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import (
    MEDIA_LAYER,
    MEDIA_STATUS,
    PUBLICATION_STATE,
    MediaLayer,
    MediaStatus,
    PublicationState,
)


class Media(Base):
    """One logical photograph — and, since CK-32, the ingest job that
    produces it (media pipeline record §6.1: the media row IS the job; a
    `media_jobs` table beside `status` would be two places that can disagree
    about whether a photograph exists, the shape CK-13 banned for the
    refcount).

    Provenance (uploader, timestamp, gathering) is NOT NULL by design — the
    book cannot be built without it (roadmap §2). Media hangs off the
    GATHERING because the gathering is the keeping and storage unit (CK-12);
    the optional occurrence_id is a label, never an owner — which is why its
    FK carries ON DELETE SET NULL (0016): removing a date removes the label
    and keeps the photograph. Not a cascade, and not a third confirmable
    refusal beside CK-30's two.

    THIS ROW STORES NO OBJECT. The stored representations of the photograph
    are MediaDerivative rows (one per layer, below); the quarantine original
    that exists between `uploaded` and `ready` is addressed by a key DERIVED
    from this row's id (the intent endpoint and the worker compute the same
    key) and is never written to a column — a stored pointer to an object
    the publish step deletes would be a second representation of "is there
    still an original", beside `status`, waiting to disagree with it. The two
    `upload_*` columns are facts about the UPLOAD, fixed at intent and true
    at every rung: the declared MIME type (the allowlist's input) and the
    declared byte size (the presigned PUT signs it as Content-Length; the
    quota reservation sums it over an account's pending rows — record §6.6).
    Neither is the photograph's stored size or format — those are sums and
    values over the derivative rows, which is why the 0001 names
    `size_bytes`/`content_type` were retired rather than reinterpreted.

    Two gates, two columns, never collapsed (record §5): `status` is the
    machine's answer (the MediaStatus ladder) and `publication_state` is the
    host's. `status` has NO server default — a writer must state the rung:
    a default of `processing` would let an omitted status be reclaimed by
    the worker fifteen minutes later against an object that was never
    uploaded.

    Job bookkeeping (record §6.2) rides here as columns: `attempts` (retry
    count), `available_at` (not claimable before — the backoff ladder),
    `claimed_at` (the reclaim clock), `last_error` (dead-letter reason; names
    the outcome, never the file's contents)."""

    __tablename__ = "media"
    __table_args__ = (
        CheckConstraint(
            "uploader_person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    # A label, never an owner: the photograph survives the removal of its
    # date and loses only the label (0016 — the CK-30 dormant 500, closed
    # for media by the phase that gives it a surface).
    occurrence_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("occurrences.id", ondelete="SET NULL"), nullable=True, index=True
    )
    uploader_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Decided at CK-34 (0017): NULL while the row waits in `pending_upload`,
    # stamped by the confirm step in the same transaction that moves status
    # to `uploaded`, never touched again — claimed_at's shape. The row is
    # born at intent, and that instant is already `created_at`; 0016's
    # now() default stamped intent time under this name, and an `intent_at`
    # rename would have been a second column carrying created_at's value.
    uploaded_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Facts about the upload, fixed at intent (see the class docstring).
    upload_content_type: Mapped[str] = mapped_column(Text, nullable=False)
    upload_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The machine's gate. No server default, deliberately.
    status: Mapped[MediaStatus] = mapped_column(MEDIA_STATUS, nullable=False)
    # Job bookkeeping (record §6.2). attempts counts from zero; available_at
    # is stamped by the confirm step (the claim predicate is
    # `available_at <= now()`, so a confirmed row must carry one — CK-34);
    # claimed_at and last_error are NULL until the worker first touches
    # the row.
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    available_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    claimed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # The host's gate — the ONE publication state the three layers share
    # (media-layers record §8). Revocation and removal act here, on the
    # logical photograph; the layers have no state of their own.
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class MediaDerivative(Base):
    """One stored object: one layer (archival / web / thumbnail) of one
    photograph (CK-32; decisions/2026-09-07-media-derivative-schema-shape.md).
    The layers differ in storage class, in size, and in access pattern
    (`last_accessed` matters to the archival layer's tiering and never to
    the thumbnail's), which is what makes them rows rather than nine
    columns on media — and it is what lets the format change per layer
    (WebP today, AVIF later — media-layers §1/§5) without a migration, since
    `content_type` and `storage_key` record what was actually written.

    THE BINDING (media-layers record §8; consent record §1): this table has
    NO publication_state, NO removed_at, NO status, and no lifecycle column
    of its own — ever. Every piece of state lives on the media row, so "the
    three layers die as a unit" is enforced by there being no per-layer
    state to diverge, rather than remembered by every writer. The FK
    cascades for the same reason: a derivative row cannot outlive its
    photograph (the 0014 companions shape — containment, not a content
    cascade; nothing here cascades from a person). `verify_schema.py`
    asserts the absent columns so a later phase cannot quietly add one.

    Rows are written by the worker in the same transaction that moves the
    media row to `ready` — publish is the last step and is atomic (pipeline
    record §8) — so a derivative row never exists under a row that is not
    ready; the verifier asserts that too."""

    __tablename__ = "media_derivatives"
    __table_args__ = (
        # One row per layer per photograph. Leads with media_id, so it also
        # indexes the FK — no separate index (the 0014 companions pattern).
        UniqueConstraint("media_id", "layer"),
    )

    id: Mapped[UUID] = uuid_pk()
    media_id: Mapped[UUID] = mapped_column(
        ForeignKey("media.id", ondelete="CASCADE"), nullable=False
    )
    layer: Mapped[MediaLayer] = mapped_column(MEDIA_LAYER, nullable=False)
    # The published-bucket object key. One object, one row.
    storage_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # The layer's own MIME type — recorded, not derived from the layer,
    # because the web layer's format is expected to change.
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    # Bytes actually stored. The sum over a photograph's rows is what moves
    # gatherings.total_bytes at publish (record §6.6).
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Open text (database-schema decision 2 — R2 class names may change).
    # No server default: the worker states the class per layer; a default
    # of 'standard' would let an archival row silently land on the wrong
    # class.
    storage_class: Mapped[str] = mapped_column(Text, nullable=False)
    # Tiering input (~Phase 5); per object, which is the reason it moved
    # off the media row.
    last_accessed: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
