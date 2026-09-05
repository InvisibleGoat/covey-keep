"""Account-holder RSVPs (CK-27; companions since CK-29) — the "are you
coming" half, answered for YOURSELF.

You RSVP to a DATE (an occurrence), never to the gathering (CK-12), and the
partial unique index uq_rsvps_occurrence_person makes the write an UPSERT:
one RSVP per account-holder per occurrence, where changing your mind is the
normal case, not an error. There is deliberately NO delete endpoint —
changing your mind is response "no", which keeps the record that they
answered; a withdrawn row would lose information the host needs and create a
second representation of "not coming" (the defect class CK-13 banned for the
refcount and CK-20 for occurrence text). Since CK-29 the update path stamps
rsvps.updated_at (a mutable row with only a created_at can be read but not
accounted for — the gap that cost CK-28 a verification).

Authorization is CK-25's read audience, inherited exactly: keeper OR host OR
accepted invitee of the parent gathering may RSVP and may read; anyone else
gets the uniform 404 — a signed-in stranger must not learn an occurrence
exists by RSVPing to it.

stay_included — "I can't make it, but keep me included" (the 2026-09-02
participation-terminology record §3) — is INTEREST, never permission. It
appears in no authorization check here or anywhere: an invitee who answers
"no" with it holds byte-identical read access to one who answers "no"
without it. It accompanies a "no" only — with any other response it is
meaningless, and a stored meaningless value is a second representation
waiting to disagree.

companions (CK-29) — "store who, compute how many". You RSVP for yourself;
if you are bringing someone, you say WHO: an ordered list of NAMES, replaced
wholesale on every write, bounded (MAX_COMPANIONS), trimmed and
blank-rejected (the CK-20 discipline). The totals a host reads are computed
at read time from these names and are never stored or accepted from a
client — a typed count can disagree with the list beside it; a computed one
cannot (adult_count/child_count, dropped at 0014, were that disagreement).
A companion is something an attendee DECLARED, not somebody the system
knows: no person_id, no invitation, no notification, and no authorization
decision anywhere may consult companions — the stay_included discipline
again. Companions accompany a "yes" or "maybe" only: "two people are not
coming with me" is not information, it is noise the row would preserve (the
deployed evidence that started this phase), so a "no" with companions is
refused just as stay_included is refused off a "no". Answering for your
FAMILY — picking which of your children come — is the family-accounts
feature, deliberately not this: a typed name here creates nothing and
notifies nobody.

The list is filtered by the gathering's rsvp_list_visibility — the host's
setting (CK-27, requires_approval's shape). Two rules hold in every mode:
the HOST always sees the full list (every mode includes the host; a
narrower setting must never show the host less than HOST_ONLY does), and
the CALLER always sees their own RSVP via `own` (no one is locked out of
their own answer). List rows carry display names, companion names, and the
computed total — an email address appears in no response body (the CK-25
roster rule, with more force here because more people read this list).

arrival_time is a BARE time of day on the occurrence's own day, already
relative to the zone that occurrence displays in — no date, no zone. The
CK-17 wall-clock conversion must never touch it (lib/datetime.ts carries the
matching warning on the frontend); an offset-carrying value is refused at
the model, never silently normalized.

DATA-HANDLING: companion names RAISE what this surface discloses — CK-27's
counts disclosed household composition; a list of names (children's first
names among them) discloses considerably more, to everyone the host's
visibility setting admits. That makes rsvp_list_visibility MORE load-bearing
than before, not less, and is why its default stays INVITEES and why this
list remains logistics (terminology record §4): post-event sharing must
never carry it. Companion names are declared by an attendee ABOUT OTHER
PEOPLE — the third-party-data class the pending-invitations design was
shaped to avoid retaining — so they are bounded, replaced wholesale, deleted
with their RSVP, never notified, never resolved to a person, and reach no
authorization decision. Guest identity is never written: guest_name and
guest_email stay NULL on every row this router touches (guest RSVPs are
their own later phase).
"""

from datetime import datetime, time, timezone
from typing import Annotated, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import _gathering_for_read, _not_found
from app.models import (
    Gathering,
    Occurrence,
    Person,
    RSVP,
    RSVPCompanion,
    RSVPListVisibility,
    RSVPResponse,
)

router = APIRouter(prefix="", tags=["rsvps"])

# Past ten names the form is the wrong tool — and an unbounded list of
# third-party names is unbounded third-party data.
MAX_COMPANIONS = 10
# The location cap (CK-20): plenty for a name, bounded for a column.
MAX_COMPANION_NAME_LENGTH = 200


