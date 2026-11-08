"""The calendar (CK-90) — every date of every gathering the caller is
invited to, in a range of instants, and one group's
(decisions/2026-10-04-calendars-and-alerts-by-scope.md §1, §2;
decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 10).
The backend only; CK-91 draws the month grid, the day's list and a group's
calendar from it.

WHY A ROUTE: `GET /gatherings` carries one date per gathering, the next or
the last. A month grid needs every date that falls in the month, and a
season can have dozens, so this answers what a month draws in one request.

WHO SEES A DATE — THE INVITED TIER, EXACTLY: the host (`host_account_id`),
a co-host (`co_hosts_gathering`), or a person holding a person-targeted
`gathering_invitations` row. Three terms, one WHERE. NEVER the memory
tier's fourth term (`shared_with` — a member only shared with sees the
photographs and never the dates), never a `left_out` row (which no read
path opts into), never the keeper by keeping (CK-77 — keeping lets no one
in; a keeper left out of a surprise in their own group must never meet its
date on their calendar), and never a pending emailed invitation, which has
no person. No membership is looked up at read time: a member who has left
a group keeps their invitation rows (places are rows — the archive record
§6.1), so that group's dates stay on their `GET /calendar` while
`GET /groups/{id}/calendar` gives them the group's 404.

THE RANGE, IN INSTANTS, NEVER DAYS: `from` and `to` are ISO 8601 instants
WITH an offset (a naive one is a field-level 422), half-open `[from, to)`:
a date with no end is in when `from <= starts_at < to`; a date with an end
is in when `starts_at < to` and `ends_at > from`, so a date that crosses
either edge of the range is in. `to` after `from`, and the span at most
CALENDAR_MAX_SPAN (62 days — a month grid with a week either side is at
most 44). THE SERVER NEVER COMPUTES A DAY OR READS A ZONE: the surface
places each date on the days it covers in the profile's zone and asks for
its grid's first and last instants.

WHAT IT ANSWERS: `{"dates": [...], "gatherings": [...]}`. Each date is the
date `GET /gatherings/{id}` carries the same caller — `_occurrence_body`
plus `caller_response`, the caller's OWN answer matched by their person (a
guest's row never matches) — plus `position`, its place among ALL of its
gathering's dates by `starts_at` then `id`, from 1 (never its place among
the dates in the range); ordered by `starts_at`, `gathering_id`, `id`. Each
gathering in `gatherings` has a date in `dates`, appears once, in the order
of its first date there, and carries `id`, `title`, `gathering_type`,
`cover` and `group` — each what `GET /gatherings`'s item carries — plus
`date_count`, all of its dates, and `published_count`: its `ready` + `live`
photographs ANDed with `_visible_media` in the same WHERE, NEVER
`gatherings.photo_count`, the keeper's charge, which counts a waiting and a
binned photograph (read here, it would tell the caller about photographs
they cannot see). No email, no person id, no URL.

ONE STATEMENT after the auth read (and the group's read on the group
route), however many gatherings and dates: an inner select numbers and
counts every date of the audience's gatherings with window functions
BEFORE the range is applied, and the outer select filters the range, joins
the caller's own answer and the home group, and counts the photographs in
a correlated scalar subquery. Pinned by a statement counter.

This module imports from api/gatherings.py and api/media.py (api/media.py
imports from api/gatherings.py, so the builder could not live there without
a cycle — api/covers.py's shape). No logger; nothing is stored."""

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import (
    _cover_body,
    _field_422,
    _group_ref,
    _occurrence_body,
    co_hosts_gathering,
)
from app.api.groups import _group_for_read
from app.api.media import _visible_media
from app.models import (
    RSVP,
    Gathering,
    GatheringInvitation,
    Group,
    Media,
    MediaStatus,
    Occurrence,
    PublicationState,
)

router = APIRouter(prefix="", tags=["calendar"])

# The widest range one request may ask for. A month grid with a week either
# side is at most 44 days; 62 leaves room for a grid padded to whole weeks
# without letting one request read a year.
CALENDAR_MAX_SPAN = timedelta(days=62)

NAIVE_INSTANT = "an instant needs a time zone offset, such as Z or +00:00"
RANGE_BACKWARDS = "`to` must be after `from`"
RANGE_TOO_WIDE = f"a calendar range is limited to {CALENDAR_MAX_SPAN.days} days"


def _check_range(start: datetime, end: datetime) -> None:
    """The range's three refusals, each a field-level 422 in the CK-68
    shape: a naive instant at its own field, then `to` not after `from`,
    then a span wider than CALENDAR_MAX_SPAN — both at `to`."""
    if start.tzinfo is None or start.utcoffset() is None:
        raise _field_422("from", NAIVE_INSTANT, where="query")
    if end.tzinfo is None or end.utcoffset() is None:
        raise _field_422("to", NAIVE_INSTANT, where="query")
    if end <= start:
        raise _field_422("to", RANGE_BACKWARDS, where="query")
    if end - start > CALENDAR_MAX_SPAN:
        raise _field_422("to", RANGE_TOO_WIDE, where="query")


