"""The chat (CK-102, CK-104; decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md
§2-§6, §8, §9, §14, §18; Steven's answers of 2026-11-21 and 2026-11-25) — the
sixteenth router. A group's chat and a gathering's: reading, polling, sending,
one route for deleting your own message and removing someone else's,
reactions, how far each person has read, opening a chat at the first message
they haven't, what is new, and who is typing.

THE TWO DOORS, and nothing else lets anyone in:

- **A gathering's chat** is behind `_gathering_for_invited`, unchanged: the
  host, a co-host, or a person holding an accepted invitation, whenever they
  were invited — an outsider while they hold their row included. A member
  only shared with, one left out, the keeper by keeping and a group admin who
  is not invited draw the gathering's 404, byte-identical to a missing id.
  A group's container is a gathering nobody is invited to, so this door
  never opens on it.
- **A group's chat** is read from the caller's MEMBERSHIP: `group_chat_window`
  answers that row's `created_at`, and a message is in the window when its
  own `created_at` is at or after it. Leaving deletes the row, so reading
  ends at once; coming back is a new row and a new window. The admin seat
  with no membership opens nothing. Everyone else draws the group's 404.

WHO RUNS THE PLACE (`may_moderate`, on every answer): a group's admin and
co-admins (`may_administer_group`), a gathering's host and co-hosts
(`may_administer`). They remove anyone's message in their window, and they
alone see a removed message while it is HELD — in place, marked, inside
their own window, until `removed_at + REMOVED_BIN`, the constant the
worker's sweep reads, so the two clocks meet at one instant (the CK-59
rule). Everyone else loses a removed message at once.

A SETTING LINE is drawn only for a caller who is a member of the gathering's
group now — never an outsider, in any read or poll.

EVERY READ IS ONE STATEMENT after the door's reads (pinned by the statement
counter) — opening at the first unread is two — and a poll's names of who is
typing one more, made only when someone is: the people's names and the
removers' are joined in it, its reactions are one correlated aggregate, and
the server computes no day. The poll reads `since` minus `CHAT_LOOKBACK`, so
a message whose transaction began before the last read and committed after it
is still found; the client drops repeats by id. A poll's instant comes as
`since` or in the `X-Chat-Since` header, which keeps its address the same at
every check.

REMOVING is one guarded UPDATE where the row is still `live`, its rowcount
checked before the 204 (the CK-77.2 Gotcha) — never read-then-assign. A
REACTION is one guarded INSERT … SELECT or DELETE against the live message,
and the message's stamp moves with it, or neither stands. A READING POSITION
is one upsert that only moves forward, taken under a share lock on the row
that lets its person read, so none outlives their way in
(services/chat_reading.py).

UNREAD is one definition (`_unread`): a live message somebody else wrote.
WHO IS TYPING is held in memory and nowhere else (services/chat_typing.py),
and a poll says it in a header, so no address and no access line does.
NOBODY'S POSITION IS IN ANYONE ELSE'S ANSWER: there is no "seen by".

NO LOGGER, and none may be added: a message's words, its writer's name, a
chat's id, a reaction and a typing signal are never logged (the record's
§18). A message's words travel in a request body, never in an address, and
so does a reaction's kind; and a database error under a send prints none of
them, because both engines hide a statement's parameters (app/db.py).
"""

