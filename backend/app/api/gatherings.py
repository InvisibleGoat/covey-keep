"""Gathering and occurrence CRUD (CK-16) — the keeper schema's first surface.

The load-bearing rule is the creation transaction: a gathering, its
occurrences, and the creator written as its keeper are born TOGETHER
(keeper record §9.2 — creator is first keeper and host). A gathering must
never exist with zero keepers, not even transiently within the request, so
creation routes through services/keeping.py::keep and commits once.

Authorization, applied uniformly: mutations require the caller to ORGANISE
the gathering — the host (`host_account_id`, the admin column renamed at
CK-28 ahead of co-hosts) OR, since CK-68, a co-host: a row in
`gathering_co_hosts` BESIDE that column, never a second value in it
(decisions/2026-09-03-co-hosts.md §1–§2; the two helpers below — `is_host`
for the reserved set, `may_administer` for the delegable one — and the
audit that classified every check in the backend as one or the other,
§5). The one exception on this router is the review switch,
`requires_approval_override`, which stays the host's: a co-host sending it
draws a field-level 422, never a silent drop. Reads require the caller's
account to keep the
gathering, OR the caller's person to hold an accepted invitation
(a person-targeted gathering_invitations row — CK-25, the first widening of
the read audience), OR host. The checks are written against the
keeper/host/invitation facts, never "is creator" — a creator-shaped check
would already be wrong now that invitees read. Non-permitted access is a
404, never a 403: the existence of a gathering is not public information.

The publication gate (CK-41; decisions/2026-09-09-consent-gate-defaults.md
2.0.0): `requires_approval` is RESOLVED, never set. Creation writes nothing
to the column — it is NULL, "nobody has decided" — and the answer comes
from the ladder in services/publication.py at the moment it is needed (the
worker's publish transaction; every gathering body here): the host's own
setting, else the home group's default, else the type's template, else the
join shape, with an ORGANIZATION host gated as a backstop beneath the two
rungs a person sets. CK-16's hard-coded `requires_approval=True` was a
fail-closed interim (database-schema decision 22) that stood for two weeks
looking like a design; it is gone, and so is the discipline that set the
column explicitly on every create — inverted on purpose (decision 33):
that discipline existed so a server default could never become the
product rule, and with the default dropped and NULL meaning inherit,
writing ANYTHING at create would be the new way to defeat the rule. Do not
"fix" the create path back to setting it. In every gathering body
`requires_approval` is the EFFECTIVE value (a plain boolean, so no
consumer handles a null) and `requires_approval_override` is the host's
own setting (null = inherited) — readable since CK-41 and, since CK-44,
WRITABLE through PATCH: `true` gates, `false` opens, an explicit `null`
clears to inherit, absent leaves it alone (the CK-22 clearing rule
exactly). The effective value stays read-only — one writable
representation of the gate, never two. The override ships after CK-43's
review surface (the host's queue, publish and decline — api/media.py) on
purpose: an override that could turn review ON before anything could
approve a photograph would have created a gathering whose photographs
could never be published. A gathering whose review is turned OFF with a
photograph still waiting publishes nothing as a side effect — the
frontend keeps the host's queue rendered while anything waits
(decisions/2026-09-13-the-hosts-review.md §13); nothing here moves a
media row on the way off, and nothing ever may.
`requires_approval` governs contributions WITHIN the gathering; the
gathering itself is created `live` (its own visibility is
publication_state, a separate fact — never conflate the two).

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
    AccountKind,
    Gathering,
    GatheringCoHost,
    GatheringInvitation,
    GatheringType,
    Occurrence,
    PublicationState,
    RSVP,
    RSVPListVisibility,
)
from app.services import publication
from app.services.keeping import keep, keeps_gathering, resolved_keeper_of

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

# The stable marker on the confirmable refusal (CK-30): DELETE /occurrences
# refuses a date that has RSVPs with a 409 carrying this code and the count,
# and proceeds when the request repeats with ?confirm=true. The frontend
# switches on this marker, never on the message's wording — the OTHER refusal
# on that endpoint (the last-occurrence rule, a 422) is not confirmable, and
# the two must stay machine-distinguishable.
CONFIRMATION_REQUIRED = "confirmation_required"

# The caller-relative role on every gathering body (CK-68): what THE CALLER
# is to this gathering — `host`, `co_host`, or null — so the frontend renders
# the widened controls without re-deriving the rule from account ids it
# mostly cannot see. Never the co-host LIST on the body: that is
# api/co_hosts.py's, readable by the host and the co-hosts alone.
ROLE_HOST = "host"
ROLE_CO_HOST = "co_host"


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
    # The patchable surface is title + memorial_decedent_name +
    # rsvp_list_visibility + requires_approval_override ONLY, mirroring
    # /me/profile: unknown fields are a 422, never a silent no-op.
    # Everything else on the row is either immutable history
    # (created_by_account_id), lifecycle owned by services/keeping.py, or a
    # later phase's surface. `requires_approval` — the EFFECTIVE value the
    # body carries — is deliberately NOT here: it is resolved, never
    # written, and a second writable representation of the gate is the
    # defect class database-schema decision 20 exists to prevent.
    #
    # `requires_approval_override` (CK-44; consent-gate-defaults §10.3, §5)
    # is rung 1 of the publication ladder — the host's own choice, the one
    # rung a person sets on the gathering — writable at last, and it shipped
    # AFTER CK-43's review surface on purpose: an override that could turn
    # review ON before anything could approve a photograph would have
    # created a gathering whose photographs could never be published.
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    memorial_decedent_name: Optional[str] = None
    rsvp_list_visibility: Optional[RSVPListVisibility] = None
    # Tri-state, and every value is a real request: True gates, False opens
    # ("open regardless of what my group later says" — accepted, and
    # produced by nothing until rung 2 gives it a meaning), and an EXPLICIT
    # null clears to inherit (NULL in the column — the ladder answers again).
    # No validator: null is the clear, the one field on this model that
    # follows the CK-22 rule in full. Absent, as everywhere, leaves it alone.
    requires_approval_override: Optional[bool] = None

    # Field validators run only when the field is PRESENT in the body
    # (validate_default is off), so a None inside one is an explicit null —
    # the merge-patch "clear" request (CK-22) — and none of the THREE text /
    # enum fields is clearable: title is NOT NULL, the memorial CHECK
    # requires the decedent's name present iff the type is memorial (so
    # clearing it on a memorial would violate the constraint, and it is
    # already NULL on everything else), and rsvp_list_visibility is NOT
    # NULL — the list always has SOME visibility. Every refusal is a
    # field-level 422, never a constraint firing as a 500.

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

    @field_validator("rsvp_list_visibility")
    @classmethod
    def _visibility(cls, value: Optional[RSVPListVisibility]) -> RSVPListVisibility:
        # NOT NULL: the RSVP list always has some visibility — the setting
        # can be changed, never cleared.
        if value is None:
            raise ValueError(
                "rsvp_list_visibility cannot be cleared — choose a visibility"
            )
        return value

    @model_validator(mode="after")
    def _something_to_patch(self) -> "GatheringPatch":
        # A patch is empty when no field was PROVIDED — not when every value
        # is None: under merge-patch semantics an explicit null is a real
        # request (refused above for the three text/enum fields, and THE
        # clear for requires_approval_override — `{"requires_approval_override":
        # null}` has all-None values and is a real patch; a value-based
        # emptiness test would silently reject it, the trap CK-22 pinned).
        if not self.model_fields_set:
            raise ValueError(
                "nothing to update — provide title, memorial_decedent_name, "
                "rsvp_list_visibility, and/or requires_approval_override"
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


async def _host_kind(db: AsyncSession, gathering: Gathering) -> Optional[AccountKind]:
    """The host account's kind — the publication ladder's backstop fact.
    None for a hostless (claimable) gathering."""
    if gathering.host_account_id is None:
        return None
    return await db.scalar(select(Account.kind).where(Account.id == gathering.host_account_id))


def _gathering_body(
    gathering: Gathering,
    occurrences: Optional[list[Occurrence]] = None,
    *,
    host_kind: Optional[AccountKind],
    caller_role: Optional[str],
) -> dict:
    # The gate, resolved for this body (CK-41): `requires_approval` is the
    # EFFECTIVE value — a plain boolean, the same field every consumer has
    # read since CK-16, so nobody handles a null — and
    # `requires_approval_override` is the host's own setting, null when
    # inherited — the switch CK-44 renders (two-state at the surface: it
    # writes true and null; false is accepted and produced by nothing until
    # rung 2 exists). The resolver's `source` is deliberately NOT exposed:
    # CK-44's accuracy statement turned out not to need it — what the
    # turning-off path has to state is what INHERIT resolves to, which the
    # source does not say when the source is HOST — and it needed nothing
    # today, because every gathering the switch can render on (a person's,
    # groupless, privately joined) inherits open. The trigger for exposing
    # the inherited answer here is the share link or rung 2, whichever
    # arrives first (consent-gate-defaults 2.3.0 §8).
    gate = publication.resolve_gathering(
        host_setting=gathering.requires_approval, host_kind=host_kind
    )
    body = {
        "id": str(gathering.id),
        "gathering_type": gathering.gathering_type.value,
        "title": gathering.title,
        "memorial_decedent_name": gathering.memorial_decedent_name,
        "requires_approval": gate.requires_approval,
        "requires_approval_override": gathering.requires_approval,
        "rsvp_list_visibility": gathering.rsvp_list_visibility.value,
        "publication_state": gathering.publication_state.value,
        "created_by_account_id": str(gathering.created_by_account_id),
        "host_account_id": (
            str(gathering.host_account_id) if gathering.host_account_id else None
        ),
        # What the caller IS to this gathering (CK-68): `host`, `co_host`,
        # or null — a fact about the caller, decided by `is_host` and the
        # co-host row, never re-derived by a consumer from the ids above
        # (a co-host's account id appears in no body). The co-host LIST is
        # not here: it is api/co_hosts.py's, readable by the organisers.
        "caller_role": caller_role,
        "created_at": gathering.created_at.isoformat(),
        "updated_at": gathering.updated_at.isoformat() if gathering.updated_at else None,
    }
    if occurrences is not None:
        body["occurrences"] = [_occurrence_body(o) for o in occurrences]
    return body


def _list_item(
    gathering: Gathering,
    host_kind: Optional[AccountKind],
    occurrence_id: Optional[UUID],
    starts_at: Optional[datetime],
    occurrence_count: Optional[int],
    caller_role: Optional[str],
) -> dict:
    """A GET /gatherings item: the gathering body plus the occurrence summary.
    The LIST's own shape, deliberately — the detail body carries full
    occurrences, and overloading one builder with both would couple the two
    surfaces (CK-20). The host's kind rides the list's one statement, and so
    does the caller's co-host fact (CK-68): the role is computed from the
    row and that one boolean, never from a second query."""
    item = _gathering_body(gathering, host_kind=host_kind, caller_role=caller_role)
    item["next_occurrence"] = (
        {"id": str(occurrence_id), "starts_at": starts_at.isoformat()}
        if occurrence_id is not None and starts_at is not None
        else None
    )
    item["occurrence_count"] = occurrence_count if occurrence_count is not None else 0
    return item


# --- the two helpers, named for what they decide (CK-68; co-hosts §5) --------
#
# THE HOST IS SINGULAR AND STAYS THE CONSENT CONTROLLER: `host_account_id`,
# one nullable FK (decisions/2026-09-03-co-hosts.md §1–§2; CK-15 §4). A
# co-host is a ROW BESIDE it — `gathering_co_hosts`, migration 0027 — and
# never a second value in it: replacing the column with a join table would
# have re-opened every decision that rests on the column being singular
# (§2 lists five). Two helpers, and every check in the backend is
# consciously one or the other — the audit §5 called the real work, done at
# CK-68 and listed, one line per check, in reference/backend/api-reference.md:
#
#   is_host          THE RESERVED SET (§4, as amended by two-bins §4):
#                    publication approval in every form — seeing a
#                    `pending` photograph, the queue, publish, decline, the
#                    batch, the review switch — destroying someone else's
#                    photograph (emptying the gathering's bin included), and
#                    adding or removing co-hosts. Never a toggle: a switch
#                    reading "co-host may approve" makes the responsible
#                    party unidentifiable afterwards, which is the one thing
#                    the gate exists to keep.
#   may_administer   THE DELEGABLE SET: the host OR a co-host — editing the
#                    gathering and its occurrences, inviting and revoking,
#                    the full RSVP list and its visibility, taking a
#                    published photograph down, and reading the gathering's
#                    bin and restoring from it (a co-host's restore passes
#                    back through the gate — two-bins §4).
#
# A NULL `host_account_id` — the claimable state (CK-13) — is nobody:
# `is_host` is false for everyone, so nothing reserved can happen on a
# hostless gathering (no queue, no publish, no switch, no co-host
# management). A CO-HOST ROW ON A HOSTLESS GATHERING STILL GRANTS
# `may_administer`: co-hosts §7's first open item, answered provisionally
# here — co-hosts persist when the host relinquishes, because a co-host is
# the likeliest person to want to claim it; the claim flow itself is
# untouched and decides the rest when it is built. §7's second item (may a
# co-host remove another co-host) stays open; the answer built is no
# (api/co_hosts.py).
#
# No bare "admin" in this module (§5): the loaders below are named for the
# set they check — `_gathering_for_organiser` and `_occurrence_for_organiser`
# for the delegable set, `_gathering_for_host` for the reserved one — and
# every route reaches for one or the other on purpose. The SQL forms
# (`co_hosts_gathering`, `administers_gathering`) exist for the WHERE
# clauses that decide which rows are fetched at all (`keeps_gathering`'s
# reason); api/media.py::_moderates IS `administers_gathering` — CK-66's one
# named place, widened exactly as its docstring promised.


def is_host(gathering: Gathering, ctx: AuthContext) -> bool:
    """The reserved set's one question: is the caller THE host? False for
    everyone on a hostless gathering — NULL is the claimable state and
    matches nobody, which is also the fact the publication ladder resolves
    such a gathering open on (nobody could ever approve)."""
    return (
        gathering.host_account_id is not None
        and gathering.host_account_id == ctx.person.account_id
    )


async def is_co_host(db: AsyncSession, gathering_id: UUID, account_id: UUID) -> bool:
    """One lookup on the relation's primary key. Keyed on the ACCOUNT, as
    `host_account_id` is, so the two halves of `may_administer` compare the
    same spine."""
    found = await db.scalar(
        select(GatheringCoHost.gathering_id).where(
            GatheringCoHost.gathering_id == gathering_id,
            GatheringCoHost.account_id == account_id,
        )
    )
    return found is not None


async def may_administer(db: AsyncSession, gathering: Gathering, ctx: AuthContext) -> bool:
    """The delegable set's one question: the host, or a co-host. The host
    half is answered from the loaded row; the co-host half is one lookup,
    made only when the host half is false."""
    return is_host(gathering, ctx) or await is_co_host(db, gathering.id, ctx.person.account_id)


def co_hosts_gathering(account_id: UUID, gathering_id):
    """The co-host half as ONE SQL criterion — TRUE when a co-host row
    names `account_id` on the gathering whose id is `gathering_id` (a
    column expression: `Gathering.id` in the list statement and, through
    `administers_gathering`, the joined `Gathering.id` in the media
    audience). An EXISTS over the relation's primary key: one index probe
    per candidate row."""
    return exists(
        select(GatheringCoHost.gathering_id).where(
            GatheringCoHost.gathering_id == gathering_id,
            GatheringCoHost.account_id == account_id,
        )
    )


def administers_gathering(account_id: UUID):
    """`may_administer` as ONE SQL criterion against the JOINED `Gathering`
    (the caller's FROM has it — api/media.py joins it to `Media`): the
    host, or a co-host row. The host half reads the joined row's own
    column, so a NULL host matches nobody there exactly as `is_host` does;
    the co-host half is `co_hosts_gathering` correlated on `Gathering.id`.
    Pinned to agree with `may_administer` on every shape it can take."""
    return or_(
        Gathering.host_account_id == account_id,
        co_hosts_gathering(account_id, Gathering.id),
    )


def _role_from_facts(gathering: Gathering, ctx: AuthContext, *, co_host: bool) -> Optional[str]:
    """`caller_role` from the two facts: the row's host column and the
    caller's co-host fact (already fetched — in the list's one statement).
    The host outranks: a host is never listed as a co-host of their own
    gathering (the relation's invariant — the verifier asserts it and the
    add refuses it), so the order here is a statement, not a tie-break."""
    if is_host(gathering, ctx):
        return ROLE_HOST
    if co_host:
        return ROLE_CO_HOST
    return None


async def _role_of(db: AsyncSession, gathering: Gathering, ctx: AuthContext) -> Optional[str]:
    """`caller_role` for a loaded row — the detail's reader: the host from
    the row, else one lookup for the co-host row."""
    if is_host(gathering, ctx):
        return ROLE_HOST
    return ROLE_CO_HOST if await is_co_host(db, gathering.id, ctx.person.account_id) else None


async def _gathering_for_read(
    db: AsyncSession, ctx: AuthContext, gathering_id: UUID
) -> Gathering:
    """Reads require the caller's account to keep the gathering, the caller's
    person to hold an accepted invitation (CK-25 — an invitation grants
    visibility, nothing more), or host. Checked against the
    keeper/host/invitation facts, never creatorship. "Keep" is the
    RESOLVED keeper (CK-49b — `services/keeping.py::resolved_keeper_of`:
    the owning group's keeper, else the gathering's own; the old kept
    relation is gone since 0023)."""
    gathering = await db.get(Gathering, gathering_id)
    if gathering is None:
        raise _not_found()
    account_id = ctx.person.account_id
    if gathering.host_account_id == account_id:
        return gathering
    if (await resolved_keeper_of(db, gathering)).keeper_account_id == account_id:
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


async def _gathering_for_organiser(
    db: AsyncSession, ctx: AuthContext, gathering_id: UUID
) -> Gathering:
    """THE DELEGABLE SET (CK-68): the host or a co-host — `may_administer`.
    Everyone else — an invitee, a keeper, a stranger — draws the gathering
    404 byte-identical to a missing id. Until CK-68 this was
    `_gathering_for_admin`, the host alone; every call site was moved here
    or to `_gathering_for_host` on purpose, and the name says which."""
    gathering = await db.get(Gathering, gathering_id)
    if gathering is None or not await may_administer(db, gathering, ctx):
        raise _not_found()
    return gathering


async def _gathering_for_host(
    db: AsyncSession, ctx: AuthContext, gathering_id: UUID
) -> Gathering:
    """THE RESERVED SET (CK-68): the host alone — `is_host`. A co-host
    draws the same 404 a stranger draws: the route hides, it does not
    refuse (the 404-not-403 posture applied to a person who can READ the
    gathering, exactly as the media 404 is applied to an uploader who can
    see a photograph and may not publish it). api/co_hosts.py's management
    routes use it; the review acts are api/media.py's and test the same
    fact in SQL."""
    gathering = await db.get(Gathering, gathering_id)
    if gathering is None or not is_host(gathering, ctx):
        raise _not_found()
    return gathering


async def _occurrence_for_organiser(
    db: AsyncSession, ctx: AuthContext, occurrence_id: UUID
) -> tuple[Occurrence, Gathering]:
    """The delegable set, reached through a date — managing occurrences is
    a co-host's (co-hosts §4)."""
    occurrence = await db.get(Occurrence, occurrence_id)
    if occurrence is None:
        raise _not_found()
    gathering = await db.get(Gathering, occurrence.gathering_id)
    if gathering is None or not await may_administer(db, gathering, ctx):
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
        host_account_id=account.id,
        gathering_type=body.gathering_type,
        title=body.title,
        memorial_decedent_name=body.memorial_decedent_name,
        # `requires_approval` is deliberately NOT set (CK-41): the column is
        # NULL — nobody has decided — and the publication ladder answers at
        # publish time. Writing anything here, true OR false, would freeze
        # the answer at create and defeat inheritance; the column has no
        # server default to fall back on either. This is the inversion of
        # decision 22's set-it-explicitly discipline, on purpose (decision
        # 33) — do not "fix" it back.
        #
        # Explicit, by contrast (CK-27): the visibility column's server
        # default exists for 0012's backfill and is never relied on.
        # INVITEES suits a private family gathering — the counts on an
        # RSVP disclose household composition, so the default is not
        # broader; type-derived defaults belong to the presets work.
        rsvp_list_visibility=RSVPListVisibility.INVITEES,
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

    # Creator = first keeper + host together (keeper record §9.2). keep()
    # flushes; the single commit below is what makes the whole birth atomic.
    await keep(db, account, gathering, now=now)
    await db.commit()

    occurrences.sort(key=lambda o: o.starts_at)
    return _gathering_body(
        gathering, occurrences, host_kind=account.kind, caller_role=ROLE_HOST
    )


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
    # The resolver's ladder as SQL (CK-49b): the gathering resolves to the
    # caller's account — through its group's keeper, else its own. Still an
    # EXISTS inside the one statement (the statement-count pin holds).
    kept_by_caller = keeps_gathering(ctx.person.account_id, Gathering.id)
    # The caller's co-host fact, as a column of the same one statement
    # (CK-68): `caller_role` on every item with no second query — the host
    # half is the row's own `host_account_id`, already fetched.
    co_hosted = co_hosts_gathering(ctx.person.account_id, Gathering.id)
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
                Account.kind,
                lead.c.occurrence_id,
                lead.c.starts_at,
                lead.c.occurrence_count,
                co_hosted.label("co_host"),
            )
            # Outer join is defensive only: creation requires an occurrence and
            # the last one is undeletable, so a NULL next_occurrence should not
            # occur — but the list must not silently drop a row if it ever does.
            .outerjoin(lead, lead.c.gathering_id == Gathering.id)
            # The host's kind for the publication ladder (CK-41), in the same
            # one statement — a hostless gathering reads NULL.
            .outerjoin(Account, Account.id == Gathering.host_account_id)
            .where(or_(kept_by_caller, invited_person))
            .order_by(Gathering.created_at.desc(), Gathering.id)
        )
    ).all()
    return {
        "gatherings": [
            _list_item(
                gathering,
                host_kind,
                occurrence_id,
                starts_at,
                occurrence_count,
                _role_from_facts(gathering, ctx, co_host=co_host),
            )
            for gathering, host_kind, occurrence_id, starts_at, occurrence_count, co_host in rows
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
    return _gathering_body(
        gathering,
        list(occurrences),
        host_kind=await _host_kind(db, gathering),
        caller_role=await _role_of(db, gathering, ctx),
    )


@router.patch("/gatherings/{gathering_id}")
async def patch_gathering(
    gathering_id: UUID,
    body: GatheringPatch,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
    # Merge patch (CK-22): a field applies iff it was PRESENT in the body.
    # None of the three text/enum fields is clearable (the model refuses
    # explicit null), so a provided value is always non-None for them; the
    # override is the exception, and None there IS the request.
    provided = body.model_fields_set
    if "requires_approval_override" in provided and not is_host(gathering, ctx):
        # THE PATCH IS FIELD-LEVEL (CK-68): every other field on this model
        # is delegable and a co-host's value applies; the review switch is
        # the consent gate's (co-hosts §4 — reserved, never a toggle), and
        # a co-host sending it draws a 422 ON THAT FIELD, never a silent
        # drop — and the whole request is refused, nothing else in the
        # body applied (the CK-34 batch precedent: a partial apply the
        # caller cannot see is worse than a refusal). On a HOSTLESS
        # gathering nobody is host, so nobody may flip it.
        raise _field_422(
            "requires_approval_override",
            "only the host decides whether photos are reviewed before they're "
            "published — a co-host can't change it",
        )
    if "requires_approval_override" in provided:
        # The host's switch (CK-44): rung 1 of the publication ladder,
        # written by a person for the first time in the column's life.
        # True gates, False opens, None clears to inherit. THE HOST'S
        # ALONE — the one reserved field on this surface (CK-68), checked
        # just above; `_gathering_for_organiser` admitted a co-host to the
        # rest. Nothing here touches a media row: turning
        # review off publishes nothing that was waiting (the-hosts-review
        # §13), and the worker reads this column at publish time, never
        # from a snapshot, so the next `ready` sees the new answer.
        gathering.requires_approval = body.requires_approval_override
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
    if "rsvp_list_visibility" in provided:
        # The host's list-visibility choice (CK-27) — delegable since CK-68
        # ("set its visibility", co-hosts §4), like every field here but the
        # switch above; the model already refused an explicit null.
        gathering.rsvp_list_visibility = body.rsvp_list_visibility
    gathering.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _gathering_body(
        gathering,
        host_kind=await _host_kind(db, gathering),
        # The organiser loader admitted the caller: the host, or else a
        # co-host — no second lookup.
        caller_role=ROLE_HOST if is_host(gathering, ctx) else ROLE_CO_HOST,
    )


@router.post("/gatherings/{gathering_id}/occurrences", status_code=201)
async def add_occurrence(
    gathering_id: UUID,
    body: OccurrenceIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    gathering = await _gathering_for_organiser(db, ctx, gathering_id)
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
    occurrence, gathering = await _occurrence_for_organiser(db, ctx, occurrence_id)
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
    confirm: bool = False,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a date. Two refusals live here, and they are deliberately
    machine-distinguishable (CK-30) — the frontend must know which one it is
    holding without parsing prose:

    - The last-occurrence rule: a 422 field error (the shape it has had since
      CK-16), and NEVER confirmable. It runs first, before anything reads
      `confirm`, so no flag can reach past it — a host confirming their way
      through the RSVP warning must never accidentally delete the only date.
    - The RSVP warning: a date somebody has answered refuses ONCE with a 409
      carrying the stable marker `confirmation_required` and the count of
      answers that would be discarded; repeating the request with
      `?confirm=true` proceeds. Refusing outright would leave a host no way
      to remove a date short of deleting the whole gathering; cascading
      silently would destroy answers CK-27 deliberately preserved by shipping
      no RSVP delete endpoint. So the host is told what they are about to
      destroy, and then allowed to destroy it — the RSVPs (and, transitively,
      their companions) go with the date via the 0015 FK. A date with no
      answers needs no confirmation and deletes as it always has.
    """
    occurrence, gathering = await _occurrence_for_organiser(db, ctx, occurrence_id)
    remaining = await _sibling_starts(db, gathering.id, excluding=occurrence.id)
    if not remaining:
        # A gathering with no dates is not a state this product has.
        raise _field_422(
            "occurrence_id", "a gathering keeps at least one occurrence", where="path"
        )
    rsvp_count = (
        await db.execute(
            select(func.count())
            .select_from(RSVP)
            .where(RSVP.occurrence_id == occurrence.id)
        )
    ).scalar_one()
    if rsvp_count and not confirm:
        # The count is people, not rows, to the reader: one row per answerer.
        # Disclosed to the organisers only — the host or a co-host, the auth
        # gate above — who always see the full RSVP list in every visibility
        # mode anyway (CK-68).
        noun = "person has" if rsvp_count == 1 else "people have"
        raise HTTPException(
            409,
            detail={
                "code": CONFIRMATION_REQUIRED,
                "rsvp_count": rsvp_count,
                "message": (
                    f"{rsvp_count} {noun} answered for this date; removing it "
                    "discards their answers — repeat the request with "
                    "confirm=true to proceed"
                ),
            },
        )
    await db.delete(occurrence)
    await db.commit()
