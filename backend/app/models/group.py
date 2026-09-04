from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import ForeignKey, Text
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
    created_at: Mapped[datetime] = created_at_col()


class SubGroup(Base):
    __tablename__ = "sub_groups"

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
