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
    MEMBER_PLACE,
    PUBLICATION_STATE,
    RSVP_LIST_VISIBILITY,
    GatheringType,
    InvitationChannel,
    MemberPlace,
    PublicationState,
    RSVPListVisibility,
)


class Gathering(Base):
    """The one keepable object (keeper record §9.2). A gathering may BELONG
    TO one group (`owning_group_id` below — written since CK-76, the
    belongs-to link of decisions/2026-09-02-groups-as-homes.md §3): created
    inside the group by any of its members, kept by the group's keeper,
    every other member invited by a real GatheringInvitation row at create,
    and never moved to another group or given one later. A group may ALSO
    be merely invited to a gathering (a group-targeted GatheringInvitation
    row) — the two links are different facts. A season and a memorial are
    gathering types, not separate objects; nothing in the schema may treat
    them specially — except the memorial exemptions below, which are keyed
    on the TYPE, never a flag. Look Back stays derived (every occurrence
    already past at creation), no column.

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
        # Whether the host chose who is invited is a fact about a GROUP
        # gathering only (0034, CK-77): a standalone gathering has no group
        # to choose from, so `invitees_chosen` is false wherever
        # `owning_group_id` is NULL. The CHECK makes the create path's rule
        # structural rather than remembered.
        CheckConstraint(
            "owning_group_id IS NOT NULL OR NOT invitees_chosen",
            name="invitees_chosen_needs_group",
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
    # A CO-HOST IS A ROW BESIDE THIS COLUMN (GatheringCoHost, 0027, CK-68),
    # never a second value in it: the host stays singular and stays the
    # consent controller (co-hosts §1–§2), and this column's five singular
    # dependants (§2) are untouched by co-hosting.
    host_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    # The belongs-to link (decisions/2026-09-02-groups-as-homes.md §3).
    # Arrived at 0022 (CK-49a) as a COLUMN WITH NO WRITER, so the CHECK in
    # __table_args__ was honest and the keeper resolver's group rung real;
    # since CK-49b the resolver READS it (services/keeping.py —
    # resolved_keeper_of; `keeps_gathering` too, which no audience criterion
    # names since CK-77) to find the group whose keeper
    # answers; WRITTEN SINCE CK-76 by `POST /gatherings` with a `group_id`
    # (api/gatherings.py — the caller a member of a HOUSEHOLD group; the
    # gathering's own keeper column NULL, the CHECK insisting; one
    # person-targeted invitation row per other live member in the same
    # transaction), and by nothing else: a gathering never moves between
    # groups and never gains a group after creation (the archive record
    # §9 — a consent reason: moving it would change the default it
    # inherits at the publication ladder's rung 2). Publication rung 3
    # (the type's template) is reached through this column since CK-76;
    # rung 2 (the group's own default) is still not built — no `groups`
    # column — and arrives with the TEAM / CONGREGATION types. Indexed
    # since 0033 (`ix_gatherings_owning_group_id`): its readers look rows
    # up BY the column — the group's gathering list and the newcomer rows.
    owning_group_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("groups.id"), nullable=True, index=True
    )
    # A standalone gathering's own keeper — an account (0022, CK-49a; keeper
    # record v2 §3.1). NULL when the gathering belongs to a group (the group's
    # keeper answers, through services/keeping.py::resolve_keeper) and NULL
    # when nobody keeps it (§5's Unkept rung). Backfilled once at 0022 from
    # the old kept relation, and once more at 0023 under the release guard
    # (a stamped gathering is Unkept on purpose and got no keeper back)
    # before that relation was dropped; since CK-49b written by keep() at
    # creation, NULLed by unkeep() and the deletion lapse, and read by every
    # consumer THROUGH THE RESOLVER (resolved_keeper_of for a loaded row;
    # keeps_gathering's SQL form sat in the audience criteria from CK-49b to
    # CK-77) — never directly. SINCE CK-77 THE KEEPER IS NOT AN AUDIENCE:
    # keeping lets no one in (keeping-explained §5.11) — the quota path
    # (api/media.py::_enforce_limits, services/keeping.py::account_usage)
    # and the deletion lapse read this column through the resolver, and no
    # read path does. THE ONLY REPRESENTATION since 0023: no relation, no
    # boolean, no count.
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
    # DID THE HOST CHOOSE WHO IS INVITED? (0034, CK-77; the 2026-10-04 record
    # §4, §9.) False: the whole group is invited — every live member holds a
    # `gathering_invitations` row (CK-76), and a newcomer to the group is
    # given one for this gathering while it is upcoming. True: the host (or a
    # co-host) chose — some members hold a `gathering_member_places` row
    # instead — and a newcomer is given a `shared_with` place row, exactly
    # the place every other uninvited member has. ONCE CHOSEN, CHOSEN: any
    # change that puts a member somewhere other than invited sets this true
    # (at create, or `PUT /gatherings/{id}/places/{membership_id}`), and
    # nothing sets it back. The server default is RIGHT here, unlike
    # `requires_approval`'s (decision 33): every writer that does not know
    # about choosing — the instance serving during 0034's pre-deploy window
    # included — means "the whole group", which is what false says; the
    # create path sets it explicitly anyway (the CK-16 discipline). Always
    # false on a standalone gathering (the CHECK above).
    invitees_chosen: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
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
    # whatever their publication state, so a photograph in the bin still
    # counts - it is still stored, whatever its age (the bin is
    # removed-and-still-stored; the 30 days are the contributor's retrieval
    # window, a different clock - bin record §6.1) - and a surface must
    # never show it as "your photos" (charged = visible + in the bin; only
    # this one is a column). NEITHER COLUMN IS DECREMENTED ON REMOVAL: a
    # removed photograph holds its layers, and removal frees nothing.
    # DESTRUCTION DOES, since CK-54: api/media.py's marking statement drops
    # both columns TOGETHER, in one statement, as this one raises them -
    # and a later writer that decrements only one would diverge them. The
    # 30-day SWEEP that destroys on a clock is Phase B and owes the same
    # one statement. Same
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
    sub-group, or an individual person; exactly one per row. The INVITED
    link between a gathering and a group (a group used as an invite list);
    since CK-76 a gathering may also BELONG TO a group through
    `Gathering.owning_group_id`, a different fact — and a group gathering's
    members are invited by PERSON-targeted rows here, materialized at
    create and at join, never computed from membership at read time (the
    archive record §6.1: removing someone from the group must never
    silently revoke their gatherings). A row written for a newcomer by the
    group's rule carries a NULL `invited_by_person_id` — the rule invited
    them, not a person (the publisher's NULL-means-the-rule shape, CK-43).
    A two-family gathering is two rows."""

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


