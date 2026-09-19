from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import GROUP_TYPE, GroupType


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[UUID] = uuid_pk()
    organization_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("organizations.id"), nullable=True, index=True
    )
    group_type: Mapped[GroupType] = mapped_column(GROUP_TYPE, nullable=False)
    capability_profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("capability_profiles.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Renamed from steward_person_id at CK-13, per the CK-11 narrowing of
    # stewardship to admin. Nullable is the "needs an admin" state — the same
    # encoding gatherings.host_account_id uses for the claimable condition.
    # Deliberately NOT renamed at CK-28: a group has an admin, a gathering
    # has a host — different concepts, and the words differing is the point.
    admin_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    backup_admin_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    # The group's KEEPER — an account, where the two admin columns above are
    # people (0022, CK-49a; keeper record v2 §3.1, §7: administering is a
    # relationship with the people, keeping is a relationship with the bill,
    # and the two land on different spines). The first account fact on this
    # table, and it authorizes nothing about membership. NULL is the unkept
    # state (§5). Backfilled once at 0022 from the admin person's account —
    # the creator is still the first keeper; NOTHING WRITES IT UNTIL CK-49b,
    # and nothing reads it until then. Every gathering that belongs to this
    # group (gatherings.owning_group_id — no writer yet) is kept by this
    # account and has no keeper of its own; an ARCHIVED group still keeps
    # its gatherings, and the resolver never reads the archive state (§3.1).
    keeper_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    # Stamped on every successful rename (PATCH /groups/{id}) and by nothing
    # else — the 0004/0010/0014 shape, added WITH the mutability (CK-45,
    # migration 0021). Nullable: a never-renamed group has no meaningful
    # value, and NULL is that fact. Account deletion's admin relinquishment
    # (services/groups.py) is a lifecycle write, not a rename: unstamped.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class SubGroup(Base):
    __tablename__ = "sub_groups"

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
