from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import (
    POST_KIND,
    POST_REACTION_KIND,
    PUBLICATION_STATE,
    PostKind,
    PostReactionKind,
    PublicationState,
)


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
    # When this message's reactions last changed (CK-104, migration 0039), so a
    # poll sends it again; NULL until they first do. Moved only while the
    # message is live, in the transaction that adds or takes one away.
    reactions_updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class PostReaction(Base):
    """One sign one person left on one message (CK-104, migration 0039; the
    chat record §4, §5): the three are the key, so a person leaves at most one
    of each kind. Written only against a live message (api/chat.py), and
    hidden the moment the message is removed. The post's FK CASCADES — the
    sweep's DELETE of a held message takes its reactions; the person's has no
    delete rule, because deleting an account deletes these rows itself
    (services/chat_reading.py::forget_in_every_chat), by this index.
    Leaving a group keeps them."""

    __tablename__ = "post_reactions"

    post_id: Mapped[UUID] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True
    )
    person_id: Mapped[UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True, index=True
    )
    kind: Mapped[PostReactionKind] = mapped_column(POST_REACTION_KIND, primary_key=True)
    created_at: Mapped[datetime] = created_at_col()


class ChatReadPosition(Base):
    """How far one person has read in one chat (CK-104, migration 0039; the
    chat record §8): the last item they have read, as the read's own order —
    an instant and an id. A PLACE AND NEVER A TIME: no column says when it
    moved, and none may be added. `through_post_id` has no foreign key on
    purpose — a held message is destroyed later and the place it marked stays
    good. `gathering_id` is the gathering's, or a group's container's. Its
    own person's and nobody else's: no answer carries another's. It only
    moves forward, and goes when its person can no longer read the chat
    (services/chat_reading.py)."""

    __tablename__ = "chat_read_positions"

    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), primary_key=True)
    gathering_id: Mapped[UUID] = mapped_column(ForeignKey("gatherings.id"), primary_key=True)
    through_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    through_post_id: Mapped[UUID] = mapped_column(nullable=False)
