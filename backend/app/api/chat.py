"""The chat (CK-102; decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md
§2, §3, §6, §9, §14, §18; Steven's answers of 2026-11-21) — the sixteenth
router. A group's chat and a gathering's: reading, polling, sending, and one
route for deleting your own message and removing someone else's.

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
counter): the people's names and the removers' are joined in it, and the
server computes no day. The poll reads `since` minus `CHAT_LOOKBACK`, so a
message whose transaction began before the last read and committed after it
is still found; the client drops repeats by id.

REMOVING is one guarded UPDATE where the row is still `live`, its rowcount
checked before the 204 (the CK-77.2 Gotcha) — never read-then-assign.

NO LOGGER, and none may be added: a message's words, its writer's name and a
chat's id are never logged (the record's §18). A message's words travel in a
request body, never in an address; and a database error under a send prints
none of them, because both engines hide a statement's parameters (app/db.py).
"""

import base64
import binascii
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, StringConstraints
from sqlalchemy import and_, func, insert, not_, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import AuthContext, get_auth_context, get_db
from app.api.gatherings import _field_422, _gathering_for_invited, _in_invited_tier, may_administer
from app.api.groups import _not_found as _group_not_found
from app.api.groups import may_administer_group
from app.models import Gathering, Group, Membership, Person, Post
from app.models.enums import GatheringType, PostKind, PublicationState
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
    invited), whether they run the place, and whether setting lines are
    drawn for them."""

    def __init__(self, gathering_id: UUID, window: Optional[datetime], moderator: bool, setting_lines: bool):
        self.gathering_id = gathering_id
        self.window = window
        self.moderator = moderator
        self.setting_lines = setting_lines


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
    return _Place(container, window, moderator, setting_lines=False)


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
    return _Place(gathering.id, None, moderator, setting_lines)


# --- reading -------------------------------------------------------------------------

Author = aliased(Person, name="author")
Remover = aliased(Person, name="remover")


def _columns():
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


def _item(row, ctx: AuthContext) -> dict:
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


def _parse_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        at_text, id_text = raw.split("|")
        at = datetime.fromisoformat(at_text)
        post_id = UUID(id_text)
    except (binascii.Error, UnicodeError, ValueError):
        raise _field_422("before", BAD_CURSOR, where="query") from None
    in_utc = None if at.tzinfo is None else _in_utc(at)
    if in_utc is None:
        raise _field_422("before", BAD_CURSOR, where="query")
    return in_utc, post_id


async def _read(
    db: AsyncSession,
    ctx: AuthContext,
    place: _Place,
    *,
    before: Optional[str],
    since: Optional[datetime],
    limit: int,
) -> dict:
    now = _now()
    shown = _shown(place, now)
    in_chat = _in_chat(place)
    if since is not None:
        return await _poll(db, ctx, place, since=since, now=now, shown=shown, in_chat=in_chat)
    statement = _from(select(*_columns())).where(in_chat, shown)
    if before is not None:
        at, post_id = _parse_cursor(before)
        statement = statement.where(tuple_(Post.created_at, Post.id) < tuple_(at, post_id))
    statement = statement.order_by(Post.created_at.desc(), Post.id.desc()).limit(limit + 1)
    rows = (await db.execute(statement)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    older = _cursor_of(rows[-1].created_at, rows[-1].id) if more else None
    return {
        "items": [_item(row, ctx) for row in reversed(rows)],
        "older": older,
        "as_of": now,
        "may_moderate": place.moderator,
    }


async def _poll(db: AsyncSession, ctx: AuthContext, place: _Place, *, since, now, shown, in_chat) -> dict:
    """Everything in the window created, or changed, at or after `since`
    minus the lookback — each row SHOWN is an item, each that is not is the
    id of one that left the caller's chat in the span: removed (for anyone
    who does not run the place), or past its hold (for those who do)."""
    reach = since - CHAT_LOOKBACK
    if place.moderator:
        left_in_span = Post.removed_at > reach - REMOVED_BIN
    else:
        left_in_span = Post.removed_at >= reach
    changed = or_(
        and_(shown, or_(Post.created_at >= reach, Post.removed_at >= reach)),
        and_(not_(shown), left_in_span),
    )
    statement = (
        _from(select(*_columns(), shown.label("shown")))
        .where(in_chat, changed)
        .order_by(Post.created_at, Post.id)
        .limit(POLL_MAX + 1)
    )
    rows = (await db.execute(statement)).all()
    base = {"as_of": now, "may_moderate": place.moderator}
    if len(rows) > POLL_MAX:
        return {"items": [], "removed": [], "truncated": True, **base}
    return {
        "items": [_item(row, ctx) for row in rows if row.shown],
        "removed": [str(row.id) for row in rows if not row.shown],
        "truncated": False,
        **base,
    }


def _read_query(
    before: Optional[str] = Query(None),
    since: Optional[AwareDatetime] = Query(None),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> dict:
    if before is not None and since is not None:
        raise _field_422("before", BOTH_CURSORS, where="query")
    if before is not None:
        _parse_cursor(before)  # refused before any door is asked
    if since is not None:
        since = _in_utc(since)
        if since is None:
            raise _field_422("since", BAD_SINCE, where="query")
    return {"before": before, "since": since, "limit": limit}


@router.get("/groups/{group_id}/chat")
async def read_group_chat(
    group_id: UUID,
    query: dict = Depends(_read_query),
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _group_place(db, ctx, group_id)
    return await _read(db, ctx, place, **query)


@router.get("/gatherings/{gathering_id}/chat")
async def read_gathering_chat(
    gathering_id: UUID,
    query: dict = Depends(_read_query),
    db: AsyncSession = Depends(get_db),
    ctx: AuthContext = Depends(get_auth_context),
) -> dict:
    place = await _gathering_place(db, ctx, gathering_id)
    return await _read(db, ctx, place, **query)


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
    return {
        "id": str(post_id),
        "kind": PostKind.MESSAGE.value,
        "created_at": created_at,
        "author": {"display_name": display_name, "is_self": True},
        "body": body,
        "removed": None,
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
                Membership.group_id == found.owning_group_id, Membership.person_id == person_id
            )
        )
        if window is None or found.created_at < window:
            raise _no_such_message()
        group = await db.get(Group, found.owning_group_id)
        moderator = group is not None and await may_administer_group(db, group, ctx)
    else:
        gathering = await db.get(Gathering, found.gathering_id)
        if gathering is None or not await _in_invited_tier(db, gathering, ctx):
            raise _no_such_message()
        if found.kind in SETTING_KINDS and not await _caller_in_group(db, ctx, found.owning_group_id):
            raise _no_such_message()
        moderator = await may_administer(db, gathering, ctx)

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
