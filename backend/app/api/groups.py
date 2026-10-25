"""Groups (CK-45) — and, since CK-75, who belongs to one: the member list,
co-admins, leaving, removal and handing over
(decisions/2026-09-14-groups-get-a-surface.md;
decisions/2026-10-23-joining-a-group-and-co-admins.md §5–§8).

A person creates a HOUSEHOLD group, reads the ones they belong to, renames
one they organise, reads who is in it, leaves it; the admin appoints and
removes co-admins and hands the role over; the admin and co-admins remove
ordinary members. Joining — the link and the requests through it — is
api/group_links.py; the emailed invitation is api/group_invitations.py; the
helper pair below is what both rest on.

AUTHORIZATION — EVERY CHECK LIVES ON THE PERSON SPINE, AND THAT IS THE
DECISION (CK-45 §3; record §6). `groups.admin_person_id`,
`group_co_admins.person_id` and `memberships.person_id` are person FKs;
there is no account fact anywhere in this router. Do not reach for
`ctx.person.account_id` here by analogy with api/gatherings.py: the
gatherings rule mixes an ACCOUNT fact (keeping, hosting — the keeper
model's spine, where quota lives) with a PERSON fact (an invitation), and
neither half transfers — a group is a standing list of PEOPLE. (A group
has held a KEEPER since 0022, an account fact that authorizes nothing about
membership; CK-75 is the phase that finally writes it at creation — record
§8.) Non-permitted access is a 404, never a 403, byte-identical to a
missing id: the existence of a group is not public information.

THE HELPER PAIR, named for what they decide (the CK-68 shape): `is_group_admin`
— THE RESERVED SET: appointing and removing co-admins, handing the role
over, and (unbuilt) archiving and the history setting; and
`may_administer_group` — THE DELEGABLE SET, the admin OR a co-admin:
renaming, approving and declining join requests, the link, emailed
invitations, removing ordinary members. Every check in the three group
routers is one or the other, or the read audience — `_group_for_read`,
a member OR the admin — on purpose (the classification, one line per check,
is in reference/backend/api-reference.md). SQL forms exist for the WHERE
clauses that decide which rows are fetched at all.

A CO-ADMIN IS A ROW BESIDE THE ONE ADMIN (`group_co_admins`, migration
0032), never a second value in `admin_person_id` and never a rung of the
seeded role ladder (`memberships.role_id` stays unread — one of its rungs is
`observer`, the retired word). One flag and a reserved list, never a
permission matrix. Every co-admin is a member, and leaving or removal
deletes the co-admin row with the membership; an admin is never also a
co-admin (the add refuses the admin; a hand-over deletes the new admin's
row). The retired `backup_admin_person_id` left every body at CK-75, was
written by nothing, UNMAPPED at CK-76 (models/group.py), and DROPPED at
0034 (CK-77) — the contract step after the release that stopped reading it.

HOUSEHOLD ONLY, AND THAT IS BINDING, NOT A SIMPLIFICATION. `group_type` is
schema-valid for four values and the create endpoint accepts one: TEAM,
CONGREGATION and CLUB draw a field-level 422 naming the gate — the CK-25
`SMS` shape exactly, and for the same reason (enabling a value later is a
validator change, never a migration against live rows). The gate:
consent-gate-defaults 2.0.0 deleted the SEASON factor from the publication
ladder on the condition that no TEAM or CONGREGATION group, and no
gathering under one, ships before rung 2 (the home group's default)
exists. Rung 2 does not exist. `capability_profiles` holds exactly one
seeded row (HOUSEHOLD / household-default, migration 0001) and this router
seeds nothing — a missing profile row is a loud failure, never a row
created on the fly.

THE CREATION TRANSACTION, and the ordering is the point: the group, the
creator's `memberships` row AND the creator's keeping land together or not
at all — a group never exists with zero members, even transiently within
the request (the verifier asserts every group whose admin is set has a
membership for that admin, and this transaction is what makes it true).
`memberships.household_id`, `.sub_group_id` and `.role_id` are left NULL
deliberately: households and sub-groups have no surface, and no permission
check anywhere reads the role ladder. Do not set them "for completeness".

RUNNING A GROUP AND KEEPING IT NEVER TOUCH (record §7). Handing over the
admin role, a co-admin's promotion at account deletion, leaving and removal
all leave `keeper_account_id` where it is: a keeper who leaves still keeps
the group, a group can be kept by someone outside it, and keeping never
falls back to the admin. Keeping moves only by the keeping flows (unbuilt).
Since CK-76 a gathering CAN belong to a group (`POST /gatherings` with a
`group_id`, api/gatherings.py — any member, in a HOUSEHOLD group), and
then the group's keeper is charged its photographs through the resolver's
first rung; nothing in THIS router changes for it, because running a
group and keeping it never touch. The group's gatherings are listed by
`GET /groups/{id}/gatherings` (api/gatherings.py — the group's read
audience, the gathering list's criterion and shape).

BODIES: `member_count` is computed at read time, never stored (store who,
compute how many — database-schema decision 27), and counts members whose
person is NOT anonymized — the people the member list shows. `caller_role`
— `admin` | `co_admin` | `member` — is the one caller-relative fact and
never appears on the member list. No email address, no phone number, no
account id in any body; the member list carries display names and the
membership id (the one handle — a row the caller already reads) beside a
role and `is_self`. `name` is user-supplied text naming a family and is
never logged — this module has no logger (pinned with the root logger at
DEBUG).

Patch semantics (CK-22): JSON Merge Patch, presence read from
`model_fields_set`. `name` is NOT NULL and therefore not clearable — an
explicit null is a field-level 422, blank stays rejected, and "" never
becomes a second spelling of absent. `updated_at` is stamped by a
successful patch and by nothing else: a hand-over, a join, a leave and a
removal are lifecycle writes, not renames.

NO DELETE ENDPOINT: a group is archived, never deleted (the archive record
§2); the delete rule `gathering_invitations.group_id` lacks has no phase to
own it. Leaving is here; the admin hands over first, and an admin who is the
only member just leaves (the group stays, with nobody in it — the archive
record §5's abandoned state, the claim flow's).

DATA-HANDLING: the member list discloses who belongs to a family to
everyone in it, by display name only. A deleted account is neither listed
nor counted; its membership row stays, attributed to the anonymized person
(CK-45's retention). Removing someone from a group is not a consent
revocation and changes none of their gatherings (the archive record §6).
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.models import (
    CapabilityProfile,
    Group,
    GroupCoAdmin,
    GroupType,
    Membership,
    Person,
)

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

# `caller_role` on every group body (CK-75): what the caller IS in this
# group — never why they may read it.
ROLE_ADMIN = "admin"
ROLE_CO_ADMIN = "co_admin"
ROLE_MEMBER = "member"

# The stable codes on the 422s of the membership acts (the CK-30 marker
# precedent): the frontend switches on these, never on wording.
NOT_A_MEMBER = "not_a_member"
IS_ADMIN = "is_admin"
ALREADY_CO_ADMIN = "already_co_admin"
ACCOUNT_DELETED = "account_deleted"
# The leave route's one 409: the admin with another live member in the
# group hands the role over first (record §7).
HAND_OVER_FIRST = "hand_over_first"


def _not_found() -> HTTPException:
    # One body for "does not exist" and "exists but you may not see it",
    # indistinguishably — the existence of a group is not public
    # information (the gatherings posture).
    return HTTPException(404, "No such group.")


def _no_such_member() -> HTTPException:
    # One body for "no membership of this group by that id" and "not yours
    # to act on" — reachable only by an organiser, who can read the member
    # list; everyone else drew the group's 404 one door earlier.
    return HTTPException(404, "No such member.")


def _refusal(code: str, message: str) -> HTTPException:
    # Field-level, on the one field the body has, carrying the code beside
    # the message (the CK-68 co-host shape) so the frontend can switch on it.
    return HTTPException(
        422,
        detail=[
            {
                "loc": ["body", "membership_id"],
                "msg": message,
                "type": "value_error",
                "code": code,
            }
        ],
    )


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


class MembershipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The membership's id — the one handle for a person in this group, the
    # row every member already reads in GET /groups/{id}/members (the
    # CK-68 idea). Never an email, a person id or an account id.
    membership_id: UUID


# --- the helper pair (record §6; the CK-68 shape on the person spine) -----------


def is_group_admin(group: Group, ctx: AuthContext) -> bool:
    """The reserved set's one question: is the caller THE admin? False for
    everyone on a group whose admin is NULL — the "needs an admin" state
    matches nobody, so such a group is read-only for the reserved acts
    until the claim flow exists."""
    return group.admin_person_id is not None and group.admin_person_id == ctx.person.id


async def is_group_co_admin(db: AsyncSession, group_id: UUID, person_id: UUID) -> bool:
    """One lookup on the relation's primary key. Keyed on the PERSON, as
    `admin_person_id` is, so the two halves of `may_administer_group`
    compare the same spine."""
    found = await db.scalar(
        select(GroupCoAdmin.group_id).where(
            GroupCoAdmin.group_id == group_id, GroupCoAdmin.person_id == person_id
        )
    )
    return found is not None


async def may_administer_group(db: AsyncSession, group: Group, ctx: AuthContext) -> bool:
    """The delegable set's one question: the admin, or a co-admin. The
    admin half is answered from the loaded row; the co-admin half is one
    lookup, made only when the admin half is false."""
    return is_group_admin(group, ctx) or await is_group_co_admin(db, group.id, ctx.person.id)


def co_administers_group(person_id: UUID, group_id):
    """The co-admin half as ONE SQL criterion — TRUE when a co-admin row
    names `person_id` on the group whose id is `group_id` (a column
    expression: `Group.id` in the list statement). An EXISTS over the
    relation's primary key: one index probe per candidate row."""
    return exists(
        select(GroupCoAdmin.group_id).where(
            GroupCoAdmin.group_id == group_id, GroupCoAdmin.person_id == person_id
        )
    )