import base64
import binascii
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, StrictBool, StringConstraints
from sqlalchemy import (
    JSON,
    and_,
    delete,
    exists,
    func,
    insert,
    literal,
    not_,
    or_,
    select,
    tuple_,
    union_all,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import (
    _field_422,
    _gathering_for_invited,
    _in_invited_tier,
    co_hosts_gathering,
    may_administer,
)
from app.api.gatherings import _not_found as _gathering_not_found
from app.api.groups import _not_found as _group_not_found
from app.api.groups import may_administer_group
from app.models import (
    ChatReadPosition,
    Gathering,
    GatheringInvitation,
    Group,
    Membership,
    Person,
    Post,
    PostReaction,
)
from app.models.enums import POST_REACTION_KIND, GatheringType, PostKind, PostReactionKind, PublicationState
from app.services import chat_typing
from app.services.chat_reading import mark_read
from app.services.group_chat import container_for, find_container
from app.services.retention import REMOVED_BIN

router = APIRouter(prefix="", tags=["chat"])

# How far a poll reaches back before its `since`: a send's row carries its
# transaction's start, so a message committed just after the last read can
# carry an instant just before it. Ten seconds is far longer than any send.
CHAT_LOOKBACK = timedelta(seconds=10)
# The first read and each page back: the newest DEFAULT_LIMIT, at most MAX_LIMIT.
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
# Past this many items a poll gives up (`truncated`) and the client reads afresh.
POLL_MAX = 200
# Opening at the first unread: how many items the page holds before it, and how
# far the unread are counted (UNREAD_MAX means that many or more).
BEFORE_UNREAD = 20
UNREAD_MAX = 100
# The brake: the (MESSAGES_PER_WINDOW + 1)th message one person sends inside
# MESSAGE_WINDOW, across every chat, is refused. The rows are the tally, so a
# deleted message still counts; two sends at one instant may pass by one.
MESSAGES_PER_WINDOW = 30
MESSAGE_WINDOW = timedelta(seconds=60)
# A message is 1 to MAX_BODY code points once trimmed — the CHECK's bound.
MAX_BODY = 4000
# The earliest instant a read may be asked from, in UTC. Nothing in a chat is
# older than CoveyKeep, so nothing refused here could have answered; and the
# poll's reach back (CHAT_LOOKBACK) and the hold's (REMOVED_BIN) both stay
# inside what a datetime, and the database driver, can hold.
EARLIEST_INSTANT = datetime(2000, 1, 1, tzinfo=timezone.utc)

SETTING_KINDS = (PostKind.OUTSIDE_INVITATIONS_ON, PostKind.OUTSIDE_INVITATIONS_OFF)

BAD_CURSOR = "that cursor isn't one this chat gave"
BAD_SINCE = "that isn't an instant this chat can be read from"
BOTH_CURSORS = "ask for `since` or `before`, not both"
ONE_WAY = "ask for a chat one way at a time"
BAD_TYPING = "this header is exactly 1 when it is sent"
TYPING_NOT_A_POLL = "this header is sent on a poll alone"


def _now() -> datetime:
    """The server's instant: the answer's `as_of` and the hold's clock. One
    function, so a test can stand at an exact edge."""
    return datetime.now(timezone.utc)


def _no_such_message() -> HTTPException:
    # One body for "no message by that id" and "not one you may act on" —
    # including a reader who may not remove it — byte-identical either way.
    return HTTPException(404, "No such message.")


def _refusal(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _no_nul(words: str) -> str:
    # PostgreSQL's text holds no NUL, so a message with one could never be
    # kept. Refused, never taken out: the words are the writer's.
    if "\x00" in words:
        raise ValueError("a message can't hold a NUL character")
    return words


class MessageBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Trimmed first, then measured: empty after trimming is pydantic's own
    # `string_too_short`, over the bound its `string_too_long`, so the
    # screens can say which from the type. `len` counts code points, as
    # PostgreSQL's `char_length` does.
    body: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_BODY),
        AfterValidator(_no_nul),
    ]


class ReactionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: PostReactionKind
    # Strict: `1` and `"true"` are not a yes.
    on: StrictBool


class ReadBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    through: UUID


# --- the doors -------------------------------------------------------------------