def _calendar_statement(
    ctx: AuthContext, now: datetime, start: datetime, end: datetime, group_id: Optional[UUID] = None
):
    """THE CALENDAR'S ONE STATEMENT. Two callers: `GET /calendar` with no
    group, and `GET /groups/{id}/calendar` with one more WHERE term — the
    same rows in the same shape, narrowed to one group's gatherings."""
    account_id = ctx.person.account_id
    # THE INVITED TIER'S THREE TERMS — and no fourth. The invitation targets
    # the PERSON; hosting and co-hosting are ACCOUNT facts (the spines
    # differ on purpose, as everywhere in api/gatherings.py).
    invited_person = exists(
        select(GatheringInvitation.id).where(
            GatheringInvitation.person_id == ctx.person.id,
            GatheringInvitation.gathering_id == Gathering.id,
        )
    )
    hosted = Gathering.host_account_id == account_id
    co_hosted = co_hosts_gathering(account_id, Gathering.id)
    audience = [or_(invited_person, hosted, co_hosted)]
    if group_id is not None:
        audience.append(Gathering.owning_group_id == group_id)
    # Every date of every gathering in the audience, numbered and counted
    # over ALL of its gathering's dates — before the range filter, so a
    # season's dates outside the range still count in `position` and
    # `date_count`.
    numbered = (
        select(
            Occurrence.id.label("occurrence_id"),
            Occurrence.gathering_id.label("gathering_id"),
            Occurrence.starts_at.label("starts_at"),
            Occurrence.ends_at.label("ends_at"),
            func.row_number()
            .over(
                partition_by=Occurrence.gathering_id,
                order_by=(Occurrence.starts_at, Occurrence.id),
            )
            .label("position"),
            func.count().over(partition_by=Occurrence.gathering_id).label("date_count"),
        )
        .join(Gathering, Gathering.id == Occurrence.gathering_id)
        .where(*audience)
        .subquery("numbered")
    )
    # The photographs the caller can see, published: `ready` + `live`
    # ANDed with THE ONE RULE in the same WHERE — never a criterion beside
    # it, and never `gatherings.photo_count`. Correlated on the outer
    # `Gathering`, which `_visible_media` reads for the host and co-host.
    published = (
        select(func.count())
        .select_from(Media)
        .where(
            Media.gathering_id == Gathering.id,
            Media.status == MediaStatus.READY,
            Media.publication_state == PublicationState.LIVE,
            _visible_media(ctx, now),
        )
        .correlate(Gathering)
        .scalar_subquery()
    )
    in_range = or_(
        and_(
            numbered.c.ends_at.is_(None),
            numbered.c.starts_at >= start,
            numbered.c.starts_at < end,
        ),
        and_(
            numbered.c.ends_at.is_not(None),
            numbered.c.starts_at < end,
            numbered.c.ends_at > start,
        ),
    )
    return (
        select(
            Occurrence,
            numbered.c.position,
            numbered.c.date_count,
            RSVP.response,
            Gathering,
            Group.id,
            Group.name,
            published.label("published_count"),
        )
        .select_from(numbered)
        .join(Occurrence, Occurrence.id == numbered.c.occurrence_id)
        .join(Gathering, Gathering.id == numbered.c.gathering_id)
        .outerjoin(Group, Group.id == Gathering.owning_group_id)
        # The caller's OWN answer: matched by their person, so a guest's row
        # (no person) and anyone else's answer never join. At most one row —
        # the partial unique on (occurrence, person).
        .outerjoin(
            RSVP,
            and_(RSVP.occurrence_id == numbered.c.occurrence_id, RSVP.person_id == ctx.person.id),
        )
        .where(in_range)
        .order_by(numbered.c.starts_at, numbered.c.gathering_id, numbered.c.occurrence_id)
    )


def _calendar_body(rows) -> dict:
    dates: list[dict] = []
    gatherings: dict[UUID, dict] = {}
    for occurrence, position, date_count, response, gathering, group_id, group_name, published_count in rows:
        dates.append(
            {
                **_occurrence_body(occurrence),
                "caller_response": response.value if response is not None else None,
                "position": position,
            }
        )
        if gathering.id not in gatherings:
            gatherings[gathering.id] = {
                "id": str(gathering.id),
                "title": gathering.title,
                "gathering_type": gathering.gathering_type.value,
                "cover": _cover_body(gathering),
                "group": _group_ref(group_id, group_name),
                "date_count": date_count,
                "published_count": published_count,
            }
    return {"dates": dates, "gatherings": list(gatherings.values())}


async def _answer(
    db: AsyncSession,
    ctx: AuthContext,
    start: datetime,
    end: datetime,
    group_id: Optional[UUID] = None,
) -> dict:
    statement = _calendar_statement(ctx, datetime.now(timezone.utc), start, end, group_id)
    return _calendar_body((await db.execute(statement)).all())


@router.get("/calendar")
async def read_calendar(
    start: datetime = Query(alias="from"),
    end: datetime = Query(alias="to"),
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """THE CALLER'S CALENDAR: every date, in `[from, to)`, of every
    gathering they host, co-host or hold an invitation to — across all their
    groups and the gatherings that belong to none. The module docstring
    states the rules."""
    _check_range(start, end)
    return await _answer(db, ctx, start, end)


@router.get("/groups/{group_id}/calendar")
async def read_group_calendar(
    group_id: UUID,
    start: datetime = Query(alias="from"),
    end: datetime = Query(alias="to"),
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """ONE GROUP'S CALENDAR: the group's read audience first
    (`_group_for_read` — a member or the admin; everyone else, a member who
    has left included, draws the group's 404 byte-identical to a missing
    group), then the caller's calendar narrowed to the gatherings that
    BELONG to the group (`owning_group_id`) — never a standalone one, never
    another group's."""
    group = await _group_for_read(db, ctx, group_id)
    _check_range(start, end)
    return await _answer(db, ctx, start, end, group.id)
