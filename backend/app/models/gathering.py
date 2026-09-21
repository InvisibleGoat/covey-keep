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
    Integer,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import (
    GATHERING_TYPE,
    INVITATION_CHANNEL,
    PUBLICATION_STATE,
    RSVP_LIST_VISIBILITY,
    GatheringType,
    InvitationChannel,
    PublicationState,
    RSVPListVisibility,
)


class Gathering(Base):
    """The one keepable object (keeper record §9.2). A gathering is never
    owned by a group: groups are invite lists, and the only gathering↔group
    link is a GatheringInvitation row. A season and a memorial are gathering
    types, not separate objects; nothing in the schema may treat them
    specially — except the memorial exemptions below, which are keyed on the
    TYPE, never a flag. Look Back stays derived (every occurrence already
    past at creation), no column.

    Lifecycle (CK-13; the keeper a column since CK-49b, and the ONLY
    representation since CK-49c): who keeps a gathering is
    `keeper_account_id` below — its own — or its owning group's, resolved
    through services/keeping.py::resolve_keeper; never both (the CHECK).
    There is deliberately no is_kept boolean and no second copy anywhere:
    a second representation could drift. The kept relation that was the
    truth from 0009 to CK-49b (one row per account keeping one gathering)
    is gone — migration 0023 re-ran 0022's backfill under the release
    guard and dropped the table — so the keeper lives on this row and
    nowhere else."""

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
        # The keeper shape (0022, CK-49a; keeper record v2 §3.1): a gathering
        # that belongs to a group finds its keeper THROUGH the group and never
        # stores it beside itself — at most one of the two is set. Both NULL
        # is legal and is the Unkept rung (§5). The gathering_invitations
        # exactly-one-target idiom applied as at-most-one; the two-
        # representations defect (database-schema decision 20's class) made
        # structural rather than remembered. Since CK-49b the resolver reads
        # both columns and every consumer asks it; since CK-49c (0023) the
        # old kept relation is gone and there is no other copy to disagree.
        CheckConstraint(
            "owning_group_id IS NULL OR keeper_account_id IS NULL",
            name="group_gathering_has_no_keeper",
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    # The creating account — immutable and historical, which is why the name
    # is not "owner": ownership is not a concept in the keeper model. The
    # creator is just the first keeper; keeping and hosting are separate facts.
    created_by_account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False, index=True
    )
    # Transferable host (the admin column, renamed at CK-28: the product
    # says host, and the moment co-hosts exist an unqualified "admin" means
    # two things — a GROUP has an admin, a gathering has a host, and the
    # words differing is the point). NULLABLE IS THE CLAIMABLE STATE — the
    # "needs a host" condition, mirroring how the nullable admin fields on
    # groups encode "needs an admin". Reverting from keeper to observer
    # relinquishes this (services/keeping.py); the claim flow is a later phase.
    host_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    # The belongs-to link (decisions/2026-09-02-groups-as-homes.md §3) as a
    # COLUMN WITH NO WRITER (0022, CK-49a). It exists so the CHECK in
    # __table_args__ is honest and the keeper resolver's group rung is real:
    # since CK-49b the resolver READS it (services/keeping.py —
    # resolved_keeper_of, keeps_gathering) to find the group whose keeper
    # answers; the write path, the home-group default and publication rungs
    # 2 and 3 are Arc B's and none of it is built. Every row is NULL and
    # stays NULL until then — the 0019 precedent (requires_approval sat
    # nullable with no writer until CK-44). The class docstring's "the only
    # gathering↔group link is a GatheringInvitation row" is still true of
    # every row in the database, and stops being true the day Arc B writes
    # here; that phase amends the docstring, not this one.
    owning_group_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("groups.id"), nullable=True
    )
    # A standalone gathering's own keeper — an account (0022, CK-49a; keeper
    # record v2 §3.1). NULL when the gathering belongs to a group (the group's
    # keeper answers, through services/keeping.py::resolve_keeper) and NULL
    # when nobody keeps it (§5's Unkept rung). Backfilled once at 0022 from
    # the old kept relation, and once more at 0023 under the release guard
    # (a stamped gathering is Unkept on purpose and got no keeper back)
    # before that relation was dropped; since CK-49b written by keep() at
    # creation, NULLed by unkeep() and the deletion lapse, and read by every
    # consumer THROUGH THE RESOLVER (resolved_keeper_of for a loaded row,
    # keeps_gathering's SQL form in the audience criteria) — never directly.
    # THE ONLY REPRESENTATION since 0023: no relation, no boolean, no count.
    # Indexed since 0024 (CK-51a; `ix_gatherings_keeper_account_id`) -
    # owed since 0023 and re-homed twice; the reader is account_usage's
    # WHERE over every gathering, not the audience criteria (those look
    # the row up by primary key).
    keeper_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True, index=True
    )
    gathering_type: Mapped[GatheringType] = mapped_column(GATHERING_TYPE, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # Required when and only when gathering_type is memorial (CHECK above).
    memorial_decedent_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Does publication wait for the host? The host's OWN answer — rung 1 of
    # the publication ladder (services/publication.py; CK-41, migration
    # 0019). NULLABLE, AND NULL MEANS INHERIT: nobody has decided, and the
    # ladder's lower rungs (the home group's default, the type's template,
    # the join shape) answer at publish time — never frozen at create. No
    # server default, deliberately: a default that fired on insert would
    # decide on the host's behalf, which is exactly what decision 22 kept
    # the server from doing; creation writes nothing here (the inversion of
    # decision 22's set-it-explicitly discipline — database-schema decision
    # 33), and CK-44's override surface is the only writer. Moderation
    # lives on the gathering, not the group's capability profile (CK-12);
    # the profile is rung 3's data, reachable only through a home group.
    requires_approval: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    # Who may read the occurrence RSVP lists (CK-27) — the host's setting, a
    # value on the gathering exactly like requires_approval. Set explicitly in
    # application code on every create; the server default exists so 0012
    # could backfill pre-existing rows, and is never relied on.
    rsvp_list_visibility: Mapped[RSVPListVisibility] = mapped_column(
        RSVP_LIST_VISIBILITY, nullable=False, server_default=text("'INVITEES'")
    )
    # Grace is ONE timestamp: stamped when the keeper leaves (under one
    # keeper, CK-49b, the same event the relation called "the last keeper
    # leaving" — the meaning did not move), cleared when anyone keeps again.
    # Archive (30d) and delete (90d) are DERIVED from it plus policy
    # constants in code (services/keeping.py) — never stored: two stored
    # dates can disagree with each other and with the keeper. A gathering
    # with a keeper always has NULL here, and a memorial has NULL regardless
    # (it never enters grace). Stays on the GATHERING under v2 (record §12
    # item 9's gathering half, decided at CK-49b); where a GROUP's stamp
    # lives is Arc B's, with the first gathering that resolves through one.
    last_keeper_left_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # A maintained fact about THIS gathering (sum of its media bytes), kept
    # current as media is added. NOT A QUOTA INPUT since CK-51b: the quota
    # counts photographs (photo_count, below), and this column is cost
    # reporting and the currency record §5's monitor (services/ingest.py
    # logs it beside the charged unit at the one UPDATE that moves both).
    # Still maintained in that statement so the two never diverge, and
    # never decremented — see photo_count.
    total_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    # THE QUOTA'S UNIT - since CK-51b (added at 0024, CK-51a; decisions/
    # 2026-09-20-photographs-are-the-currency.md §3, §6): a photograph is
    # 1, whatever the file weighed, and this is the count of this
    # gathering's `ready` photographs - the same rung, the same rows, as
    # total_bytes above, incremented in the SAME UPDATE statement
    # (services/ingest.py, step 4) so the two cannot diverge. Read by
    # services/keeping.py::account_usage (the account's sum, plus the
    # in-flight rows) and gathering_units (a memorial's own ceiling).
    # CHARGED, NEVER VISIBLE (the bin record §4): it counts `ready` rows
    # whatever their publication state, so a photograph in the 30-day bin
    # still counts - it is still stored - and a surface must never show it
    # as "your photos" (charged = visible + in the bin; only this one is a
    # column). NEITHER COLUMN IS DECREMENTED ON REMOVAL: a removed
    # photograph holds its layers for the bin and the sweep that frees them
    # does not exist - when it is built it owes both columns, together, in
    # the one statement that deletes the layers, or they diverge. Same
    # reasoning as total_bytes under the never-stored rule: a maintained
    # fact about THIS gathering, an input to the account-level sum computed
    # at request time, never a cached answer about any account. Backfilled
    # once at 0024 from the existing ready rows; the server default is
    # right here (every gathering starts at zero and the writer only ever
    # adds). It was read by nothing for one full deploy (CK-51a) on
    # purpose - the deploy-window reason is in 0024's docstring.
    photo_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    publication_state: Mapped[PublicationState] = mapped_column(
        PUBLICATION_STATE, nullable=False
    )
    removed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 0010 (CK-16) — stamped on every successful PATCH, the people.updated_at
    # precedent: the column arrives with the phase that makes the row mutable.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
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


class GatheringInvitationPending(Base):
    """An invitation to a DESTINATION rather than to a person (CK-25): an
    email address today, a phone number when SMS ships. Held here until
    someone who controls that destination signs in and accepts — the
    GatheringInvitation row is created ONLY at acceptance, when a real person
    exists. The rejected alternative — pre-creating a people row at invite
    time — would leave permanent person rows holding an address a THIRD PARTY
    supplied, for invitees who never accept: the exact defect class CK-24
    purged from email_change_requests.

    So the row is ephemeral, on the magic_link_tokens conventions: only the
    token's SHA-256 hash is stored, the row expires (INVITATION_TTL), and
    services/retention.py::purge_stale reaps it — its fourth customer.

    Channel-agnostic from the first row, deliberately (launch-shape decision
    2026-08-31): `channel` + `destination`, never an `email` column, so
    enabling SMS is a validator-and-delivery change, never a migration
    against live invitation rows. `destination` is stored normalized
    (lowercased/trimmed for EMAIL; E.164 when SMS ships).

    `revoked_at` covers both an admin's withdrawal and supersession by a
    fresh invite to the same destination. A revoked row is STAMPED, never
    deleted: the rate limit tallies rows by created_at (the CK-24 lesson —
    deleting rows the caller can trigger deletion of silently disables the
    limit), so revocation stamps revoked_at, forces expires_at to now, and
    leaves removal to the reaper an hour later. The CHECK pins the state
    machine: a row is consumed or revoked, never both."""

    __tablename__ = "gathering_invitations_pending"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(consumed_at, revoked_at) <= 1",
            name="consumed_or_revoked",
        ),
        # At most one LIVE invitation per (gathering, channel, destination) —
        # a fresh invite supersedes (revokes) the old one rather than piling
        # a second live token onto the same inbox.
        Index(
            "uq_gathering_invitations_pending_live_destination",
            "gathering_id",
            "channel",
            "destination",
            unique=True,
            postgresql_where=text("consumed_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), nullable=False, index=True
    )
    channel: Mapped[InvitationChannel] = mapped_column(INVITATION_CHANNEL, nullable=False)
    destination: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 only — the raw token exists solely in the sent (or console-
    # logged) invitation link.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Provenance — carried onto the GatheringInvitation row at acceptance.
    invited_by_person_id: Mapped[UUID] = mapped_column(
        ForeignKey("people.id"), nullable=False
    )
    created_at: Mapped[datetime] = created_at_col()
