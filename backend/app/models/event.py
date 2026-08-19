from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import EVENT_TYPE, PUBLICATION_STATE, EventType, PublicationState


class EventSeries(Base):
    __tablename__ = "event_series"

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class Event(Base):
    """An event is an INSTANCE of a series; series_id is deliberately NOT NULL.

    Look Back is not a type: starts_at earlier than created_at presents
    differently in the UI — same object, date-driven mode (schema doc)."""

    __tablename__ = "events"

    id: Mapped[UUID] = uuid_pk()
    series_id: Mapped[UUID] = mapped_column(
        ForeignKey("event_series.id"), nullable=False, index=True
    )
    event_type: Mapped[EventType] = mapped_column(EVENT_TYPE, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    location: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
