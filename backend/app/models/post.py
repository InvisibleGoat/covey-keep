from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import PUBLICATION_STATE, PublicationState


class Post(Base):
    """Discussion belongs to the GATHERING and continues across occurrences;
    a post may optionally be about one date (occurrence_id) — a label, never
    the owner (CK-12)."""

    __tablename__ = "posts"
    __table_args__ = (
        CheckConstraint(
            "author_person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    occurrence_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("occurrences.id"), nullable=True, index=True
    )
    parent_post_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("posts.id"), nullable=True, index=True
    )
    author_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
