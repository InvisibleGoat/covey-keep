from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, uuid_pk
from app.models.enums import (
    GROUP_TYPE,
    INVITATION_CHANNEL,
    JOIN_REQUEST_OUTCOME,
    GroupType,
    InvitationChannel,
    JoinRequestOutcome,
)


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
    # Transferable since CK-75 (POST /groups/{id}/hand-over): the admin
    # hands the role to another member at once, and the deletion leg
    # (services/groups.py) promotes the longest-serving co-admin where one
    # exists. Co-admins are rows in `group_co_admins` BESIDE this column,
    # never a second value in it (the co-host shape, CK-68).
    admin_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )
    # `backup_admin_person_id` IS NOT MAPPED HERE, ON PURPOSE (CK-76). The
    # column still exists in the database: RETIRED at CK-75 by the co-admin
    # relation (joining-a-group record §6 — a backup slot beside co-admins
    # is two representations of "who else administers"), never written by
    # anything, out of every group body since CK-75, and asserted NULL on
    # every row by the verifier through raw SQL. CK-75 kept it mapped
    # because the instance serving during its pre-deploy window still
    # selected it; CK-76 unmaps it (the model no longer selects it, the
    # deletion leg no longer NULLs it), and the DROP is the next contract
    # step — CK-77's migration — after the release that stops reading it.
    # Do not map it back, and do not drop it here.
    # The group's KEEPER — an account, where the two admin columns above are
    # people (0022, CK-49a; keeper record v2 §3.1, §7: administering is a
    # relationship with the people, keeping is a relationship with the bill,
    # and the two land on different spines). The first account fact on this
    # table, and it authorizes nothing about membership. NULL is the unkept
    # state (§5). Backfilled once at 0022 from the admin person's account —
    # the creator is still the first keeper; since CK-49b read by the
    # resolver's first rung (services/keeping.py — unreachable until Arc B
    # writes gatherings.owning_group_id) and NULLed by the deletion lapse
    # where the anonymized account held it. WRITTEN AT CREATION SINCE CK-75
    # (migration 0032 backfilled the groups created between 0022 and then):
    # POST /groups had never written it, so every group created since 0022
    # had no keeper — the joining-a-group record §8. Nothing else writes it:
    # handing over the admin role, a co-admin's promotion, leaving and
    # removal all leave it where it is (record §7 — running a group and
    # keeping it never touch; keeping never falls back to the admin), so a
    # keeper who leaves still keeps the group, and a group can be kept by
    # someone outside it, until the keeping flows move it (unbuilt).
    # Every gathering that belongs to this
    # group (gatherings.owning_group_id — written since CK-76 by any
    # member creating a gathering in a HOUSEHOLD group) is kept by this
    # account and has no keeper of its own; the first rung is live, and
    # the upload gate charges this account for a group gathering's
    # photographs (CK-50's resolver, its first real subject at CK-76); an
    # ARCHIVED group still keeps its gatherings, and the resolver never
    # reads the archive state (§3.1). No lapse stamp lives here yet: where
    # a group's stamp lives is v2 §12 item 9's group half, still open —
    # CK-76 writes the first gathering that resolves through a group and
    # decides nothing about the stamp.
    # Indexed since 0024 (CK-51a; `ix_groups_keeper_account_id`), with the
    # gatherings one: account_usage's WHERE names both.
    keeper_account_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True, index=True
    )
    # Stamped on every successful rename (PATCH /groups/{id}) and by nothing
    # else — the 0004/0010/0014 shape, added WITH the mutability (CK-45,
    # migration 0021). Nullable: a never-renamed group has no meaningful
    # value, and NULL is that fact. Account deletion's admin succession
    # (services/groups.py), a hand-over, a join, a leave and a removal are
    # lifecycle writes, not renames: unstamped.
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()


