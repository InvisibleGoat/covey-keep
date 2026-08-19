from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("group_id", "person_id"),)

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    # The household through which this membership exists (spine: membership is household-linked).
    household_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("households.id"), nullable=True, index=True
    )
    sub_group_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("sub_groups.id"), nullable=True
    )
    role_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("roles.id"), nullable=True)
    created_at: Mapped[datetime] = created_at_col()
