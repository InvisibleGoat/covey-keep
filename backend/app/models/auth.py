from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk


class MagicLinkToken(Base):
    """One minted sign-in link. Only the SHA-256 hash is stored — the raw token
    exists solely in the emailed (or console-logged) link."""

    __tablename__ = "magic_link_tokens"

    id: Mapped[UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_ip: Mapped[Optional[str]] = mapped_column(INET, nullable=True)
    # The ToS version the requester affirmatively accepted on the sign-in form.
    # NULL only on pre-CK-6 rows, which recorded no consent — verify refuses to
    # create an account from a NULL-version token.
    tos_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = created_at_col()


class Session(Base):
    """A trusted-device session (~30 days). The JWT carries this row's id as
    `sid`; the row is what makes the JWT revocable — a valid signature alone is
    never sufficient."""

    __tablename__ = "sessions"

    id: Mapped[UUID] = uuid_pk()
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_at_col()


class TosAcceptance(Base):
    """Affirmative ToS acceptance, captured at account creation (roadmap §2).
    The copy doesn't exist yet; the versioned record does."""

    __tablename__ = "tos_acceptances"

    id: Mapped[UUID] = uuid_pk()
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    accepted_ip: Mapped[Optional[str]] = mapped_column(INET, nullable=True)
    created_at: Mapped[datetime] = created_at_col()
