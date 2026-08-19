from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class NextStepTrigger(Base):
    """Data-driven suggestion framework: later phases add rows, not screens.
    No trigger rows are seeded here — the framework phase seeds them."""

    __tablename__ = "next_step_triggers"

    id: Mapped[UUID] = uuid_pk()
    key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = created_at_col()


class NextStepDismissal(Base):
    """One row per dismissal; '2 declines = never again' is computed by count."""

    __tablename__ = "next_step_dismissals"
    __table_args__ = (Index("ix_next_step_dismissals_person_trigger", "person_id", "trigger_id"),)

    id: Mapped[UUID] = uuid_pk()
    trigger_id: Mapped[UUID] = mapped_column(ForeignKey("next_step_triggers.id"), nullable=False)
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    dismissed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class NextStepAcceptance(Base):
    """Per-trigger acceptance instrumentation."""

    __tablename__ = "next_step_acceptances"
    __table_args__ = (Index("ix_next_step_acceptances_person_trigger", "person_id", "trigger_id"),)

    id: Mapped[UUID] = uuid_pk()
    trigger_id: Mapped[UUID] = mapped_column(ForeignKey("next_step_triggers.id"), nullable=False)
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
