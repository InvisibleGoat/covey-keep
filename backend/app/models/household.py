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
    """Identity + memberships + attended-gatherings index. Still NO quota
    columns — under the keeper model (CK-12) quota belongs to the person's
    ACCOUNT and is computed at request time over what it keeps, never stored."""

    __tablename__ = "people"
    __table_args__ = (
        CheckConstraint("btrim(display_name) <> ''", name="display_name_not_blank"),
    )

    id: Mapped[UUID] = uuid_pk()
    # The accounts-supertype link (CK-12): the person points AT the account —
    # accounts.id is the one FK target for quota/subscription/keeping.
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, unique=True
    )
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
    # Set once, by account deletion (CK-8). This stamp ALONE marks a row as
    # anonymized — there is deliberately no boolean that could disagree with
    # it. An anonymized row keeps its contributions (provenance) but has no
    # email, a neutral display name, and no auth material; the auth gate
    # rejects it even on a validly signed JWT.
    anonymized_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
