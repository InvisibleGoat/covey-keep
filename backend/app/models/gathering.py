from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import GATHERING_TYPE, PUBLICATION_STATE, GatheringType, PublicationState


class Gathering(Base):
    """The one keepable object (keeper record §9.2). Owned by an ACCOUNT —
    person or organization — never by a group: groups are invite lists, and
    the only gathering↔group link is a GatheringInvitation row. A season and
    a memorial are gathering types, not separate objects; nothing in the
    schema may treat them specially. Look Back stays derived (every
    occurrence already past at creation), no column."""

    __tablename__ = "gatherings"

    id: Mapped[UUID] = uuid_pk()
    # Creator/owner. The kept relation (who else holds it alive) is CK-13.
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, index=True
    )
    gathering_type: Mapped[GatheringType] = mapped_column(GATHERING_TYPE, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # Moderation moved here from the group's capability profile (CK-12): a
    # gathering belongs to no group, so the flag lives on the gathering and is
    # defaulted at creation from the inviting context.
    requires_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class Occurrence(Base):
    """A date of a gathering. A one-off gathering has exactly one occurrence;
    a season has many (capped at one year — app-layer rule, not schema).
    RSVP, attendance, and items hang here — you RSVP to a date. Title and
    description live on the gathering; the occurrence is when and where."""

    __tablename__ = "occurrences"

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    location: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    map_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = created_at_col()


class GatheringInvitation(Base):
    """The many-to-many between a gathering and its audience — a group, a
    sub-group, or an individual person; exactly one per row. This is the ONLY
    link between a gathering and a group (groups own nothing). A two-family
    gathering is two rows."""

    __tablename__ = "gathering_invitations"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(group_id, sub_group_id, person_id) = 1",
            name="exactly_one_target",
        ),
        # One invitation per (gathering, target); NULLs keep the three partial.
        Index(
            "uq_gathering_invitations_gathering_group",
            "gathering_id",
            "group_id",
            unique=True,
            postgresql_where=text("group_id IS NOT NULL"),
        ),
        Index(
            "uq_gathering_invitations_gathering_sub_group",
            "gathering_id",
            "sub_group_id",
            unique=True,
            postgresql_where=text("sub_group_id IS NOT NULL"),
        ),
        Index(
            "uq_gathering_invitations_gathering_person",
            "gathering_id",
            "person_id",
            unique=True,
            postgresql_where=text("person_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    group_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("groups.id"), nullable=True)
    sub_group_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("sub_groups.id"), nullable=True
    )
    person_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("people.id"), nullable=True)
    invited_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
