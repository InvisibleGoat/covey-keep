from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import ACCOUNT_KIND, AccountKind


class Account(Base):
    """The supertype every person and organization points at (keeper record
    §9.1). accounts.id is the single FK target that quota, subscription,
    keeping, and entitlement reference — people/organizations carry the
    account_id, never the reverse: a nullable person/org pair here could not
    be foreign-keyed to, would force every quota query to branch, and would
    turn a third account kind into a column plus a CHECK revision instead of
    a row. Quota itself is never stored — it is computed at request time over
    what the account keeps (the kept relation is CK-13)."""

    __tablename__ = "accounts"

    id: Mapped[UUID] = uuid_pk()
    kind: Mapped[AccountKind] = mapped_column(ACCOUNT_KIND, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
