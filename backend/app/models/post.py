from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import POST_KIND, PUBLICATION_STATE, PostKind, PublicationState


class Post(Base):
    """Discussion belongs to the GATHERING and continues across occurrences;
    a post may optionally be about one date (occurrence_id) — a label, never
    the owner (CK-12).

    Since CK-102 (migration 0038) a post is an item in a chat — a group's,
    in its `group_media` container, or a gathering's — with a KIND: a
    person's message, or a line the chat writes itself (a join, a setting
    change), which has no body. A message is `live` when written and is
    REMOVED by its writer or by the people who run the place
    (`removed_at`, `removed_by_person_id` — set together, the CHECK); held
    for those people alone until `removed_at + REMOVED_BIN`, then deleted
    by the worker's sweep (services/destruction.py::sweep_expired_messages).
    No message names a date, and the date's FK sets NULL."""

    __tablename__ = "posts"
    __table_args__ = (
        CheckConstraint(
            "author_person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
        CheckConstraint("(kind = 'message') = (body IS NOT NULL)", name="body_iff_message"),
        CheckConstraint(
            "body IS NULL OR char_length(body) BETWEEN 1 AND 4000", name="body_length"
        ),
        CheckConstraint(
            "(publication_state = 'removed') = (removed_at IS NOT NULL) "
            "AND (removed_at IS NULL) = (removed_by_person_id IS NULL)",
            name="removed_iff_removed",
        ),
        # The read, newest first, and paging (the chat's one statement).
        Index("ix_posts_gathering_id_created_at_id", "gathering_id", "created_at", "id"),
        # The rate limit's count: one person's messages in the last minute.
        Index("ix_posts_author_person_id_created_at", "author_person_id", "created_at"),
    )

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(ForeignKey("gatherings.id"), nullable=False)
    occurrence_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("occurrences.id", ondelete="SET NULL"), nullable=True, index=True
    )
    parent_post_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("posts.id"), nullable=True, index=True
    )
    author_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    kind: Mapped[PostKind] = mapped_column(POST_KIND, nullable=False)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Who removed it — the writer, or one of the people who run the place.
    # No delete rule: people rows are never deleted (anonymized instead).
    removed_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
