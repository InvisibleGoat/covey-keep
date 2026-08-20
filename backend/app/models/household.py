from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class Household(Base):
    __tablename__ = "households"

    id: Mapped[UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class Person(Base):
    """Identity + memberships + attended-events index. NO quota fields — storage
    belongs to the group (roadmap §2)."""

    __tablename__ = "people"
    __table_args__ = (
        CheckConstraint("btrim(display_name) <> ''", name="display_name_not_blank"),
    )

    id: Mapped[UUID] = uuid_pk()
    household_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("households.id"), nullable=True, index=True
    )
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(Text, nullable=True, unique=True)
    # IANA zone name (e.g. America/Chicago), NEVER a UTC offset — offsets are
    # wrong twice a year and carry no DST rules. Nullable: existing rows have
    # none and no value can be invented server-side.
    timezone: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # First mutable row in the system (CK-7); stamped on every profile patch.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
