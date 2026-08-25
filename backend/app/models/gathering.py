from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import GATHERING_TYPE, PUBLICATION_STATE, GatheringType, PublicationState


class Gathering(Base):
    """The one keepable object (keeper record §9.2). A gathering is never
    owned by a group: groups are invite lists, and the only gathering↔group
    link is a GatheringInvitation row. A season and a memorial are gathering
    types, not separate objects; nothing in the schema may treat them
    specially — except the memorial exemptions below, which are keyed on the
    TYPE, never a flag. Look Back stays derived (every occurrence already
    past at creation), no column.

    Lifecycle (CK-13): who holds a gathering alive is the KeptGathering
    relation — the single source of truth for both the reference count and
    the quota arithmetic. There is deliberately no is_kept boolean and no
    keeper-count column here: a second representation could drift."""

    __tablename__ = "gatherings"
    __table_args__ = (
        # The memorial abuse gate: a named decedent is what qualifies the type
        # (keeper record §9.4) — without it, everything becomes a memorial.
        # Present (and non-blank) when and only when the type is memorial.
        CheckConstraint(
            "(gathering_type = 'memorial' AND memorial_decedent_name IS NOT NULL"
            " AND btrim(memorial_decedent_name) <> '')"
            " OR (gathering_type <> 'memorial' AND memorial_decedent_name IS NULL)",
            name="memorial_decedent_name",
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # The creating account — immutable and historical, which is why the name
    # is not "owner": ownership is not a concept in the keeper model. The
    # creator is just the first keeper; keeping and admin are separate facts.
    created_by_account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, index=True
    )
    # Transferable admin. NULLABLE IS THE CLAIMABLE STATE — the "needs an
    # admin" condition, mirroring how the nullable admin fields on groups
    # encode "needs an admin". Reverting from keeper to observer relinquishes
    # this (services/keeping.py); the claim flow itself is a later phase.
    admin_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    gathering_type: Mapped[GatheringType] = mapped_column(GATHERING_TYPE, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # Required when and only when gathering_type is memorial (CHECK above).
    memorial_decedent_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Moderation moved here from the group's capability profile (CK-12): a
    # gathering belongs to no group, so the flag lives on the gathering and is
    # defaulted at creation from the inviting context.
    requires_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # Grace is ONE timestamp: stamped when the last keeper leaves, cleared
    # when anyone keeps again. Archive (30d) and delete (90d) are DERIVED from
    # it plus policy constants in code (services/keeping.py) — never stored:
    # two stored dates can disagree with each other and with the refcount.
    # A gathering with at least one keeper always has NULL here, and a
    # memorial has NULL regardless of keeper count (it never enters grace).
    last_keeper_left_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # A maintained fact about THIS gathering (sum of its media bytes), kept
    # current as media is added and removed. This is not a violation of the
    # entitlement-never-stored rule: quota and entitlement stay computed at
    # request time by summing total_bytes across an account's kept gatherings
    # — this column is the input to that computation, not a cached answer to
    # a question about any account.
    total_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class KeptGathering(Base):
    """One account keeping one gathering — THE single source of truth for
    both the quota arithmetic and the reference count (roadmap §2). Quota is
    a sum over these rows computed at request time; a gathering lives while
    at least one of these rows exists. No other representation of "is kept"
    may exist anywhere — no boolean on gatherings, no counter column that
    can drift. Attended is a separate, permanent fact (attendance_records);
    kept is this revocable status — never conflate them (keeper record §2.4)."""

    __tablename__ = "kept_gatherings"
    __table_args__ = (
        UniqueConstraint("account_id", "gathering_id"),
    )

    id: Mapped[UUID] = uuid_pk()
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, index=True
    )
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    kept_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
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