def administers_group(person_id: UUID):
    """`may_administer_group` as ONE SQL criterion against `Group` in the
    caller's FROM: the admin column, or a co-admin row. A NULL admin
    matches nobody there exactly as `is_group_admin` does."""
    return or_(Group.admin_person_id == person_id, co_administers_group(person_id, Group.id))


def member_of(person_id: UUID, group_id):
    """A membership row for `person_id` on the group whose id is `group_id`
    — the read audience's membership half, as an EXISTS."""
    return exists(
        select(Membership.id).where(
            Membership.group_id == group_id, Membership.person_id == person_id
        )
    )


# --- loaders, named for the set they check ----------------------------------------


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


async def _group_for_organiser(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> Group:
    """THE DELEGABLE SET: the admin or a co-admin (`may_administer_group`).
    Everyone else — an ordinary member, a stranger — draws the group 404
    byte-identical to a missing id."""
    group = await db.get(Group, group_id)
    if group is None or not await may_administer_group(db, group, ctx):
        raise _not_found()
    return group


async def _group_for_admin(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> Group:
    """THE RESERVED SET: the admin alone (`is_group_admin`). A co-admin draws
    the same group 404 an ordinary member does — the route hides. A NULL
    admin matches nobody, so such a group is read-only for these acts
    until the claim flow exists."""
    group = await db.get(Group, group_id)
    if group is None or not is_group_admin(group, ctx):
        raise _not_found()
    return group


# --- bodies ---------------------------------------------------------------------------


def _group_body(group: Group, member_count: int, caller_role: str) -> dict:
    # The admin column is the group's own fact; `caller_role` the one
    # caller-relative one. No retired backup column (CK-75), no roster,
    # no email, no account id.
    return {
        "id": str(group.id),
        "name": group.name,
        "group_type": group.group_type.value,
        "admin_person_id": str(group.admin_person_id) if group.admin_person_id else None,
        "member_count": member_count,
        "caller_role": caller_role,
        "created_at": group.created_at.isoformat(),
        "updated_at": group.updated_at.isoformat() if group.updated_at else None,
    }


def _member_entry(membership_id: UUID, display_name: str, role: str, *, is_self: bool) -> dict:
    # A display name, the handle, the role and the one caller-relative fact
    # — never an email, a phone number, a person id or an account id.
    return {
        "membership_id": str(membership_id),
        "display_name": display_name,
        "role": role,
        "is_self": is_self,
    }


def _live_member_count():
    """The member count as a correlated scalar subquery against `Group` —
    members whose person is NOT anonymized: the people the member list
    shows (record §5: a deleted account is neither listed nor counted)."""
    return (
        select(func.count())
        .select_from(Membership)
        .join(Person, Person.id == Membership.person_id)
        .where(Membership.group_id == Group.id, Person.anonymized_at.is_(None))
        .correlate(Group)
        .scalar_subquery()
    )


async def _member_count(db: AsyncSession, group_id: UUID) -> int:
    """Computed at read time, never stored — store who, compute how many;
    the anonymized excluded, as the list excludes them."""
    return int(
        await db.scalar(
            select(func.count())
            .select_from(Membership)
            .join(Person, Person.id == Membership.person_id)
            .where(Membership.group_id == group_id, Person.anonymized_at.is_(None))
        )
    )


def _role_from_facts(group: Group, ctx: AuthContext, *, co_admin: bool) -> str:
    """`caller_role` from the two facts: the row's admin column and the
    caller's co-admin fact (already fetched — in the list's one statement).
    The admin outranks: an admin is never a co-admin of their own group
    (the verifier asserts it and the add refuses it), so the order here is
    a statement, not a tie-break. Anyone else in the read audience is a
    member."""
    if is_group_admin(group, ctx):
        return ROLE_ADMIN
    if co_admin:
        return ROLE_CO_ADMIN
    return ROLE_MEMBER


async def _role_of(db: AsyncSession, group: Group, ctx: AuthContext) -> str:
    """`caller_role` for a loaded row — the detail's reader: the admin from
    the row, else one lookup for the co-admin row."""
    if is_group_admin(group, ctx):
        return ROLE_ADMIN
    if await is_group_co_admin(db, group.id, ctx.person.id):
        return ROLE_CO_ADMIN
    return ROLE_MEMBER


async def _body_for(db: AsyncSession, group: Group, ctx: AuthContext) -> dict:
    return _group_body(group, await _member_count(db, group.id), await _role_of(db, group, ctx))


async def _membership_in(
    db: AsyncSession, group: Group, membership_id: UUID
) -> Optional[tuple[Membership, Person]]:
    """The membership by that id IN THIS GROUP, with its person — or None.
    The handle every membership act takes; a membership of another group
    is None here, so no refusal confirms anything about other groups."""
    return (
        await db.execute(
            select(Membership, Person)
            .join(Person, Person.id == Membership.person_id)
            .where(Membership.id == membership_id, Membership.group_id == group.id)
        )
    ).first()


# --- the group ------------------------------------------------------------------------


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One transaction, and the ordering is the point: the group, the
    creator's memberships row and the creator's KEEPING land together or
    not at all — a group must never exist with zero members, even
    transiently, and (since CK-75, record §8) never without its keeper:
    `keeper_account_id` is the caller's account, the fact every account
    keeps what it creates on the free tier (keeping-explained §5.3). From
    0022 to CK-75 nothing wrote it — migration 0032 backfilled those
    groups once."""
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
        # The creator is the first keeper (record §8) — an ACCOUNT fact on a
        # row whose other facts are people, and it authorizes nothing here.
        keeper_account_id=ctx.person.account_id,
        # No backup admin: the column was retired at CK-75, unmapped at
        # CK-76 and dropped at 0034 (CK-77) — co-admins are the relation.
        # organization_id stays NULL: a household has no organization.
    )
    db.add(group)
    await db.flush()
    # Creator = admin + first member together. household_id, sub_group_id
    # and role_id deliberately NULL (the module docstring says why); the
    # single commit below is what makes the whole birth atomic.
    db.add(Membership(group_id=group.id, person_id=ctx.person.id))
    await db.commit()
    return _group_body(group, await _member_count(db, group.id), ROLE_ADMIN)


@router.get("/groups")
async def list_groups(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The groups the caller's person is a member of OR administers,
    deduplicated (each group row appears once; the OR is a predicate on it,
    not a union), newest first — ONE statement: the membership test is an
    EXISTS against the row, the member count a correlated subquery, the
    co-admin fact an EXISTS column (the CK-20 shape; pinned by a
    statement-count test)."""
    person_id = ctx.person.id
    rows = (
        await db.execute(
            select(
                Group,
                _live_member_count(),
                co_administers_group(person_id, Group.id).label("co_admin"),
            )
            .where(or_(Group.admin_person_id == person_id, member_of(person_id, Group.id)))
            .order_by(Group.created_at.desc(), Group.id)
        )
    ).all()
    return {
        "groups": [
            _group_body(group, int(count), _role_from_facts(group, ctx, co_admin=bool(co_admin)))
            for group, count, co_admin in rows
        ]
    }


@router.get("/groups/{group_id}")
async def get_group(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # A read stamps nothing.
    group = await _group_for_read(db, ctx, group_id)
    return await _body_for(db, group, ctx)


@router.patch("/groups/{group_id}")
async def patch_group(
    group_id: UUID,
    body: GroupPatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Renaming is DELEGABLE (record §6): the admin or a co-admin; an
    ordinary member and a stranger draw the group 404."""
    group = await _group_for_organiser(db, ctx, group_id)
    # Merge patch (CK-22): a field applies iff it was PRESENT in the body.
    # `name` is not clearable (the model refused an explicit null), so a
    # provided value is always a real, cleaned name.
    if "name" in body.model_fields_set:
        group.name = body.name
    # Stamped on every successful patch and only by patches.
    group.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return await _body_for(db, group, ctx)


# --- the member list (record §5) -----------------------------------------------------


@router.get("/groups/{group_id}/members")
async def list_members(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """EVERY MEMBER SEES WHO IS IN THE GROUP (record §5) — the read audience.
    **200** `{"members": [{"membership_id", "display_name", "role",
    "is_self"}, …]}`, in joining order: display names and the handle, the
    role (`admin` | `co_admin` | `member`), and `is_self` as the one
    caller-relative fact — never an email, a phone number, an account id or
    a person id. A person who deleted their account is ABSENT (their
    membership row stays, attributed to the anonymized person, and is
    neither listed nor counted). Pending invitations and join requests are
    the admin's and co-admins' (their own routes). ONE statement: the
    memberships joined to their person, the co-admin fact an EXISTS column."""
    group = await _group_for_read(db, ctx, group_id)
    co_admin = exists(
        select(GroupCoAdmin.group_id).where(
            GroupCoAdmin.group_id == Membership.group_id,
            GroupCoAdmin.person_id == Membership.person_id,
        )
    ).label("co_admin")
    rows = (
        await db.execute(
            select(Membership.id, Person.id, Person.display_name, co_admin)
            .join(Person, Person.id == Membership.person_id)
            .where(Membership.group_id == group.id, Person.anonymized_at.is_(None))
            .order_by(Membership.created_at, Membership.id)
        )
    ).all()
    members = []
    for membership_id, person_id, display_name, is_co_admin in rows:
        if person_id == group.admin_person_id:
            role = ROLE_ADMIN
        elif is_co_admin:
            role = ROLE_CO_ADMIN
        else:
            role = ROLE_MEMBER
        members.append(
            _member_entry(membership_id, display_name, role, is_self=(person_id == ctx.person.id))
        )
    return {"members": members}


# --- co-admins (record §6; the co-host shape) ---------------------------------------


@router.post("/groups/{group_id}/co-admins", status_code=201)
async def add_co_admin(
    group_id: UUID,
    body: MembershipBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE ADMIN APPOINTS A CO-ADMIN — reserved (record §6): a co-admin, a
    member and a stranger each draw the group 404 byte-identical to a
    missing id. The subject is a member of this group, named by their
    membership id; the four refusals are 422s on that field with stable
    codes, and none writes a row. **201** with the member-list entry
    (`role` `co_admin`, `is_self` false)."""
    group = await _group_for_admin(db, ctx, group_id)
    found = await _membership_in(db, group, body.membership_id)
    if found is None:
        raise _refusal(NOT_A_MEMBER, "nobody is a member of this group by that id")
    membership, person = found
    if person.anonymized_at is not None:
        # Deletion ended every role they held (services/groups.py) and must
        # not be undone by a later appointment: an anonymized person
        # administers nothing. They are already absent from the member
        # list, so the code discloses nothing new.
        raise _refusal(ACCOUNT_DELETED, "that account has been deleted, so it can't be a co-admin")
    if person.id == group.admin_person_id:
        # Admin and co-admin are exclusive — the verifier asserts no co-admin
        # row names its group's admin, and this is where it is kept true.
        raise _refusal(IS_ADMIN, "the admin runs this group already and can't be made its co-admin")
    if await is_group_co_admin(db, group.id, person.id):
        raise _refusal(ALREADY_CO_ADMIN, "they're already a co-admin of this group")
    # Read before the write: on the racing-add path below the session is
    # rolled back, and nothing loaded may be touched after that.
    membership_id = membership.id
    display_name = person.display_name
    db.add(
        GroupCoAdmin(
            group_id=group.id,
            person_id=person.id,
            # Provenance: who appointed them — the admin, by construction of
            # the loader above.
            added_by_person_id=ctx.person.id,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        # Two appointments of the same person racing: the primary key held,
        # so the row exists — the same refusal the check above would draw.
        await db.rollback()
        raise _refusal(ALREADY_CO_ADMIN, "they're already a co-admin of this group")
    return _member_entry(membership_id, display_name, ROLE_CO_ADMIN, is_self=False)


@router.delete("/groups/{group_id}/co-admins/{membership_id}", status_code=204)
async def remove_co_admin(
    group_id: UUID,
    membership_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """THE ADMIN REMOVES A CO-ADMIN, or A CO-ADMIN STEPS DOWN. Two callers,
    one route: the admin may remove anyone (reserved — record §6),
    idempotently (a member who is not a co-admin is a 204: the state asked
    for is the state that holds; a handle naming no membership of this
    group is the member 404); a co-admin may remove exactly themselves —
    stepping down, which is not "removing a co-admin" in §6's sense — and
    a co-admin naming ANYONE else, a co-admin or not, draws the group 404,
    hidden rather than refused (the kickoff's rule; the CK-68 shape). An
    ordinary member and a stranger drew the group 404 one door earlier.
    **204**. The membership itself is untouched: an ex-co-admin is an
    ordinary member."""
    group = await _group_for_organiser(db, ctx, group_id)
    found = await _membership_in(db, group, membership_id)
    if not is_group_admin(group, ctx):
        if found is None or found[1].id != ctx.person.id:
            raise _not_found()
    elif found is None:
        raise _no_such_member()
    await db.execute(
        delete(GroupCoAdmin).where(
            GroupCoAdmin.group_id == group.id, GroupCoAdmin.person_id == found[1].id
        )
    )
    await db.commit()


# --- leaving, removal, handing over (record §7) ---------------------------------------


@router.post("/groups/{group_id}/leave", status_code=204)
async def leave_group(
    group_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """A MEMBER LEAVES AT WILL (record §7): the caller's membership row is
    deleted, and any co-admin row with it. **THE ADMIN HANDS OVER FIRST**:
    with any other member whose person is not anonymized in the group, the
    admin's leave is a **409** with the stable code `hand_over_first` and
    nothing changes; an admin who is the only such member just leaves —
    membership deleted, `admin_person_id` NULL, the group left with nobody
    in it (the archive record §5's abandoned state, the claim flow's).
    **The keeper does not move**: a keeper who leaves still keeps the group.
    A stranger draws the group 404. **204.** Coming back is a new
    invitation or a new request."""
    group = await db.get(Group, group_id)
    if group is None:
        raise _not_found()
    membership = await db.scalar(
        select(Membership).where(
            Membership.group_id == group.id, Membership.person_id == ctx.person.id
        )
    )
    admin = is_group_admin(group, ctx)
    if membership is None and not admin:
        raise _not_found()
    if admin:
        others = await db.scalar(
            select(func.count())
            .select_from(Membership)
            .join(Person, Person.id == Membership.person_id)
            .where(
                Membership.group_id == group.id,
                Membership.person_id != ctx.person.id,
                Person.anonymized_at.is_(None),
            )
        )
        if others:
            raise HTTPException(
                409,
                detail={
                    "code": HAND_OVER_FIRST,
                    "message": (
                        "you're the admin of this group — hand the role to another "
                        "member before you leave"
                    ),
                },
            )
        group.admin_person_id = None
    await db.execute(
        delete(GroupCoAdmin).where(
            GroupCoAdmin.group_id == group.id, GroupCoAdmin.person_id == ctx.person.id
        )
    )
    if membership is not None:
        await db.execute(delete(Membership).where(Membership.id == membership.id))
    await db.commit()


@router.delete("/groups/{group_id}/members/{membership_id}", status_code=204)
async def remove_member(
    group_id: UUID,
    membership_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """REMOVAL (record §7): THE ADMIN removes anyone but themselves — a
    co-admin's row goes with the membership; A CO-ADMIN removes an ordinary
    member only — naming the admin or another co-admin draws the member
    404, hidden rather than refused. **The caller's own membership is the
    leave route's, never this one's**: naming it draws the member 404 too.
    An ordinary member and a stranger drew the group 404 one door earlier;
    a handle naming no membership of this group is the member 404. **204.**
    Removing someone never touches their gatherings (the archive record
    §6) and is not a consent revocation; the keeper does not move."""
    group = await _group_for_organiser(db, ctx, group_id)
    found = await _membership_in(db, group, membership_id)
    if found is None:
        raise _no_such_member()
    membership, person = found
    if person.id == ctx.person.id:
        raise _no_such_member()
    if not is_group_admin(group, ctx):
        if person.id == group.admin_person_id or await is_group_co_admin(db, group.id, person.id):
            raise _no_such_member()
    await db.execute(
        delete(GroupCoAdmin).where(
            GroupCoAdmin.group_id == group.id, GroupCoAdmin.person_id == person.id
        )
    )
    await db.execute(delete(Membership).where(Membership.id == membership.id))
    await db.commit()


@router.post("/groups/{group_id}/hand-over")
async def hand_over(
    group_id: UUID,
    body: MembershipBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE ADMIN HANDS THE ROLE OVER — reserved (record §7): the named member
    becomes the admin AT ONCE, the former admin stays an ordinary member
    (their membership row is untouched), and the new admin's co-admin row,
    if any, is deleted — an admin is never also a co-admin. 422s on
    `membership_id` with stable codes, none writing anything: `not_a_member`,
    `is_admin` (the admin naming themselves), `account_deleted`. A co-admin,
    a member and a stranger draw the group 404. **The keeper does not move**
    (record §7 — running a group and keeping it never touch). `updated_at`
    is not stamped: a lifecycle write, not a rename. **200** with the group
    body — the caller's `caller_role` now `member`."""
    group = await _group_for_admin(db, ctx, group_id)
    found = await _membership_in(db, group, body.membership_id)
    if found is None:
        raise _refusal(NOT_A_MEMBER, "nobody is a member of this group by that id")
    _, person = found
    if person.anonymized_at is not None:
        raise _refusal(ACCOUNT_DELETED, "that account has been deleted, so it can't be the admin")
    if person.id == group.admin_person_id:
        raise _refusal(IS_ADMIN, "you're the admin of this group already")
    group.admin_person_id = person.id
    await db.execute(
        delete(GroupCoAdmin).where(
            GroupCoAdmin.group_id == group.id, GroupCoAdmin.person_id == person.id
        )
    )
    await db.commit()
    return await _body_for(db, group, ctx)