class GatheringCoHost(Base):
    """A co-host of a gathering (CK-68; decisions/2026-09-03-co-hosts.md §1,
    §4; amended by two-bins §4) — ONE ROW PER (gathering, account), an
    additive relation BESIDE `gatherings.host_account_id` and never a
    replacement for it: the host stays singular and stays the consent
    controller, and a co-host gets the DELEGABLE set (edit the gathering
    and its occurrences, invite and revoke, the full RSVP list, take a
    published photograph down, read the gathering's bin and restore from
    it — through the gate) and none of the RESERVED one (anything about an
    unapproved photograph, destroying someone else's, adding or removing
    co-hosts). One flag, and a reserved list — never a permission matrix:
    there is deliberately no capability column on this row, and adding one
    would be the switch §4 refuses.

    Keyed on the ACCOUNT, as `host_account_id` is, so `is_host` and
    `may_administer` (api/gatherings.py) compare the same spine; the
    composite primary key IS the uniqueness (an account co-hosts a gathering
    once), and the index on `account_id` answers "what does this account
    co-host" — the deletion leg's reader. `added_by_account_id` is
    provenance — who made them a co-host — with no delete rule, the
    `published_by_person_id` shape: account deletion is anonymization, the
    accounts row is retained, and nothing cascades from it. No delete rule
    from `accounts` on `account_id` either: services/keeping.py's deletion
    leg DELETES an anonymized account's co-host rows explicitly, in the
    transaction that relinquishes host — a row here IS the role, and there
    is no "needs a co-host" state to leave behind. A co-host row on a
    HOSTLESS gathering persists and still grants the delegable set
    (co-hosts §7's first item, answered provisionally at CK-68). Not built:
    a co-host removing another co-host (§7's second item, open — the answer
    built is no), and the managed-profile exclusion (no account kind for a
    managed profile exists in code, so there is nothing yet to exclude). A
    GROUP's co-hosts are its CO-ADMINS — built at CK-75 as a relation of
    their own in this shape, keyed on the PERSON (`group_co_admins`,
    models/group.py), with `groups.admin_person_id` keeping its shape."""

    __tablename__ = "gathering_co_hosts"

    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), primary_key=True
    )
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), primary_key=True, index=True
    )
    # Provenance, never a subject: the host who made them a co-host (the
    # add is reserved, so it is always the host at the time).
    added_by_account_id: Mapped[UUID] = mapped_column(
        ForeignKey("accounts.id"), nullable=False
    )
    created_at: Mapped[datetime] = created_at_col()