async def group_chat_window(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> datetime:
    """The caller's window on a group's chat: their membership's `created_at`,
    or the group's 404 — byte-identical to a missing group's — for anyone
    with no membership row, the admin seat alone included."""
    since = await db.scalar(
        select(Membership.created_at).where(
            Membership.group_id == group_id, Membership.person_id == ctx.person.id
        )
    )
    if since is None:
        raise _group_not_found()
    return since


class _Place:
    """What a door hands the read and the send: the chat's gathering row's
    id, the caller's window (None in a gathering's chat: whenever they were
    invited), whether they run the place, whether setting lines are drawn for
    them, the group whose chat this is (None for a gathering's), and whether
    it is a memorial's, whose reactions carry no number."""

    def __init__(
        self,
        gathering_id: UUID,
        window: Optional[datetime],
        moderator: bool,
        setting_lines: bool,
        *,
        group_id: Optional[UUID] = None,
        memorial: bool = False,
    ):
        self.gathering_id = gathering_id
        self.window = window
        self.moderator = moderator
        self.setting_lines = setting_lines
        self.group_id = group_id
        self.memorial = memorial


async def _group_place(db: AsyncSession, ctx: AuthContext, group_id: UUID) -> _Place:
    window = await group_chat_window(db, ctx, group_id)
    group = await db.get(Group, group_id)
    if group is None:  # a membership names an existing group; never reached
        raise _group_not_found()
    container = await find_container(db, group_id)
    if container is None:
        # An older group's first read or send: its container is made here,
        # under the group's row lock, and kept whatever the answer is.
        container = await container_for(db, group_id, ctx.person.account_id)
        await db.commit()
    moderator = await may_administer_group(db, group, ctx)
    # The container holds no setting line; nothing to draw.
    return _Place(container, window, moderator, setting_lines=False, group_id=group_id)


async def _caller_in_group(db: AsyncSession, ctx: AuthContext, group_id: Optional[UUID]) -> bool:
    if group_id is None:
        return False
    found = await db.scalar(
        select(Membership.id).where(
            Membership.group_id == group_id, Membership.person_id == ctx.person.id
        )
    )
    return found is not None


async def _gathering_place(db: AsyncSession, ctx: AuthContext, gathering_id: UUID) -> _Place:
    gathering = await _gathering_for_invited(db, ctx, gathering_id)
    moderator = await may_administer(db, gathering, ctx)
    setting_lines = await _caller_in_group(db, ctx, gathering.owning_group_id)
    memorial = gathering.gathering_type == GatheringType.MEMORIAL
    return _Place(gathering.id, None, moderator, setting_lines, memorial=memorial)


# --- reading -------------------------------------------------------------------------

Author = aliased(Person, name="author")
Remover = aliased(Person, name="remover")


def _marks(me: UUID):
    """A live message's reactions as one JSON list of `[kind, the caller's
    own]`, in the statement that reads the message; NULL where there are
    none, and for a held message always."""
    return (
        select(
            func.json_agg(
                func.json_build_array(PostReaction.kind, PostReaction.person_id == me), type_=JSON
            )
        )
        .where(PostReaction.post_id == Post.id, Post.publication_state == PublicationState.LIVE)
        .correlate(Post)
        .scalar_subquery()
    )


def _reactions(marks: Optional[list], memorial: bool) -> list[dict]:
    """The kinds present, in the kinds' order, each with how many left it and
    whether the caller did. In a memorial's chat no answer carries a number."""
    counted = Counter(kind for kind, _ in marks or [])
    mine = {kind for kind, own in marks or [] if own}
    return [
        {
            "kind": kind.value,
            "count": None if memorial else counted[kind.value],
            "mine": kind.value in mine,
        }
        for kind in PostReactionKind
        if kind.value in counted
    ]


def _columns(me: UUID):
    return (
        Post.id,
        Post.kind,
        Post.created_at,
        Post.body,
        Post.publication_state,
        Post.removed_at,
        Post.author_person_id,
        Post.removed_by_person_id,
        Author.display_name.label("author_name"),
        Remover.display_name.label("remover_name"),
        _marks(me).label("marks"),
    )


def _from(statement):
    return statement.join(Author, Author.id == Post.author_person_id).outerjoin(
        Remover, Remover.id == Post.removed_by_person_id
    )


def _in_chat(place: _Place):
    """The rows of this chat the caller may ever be told about: this chat's,
    inside their window, and no setting line unless it is drawn for them."""
    criteria = [Post.gathering_id == place.gathering_id]
    if place.window is not None:
        criteria.append(Post.created_at >= place.window)
    if not place.setting_lines:
        criteria.append(Post.kind.notin_(SETTING_KINDS))
    return and_(*criteria)


def _shown(place: _Place, now: datetime):
    """Shown now: a live row to everyone at the door; a held row to the
    people who run the place alone, until `removed_at + REMOVED_BIN`."""
    live = Post.publication_state == PublicationState.LIVE
    if not place.moderator:
        return live
    held = and_(
        Post.publication_state == PublicationState.REMOVED,
        Post.removed_at > now - REMOVED_BIN,
    )
    return or_(live, held)


def _unread(me: UUID):
    """What can be unread at all: a live message somebody else wrote. A line
    the chat wrote never is, nor a held message, for the people who run the
    place too."""
    return and_(
        Post.kind == PostKind.MESSAGE,
        Post.publication_state == PublicationState.LIVE,
        Post.author_person_id.is_distinct_from(me),
    )


def _past_position():
    """Past the caller's own place in a chat, in the read's own order."""
    return tuple_(Post.created_at, Post.id) > tuple_(
        ChatReadPosition.through_created_at, ChatReadPosition.through_post_id
    )


def _item(row, ctx: AuthContext, place: _Place) -> dict:
    removed = None
    if row.publication_state == PublicationState.REMOVED:
        removed = {
            "at": row.removed_at,
            "by": row.remover_name,
            "by_writer": row.removed_by_person_id == row.author_person_id,
            # Whether the remover is the caller (CK-103), so the screen says
            # *You*; it discloses nothing to anyone else.
            "by_self": row.removed_by_person_id == ctx.person.id,
        }
    return {
        "id": str(row.id),
        "kind": row.kind.value,
        "created_at": row.created_at,
        "author": {"display_name": row.author_name, "is_self": row.author_person_id == ctx.person.id},
        "body": row.body if row.kind == PostKind.MESSAGE else None,
        "removed": removed,
        "reactions": _reactions(row.marks, place.memorial),
    }


def _cursor_of(created_at: datetime, post_id: UUID) -> str:
    raw = f"{created_at.isoformat()}|{post_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _in_utc(at: datetime) -> Optional[datetime]:
    """The instant in UTC, or None for one no read can be asked from: before
    `EARLIEST_INSTANT`, or past what UTC can hold — an offset can carry year
    9999 into 10000, or year 1 into 0."""
    try:
        at = at.astimezone(timezone.utc)
    except OverflowError:
        return None
    return at if at >= EARLIEST_INSTANT else None


def _parse_cursor(cursor: str, field: str) -> tuple[datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        at_text, id_text = raw.split("|")
        at = datetime.fromisoformat(at_text)
        post_id = UUID(id_text)
    except (binascii.Error, UnicodeError, ValueError):
        raise _field_422(field, BAD_CURSOR, where="query") from None
    in_utc = None if at.tzinfo is None else _in_utc(at)
    if in_utc is None:
        raise _field_422(field, BAD_CURSOR, where="query")
    return in_utc, post_id


@dataclass(frozen=True)
class _Asked:
    """One way of reading a chat, already checked: the newest page, the page
    back from `before`, the page on from `after`, the page at the first
    unread (`open`), or a poll from `since` — with the caller's typing signal
    on a poll alone."""

    limit: int
    before: Optional[tuple[datetime, UUID]] = None
    after: Optional[tuple[datetime, UUID]] = None
    open: bool = False
    since: Optional[datetime] = None
    typing: bool = False


async def _read(db: AsyncSession, ctx: AuthContext, place: _Place, asked: _Asked) -> dict:
    now = _now()
    shown = _shown(place, now)
    in_chat = _in_chat(place)
    if asked.since is not None:
        return await _poll(db, ctx, place, asked, now=now, shown=shown, in_chat=in_chat)
    if asked.after is not None:
        return await _onward(db, ctx, place, asked, now=now, shown=shown, in_chat=in_chat)
    if asked.open:
        return await _opened(db, ctx, place, asked, now=now, shown=shown, in_chat=in_chat)
    return await _newest(db, ctx, place, asked, now=now, shown=shown, in_chat=in_chat)


async def _newest(
    db: AsyncSession, ctx: AuthContext, place: _Place, asked: _Asked, *, now, shown, in_chat
) -> dict:
    """The newest page, or the page back from a cursor."""
    limit = asked.limit
    statement = _from(select(*_columns(ctx.person.id))).where(in_chat, shown)
    if asked.before is not None:
        statement = statement.where(tuple_(Post.created_at, Post.id) < tuple_(*asked.before))
    statement = statement.order_by(Post.created_at.desc(), Post.id.desc()).limit(limit + 1)
    rows = (await db.execute(statement)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    older = _cursor_of(rows[-1].created_at, rows[-1].id) if more else None
    return {
        "items": [_item(row, ctx, place) for row in reversed(rows)],
        "older": older,
        "as_of": now,
        "may_moderate": place.moderator,
    }


async def _onward(
    db: AsyncSession, ctx: AuthContext, place: _Place, asked: _Asked, *, now, shown, in_chat
) -> dict:
    """The page on towards the newest from a cursor, oldest first. A `newer`
    of null is the newest reached."""
    limit = asked.limit
    statement = (
        _from(select(*_columns(ctx.person.id)))
        .where(in_chat, shown, tuple_(Post.created_at, Post.id) > tuple_(*asked.after))
        .order_by(Post.created_at, Post.id)
        .limit(limit + 1)
    )
    rows = (await db.execute(statement)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [_item(row, ctx, place) for row in rows],
        "newer": _cursor_of(rows[-1].created_at, rows[-1].id) if more else None,
        "as_of": now,
        "may_moderate": place.moderator,
    }


async def _opened(
    db: AsyncSession, ctx: AuthContext, place: _Place, asked: _Asked, *, now, shown, in_chat
) -> dict:
    """The page at the first message the caller hasn't read: up to
    BEFORE_UNREAD items before it, then on to the limit. Two statements: the
    unread ones past the caller's place, to UNREAD_MAX (the first is where
    the page is, and their number the count), and the page — the plain newest
    one where there is no place or nothing is unread. Moves no position."""
    me, limit = ctx.person.id, asked.limit
    unread = (
        await db.execute(
            select(Post.created_at, Post.id)
            .join(
                ChatReadPosition,
                and_(
                    ChatReadPosition.gathering_id == Post.gathering_id,
                    ChatReadPosition.person_id == me,
                ),
            )
            .where(in_chat, _unread(me), _past_position())
            .order_by(Post.created_at, Post.id)
            .limit(UNREAD_MAX)
        )
    ).all()
    if not unread:
        page = await _newest(db, ctx, place, asked, now=now, shown=shown, in_chat=in_chat)
        return {**page, "first_unread": None, "unread": 0, "newer": None}

    first = (unread[0].created_at, unread[0].id)
    at, first_at = tuple_(Post.created_at, Post.id), tuple_(*first)
    ahead = min(BEFORE_UNREAD, limit - 1)
    earlier = (
        select(Post.id)
        .where(in_chat, shown, at < first_at)
        .order_by(Post.created_at.desc(), Post.id.desc())
        .limit(ahead + 1)
        .subquery()
    )
    later = (
        select(Post.id)
        .where(in_chat, shown, at >= first_at)
        .order_by(Post.created_at, Post.id)
        .limit(limit + 1)
        .subquery()
    )
    rows = (
        await db.execute(
            _from(select(*_columns(me)))
            .where(Post.id.in_(union_all(select(earlier.c.id), select(later.c.id))))
            .order_by(Post.created_at, Post.id)
        )
    ).all()
    before = [row for row in rows if (row.created_at, row.id) < first]
    onward = [row for row in rows if (row.created_at, row.id) >= first]
    more_before = len(before) > ahead
    before = before[-ahead:] if ahead else []
    room = limit - len(before)
    more_onward = len(onward) > room
    onward = onward[:room]
    items = before + onward
    # The first of them still on the page: one removed between the two
    # statements is on neither, and the next is the first.
    ids = {row.id for row in unread}
    first_unread = next((row.id for row in onward if row.id in ids), None)
    return {
        "items": [_item(row, ctx, place) for row in items],
        "older": _cursor_of(items[0].created_at, items[0].id) if more_before and items else None,
        "newer": _cursor_of(items[-1].created_at, items[-1].id) if more_onward and items else None,
        "first_unread": None if first_unread is None else str(first_unread),
        "unread": len(unread),
        "as_of": now,
        "may_moderate": place.moderator,
    }


async def _who_is_typing(db: AsyncSession, ctx: AuthContext, place: _Place) -> list[str]:
    """The other people typing in this chat, oldest signal first: one small
    read, made only when someone is. A signal that outlived its person's way
    in shows nobody's name — the people who can read the chat now, alone."""
    typing = chat_typing.store.others(place.gathering_id, ctx.person.id)
    if not typing:
        return []
    if place.group_id is not None:
        reads = exists(
            select(Membership.id).where(
                Membership.group_id == place.group_id, Membership.person_id == Person.id
            )
        )
    else:
        # The invited tier, as `_in_invited_tier` asks it.
        reads = or_(
            exists(
                select(Gathering.id).where(
                    Gathering.id == place.gathering_id, Gathering.host_account_id == Person.account_id
                )
            ),
            exists(
                select(GatheringInvitation.id).where(
                    GatheringInvitation.gathering_id == place.gathering_id,
                    GatheringInvitation.person_id == Person.id,
                )
            ),
            co_hosts_gathering(Person.account_id, place.gathering_id),
        )
    names = dict(
        (
            await db.execute(
                select(Person.id, Person.display_name).where(
                    Person.id.in_(typing), Person.anonymized_at.is_(None), reads
                )
            )
        ).all()
    )
    return [names[person_id] for person_id in typing if person_id in names]


async def _poll(
    db: AsyncSession, ctx: AuthContext, place: _Place, asked: _Asked, *, now, shown, in_chat
) -> dict:
    """Everything in the window created, or changed, at or after `since`
    minus the lookback — each row SHOWN is an item, each that is not is the
    id of one that left the caller's chat in the span: removed (for anyone
    who does not run the place), or past its hold (for those who do). A
    message whose reactions changed in the span is an item again. The
    caller's typing signal, when the poll carries one, is noted here, behind
    the poll's own door."""
    if asked.typing:
        chat_typing.store.note(place.gathering_id, ctx.person.id)
    reach = asked.since - CHAT_LOOKBACK
    if place.moderator:
        left_in_span = Post.removed_at > reach - REMOVED_BIN
    else:
        left_in_span = Post.removed_at >= reach
    changed = or_(
        and_(
            shown,
            or_(
                Post.created_at >= reach,
                Post.removed_at >= reach,
                Post.reactions_updated_at >= reach,
            ),
        ),
        and_(not_(shown), left_in_span),
    )
    statement = (
        _from(select(*_columns(ctx.person.id), shown.label("shown")))
        .where(in_chat, changed)
        .order_by(Post.created_at, Post.id)
        .limit(POLL_MAX + 1)
    )
    rows = (await db.execute(statement)).all()
    base = {
        "as_of": now,
        "may_moderate": place.moderator,
        "typing": await _who_is_typing(db, ctx, place),
    }
    if len(rows) > POLL_MAX:
        return {"items": [], "removed": [], "truncated": True, **base}
    return {
        "items": [_item(row, ctx, place) for row in rows if row.shown],
        "removed": [str(row.id) for row in rows if not row.shown],
        "truncated": False,
        **base,
    }


def _read_query(
    before: Optional[str] = Query(None),
    after: Optional[str] = Query(None),
    open_: bool = Query(False, alias="open"),
    since: Optional[AwareDatetime] = Query(None),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    x_chat_since: Optional[AwareDatetime] = Header(None),
    x_chat_typing: Optional[str] = Header(None),
) -> _Asked:
    """One way of reading a chat, every refusal made before any door is
    asked. Two ways at once are refused at the first named, in the order the
    parameters have here. A poll's instant is `since` or the `X-Chat-Since`
    header, one form and one set of refusals; `X-Chat-Typing` is exactly `1`,
    on a poll alone."""
    ways = [
        named
        for given, named in (
            (before is not None, ("query", "before")),
            (after is not None, ("query", "after")),
            (open_, ("query", "open")),
            (since is not None, ("query", "since")),
            (x_chat_since is not None, ("header", "x-chat-since")),
        )
        if given
    ]
    if len(ways) > 1:
        where, field = ways[0]
        the_old_pair = ways == [("query", "before"), ("query", "since")]
        raise _field_422(field, BOTH_CURSORS if the_old_pair else ONE_WAY, where=where)
    back = None if before is None else _parse_cursor(before, "before")
    onward = None if after is None else _parse_cursor(after, "after")
    asked_since = since if since is not None else x_chat_since
    at = None
    if asked_since is not None:
        at = _in_utc(asked_since)
        if at is None:
            where, field = ways[0]
            raise _field_422(field, BAD_SINCE, where=where)
    if x_chat_typing is not None:
        if x_chat_typing != "1":
            raise _field_422("x-chat-typing", BAD_TYPING, where="header")
        if at is None:
            raise _field_422("x-chat-typing", TYPING_NOT_A_POLL, where="header")
    return _Asked(
        limit=limit, before=back, after=onward, open=open_, since=at, typing=x_chat_typing is not None
    )


@router.get("/groups/{group_id}/chat")
async def read_group_chat(
    group_id: UUID,
    asked: _Asked = Depends(_read_query),
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _group_place(db, ctx, group_id)
    return await _read(db, ctx, place, asked)


@router.get("/gatherings/{gathering_id}/chat")
async def read_gathering_chat(
    gathering_id: UUID,
    asked: _Asked = Depends(_read_query),
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _gathering_place(db, ctx, gathering_id)
    return await _read(db, ctx, place, asked)


# --- sending -------------------------------------------------------------------------


async def _send(db: AsyncSession, ctx: AuthContext, place: _Place, body: str) -> dict:
    person_id, display_name = ctx.person.id, ctx.person.display_name
    sent_lately = await db.scalar(
        select(func.count())
        .select_from(Post)
        .where(
            Post.author_person_id == person_id,
            Post.kind == PostKind.MESSAGE,
            Post.created_at > func.now() - MESSAGE_WINDOW,
        )
    )
    if sent_lately >= MESSAGES_PER_WINDOW:
        raise _refusal(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too_many_messages",
            "That's a lot of messages in a minute. Wait a moment, then send it again.",
        )
    post_id, created_at = (
        await db.execute(
            insert(Post)
            .values(
                gathering_id=place.gathering_id,
                author_person_id=person_id,
                kind=PostKind.MESSAGE,
                body=body,
                publication_state=PublicationState.LIVE,
            )
            .returning(Post.id, Post.created_at)
        )
    ).one()
    await db.commit()
    # They have stopped typing here: their words are in the chat.
    chat_typing.store.drop(place.gathering_id, person_id)
    return {
        "id": str(post_id),
        "kind": PostKind.MESSAGE.value,
        "created_at": created_at,
        "author": {"display_name": display_name, "is_self": True},
        "body": body,
        "removed": None,
        "reactions": [],
    }


@router.post("/groups/{group_id}/chat", status_code=status.HTTP_201_CREATED)
async def send_to_group_chat(
    group_id: UUID,
    payload: MessageBody,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _group_place(db, ctx, group_id)
    return await _send(db, ctx, place, payload.body)


@router.post("/gatherings/{gathering_id}/chat", status_code=status.HTTP_201_CREATED)
async def send_to_gathering_chat(
    gathering_id: UUID,
    payload: MessageBody,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _gathering_place(db, ctx, gathering_id)
    return await _send(db, ctx, place, payload.body)


# --- how far the caller has read -----------------------------------------------------------


async def _still_here(db: AsyncSession, person_id: UUID) -> None:
    """The caller's own row, held against their account's deletion until this
    transaction ends: a deletion waits for what is written here and takes it,
    and one that came first leaves nobody to write for."""
    here = await db.scalar(
        select(Person.id)
        .where(Person.id == person_id, Person.anonymized_at.is_(None))
        .with_for_update(read=True)
    )
    if here is None:
        raise _no_such_message()


async def _mark(db: AsyncSession, ctx: AuthContext, place: _Place, through: UUID) -> None:
    """The caller has read this chat through this item — any item they are
    shown now, a line or a held message included; anything else is the 404.
    THE ROW THAT LETS THEM READ is held first (the membership; the gathering,
    whose lock every act that moves a place takes), and asked again under it,
    so a position never outlives its person's way in. Forward only: a place
    already passed is a 204 that changes nothing."""
    person_id = ctx.person.id
    await _still_here(db, person_id)
    if place.group_id is not None:
        place.window = await db.scalar(
            select(Membership.created_at)
            .where(Membership.group_id == place.group_id, Membership.person_id == person_id)
            .with_for_update(read=True)
        )
        if place.window is None:
            raise _group_not_found()
    else:
        gathering = await db.scalar(
            select(Gathering)
            .where(Gathering.id == place.gathering_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        if gathering is None or not await _in_invited_tier(db, gathering, ctx):
            raise _gathering_not_found()
    at = await db.scalar(
        select(Post.created_at).where(Post.id == through, _in_chat(place), _shown(place, _now()))
    )
    if at is None:
        raise _no_such_message()
    await mark_read(db, person_id, place.gathering_id, at, through)
    await db.commit()


@router.put("/groups/{group_id}/chat/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_group_chat_read(
    group_id: UUID,
    payload: ReadBody,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> None:
    place = await _group_place(db, ctx, group_id)
    await _mark(db, ctx, place, payload.through)


@router.put("/gatherings/{gathering_id}/chat/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_gathering_chat_read(
    gathering_id: UUID,
    payload: ReadBody,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> None:
    place = await _gathering_place(db, ctx, gathering_id)
    await _mark(db, ctx, place, payload.through)


# --- what is new ----------------------------------------------------------------------------


@router.get("/chats/new")
async def chats_with_something_new(
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    """The caller's own chats with something unread in them, by the two
    doors' own rules: a group by the membership and its window, a gathering
    by the invited tier. One they have never opened is here if anyone else
    has written in it. Ids alone, in one statement; no number, and no place
    of anyone's."""
    me, account_id = ctx.person.id, ctx.person.account_id
    Container = aliased(Gathering, name="container")

    def something_unread(gathering_id, *window):
        return exists(
            select(Post.id).where(
                Post.gathering_id == gathering_id,
                *window,
                _unread(me),
                or_(ChatReadPosition.person_id.is_(None), _past_position()),
            )
        )

    def mine(gathering_id):
        return and_(
            ChatReadPosition.person_id == me, ChatReadPosition.gathering_id == gathering_id
        )

    groups = (
        select(literal("group").label("place"), Membership.group_id.label("id"))
        .select_from(Membership)
        .join(
            Container,
            and_(
                Container.owning_group_id == Membership.group_id,
                Container.gathering_type == GatheringType.GROUP_MEDIA,
            ),
        )
        .outerjoin(ChatReadPosition, mine(Container.id))
        .where(
            Membership.person_id == me,
            something_unread(Container.id, Post.created_at >= Membership.created_at),
        )
    )
    gatherings = (
        select(literal("gathering").label("place"), Gathering.id.label("id"))
        .select_from(Gathering)
        .outerjoin(ChatReadPosition, mine(Gathering.id))
        .where(
            Gathering.gathering_type != GatheringType.GROUP_MEDIA,
            or_(
                Gathering.host_account_id == account_id,
                co_hosts_gathering(account_id, Gathering.id),
                exists(
                    select(GatheringInvitation.id).where(
                        GatheringInvitation.gathering_id == Gathering.id,
                        GatheringInvitation.person_id == me,
                    )
                ),
            ),
            something_unread(Gathering.id),
        )
    )
    both = union_all(groups, gatherings).subquery()
    rows = (await db.execute(select(both.c.place, both.c.id).order_by(both.c.place, both.c.id))).all()
    return {
        "groups": [str(row.id) for row in rows if row.place == "group"],
        "gatherings": [str(row.id) for row in rows if row.place == "gathering"],
    }


# --- one message's door ----------------------------------------------------------------------


async def _message_at_the_door(db: AsyncSession, ctx: AuthContext, message_id: UUID):
    """One item by its id, through its own chat's door and window, whatever
    its state: the row, and the gathering it is in (None for a group's chat).
    The 404 for anyone else, and for an id that names none."""
    found = (
        await db.execute(
            select(
                Post.kind,
                Post.created_at,
                Post.publication_state,
                Post.removed_at,
                Post.author_person_id,
                Gathering.id.label("gathering_id"),
                Gathering.gathering_type,
                Gathering.owning_group_id,
            )
            .select_from(Post)
            .join(Gathering, Gathering.id == Post.gathering_id)
            .where(Post.id == message_id)
        )
    ).one_or_none()
    if found is None:
        raise _no_such_message()

    if found.gathering_type == GatheringType.GROUP_MEDIA:
        # A group's chat: the caller's membership is the door and the window.
        window = await db.scalar(
            select(Membership.created_at).where(
                Membership.group_id == found.owning_group_id, Membership.person_id == ctx.person.id
            )
        )
        if window is None or found.created_at < window:
            raise _no_such_message()
        return found, None
    gathering = await db.get(Gathering, found.gathering_id)
    if gathering is None or not await _in_invited_tier(db, gathering, ctx):
        raise _no_such_message()
    if found.kind in SETTING_KINDS and not await _caller_in_group(db, ctx, found.owning_group_id):
        raise _no_such_message()
    return found, gathering


async def _runs_its_place(
    db: AsyncSession, ctx: AuthContext, found, gathering: Optional[Gathering]
) -> bool:
    if gathering is not None:
        return await may_administer(db, gathering, ctx)
    group = await db.get(Group, found.owning_group_id)
    return group is not None and await may_administer_group(db, group, ctx)


# --- reactions -------------------------------------------------------------------------------


async def _reactable(db: AsyncSession, ctx: AuthContext, message_id: UUID):
    """A live message the caller can read. A removed one is the 404 for
    everyone, the people who run the place included; a line the chat wrote
    takes no reaction."""
    found, _ = await _message_at_the_door(db, ctx, message_id)
    if found.publication_state != PublicationState.LIVE:
        raise _no_such_message()
    if found.kind != PostKind.MESSAGE:
        raise _refusal(409, "not_a_message", "A line the chat wrote itself takes no reactions.")
    return found


@router.put("/messages/{message_id}/reactions")
async def put_reaction(
    message_id: UUID,
    payload: ReactionBody,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    """Leave one kind of reaction on a message, or take it away: anyone who
    can read it, the writer included, one of each kind a person. Answers the
    message's reactions as the caller sees them. Asking for what is already
    so changes nothing and stamps nothing.

    GUARDED, never read-then-assign: the row is added, or taken, only where
    the message is still live, and the message's stamp moves in the same
    transaction only where it is live still — a removal at the same instant
    takes both back, and answers the 404."""
    person_id = ctx.person.id
    found = await _reactable(db, ctx, message_id)
    await _still_here(db, person_id)
    live = and_(Post.id == message_id, Post.publication_state == PublicationState.LIVE)
    if payload.on:
        changed = await db.execute(
            pg_insert(PostReaction)
            .from_select(
                ["post_id", "person_id", "kind"],
                select(Post.id, literal(person_id), literal(payload.kind, POST_REACTION_KIND)).where(live),
            )
            .on_conflict_do_nothing(index_elements=["post_id", "person_id", "kind"])
        )
    else:
        changed = await db.execute(
            delete(PostReaction)
            .where(
                PostReaction.post_id == message_id,
                PostReaction.person_id == person_id,
                PostReaction.kind == payload.kind,
                exists(select(Post.id).where(live)),
            )
            .execution_options(synchronize_session=False)
        )
    if changed.rowcount:
        stamped = await db.execute(
            update(Post)
            .where(live)
            .values(reactions_updated_at=func.clock_timestamp())
            .execution_options(synchronize_session=False)
        )
        if stamped.rowcount != 1:
            raise _no_such_message()  # removed at this instant; nothing is kept
    elif await db.scalar(select(Post.id).where(live)) is None:
        raise _no_such_message()
    marks = await db.scalar(select(_marks(person_id)).select_from(Post).where(Post.id == message_id))
    await db.commit()
    return {"reactions": _reactions(marks, found.gathering_type == GatheringType.MEMORIAL)}


@router.get("/messages/{message_id}/reactions")
async def who_reacted(
    message_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    """Who left each kind on a message, for anyone who can read it: names,
    the oldest first, and no number on any chat."""
    await _reactable(db, ctx, message_id)
    rows = (
        await db.execute(
            select(PostReaction.kind, Person.display_name)
            .join(Person, Person.id == PostReaction.person_id)
            .where(PostReaction.post_id == message_id)
            .order_by(PostReaction.created_at, PostReaction.person_id)
        )
    ).all()
    names: dict[PostReactionKind, list[str]] = {}
    for row in rows:
        names.setdefault(row.kind, []).append(row.display_name)
    return {
        "reactions": [
            {"kind": kind.value, "names": names[kind]} for kind in PostReactionKind if kind in names
        ]
    }


# --- deleting your own, removing another's ----------------------------------------------


@router.post("/messages/{message_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
async def remove_message(
    message_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> None:
    """The writer deletes their own live message in their window; the people
    who run the place remove anyone's in theirs. The remover recorded says
    which act it was. Everyone else draws the 404."""
    person_id = ctx.person.id
    now = _now()
    found, gathering = await _message_at_the_door(db, ctx, message_id)
    moderator = await _runs_its_place(db, ctx, found, gathering)

    if found.publication_state == PublicationState.REMOVED:
        held = moderator and found.removed_at > now - REMOVED_BIN
        if not held:
            raise _no_such_message()
    elif found.publication_state != PublicationState.LIVE:
        raise _no_such_message()
    if not moderator and found.author_person_id != person_id:
        raise _no_such_message()
    if found.kind != PostKind.MESSAGE:
        raise _refusal(409, "not_a_message", "A line the chat wrote itself can't be removed.")
    already = _refusal(409, "already_removed", "That message has already been removed.")
    if found.publication_state == PublicationState.REMOVED:
        raise already

    taken = await db.execute(
        update(Post)
        .where(Post.id == message_id, Post.publication_state == PublicationState.LIVE)
        .values(
            publication_state=PublicationState.REMOVED,
            removed_at=func.now(),
            removed_by_person_id=person_id,
        )
        .execution_options(synchronize_session=False)
    )
    if taken.rowcount != 1:
        # Lost the race: someone removed it first. For the people who run the
        # place it is now held, and they are told so; for a writer who does
        # not, it has left their chat. Nothing was written to roll back.
        if moderator:
            raise already
        raise _no_such_message()
    await db.commit()
