from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, LargeBinary, Text, func, text
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


class EmailChangeRequest(Base):
    """One requested sign-in-address change (CK-9). Mirrors MagicLinkToken's
    conventions: only the SHA-256 hash is stored — the raw token exists solely
    in the link emailed to the NEW address, because controlling that inbox is
    the entire proof. A row exists for every request, including requests for an
    address that was already taken (where no link is ever sent): the rows feed
    the per-person rate limit, which must not diverge between the two cases —
    that divergence would be the enumeration oracle wearing a 429."""

    __tablename__ = "email_change_requests"

    id: Mapped[UUID] = uuid_pk()
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    # The session that made the request. Verification revokes every OTHER
    # session (email is the credential; a change must not leave old sessions
    # alive) — this column is how the device that asked stays signed in.
    requested_session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"), nullable=False)
    new_email: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_ip: Mapped[Optional[str]] = mapped_column(INET, nullable=True)
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


class WebauthnCredential(Base):
    """One enrolled passkey (CK-10). What is stored is the PUBLIC half of the
    credential plus its identifier — never a biometric; those never leave the
    person's authenticator. `nickname` is user-supplied text that will name a
    device: personal data, never logged. Hard-deleted on account deletion — a
    credential outliving the account it authenticates is worse than orphaned
    PII."""

    __tablename__ = "webauthn_credentials"

    id: Mapped[UUID] = uuid_pk()
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    # base64url of the authenticator's credential ID — the lookup key for
    # usernameless sign-in (the assertion carries it; no address ever does).
    credential_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Last verified authenticator counter. Synced platform passkeys (iCloud
    # Keychain, Google Password Manager) legitimately report 0 forever — the
    # 0/0 case is normal, never treated as cloning (kickoff STEP 6).
    sign_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    # Comma-joined transport hints from enrolment ("internal,hybrid") —
    # informational only, never load-bearing for verification.
    transports: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    nickname: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    backup_eligible: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = created_at_col()
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class WebauthnChallenge(Base):
    """One outstanding WebAuthn ceremony challenge (CK-10). Single-use and
    short-lived (5 minutes), exactly like every other token in this codebase —
    consumed on the first completion attempt, successful or not. Stored in the
    clear, unlike token hashes: a challenge is sent to the browser anyway; its
    security is the single use plus the signature binding, not secrecy.
    person_id is NULL for sign-in challenges — usernameless sign-in has no
    known person until the assertion resolves."""

    __tablename__ = "webauthn_challenges"

    id: Mapped[UUID] = uuid_pk()
    person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True, index=True
    )
    challenge: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    # "register" | "authenticate" — a challenge minted for one ceremony must
    # never complete the other.
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
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
