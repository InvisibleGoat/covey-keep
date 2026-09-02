"""Gathering and occurrence CRUD (CK-16) — the keeper schema's first surface.

The load-bearing rule is the creation transaction: a gathering, its
occurrences, and the creator's kept_gatherings row are born TOGETHER
(keeper record §9.2 — creator is first keeper and admin). A gathering must
never exist with zero keepers, not even transiently within the request, so
creation routes through services/keeping.py::keep and commits once.

Authorization, applied uniformly: mutations require the caller's account to
hold admin (`admin_account_id`); reads require the caller's account to keep
the gathering, OR the caller's person to hold an accepted invitation
(a person-targeted gathering_invitations row — CK-25, the first widening of
the read audience), OR admin. The checks are written against the
keeper/admin/invitation facts, never "is creator" — a creator-shaped check
would already be wrong now that invitees read. Non-permitted access is a
404, never a 403: the existence of a gathering is not public information.

Moderation: `requires_approval` is set to True explicitly on every create —
fail closed (decided 2026-08-25). CK-25 shipped PERSON-targeted invitations
and deliberately did NOT relax this: the recorded relaxation is a GROUP-TYPE
rule (ON for TEAM/CONGREGATION-sourced invites, OFF for HOUSEHOLD/CLUB), and
a person-targeted invite carries no group, so there is still no inviting
context to default from. The trigger waits for group-targeted invitations.
The column's server_default is false (0008) and must never be relied on —
see database-schema decision 22. `requires_approval` governs contributions
WITHIN the gathering; the gathering itself is created `live` (its own
visibility is publication_state, a separate fact — never conflate the two).

Patch semantics (CK-22 — JSON Merge Patch): a field ABSENT from a PATCH body
leaves the stored value alone; an explicit `null` clears it, where the column
allows. The clearable set is exactly ends_at, location, and map_url. starts_at
and title are NOT NULL — an explicit null is a field-level 422 — and
memorial_decedent_name is gated by the memorial CHECK (present iff the type is
memorial), so clearing it on a memorial would violate the constraint and it is
already NULL everywhere else: refused, never an IntegrityError-turned-500.
Pydantic hands both absent and explicit-null to the model as None, so the
distinction lives in `model_fields_set` — the set of fields actually present
in the request body. Blank is NOT a clear: `""` keeps its field-level 422
(decisions/2026-08-27-optional-field-clearing.md).
"""

from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import case, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.models import (
    Account,
    Gathering,
    GatheringInvitation,
    GatheringType,
    KeptGathering,
    Occurrence,
    PublicationState,
)
from app.services.keeping import keep

router = APIRouter(prefix="", tags=["gatherings"])

MAX_TITLE_LENGTH = 200
MAX_DECEDENT_NAME_LENGTH = 200
MAX_LOCATION_LENGTH = 200
# URLs run longer than names — a full Google Maps link with a data= segment
# clears 200 easily — so the cap is the conventional URL bound, not the title's.
MAX_MAP_URL_LENGTH = 2000

# A season's occurrences must fall within one year of the earliest starts_at
# (keeper record §9.2: beyond that is a new season). App-layer by design — the
# schema deliberately treats no gathering type specially, and must not start.
SEASON_MAX_SPAN = timedelta(days=365)


def _not_found() -> HTTPException:
    # One body for "does not exist" and "exists but you may not see it",
    # indistinguishably — the existence of a gathering is not public
    # information (same posture as the passkey DELETE's 404).
    return HTTPException(404, "No such gathering.")


def _field_422(field: str, message: str, *, where: str = "body") -> HTTPException:
    # App-layer validation that needs DB state (the row's type, its other
    # occurrences) can't live in the Pydantic model — but its failures wear
    # the same field-level shape FastAPI's validation errors do, so the
    # frontend renders inline errors from one code path.
    return HTTPException(
        422, detail=[{"loc": [where, field], "msg": message, "type": "value_error"}]
    )


