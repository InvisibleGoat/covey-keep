"""Groups (CK-45) — the first surface on a table that has existed since 0001.

A person creates a HOUSEHOLD group, reads the ones they belong to, and
renames one they administer. Nothing more: no membership of anyone but the
creator, no invitations, no sub-groups, no delete, no belongs-to link, no
group-level publication default (decisions/2026-09-14-groups-get-a-surface.md
— the prerequisite for the groups-as-homes arc, whose belongs-to link and
rung 2 of the publication ladder land in the next phase and need a group to
hang off).

AUTHORIZATION — BOTH CHECKS LIVE ON THE PERSON SPINE, AND THAT IS THE
DECISION. `groups.admin_person_id` is a person FK and `memberships.person_id`
is a person FK; there is no account fact anywhere in this router. Mutations
require the caller's PERSON to hold `admin_person_id`; reads require the
caller's person to hold a `memberships` row for the group OR to hold
`admin_person_id`. Do not reach for `ctx.person.account_id` here by analogy
with api/gatherings.py: the gatherings rule mixes an ACCOUNT fact (keeping,
hosting — the keeper model's spine, where quota lives) with a PERSON fact
(an invitation), and neither half transfers — a group is a standing list of
PEOPLE, and an account keeps gatherings, never groups. Non-permitted access
is a 404, never a 403, byte-identical to a missing id: the existence of a
group is not public information (the gatherings posture, pinned by test).

HOUSEHOLD ONLY, AND THAT IS BINDING, NOT A SIMPLIFICATION. `group_type` is
schema-valid for four values and this endpoint accepts one: TEAM,
CONGREGATION and CLUB draw a field-level 422 naming the gate — the CK-25
`SMS` shape exactly, and for the same reason (the shape exists so enabling
a value later is a validator change, never a migration against live rows).
The gate: consent-gate-defaults 2.0.0 deleted the SEASON factor from the
publication ladder on the condition that no TEAM or CONGREGATION group, and
no gathering under one, ships before rung 2 (the home group's default)
exists. Rung 2 does not exist. `capability_profiles` holds exactly one
seeded row (HOUSEHOLD / household-default, migration 0001) and this router
seeds nothing — a missing profile row is a loud failure, never a row
created on the fly.

THE CREATION TRANSACTION, and the ordering is the point: the group and the
creator's `memberships` row land together or not at all — a group never
exists with zero members, even transiently within the request (the
creation-keeps sentence from POST /gatherings, applied here; the verifier
asserts every group has at least one membership, and this transaction is
what makes that true). `memberships.household_id`, `.sub_group_id` and
`.role_id` are left NULL deliberately: households and sub-groups have no
surface, and no permission check anywhere reads the role ladder — writing
the creator a rung would be inventing a fact no reader consumes (and one of
the seeded rungs is `observer`, a schema label for a word the product
retired on 2026-09-02). Do not set them "for completeness".

BODIES: `member_count` is computed at read time, never stored (store who,
compute how many — database-schema decision 27). No person id beyond the
two admin columns, no email address, and NO MEMBER ROSTER in any body this
phase: who else belongs to a group is a disclosure with its own audience
question, owed to the phase that builds membership. `name` is user-supplied
text naming a family and is never logged — this module has no logger
(pinned with the root logger at DEBUG).

Patch semantics (CK-22): JSON Merge Patch, presence read from
`model_fields_set`. `name` is NOT NULL and therefore not clearable — an
explicit null is a field-level 422, blank stays rejected, and "" never
becomes a second spelling of absent. `updated_at` is stamped by a
successful patch and by nothing else.

NO DELETE ENDPOINT, deliberately: `gathering_invitations.group_id` carries
no delete rule, so a DELETE against a group used as an invite list would be
an IntegrityError surfacing as a 500 — exactly `delete_occurrence` before
migration 0015 (database-schema decision 28's class; the `posts.
occurrence_id` precedent for a latent FK recorded rather than "fixed" in
passing). The rule is owed by the phase that ships the delete, and a
leave-group endpoint is that phase's question too.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.models import CapabilityProfile, Group, GroupType, Membership

router = APIRouter(prefix="", tags=["groups"])

# The gathering title's rule (CK-16): a name is trimmed, non-blank, ≤ 200.
MAX_NAME_LENGTH = 200

# The one seeded capability profile (migration 0001), looked up by its
# UNIQUE name — never a hardcoded id, and never created here. The group's
# own type and the profile's must agree (verifier-asserted on every row;
# checked at the one write site below).
HOUSEHOLD_PROFILE_NAME = "household-default"

# One message for the three refused types; it names the gate rather than
# the type, so a reader learns what would have to exist first.
GROUP_TYPE_GATE_MESSAGE = (
    "only a HOUSEHOLD group can be created — TEAM, CONGREGATION and CLUB "
    "wait for the home group's publication default (rung 2 of the "
    "publication ladder)"
)


def _not_found() -> HTTPException:
    # One body for "does not exist" and "exists but you may not see it",
    # indistinguishably — the existence of a group is not public
    # information (the gatherings posture).
    return HTTPException(404, "No such group.")


def _clean_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("name cannot be empty")
    if len(value) > MAX_NAME_LENGTH:
        raise ValueError(f"name is limited to {MAX_NAME_LENGTH} characters")
    return value


class GroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    # Schema-valid for four values, endpoint-accepted for one (the CK-25 SMS
    # shape): absent defaults to HOUSEHOLD, and anything else is refused by
    # the validator below with a field-level 422 — so the refusal lands on
    # `group_type` exactly where an unknown value would.
    group_type: GroupType = GroupType.HOUSEHOLD

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("group_type")
    @classmethod
    def _household_only(cls, value: GroupType) -> GroupType:
        # The rung-2 gate (consent-gate-defaults 2.0.0's closing condition):
        # enabling a type later is this validator changing, never a
        # migration — and never before the home group's default exists.
        if value != GroupType.HOUSEHOLD:
            raise ValueError(GROUP_TYPE_GATE_MESSAGE)
        return value


class GroupPatch(BaseModel):
    # The patchable surface is `name` ONLY: unknown fields are a 422, never a
    # silent no-op (the /me/profile convention). `group_type` is not
    # patchable — a group's type is fixed at creation, and changing it would
    # move the row across the rung-2 gate the create validator enforces.
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: Optional[str]) -> str:
        # Runs only when the field is PRESENT in the body, so this None is
        # an explicit null — the merge-patch clear request (CK-22) — and the
        # column is NOT NULL: a name can be corrected, never removed.
        if value is None:
            raise ValueError("name cannot be cleared — provide a new name")
        return _clean_name(value)

    @model_validator(mode="after")
    def _something_to_patch(self) -> "GroupPatch":
        # Presence, not value (CK-22): a patch is empty when no field was
        # PROVIDED. (With one non-clearable field the two tests coincide
        # today; the presence form is the convention every PATCH follows.)
        if not self.model_fields_set:
            raise ValueError("nothing to update — provide name")
        return self


def _group_body(group: Group, member_count: int) -> dict:
    # Two person ids and nothing else about anyone: the admin columns are the
    # group's own facts; who else belongs is not in any body this phase.
    return {
        "id": str(group.id),
        "name": group.name,
        "group_type": group.group_type.value,
        "admin_person_id": str(group.admin_person_id) if group.admin_person_id else None,
        "backup_admin_person_id": (
            str(group.backup_admin_person_id) if group.backup_admin_person_id else None
        ),
        "member_count": member_count,
        "created_at": group.created_at.isoformat(),
        "updated_at": group.updated_at.isoformat() if group.updated_at else None,
    }


async def _member_count(db: AsyncSession, group_id: UUID) -> int:
    """Computed at read time, never stored — store who, compute how many."""
    return int(
        await db.scalar(
            select(func.count()).select_from(Membership).where(Membership.group_id == group_id)
        )
    )


async def _group_for_read(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> Group:
    """Reads require the caller's PERSON to be a member (a memberships row)
    OR the admin. Person spine only — see the module docstring."""
    group = await db.get(Group, group_id)
    if group is None:
        raise _not_found()
    if group.admin_person_id == ctx.person.id:
        return group
    member = await db.scalar(
        select(Membership.id).where(
            Membership.group_id == group_id, Membership.person_id == ctx.person.id
        )
    )
    if member is None:
        raise _not_found()
    return group


async def _group_for_admin(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> Group:
    """Mutations require the caller's PERSON to hold admin_person_id. A NULL
    admin (the "needs an admin" state, reachable since CK-45's deletion leg)
    matches nobody, so such a group is read-only until the claim flow
    exists."""
    group = await db.get(Group, group_id)
    if group is None or group.admin_person_id != ctx.person.id:
        raise _not_found()
    return group


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One transaction, and the ordering is the point: the group and the
    creator's memberships row land together or not at all — a group must
    never exist with zero members, even transiently."""
    profile = await db.scalar(
        select(CapabilityProfile).where(CapabilityProfile.name == HOUSEHOLD_PROFILE_NAME)
    )
    if profile is None or profile.group_type != body.group_type:
        # Fail loudly, before anything is written: the seed is migration
        # 0001's, and a router that created a profile on the fly would be
        # a second seed path with nothing recording what it wrote.
        raise RuntimeError(
            f"capability profile {HOUSEHOLD_PROFILE_NAME!r} of type "
            f"{body.group_type.value} is missing — seeded by migration 0001, "
            "never created here"
        )

    group = Group(
        group_type=body.group_type,
        capability_profile_id=profile.id,
        name=body.name,
        admin_person_id=ctx.person.id,
        # backup_admin_person_id stays NULL: nothing sets it this phase.
        # organization_id stays NULL: a household has no organization.
    )
    db.add(group)
    await db.flush()
    # Creator = admin + first member together. household_id, sub_group_id
    # and role_id deliberately NULL (the module docstring says why); the
    # single commit below is what makes the whole birth atomic.
    db.add(Membership(group_id=group.id, person_id=ctx.person.id))
    await db.commit()
    return _group_body(group, await _member_count(db, group.id))


@router.get("/groups")
async def list_groups(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The groups the caller's person is a member of OR administers,
    deduplicated (each group row appears once; the OR is a predicate on it,
    not a union), newest first — ONE statement: the membership test is an
    EXISTS against the row, the member count a correlated subquery (the
    CK-20 shape; pinned by a statement-count test)."""
    person_id = ctx.person.id
    member_count = (
        select(func.count())
        .select_from(Membership)
        .where(Membership.group_id == Group.id)
        .correlate(Group)
        .scalar_subquery()
    )
    is_member = exists(
        select(Membership.id).where(
            Membership.group_id == Group.id, Membership.person_id == person_id
        )
    )
    rows = (
        await db.execute(
            select(Group, member_count)
            .where(or_(Group.admin_person_id == person_id, is_member))
            .order_by(Group.created_at.desc(), Group.id)
        )
    ).all()
    return {"groups": [_group_body(group, int(count)) for group, count in rows]}


@router.get("/groups/{group_id}")
async def get_group(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # A read stamps nothing.
    group = await _group_for_read(db, ctx, group_id)
    return _group_body(group, await _member_count(db, group.id))


@router.patch("/groups/{group_id}")
async def patch_group(
    group_id: UUID,
    body: GroupPatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    group = await _group_for_admin(db, ctx, group_id)
    # Merge patch (CK-22): a field applies iff it was PRESENT in the body.
    # `name` is not clearable (the model refused an explicit null), so a
    # provided value is always a real, cleaned name.
    if "name" in body.model_fields_set:
        group.name = body.name
    # Stamped on every successful patch and only by patches.
    group.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _group_body(group, await _member_count(db, group.id))