def _clean_companion_name(value: str) -> str:
    # Trimmed and blank-rejected (CK-20): NULL-shaped absence is "not in the
    # list" — a blank entry is not a person and not a value. Item-level, so
    # the 422 lands on the row that provoked it.
    value = value.strip()
    if not value:
        raise ValueError("a companion needs a name — remove the empty entry instead")
    if len(value) > MAX_COMPANION_NAME_LENGTH:
        raise ValueError(
            f"a companion's name is limited to {MAX_COMPANION_NAME_LENGTH} characters"
        )
    return value


CompanionName = Annotated[str, AfterValidator(_clean_companion_name)]


class RSVPIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # response first: the stay_included and companions validators read it
    # from info.data.
    response: RSVPResponse
    stay_included: bool = False
    # Ordered names, replacing the RSVP's companions wholesale on each write.
    # Empty is the normal case: you RSVP for yourself.
    companions: list[CompanionName] = Field(default_factory=list)
    arrival_time: Optional[time] = None

    @field_validator("stay_included")
    @classmethod
    def _accompanies_a_no(cls, value: bool, info) -> bool:
        response = info.data.get("response")
        if response is None:
            return value  # response itself failed; report only that
        if value and response != RSVPResponse.NO:
            raise ValueError(
                '"keep me included" goes with "no" — it says you can\'t make '
                "it but want to stay in the loop"
            )
        return value

    @field_validator("companions")
    @classmethod
    def _bounded_and_not_on_a_no(cls, value: list[str], info) -> list[str]:
        if len(value) > MAX_COMPANIONS:
            raise ValueError(
                f"you can bring up to {MAX_COMPANIONS} people — for more, ask "
                "the host to invite them"
            )
        response = info.data.get("response")
        if response is None:
            return value  # response itself failed; report only that
        if value and response == RSVPResponse.NO:
            # "Two people are not coming with me" is not information — the
            # noise the dropped head counts manufactured on declined rows.
            raise ValueError(
                'companions go with "yes" or "maybe" — nobody comes along '
                "to a gathering you can't make"
            )
        return value

    @field_validator("arrival_time")
    @classmethod
    def _bare_time(cls, value: Optional[time]) -> Optional[time]:
        # A bare wall clock on the occurrence's own day, in the zone the
        # occurrence displays in. An offset would invite exactly the zone
        # arithmetic this column is designed to stay out of.
        if value is not None and value.tzinfo is not None:
            raise ValueError(
                "arrival time is a plain time of day at the gathering — "
                "no time zone or offset"
            )
        return value


def _rsvp_body(row: RSVP, companions: list[str]) -> dict:
    """The caller's OWN row — the one shape that carries ids. arrival_time
    checks `is not None`, not truthiness: time(0, 0) — a midnight arrival —
    is falsy."""
    return {
        "id": str(row.id),
        "occurrence_id": str(row.occurrence_id),
        "response": row.response.value,
        "stay_included": row.stay_included,
        "companions": companions,
        "arrival_time": row.arrival_time.isoformat() if row.arrival_time is not None else None,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat() if row.updated_at is not None else None,
    }


def _list_row(row: RSVP, display_name: str, companions: list[str]) -> dict:
    """A roster entry: display name, the answer's substance, and the party it
    declares — never an email, never a person or account id. `total` is
    COMPUTED here, at read time, from the named people (the row's person plus
    their companions); it is never stored and never accepted from a client."""
    return {
        "id": str(row.id),
        "display_name": display_name,
        "response": row.response.value,
        "stay_included": row.stay_included,
        "companions": companions,
        "total": 1 + len(companions),
        "arrival_time": row.arrival_time.isoformat() if row.arrival_time is not None else None,
    }


async def _occurrence_for_read(
    db: AsyncSession, ctx: AuthContext, occurrence_id: UUID
) -> tuple[Occurrence, Gathering]:
    """The CK-25 audience, applied through the occurrence: a missing id and a
    parent gathering the caller may not read raise the same 404 with the same
    body — byte-identical, the gatherings posture."""
    occurrence = await db.get(Occurrence, occurrence_id)
    if occurrence is None:
        raise _not_found()
    gathering = await _gathering_for_read(db, ctx, occurrence.gathering_id)
    return occurrence, gathering


def _apply(row: RSVP, body: RSVPIn) -> None:
    # PUT semantics: the whole answer is replaced — an omitted optional field
    # lands as its default (arrival_time None clears a stored one). The guest
    # columns are never touched: they stay NULL on every row this writes.
    row.response = body.response
    row.stay_included = body.stay_included
    row.arrival_time = body.arrival_time