class GatheringMemberPlace(Base):
    """A group member's place on one of the group's gatherings when that
    place is NOT invited — `shared_with` or `left_out` (CK-77, migration
    0034; decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4,
    §9, §10; the participation record §4). ONE ROW PER (gathering, person),
    A SIBLING RELATION BESIDE `gathering_invitations` AND NEVER A KIND ON
    IT: an invited member keeps holding exactly the person-targeted
    invitation row the product has always understood, so every check that
    admits an invitee — the read audience, RSVP, uploads, the co-host
    handle, the invitation roster — stays correct by construction, and a
    row here GRANTS NOTHING until a read path opts in to it. Two do, for
    `shared_with` alone: api/gatherings.py::_gathering_for_memory (the
    detail and the media list, in the MEMORY view — no dates, no RSVP
    setting) and api/media.py::_visible_media's `live` branch (the
    photographs). `left_out` is opted into by nothing: no trace, anywhere.

    ONE PLACE PER PERSON PER GATHERING, ACROSS THE TWO TABLES: a person
    never holds both an invitation row and a place row for one gathering
    (verifier-asserted; the places route deletes one as it writes the
    other), and a place row exists only on a gathering that belongs to a
    group (verifier-asserted). A live member with NO row of either kind has
    no place — they see nothing — which is what a member who joined after
    the gathering's dates passed holds (the newcomer rule writes nothing
    for the past), and the host may give them one.

    WRITTEN by the host's or a co-host's choice (`set_by_person_id` the
    chooser) at create and through the places route, and by the group's
    rule for a newcomer to a chosen gathering (`set_by_person_id` NULL — the
    CK-43 publisher shape); `updated_at` stamped when the place CHANGES
    (shared with → left out or back), never on the first write. Rows, never
    a lookup: leaving or removal from the group changes no row (the archive
    record §6.1). Three FKs with no delete rule — nothing cascades from a
    person or a gathering; a person who deleted their account keeps their
    row, which admits nobody (an anonymized person cannot sign in). Keyed on
    the PERSON, as the invitation row is: a place is a relationship with the
    people, and keeping (an account fact) never enters into it — keeping
    lets no one in (keeping-explained §5.11)."""

    __tablename__ = "gathering_member_places"

    gathering_id: Mapped[UUID] = mapped_column(
        ForeignKey("gatherings.id"), primary_key=True
    )
    person_id: Mapped[UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True, index=True
    )
    place: Mapped[MemberPlace] = mapped_column(MEMBER_PLACE, nullable=False)
    # Provenance, never a subject: who chose this place — the host or a
    # co-host — or NULL when the group's rule placed a newcomer.
    set_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()
    # Stamped when the place changes, the 0004/0010 shape: NULL until then.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
