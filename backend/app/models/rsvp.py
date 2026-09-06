from datetime import datetime, time
from typing import Optional
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import RSVP_RESPONSE, RSVPResponse


class RSVP(Base):
    __tablename__ = "rsvps"
    __table_args__ = (
        CheckConstraint(
            "person_id IS NOT NULL OR guest_name IS NOT NULL", name="identity_present"
        ),
        # One RSVP per account-holder per occurrence; guests (person_id NULL)
        # are unconstrained.
        Index(
            "uq_rsvps_occurrence_person",
            "occurrence_id",
            "person_id",
            unique=True,
            postgresql_where=text("person_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # You RSVP to a DATE, not to the gathering (CK-12) — and an RSVP cannot
    # outlive its date (0015/CK-30): a removed occurrence takes its RSVPs,
    # whose companions then cascade transitively. Whether the delete is
    # allowed to destroy answers is the endpoint's decision (it refuses once
    # with a count, then obeys); the cascade only keeps the confirmed path
    # from leaving rows that point at nothing.
    occurrence_id: Mapped[UUID] = mapped_column(
        ForeignKey("occurrences.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("people.id"), nullable=True)
    guest_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    guest_email: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    response: Mapped[RSVPResponse] = mapped_column(RSVP_RESPONSE, nullable=False)
    arrival_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    # "I can't make it, but keep me included" (CK-27; the 2026-09-02
    # participation-terminology record §3): the third RSVP answer, stored as a
    # modifier on a "no" — the API refuses it with any other response. It
    # changes INTEREST (active lists, notifications, the people list) and
    # NEVER access: no authorization check anywhere may consult it. Renamed
    # from is_observer (0001–0011), a column named for a word the product
    # retired — its meaning had been an empty notes cell since migration 0001.
    stay_included: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # 0014 (CK-29) — the row has been MUTABLE since CK-27 (the upsert is the
    # normal path; changing your mind is the point) and carried only a
    # created_at, which cost a verification at CK-28: rows that did not match
    # expectation could be read but not accounted for. The people/gatherings
    # precedent (0004/0010): nullable, NULL until the row is first changed,
    # stamped by the upsert's update path — so it never merely mirrors
    # created_at, which would look like an answer and not be one.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class RSVPCompanion(Base):
    """CK-29 — a NAME an attendee declared they are bringing; one row per
    accompanying person, ordered. "Store who, compute how many": the total a
    host reads is derived from these rows at read time, never typed by anyone
    and never stored — a typed count can disagree with the list of names
    beside it, and a computed one cannot (adult_count/child_count, dropped at
    0014, were exactly that disagreement waiting to happen).

    A companion is something an attendee DECLARED, not somebody the system
    knows: no person_id, no invitation, no notification, and no authorization
    decision anywhere may consult these rows — the stay_included discipline.
    Deliberately NOT named after RSVP's no-account identity columns above:
    that word already means a person participating with no account of their
    own — a different axis entirely (participation-terminology record §8) —
    and reusing it would restart the four-meanings failure the record exists
    to end. These are third-party names declared about other people, so they
    are bounded per RSVP (MAX_COMPANIONS in the API), replaced wholesale on
    every write, and deleted with their RSVP (ON DELETE CASCADE)."""

    __tablename__ = "rsvp_companions"
    __table_args__ = (
        # Order is part of the value, and the pair being unique means two
        # racing writes can never interleave into one list. The unique index
        # leads with rsvp_id, so no separate index on the FK is needed.
        UniqueConstraint("rsvp_id", "position"),
    )

    id: Mapped[UUID] = uuid_pk()
    rsvp_id: Mapped[UUID] = mapped_column(
        ForeignKey("rsvps.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
