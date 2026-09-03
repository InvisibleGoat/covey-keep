from datetime import datetime, time
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, SmallInteger, Text, Time, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import RSVP_RESPONSE, RSVPResponse


class RSVP(Base):
    __tablename__ = "rsvps"
    __table_args__ = (
        CheckConstraint(
            "person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
        # One RSVP per account-holder per occurrence; guests (person_id NULL)
        # are unconstrained.
        Index(
            "uq_rsvps_occurrence_person",
            "occurrence_id",
            "person_id",
            unique=True,
            postgresql_where=text("person_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # You RSVP to a DATE, not to the gathering (CK-12).
    occurrence_id: Mapped[UUID] = mapped_column(
        ForeignKey("occurrences.id"), nullable=False, index=True
    )
    person_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("people.id"), nullable=True)
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    guest_email: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    response: Mapped[RSVPResponse] = mapped_column(RSVP_RESPONSE, nullable=False)
    adult_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default=text("1"))
    child_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default=text("0"))
    arrival_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    # "I can't make it, but keep me included" (CK-27; the 2026-09-02
    # participation-terminology record §3): the third RSVP answer, stored as a
    # modifier on a "no" — the API refuses it with any other response. It
    # changes INTEREST (active lists, notifications, the people list) and
    # NEVER access: no authorization check anywhere may consult it. Renamed
    # from is_observer (0001–0011), a column named for a word the product
    # retired — its meaning had been an empty notes cell since migration 0001.
    stay_included: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = created_at_col()