def _clean_title(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("title cannot be empty")
    if len(value) > MAX_TITLE_LENGTH:
        raise ValueError(f"title is limited to {MAX_TITLE_LENGTH} characters")
    return value


def _clean_decedent_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("the decedent's name cannot be empty")
    if len(value) > MAX_DECEDENT_NAME_LENGTH:
        raise ValueError(
            f"the decedent's name is limited to {MAX_DECEDENT_NAME_LENGTH} characters"
        )
    return value


def _clean_location(value: str) -> str:
    # NULL is the ONE representation of "no location" (the CK-13 discipline —
    # no second representation that can disagree). A blank is not a value and
    # not a clear: clearing is an explicit null on a PATCH (CK-22), and this
    # refusal is what keeps "" from becoming a second spelling of "absent"
    # through the front door.
    value = value.strip()
    if not value:
        raise ValueError("location cannot be empty — leave it out instead")
    if len(value) > MAX_LOCATION_LENGTH:
        raise ValueError(f"location is limited to {MAX_LOCATION_LENGTH} characters")
    return value


# One message for every scheme failure, and it never echoes the rejected
# value — a rejection message that reflects its input is itself a small
# injection surface (and a map link can identify a home, so it is never
# logged either).
MAP_URL_SCHEME_MESSAGE = "a map link must start with http:// or https://"


def _clean_map_url(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("map link cannot be empty — leave it out instead")
    if len(value) > MAX_MAP_URL_LENGTH:
        raise ValueError(f"map link is limited to {MAX_MAP_URL_LENGTH} characters")
    # Scheme allowlist (CK-21): the value is rendered as a link href, so any
    # non-http(s) scheme — javascript:, data:, vbscript: — is script execution
    # in a reader's browser: XSS with no HTML injection anywhere. The scheme
    # is PARSED, never prefix-matched: urlsplit strips embedded tab/CR/LF the
    # same way browsers do ("java\tscript:" parses as javascript), and the
    # explicit control-character rejection closes the gap on runtimes whose
    # parser disagrees. Requiring a netloc keeps the accepted set to what the
    # message promises — a literal http:// or https:// prefix.
    if any(c in value for c in "\t\r\n"):
        raise ValueError(MAP_URL_SCHEME_MESSAGE)
    parts = urlsplit(value)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise ValueError(MAP_URL_SCHEME_MESSAGE)
    return value


def _season_span_error(span: timedelta) -> str:
    return (
        "a season's occurrences must all fall within one year of its earliest "
        f"date — this would make the span {span.days} days"
    )


class OccurrenceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # AwareDatetime: a timestamp without a zone is a field-level 422, never an
    # asyncpg encoding error surfacing as a 500 (the columns are timestamptz).
    starts_at: AwareDatetime
    ends_at: Optional[AwareDatetime] = None
    location: Optional[str] = None
    map_url: Optional[str] = None

    @field_validator("location")
    @classmethod
    def _location(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else _clean_location(value)

    @field_validator("map_url")
    @classmethod
    def _map_url(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else _clean_map_url(value)


class GatheringCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Field order matters: gathering_type validates first, so the two
    # validators below can read it from info.data for their cross-field checks
    # and still report against their OWN field (a field-level 422, not a
    # body-level one).
    gathering_type: GatheringType
    title: str
    # validate_default=True: the validator must run when the field is ABSENT
    # too — a memorial with no name at all is the case the CHECK constraint
    # would otherwise catch as an IntegrityError-turned-500.
    memorial_decedent_name: Optional[str] = Field(default=None, validate_default=True)
    occurrences: list[OccurrenceIn] = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        return _clean_title(value)

    @field_validator("memorial_decedent_name")
    @classmethod
    def _decedent_iff_memorial(cls, value: Optional[str], info) -> Optional[str]:
        # The Pydantic half of the memorial gate (keeper record §9.4): a named
        # decedent when and only when the type is memorial. The DB CHECK stays
        # as the backstop; this is the UX — a field error, never a 500.
        gathering_type = info.data.get("gathering_type")
        if gathering_type is None:
            return value  # gathering_type itself failed; report only that
        if gathering_type == GatheringType.MEMORIAL:
            if value is None:
                raise ValueError("a memorial requires the decedent's name")
            return _clean_decedent_name(value)
        if value is not None:
            raise ValueError("only a memorial carries a decedent's name")
        return None

    @field_validator("occurrences")
    @classmethod
    def _season_span(cls, value: list[OccurrenceIn], info) -> list[OccurrenceIn]:
        if info.data.get("gathering_type") == GatheringType.SEASON and len(value) > 1:
            starts = [o.starts_at for o in value]
            span = max(starts) - min(starts)
            if span > SEASON_MAX_SPAN:
                raise ValueError(_season_span_error(span))
        return value


class GatheringPatch(BaseModel):
    # The patchable surface is title + memorial_decedent_name ONLY, mirroring
    # /me/profile: unknown fields are a 422, never a silent no-op. Everything
    # else on the row is either immutable history (created_by_account_id),
    # lifecycle owned by services/keeping.py, or a later phase's surface.
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    memorial_decedent_name: Optional[str] = None

    # Field validators run only when the field is PRESENT in the body
    # (validate_default is off), so a None inside one is an explicit null —
    # the merge-patch "clear" request (CK-22) — and neither field here is
    # clearable: title is NOT NULL, and the memorial CHECK requires the
    # decedent's name present iff the type is memorial, so clearing it on a
    # memorial would violate the constraint (and it is already NULL on
    # everything else). Both refusals are field-level 422s, never the
    # constraint firing as a 500.

    @field_validator("title")
    @classmethod
    def _title(cls, value: Optional[str]) -> str:
        if value is None:
            raise ValueError("title cannot be cleared — provide a new title")
        return _clean_title(value)

    @field_validator("memorial_decedent_name")
    @classmethod
    def _decedent(cls, value: Optional[str]) -> str:
        # Shape only — whether the gathering may carry a name at all depends
        # on its type, which lives in the DB row (checked in the endpoint).
        if value is None:
            raise ValueError("the decedent's name can be corrected, never removed")
        return _clean_decedent_name(value)

    @model_validator(mode="after")
    def _something_to_patch(self) -> "GatheringPatch":
        # A patch is empty when no field was PROVIDED — not when every value
        # is None: under merge-patch semantics an explicit null is a real
        # request (refused above for these two fields, but the emptiness test
        # must still be about presence, the same rule as OccurrencePatch).
        if not self.model_fields_set:
            raise ValueError(
                "nothing to update — provide title and/or memorial_decedent_name"
            )
        return self


class OccurrencePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Merge-patch semantics (CK-22): absent means "leave alone", explicit null
    # means "clear" — the clearable set is ends_at, location, and map_url
    # (every one already nullable). starts_at is NOT NULL, so its explicit
    # null is refused below. The endpoint reads model_fields_set to tell the
    # two Nones apart.
    starts_at: Optional[AwareDatetime] = None
    ends_at: Optional[AwareDatetime] = None
    location: Optional[str] = None
    map_url: Optional[str] = None

    @field_validator("starts_at")
    @classmethod
    def _starts_at(cls, value: Optional[AwareDatetime]) -> AwareDatetime:
        # Runs only when the field is present, so this None is an explicit
        # null — and the column is NOT NULL: a date can be moved, not removed.
        if value is None:
            raise ValueError("starts_at cannot be cleared — a date can be moved, not removed")
        return value

    @field_validator("location")
    @classmethod
    def _location(cls, value: Optional[str]) -> Optional[str]:
        # An explicit null passes through as the clear request; a blank stays
        # rejected inside _clean_location — "" is never a second spelling of
        # "no value", and never a clear (CK-20's discipline holds).
        return None if value is None else _clean_location(value)

    @field_validator("map_url")
    @classmethod
    def _map_url(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else _clean_map_url(value)

    @model_validator(mode="after")
    def _something_to_patch(self) -> "OccurrencePatch":
        # Presence, not value: {"location": null} has all-None values and is a
        # real patch (it clears the location). Testing values here would
        # silently reject every explicit-null clear as "empty".
        if not self.model_fields_set:
            raise ValueError("nothing to update — provide at least one field")
        return self


def _occurrence_body(occurrence: Occurrence) -> dict:
    return {
        "id": str(occurrence.id),
        "gathering_id": str(occurrence.gathering_id),
        "starts_at": occurrence.starts_at.isoformat(),
        "ends_at": occurrence.ends_at.isoformat() if occurrence.ends_at else None,
        "location": occurrence.location,
        "map_url": occurrence.map_url,
    }


def _gathering_body(
    gathering: Gathering, occurrences: Optional[list[Occurrence]] = None
) -> dict:
    body = {
        "id": str(gathering.id),
        "gathering_type": gathering.gathering_type.value,
        "title": gathering.title,
        "memorial_decedent_name": gathering.memorial_decedent_name,
        "requires_approval": gathering.requires_approval,
        "publication_state": gathering.publication_state.value,
        "created_by_account_id": str(gathering.created_by_account_id),
        "admin_account_id": (
            str(gathering.admin_account_id) if gathering.admin_account_id else None
        ),
        "created_at": gathering.created_at.isoformat(),
        "updated_at": gathering.updated_at.isoformat() if gathering.updated_at else None,
    }
    if occurrences is not None:
        body["occurrences"] = [_occurrence_body(o) for o in occurrences]
    return body


def _list_item(
    gathering: Gathering,
    occurrence_id: Optional[UUID],
    starts_at: Optional[datetime],
    occurrence_count: Optional[int],
) -> dict:
    """A GET /gatherings item: the gathering body plus the occurrence summary.
    The LIST's own shape, deliberately — the detail body carries full
    occurrences, and overloading one builder with both would couple the two
    surfaces (CK-20)."""
    item = _gathering_body(gathering)
    item["next_occurrence"] = (
        {"id": str(occurrence_id), "starts_at": starts_at.isoformat()}
        if occurrence_id is not None and starts_at is not None
        else None
    )
    item["occurrence_count"] = occurrence_count if occurrence_count is not None else 0
    return item


async def _gathering_for_read(
    db: AsyncSession, ctx: AuthContext, gathering_id: UUID
) -> Gathering:
    """Reads require the caller's account to keep the gathering, the caller's
    person to hold an accepted invitation (CK-25 — an invitation grants
    visibility, nothing more), or admin. Checked against the
    keeper/admin/invitation facts, never creatorship."""
    gathering = await db.get(Gathering, gathering_id)
    if gathering is None:
        raise _not_found()
    account_id = ctx.person.account_id
    if gathering.admin_account_id == account_id:
        return gathering
    kept = await db.scalar(
        select(KeptGathering.id).where(
            KeptGathering.account_id == account_id,
            KeptGathering.gathering_id == gathering_id,
        )
    )
    if kept is not None:
        return gathering
    # Keeping is an ACCOUNT fact; an invitation targets the PERSON — the
    # invitee never chose to keep anything, so the checks live on different
    # spines deliberately.
    invited = await db.scalar(
        select(GatheringInvitation.id).where(
            GatheringInvitation.person_id == ctx.person.id,
            GatheringInvitation.gathering_id == gathering_id,
        )
    )
    if invited is None:
        raise _not_found()
    return gathering


async def _gathering_for_admin(
    db: AsyncSession, ctx: AuthContext, gathering_id: UUID
) -> Gathering:
    """Mutations require the caller's account to hold admin."""
    gathering = await db.get(Gathering, gathering_id)
    if gathering is None or gathering.admin_account_id != ctx.person.account_id:
        raise _not_found()
    return gathering


async def _occurrence_for_admin(
    db: AsyncSession, ctx: AuthContext, occurrence_id: UUID
) -> tuple[Occurrence, Gathering]:
    occurrence = await db.get(Occurrence, occurrence_id)
    if occurrence is None:
        raise _not_found()
    gathering = await db.get(Gathering, occurrence.gathering_id)
    if gathering is None or gathering.admin_account_id != ctx.person.account_id:
        raise _not_found()
    return occurrence, gathering


async def _sibling_starts(
    db: AsyncSession, gathering_id: UUID, *, excluding: Optional[UUID] = None
) -> list[datetime]:
    query = select(Occurrence.starts_at).where(Occurrence.gathering_id == gathering_id)
    if excluding is not None:
        query = query.where(Occurrence.id != excluding)
    return list((await db.scalars(query)).all())


def _enforce_season_span(
    gathering: Gathering, starts: list[datetime], candidate: datetime
) -> None:
    """The one-year season cap against DB state (occurrence add and date
    move). The create-time half lives in GatheringCreate."""
    if gathering.gathering_type != GatheringType.SEASON:
        return
    all_starts = starts + [candidate]
    span = max(all_starts) - min(all_starts)
    if span > SEASON_MAX_SPAN:
        raise _field_422("starts_at", _season_span_error(span))


@router.post("/gatherings", status_code=201)
async def create_gathering(
    body: GatheringCreate,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One transaction, and the ordering is the point: the gathering, its
    occurrences, and the creator's kept row land together or not at all — a
    gathering must never exist with zero keepers, even transiently."""
    account = await db.get(Account, ctx.person.account_id)
    now = datetime.now(timezone.utc)

    gathering = Gathering(
        created_by_account_id=account.id,
        admin_account_id=account.id,
        gathering_type=body.gathering_type,
        title=body.title,
        memorial_decedent_name=body.memorial_decedent_name,
        # Fail closed, explicitly — never the column's server default (which
        # is false and stays false; database-schema decision 22). Every
        # gathering is moderated until the invitation phase brings an
        # inviting context to default from.
        requires_approval=True,
        # The gathering itself is live; requires_approval governs
        # contributions WITHIN it, not its own visibility.
        publication_state=PublicationState.LIVE,
    )
    db.add(gathering)
    await db.flush()

    occurrences = [
        Occurrence(
            gathering_id=gathering.id,
            starts_at=o.starts_at,
            ends_at=o.ends_at,
            location=o.location,
            map_url=o.map_url,
        )
        for o in body.occurrences
    ]
    db.add_all(occurrences)

    # Creator = first keeper + admin together (keeper record §9.2). keep()
    # flushes; the single commit below is what makes the whole birth atomic.
    await keep(db, account, gathering, now=now)
    await db.commit()

    occurrences.sort(key=lambda o: o.starts_at)
    return _gathering_body(gathering, occurrences)


@router.get("/gatherings")
async def list_gatherings(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The gatherings the caller keeps OR holds an accepted invitation to
    (CK-25 — without the invited half an invitee could reach a gathering only
    through the emailed link, forever), newest first — each with an occurrence
    summary (CK-20): `next_occurrence` is the earliest occurrence at or after
    now, or, when every date has passed, the latest past one (the
    next-or-most-recent rule — a display decision that lives HERE so the list
    view needs no per-gathering detail fetch), plus `occurrence_count`.

    ONE query, deliberately: the lead occurrence and the count come from a
    DISTINCT ON subquery with a window count, joined to the caller's
    gatherings (kept-or-invited via EXISTS, which also dedupes a person who
    is somehow both) — moving CK-17's client-side N+1 into a server-side loop
    would not have been a fix (pinned by a query-count test)."""
    now = datetime.now(timezone.utc)
    upcoming = Occurrence.starts_at >= now
    # One row per gathering: upcoming rows outrank past ones, the earliest
    # upcoming wins among those (the CASE key is NULL for past rows), and the
    # latest past wins when nothing is upcoming.
    lead = (
        select(
            Occurrence.gathering_id.label("gathering_id"),
            Occurrence.id.label("occurrence_id"),
            Occurrence.starts_at.label("starts_at"),
            func.count()
            .over(partition_by=Occurrence.gathering_id)
            .label("occurrence_count"),
        )
        .distinct(Occurrence.gathering_id)
        .order_by(
            Occurrence.gathering_id,
            upcoming.desc(),
            case((upcoming, Occurrence.starts_at)).asc(),
            Occurrence.starts_at.desc(),
            Occurrence.id,
        )
        .subquery("lead_occurrence")
    )
    kept_by_caller = exists(
        select(KeptGathering.id).where(
            KeptGathering.account_id == ctx.person.account_id,
            KeptGathering.gathering_id == Gathering.id,
        )
    )
    invited_person = exists(
        select(GatheringInvitation.id).where(
            GatheringInvitation.person_id == ctx.person.id,
            GatheringInvitation.gathering_id == Gathering.id,
        )
    )
    rows = (
        await db.execute(
            select(
                Gathering,
                lead.c.occurrence_id,
                lead.c.starts_at,
                lead.c.occurrence_count,
            )
            # Outer join is defensive only: creation requires an occurrence and
            # the last one is undeletable, so a NULL next_occurrence should not
            # occur — but the list must not silently drop a row if it ever does.
            .outerjoin(lead, lead.c.gathering_id == Gathering.id)
            .where(or_(kept_by_caller, invited_person))
            .order_by(Gathering.created_at.desc(), Gathering.id)
        )
    ).all()
    return {
        "gatherings": [
            _list_item(gathering, occurrence_id, starts_at, occurrence_count)
            for gathering, occurrence_id, starts_at, occurrence_count in rows
        ]
    }


@router.get("/gatherings/{gathering_id}")
async def get_gathering(
    gathering_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_read(db, ctx, gathering_id)
    occurrences = (
        await db.scalars(
            select(Occurrence)
            .where(Occurrence.gathering_id == gathering.id)
            .order_by(Occurrence.starts_at, Occurrence.id)
        )
    ).all()
    return _gathering_body(gathering, list(occurrences))


@router.patch("/gatherings/{gathering_id}")
async def patch_gathering(
    gathering_id: UUID,
    body: GatheringPatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_admin(db, ctx, gathering_id)
    # Merge patch (CK-22): a field applies iff it was PRESENT in the body.
    # Neither of these is clearable (the model refuses explicit null), so a
    # provided value is always non-None here.
    provided = body.model_fields_set
    if "memorial_decedent_name" in provided:
        # The type-dependent half of the memorial gate needs the row: only a
        # memorial carries a decedent name (the CHECK would fire as a 500
        # otherwise). A memorial's name can be corrected, never removed.
        if gathering.gathering_type != GatheringType.MEMORIAL:
            raise _field_422(
                "memorial_decedent_name", "only a memorial carries a decedent's name"
            )
        gathering.memorial_decedent_name = body.memorial_decedent_name
    if "title" in provided:
        gathering.title = body.title
    gathering.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _gathering_body(gathering)


@router.post("/gatherings/{gathering_id}/occurrences", status_code=201)
async def add_occurrence(
    gathering_id: UUID,
    body: OccurrenceIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_admin(db, ctx, gathering_id)
    starts = await _sibling_starts(db, gathering.id)
    _enforce_season_span(gathering, starts, body.starts_at)
    occurrence = Occurrence(
        gathering_id=gathering.id,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        location=body.location,
        map_url=body.map_url,
    )
    db.add(occurrence)
    await db.commit()
    return _occurrence_body(occurrence)


@router.patch("/occurrences/{occurrence_id}")
async def patch_occurrence(
    occurrence_id: UUID,
    body: OccurrencePatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    occurrence, gathering = await _occurrence_for_admin(db, ctx, occurrence_id)
    # Merge patch (CK-22): a field applies iff it was PRESENT in the body —
    # an absent field leaves the stored value alone, and an explicit null on
    # ends_at/location/map_url clears it (writes NULL, never ""; the blank
    # rejection in the validators is untouched). starts_at can never arrive
    # as null (the model refuses it), so a provided one is always a real move.
    provided = body.model_fields_set
    if "starts_at" in provided:
        # Moving a date is the third way a season's span can grow; the cap is
        # a property of the gathering, so it holds here exactly as it does at
        # create and at add.
        starts = await _sibling_starts(db, gathering.id, excluding=occurrence.id)
        _enforce_season_span(gathering, starts, body.starts_at)
        occurrence.starts_at = body.starts_at
    if "ends_at" in provided:
        occurrence.ends_at = body.ends_at
    if "location" in provided:
        occurrence.location = body.location
    if "map_url" in provided:
        occurrence.map_url = body.map_url
    await db.commit()
    return _occurrence_body(occurrence)


@router.delete("/occurrences/{occurrence_id}", status_code=204)
async def delete_occurrence(
    occurrence_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    occurrence, gathering = await _occurrence_for_admin(db, ctx, occurrence_id)
    remaining = await _sibling_starts(db, gathering.id, excluding=occurrence.id)
    if not remaining:
        # A gathering with no dates is not a state this product has.
        raise _field_422(
            "occurrence_id", "a gathering keeps at least one occurrence", where="path"
        )
    await db.delete(occurrence)
    await db.commit()
