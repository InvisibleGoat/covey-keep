from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class ItemSlot(Base):
    __tablename__ = "item_slots"

    id: Mapped[UUID] = uuid_pk()
    event_id: Mapped[UUID] = mapped_column(ForeignKey("events.id"), nullable=False, index=True)
    category: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    target_quantity: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = created_at_col()


class ItemClaim(Base):
    """A claim on a slot, or a write-in contribution. Contributions are owned by
    their contributor (roadmap §2)."""

    __tablename__ = "item_claims"
    __table_args__ = (
        CheckConstraint(
            "person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
        CheckConstraint(
            "item_slot_id IS NOT NULL OR write_in_text IS NOT NULL", name="slot_or_write_in"
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    event_id: Mapped[UUID] = mapped_column(ForeignKey("events.id"), nullable=False, index=True)
    item_slot_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("item_slots.id"), nullable=True, index=True
    )
    person_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("people.id"), nullable=True)
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    write_in_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    created_at: Mapped[datetime] = created_at_col()
