from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class ConsentRecord(Base):
    """Per-channel, versioned, revocable. Consent is evaluated at publication
    time as a live query against these rows — never stored as a flag — so
    revocation is immediate and retroactive (architecture overview).

    `channel` is open text, not an enum: the three tiers (closed sharing /
    public listing / sold book) and the church four-way model add channel
    values, not columns."""

    __tablename__ = "consent_records"
    __table_args__ = (Index("ix_consent_records_subject_channel", "subject_person_id", "channel"),)

    id: Mapped[UUID] = uuid_pk()
    # The person the consent is about (may be a minor who is not a user).
    subject_person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    # Who recorded it (e.g. a parent/guardian on behalf of the subject).
    granted_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    group_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("groups.id"), nullable=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    # True = consent granted; False = explicit opt-out (Phase 1 ships the opt-out).
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    effective_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