async def _replace_companions(db: AsyncSession, rsvp_id: UUID, names: list[str]) -> None:
    # Wholesale replacement, every write: the list IS the value. The Core
    # delete executes immediately (before the inserts flush), so the
    # (rsvp_id, position) unique never sees old and new rows together.
    await db.execute(delete(RSVPCompanion).where(RSVPCompanion.rsvp_id == rsvp_id))
    for position, name in enumerate(names):
        db.add(RSVPCompanion(rsvp_id=rsvp_id, position=position, name=name))


@router.put("/occurrences/{occurrence_id}/rsvp")
async def put_rsvp(
    occurrence_id: UUID,
    body: RSVPIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Upsert the caller's own RSVP — theirs alone, keyed by the session;
    nobody RSVPs for anyone else here. A second submission updates the one
    row (the partial unique index is the backstop, never the error path) and
    stamps updated_at; the first leaves it NULL, so the stamp means "changed
    since first answered" and never merely mirrors created_at."""
    occurrence, _ = await _occurrence_for_read(db, ctx, occurrence_id)
    row = (
        await db.execute(
            select(RSVP).where(
                RSVP.occurrence_id == occurrence.id,
                RSVP.person_id == ctx.person.id,
            )
        )
    ).scalar_one_or_none()
    try:
        if row is None:
            row = RSVP(occurrence_id=occurrence.id, person_id=ctx.person.id)
            _apply(row, body)
            db.add(row)
            # Flush so the server-generated id exists for the companion rows
            # — which is also where a racing first submission's unique
            # violation surfaces, hence the try around the whole write.
            await db.flush()
        else:
            _apply(row, body)
            row.updated_at = datetime.now(timezone.utc)
        await _replace_companions(db, row.id, body.companions)
        await db.commit()
    except IntegrityError:
        # Two first-time submissions racing: the partial unique index held, so
        # the row exists now — apply this request as the update it would have
        # been a moment later.
        await db.rollback()
        row = (
            await db.execute(
                select(RSVP).where(
                    RSVP.occurrence_id == occurrence.id,
                    RSVP.person_id == ctx.person.id,
                )
            )
        ).scalar_one()
        _apply(row, body)
        row.updated_at = datetime.now(timezone.utc)
        await _replace_companions(db, row.id, body.companions)
        await db.commit()
    return _rsvp_body(row, body.companions)



@router.get("/occurrences/{occurrence_id}/rsvps")
async def list_rsvps(
    occurrence_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The occurrence's RSVP list, filtered by the gathering's visibility
    setting. `own` always carries the caller's row (or null — an unanswered
    occurrence is unanswered, never a defaulted "no"); `rsvps` carries the
    roster when the setting admits the caller, and is empty otherwise.
    stay_included and companions change what a row SAYS, never who may read
    it — both are deliberately absent from every check in this function."""
    occurrence, gathering = await _occurrence_for_read(db, ctx, occurrence_id)
    rows = (
        await db.execute(
            select(RSVP, Person.display_name)
            # Inner join: an account-holder RSVP always has a person; guest
            # rows (person_id NULL — a later phase) would fall out here rather
            # than leak with no name.
            .join(Person, Person.id == RSVP.person_id)
            .where(RSVP.occurrence_id == occurrence.id)
            .order_by(RSVP.created_at, RSVP.id)
        )
    ).all()
    # One query for every row's companions — the CK-20 shape discipline: the
    # roster must not fan out per-RSVP reads.
    companion_rows = (
        await db.execute(
            select(RSVPCompanion)
            .join(RSVP, RSVP.id == RSVPCompanion.rsvp_id)
            .where(RSVP.occurrence_id == occurrence.id)
            .order_by(RSVPCompanion.rsvp_id, RSVPCompanion.position)
        )
    ).scalars().all()
    companions_by_rsvp: dict[UUID, list[str]] = {}
    for companion in companion_rows:
        companions_by_rsvp.setdefault(companion.rsvp_id, []).append(companion.name)

    own_row = next((row for row, _ in rows if row.person_id == ctx.person.id), None)
    is_host = gathering.host_account_id == ctx.person.account_id
    visibility = gathering.rsvp_list_visibility
    # The host sees the list in EVERY mode: HOST_ONLY is the floor, and a
    # narrower setting must never show the host less than it does.
    may_see_list = (
        is_host
        or visibility == RSVPListVisibility.INVITEES
        or (
            visibility == RSVPListVisibility.ATTENDEES
            and own_row is not None
            and own_row.response == RSVPResponse.YES
        )
    )
    return {
        "visibility": visibility.value,
        "own": (
            _rsvp_body(own_row, companions_by_rsvp.get(own_row.id, []))
            if own_row is not None
            else None
        ),
        "rsvps": (
            [
                _list_row(row, name, companions_by_rsvp.get(row.id, []))
                for row, name in rows
            ]
            if may_see_list
            else []
        ),
    }
