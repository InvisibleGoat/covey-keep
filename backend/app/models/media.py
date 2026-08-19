from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import MEDIA_STATUS, PUBLICATION_STATE, MediaStatus, PublicationState


class Media(Base):
    """Provenance (uploader, timestamp, event) is NOT NULL by design — the book
    cannot be built without it (roadmap §2)."""

    __tablename__ = "media"
    __table_args__ = (
        CheckConstraint(
            "uploader_person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    event_id: Mapped[UUID] = mapped_column(ForeignKey("events.id"), nullable=False, index=True)
    uploader_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    # Lifecycle tiering columns exist from day one; tiering itself is enabled ~Phase 5.
    storage_class: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'standard'")
    )
    last_accessed: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[MediaStatus] = mapped_column(
        MEDIA_STATUS, nullable=False, server_default=text("'processing'")
    )
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