class GroupCoAdmin(Base):
    """A co-admin of a group (CK-75; joining-a-group record §6) — ONE ROW
    PER (group, person), an additive relation BESIDE `groups.admin_person_id`
    and never a replacement for it: the admin stays singular, and a co-admin
    gets the DELEGABLE set (approve and decline join requests, emailed
    invitations, the link, removing ordinary members, renaming) and none of
    the RESERVED one (appointing and removing co-admins, handing over,
    archiving and the history setting — both unbuilt). One flag and a
    reserved list, never a permission matrix: no capability column here,
    ever (the co-host shape, CK-68, keyed on the PERSON instead of the
    account because group administration is a person fact — CK-45 §3).

    Every co-admin is a member (verifier-asserted), and leaving or removal
    deletes this row with the membership. NOT the seeded role ladder:
    `memberships.role_id` stays unread (record §6). `added_by_person_id` is
    provenance with no delete rule, the `published_by_person_id` shape; no
    delete rule from `people` on `person_id` either — the deletion leg
    (services/groups.py::lapse_group_roles) DELETES an anonymized person's
    rows explicitly, and promotes the longest-serving co-admin (earliest
    `created_at`, then `person_id`) where the deleted person was the admin.
    An admin is never also a co-admin (verifier-asserted): the add refuses
    the admin, and a hand-over deletes the new admin's row."""

    __tablename__ = "group_co_admins"

    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), primary_key=True)
    person_id: Mapped[UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True, index=True
    )
    added_by_person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class GroupInvitationPending(Base):
    """An emailed invitation to join a GROUP (CK-75; record §2) — a SIBLING of
    `gathering_invitations_pending`, never a widened target on it: no live
    table changes shape. The CK-25 machinery with the group as the target,
    and nothing new invented: a channel and a destination (never an email
    column — `SMS` is schema-valid and endpoint-refused until A2P clears),
    the token's SHA-256 hash only, seven days, consumed or revoked and never
    both (the CHECK), one live row per (group, channel, destination) (the
    partial unique — a fresh invite supersedes), stamped never deleted (the
    rate tally), reaped by services/retention.py::purge_stale. Accepting
    creates the membership. The destination is an address a third party
    supplied, seen by the admin and co-admins only."""

    __tablename__ = "group_invitations_pending"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(consumed_at, revoked_at) <= 1",
            name="consumed_or_revoked",
        ),
        Index(
            "uq_group_invitations_pending_live_destination",
            "group_id",
            "channel",
            "destination",
            unique=True,
            postgresql_where=text("consumed_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
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
    invited_by_person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class GroupLink(Base):
    """The group's one shareable link (CK-75; record §2–§3). NO TOKEN COLUMN,
    and none may ever be added: the token is DERIVED from this row's id with
    the server's session secret (app/security.py::group_link_token — an
    HMAC under a context string of its own), so any member can be shown the
    link again and a leaked database yields no working link. A bearer
    credential that is never stored and never logged. At most one unrevoked
    link per group (the partial unique `uq_group_links_live`): making a link
    stamps every unrevoked row for the group first. Expires after
    INVITATION_TTL (7 days); revoking stamps `revoked_at` and forces
    `expires_at` to now; reaped by purge_stale an hour past expiry. Every
    join through it waits for an approval (GroupJoinRequest)."""

    __tablename__ = "group_links"
    __table_args__ = (
        Index(
            "uq_group_links_live",
            "group_id",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False)
    created_by_person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False)
    created_at: Mapped[datetime] = created_at_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class GroupJoinRequest(Base):
    """A request to join a group through its link (CK-75; record §2): the
    requester's person and nothing else about them — the admin and co-admins
    read the display name. OPEN while `decided_at` is NULL, and an open
    request never expires (a keeping request's shape, keeping-explained
    §5.12); one open request per (group, person) (the partial unique
    `uq_group_join_requests_open`). Decided — `decided_at` and `outcome`
    together (the CHECK), `decided_by_person_id` the approver, or NULL when
    an emailed invitation's acceptance closed it as approved — a decided row
    is ephemeral data: stamped, never deleted by any endpoint (it keeps
    counting toward the per-group rate limit), and reaped by purge_stale an
    hour after the decision. The deletion leg deletes an anonymized
    person's OPEN requests; decided ones are left to the reaper."""

    __tablename__ = "group_join_requests"
    __table_args__ = (
        CheckConstraint(
            "(decided_at IS NULL) = (outcome IS NULL)",
            name="decided_with_outcome",
        ),
        Index(
            "uq_group_join_requests_open",
            "group_id",
            "person_id",
            unique=True,
            postgresql_where=text("decided_at IS NULL"),
        ),
    )

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    person_id: Mapped[UUID] = mapped_column(ForeignKey("people.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = created_at_col()
    decided_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    outcome: Mapped[Optional[JoinRequestOutcome]] = mapped_column(
        JOIN_REQUEST_OUTCOME, nullable=True
    )
    decided_by_person_id: Mapped[Optional[UUID]] = mapped_column(
        ForeignKey("people.id"), nullable=True
    )


class SubGroup(Base):
    __tablename__ = "sub_groups"

    id: Mapped[UUID] = uuid_pk()
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
