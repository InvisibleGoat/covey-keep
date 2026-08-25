from datetime import datetime
from uuid import UUID

from sqlalchemy import ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[UUID] = uuid_pk()
    # The accounts-supertype link (CK-12); same direction as people.account_id.
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, unique=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
