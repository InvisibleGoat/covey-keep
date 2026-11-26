"""How far a person has read in a chat, and what ends with their reading of it
(CK-104; decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §5,
§8; database-schema decision 55).

A READING POSITION is a place and never a time: the last item a person has
read in one chat, as the read's own order (an instant and an id). It is its
own person's and nobody else's: no answer carries another's, and there is no
"seen by". It only ever moves forward — `mark_read` is one upsert whose
update asks that the new place is later.

IT GOES WHEN THE READING DOES, so that coming back is a new window with no
position. `end_chat_access` is the ONE function that ends one person's hold
on one chat — the position, and the typing signal beside it. Every path that
ends a person's reading calls it in its own transaction, AFTER its own
delete of the row that let them in: leaving a group and being removed from
one (api/groups.py), a place moved off *invited* and the outside setting
turned off (api/gatherings.py), and a relinquished host holding no place of
their own (services/keeping.py::unkeep). The order matters. A mark takes a
share lock on that same row before it writes (api/chat.py), so either it
finds the row gone and is refused, or this delete waits for it and takes what
it wrote: nothing is left behind by two requests at once.

DELETING AN ACCOUNT ends every chat at once (`forget_in_every_chat`), by
person and not by access, because an account's deletion KEEPS the
memberships and the invitation rows, attributed to the anonymized row. It
takes the person's reactions too: a reaction has no words to keep, and its
name is gone.

The models, SQLAlchemy and the typing store only; no logger.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import delete, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatReadPosition, Post, PostReaction
from app.models.enums import PublicationState
from app.services import chat_typing
from app.services.group_chat import find_container


async def mark_read(
    db: AsyncSession, person_id: UUID, gathering_id: UUID, through_created_at: datetime, through_post_id: UUID
) -> None:
    """The person has read this chat through this item. One statement, and
    forward only: a place at or before the one held changes nothing. Never
    commits."""
    placed = pg_insert(ChatReadPosition).values(
        person_id=person_id,
        gathering_id=gathering_id,
        through_created_at=through_created_at,
        through_post_id=through_post_id,
    )
    await db.execute(
        placed.on_conflict_do_update(
            index_elements=["person_id", "gathering_id"],
            set_={
                "through_created_at": placed.excluded.through_created_at,
                "through_post_id": placed.excluded.through_post_id,
            },
            where=tuple_(placed.excluded.through_created_at, placed.excluded.through_post_id)
            > tuple_(ChatReadPosition.through_created_at, ChatReadPosition.through_post_id),
        )
    )


async def end_chat_access(db: AsyncSession, person_id: UUID, gathering_id: UUID) -> None:
    """One person can no longer read one chat: their place in it goes, and
    their typing signal with it. Called after the delete that ended it, in
    that delete's transaction. Never commits."""
    await db.execute(
        delete(ChatReadPosition).where(
            ChatReadPosition.person_id == person_id, ChatReadPosition.gathering_id == gathering_id
        )
    )
    chat_typing.store.drop(gathering_id, person_id)


async def end_group_chat_access(db: AsyncSession, person_id: UUID, group_id: UUID) -> None:
    """The same, for a group's chat: its container, if it has been made."""
    container: Optional[UUID] = await find_container(db, group_id)
    if container is not None:
        await end_chat_access(db, person_id, container)


async def forget_in_every_chat(db: AsyncSession, person_id: UUID) -> None:
    """An account is being deleted: every place it has read to, every
    reaction it left, and every typing signal, in the deletion's transaction
    and after the anonymization. The messages the reactions were on are
    stamped, so an open chat drops them at its next check; a held message's
    reactions are shown to nobody, so only a live one is. The messages are
    locked in the order of their ids first, so two accounts deleted at once
    take turns. Never commits."""
    await db.execute(delete(ChatReadPosition).where(ChatReadPosition.person_id == person_id))
    reacted_to = select(PostReaction.post_id).where(PostReaction.person_id == person_id)
    live = Post.publication_state == PublicationState.LIVE
    await db.execute(
        select(Post.id).where(Post.id.in_(reacted_to), live).order_by(Post.id).with_for_update(key_share=True)
    )
    await db.execute(
        update(Post)
        .where(Post.id.in_(reacted_to), live)
        .values(reactions_updated_at=func.clock_timestamp())
        .execution_options(synchronize_session=False)
    )
    await db.execute(delete(PostReaction).where(PostReaction.person_id == person_id))
    chat_typing.store.drop_person(person_id)
