from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import GROUP_TYPE, GroupType


class RoleLadder(Base):
    __tablename__ = "role_ladders"

    id: Mapped[UUID] = uuid_pk()
    key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("role_ladder_id", "key"),)

    id: Mapped[UUID] = uuid_pk()
    role_ladder_id: Mapped[UUID] = mapped_column(
        ForeignKey("role_ladders.id"), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # 0 = most senior rung of the ladder; permissions compare against this.
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class CapabilityProfile(Base):
    __tablename__ = "capability_profiles"

    id: Mapped[UUID] = uuid_pk()
    group_type: Mapped[GroupType] = mapped_column(GROUP_TYPE, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    requires_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    role_ladder_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("role_ladders.id"), nullable=True
    )
    feature_flags: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = created_at_col()
