from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class AttendanceRecord(Base):
    """Distinct from RSVP: who was actually there. Supports host-created
    write-ins for attendees with no account (display_name, no person)."""

    __tablename__ = "attendance_records"
    __table_args__ = (
        CheckConstraint(
            "person_id IS NOT NULL OR display_name IS NOT NULL", name="identity_present"
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    event_id: Mapped[UUID] = mapped_column(ForeignKey("events.id"), nullable=False, index=True)
    person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True, index=True
    )
    display_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recorded_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
