"""Account-holder RSVPs (CK-27) — the "are you coming" half.

You RSVP to a DATE (an occurrence), never to the gathering (CK-12), and the
partial unique index uq_rsvps_occurrence_person makes the write an UPSERT:
one RSVP per account-holder per occurrence, where changing your mind is the
normal case, not an error. There is deliberately NO delete endpoint —
changing your mind is response "no", which keeps the record that they
answered; a withdrawn row would lose information the host needs and create a
second representation of "not coming" (the defect class CK-13 banned for the
refcount and CK-20 for occurrence text).

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

The list is filtered by the gathering's rsvp_list_visibility — the host's
setting (CK-27, requires_approval's shape). Two rules hold in every mode:
the HOST always sees the full list (every mode includes the host; a
narrower setting must never show the host less than HOST_ONLY does), and
the CALLER always sees their own RSVP via `own` (no one is locked out of
their own answer). List rows carry display names and counts only — an email
address appears in no response body (the CK-25 roster rule, with more force
here because more people read this list).

arrival_time is a BARE time of day on the occurrence's own day, already
relative to the zone that occurrence displays in — no date, no zone. The
CK-17 wall-clock conversion must never touch it (lib/datetime.ts carries the
matching warning on the frontend); an offset-carrying value is refused at
the model, never silently normalized.

DATA-HANDLING: this is the first surface that shows one person's plans to
others, and adult_count/child_count disclose household composition — how
many children someone brings — to whoever the visibility setting admits.
That is why the setting exists and why its default is INVITEES rather than
anything broader. Guest identity is never written: guest_name and
guest_email stay NULL on every row this router touches (guest RSVPs are
their own later phase).
"""

from datetime import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import _gathering_for_read, _not_found
from app.models import (
    Gathering,
    Occurrence,
    Person,
    RSVP,
    RSVPListVisibility,
    RSVPResponse,
)

router = APIRouter(prefix="", tags=["rsvps"])

# SmallInteger-safe and family-plausible: a count past this is a typo, and an
# unbounded one is an asyncpg overflow surfacing as a 500.
MAX_PARTY_COUNT = 99


class RSVPIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # response first: the stay_included validator reads it from info.data.
    response: RSVPResponse
    stay_included: bool = False
    adult_count: int = Field(default=1, ge=0, le=MAX_PARTY_COUNT)
    child_count: int = Field(default=0, ge=0, le=MAX_PARTY_COUNT)
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


def _rsvp_body(row: RSVP) -> dict:
    """The caller's OWN row — the one shape that carries ids. arrival_time
    checks `is not None`, not truthiness: time(0, 0) — a midnight arrival —
    is falsy."""
    return {
        "id": str(row.id),
        "occurrence_id": str(row.occurrence_id),
        "response": row.response.value,
        "stay_included": row.stay_included,
        "adult_count": row.adult_count,
        "child_count": row.child_count,
        "arrival_time": row.arrival_time.isoformat() if row.arrival_time is not None else None,
        "created_at": row.created_at.isoformat(),
    }


def _list_row(row: RSVP, display_name: str) -> dict:
    """A roster entry: display name and the answer's substance, nothing
    identifying beyond that — never an email, never a person or account id."""
    return {
        "id": str(row.id),
        "display_name": display_name,
        "response": row.response.value,
        "stay_included": row.stay_included,
        "adult_count": row.adult_count,
        "child_count": row.child_count,
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
    row.adult_count = body.adult_count
    row.child_count = body.child_count
    row.arrival_time = body.arrival_time


@router.put("/occurrences/{occurrence_id}/rsvp")
async def put_rsvp(
    occurrence_id: UUID,
    body: RSVPIn,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Upsert the caller's own RSVP — theirs alone, keyed by the session;
    nobody RSVPs for anyone else here. A second submission updates the one
    row (the partial unique index is the backstop, never the error path)."""
    occurrence, _ = await _occurrence_for_read(db, ctx, occurrence_id)
    row = (
        await db.execute(
            select(RSVP).where(
                RSVP.occurrence_id == occurrence.id,
                RSVP.person_id == ctx.person.id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = RSVP(occurrence_id=occurrence.id, person_id=ctx.person.id)
        _apply(row, body)
        db.add(row)
    else:
        _apply(row, body)
    try:
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
        await db.commit()
    return _rsvp_body(row)


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
    stay_included changes what a row SAYS, never who may read it — it is
    deliberately absent from every check in this function."""
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
        "own": _rsvp_body(own_row) if own_row is not None else None,
        "rsvps": [_list_row(row, name) for row, name in rows] if may_see_list else [],
    }
