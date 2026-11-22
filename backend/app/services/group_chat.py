"""A group's chat container, and the lines the chat writes itself (CK-102;
decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §9, §14,
P1-P5; decisions/2026-09-02-group-chat-and-media.md §4).

A group's chat lives in ONE `group_media` gathering per group — the
CONTAINER — which holds the group's messages and nothing else: no host, no
keeper of its own, no date, no invitation row, no place row, no co-host, no
cover, no outside setting, `requires_approval` NULL. Every other way into a
gathering opens on a host, an invitation row, a place row or a date, so the
container is invisible to all of them with no change; the chat's own door
(api/chat.py::group_chat_window, the caller's MEMBERSHIP) is the only way in.

`container_for` is the ONE place a container is made, and never a migration:

- it looks without a lock and returns what it finds — the steady state, one
  index probe, no group lock;
- finding nothing, it takes the group's row lock (`SELECT … FOR UPDATE`),
  looks again — READ COMMITTED takes a fresh snapshot for that statement, so
  a container another transaction committed while this one waited is seen —
  and makes one only if there is still none.

At most one per group is made sure three ways, because no index or CHECK may
name a label added by `ALTER TYPE … ADD VALUE` (0038; the CK-71 Gotcha):
this lock, the verifier's line, and a staged race test.

It runs inside `POST /groups`'s own transaction (every new group is born with
its chat), and the first time an older group's chat is read or written or
someone joins it. In an admission it runs BEFORE the membership INSERT: an
INSERT referencing `groups` takes FOR KEY SHARE on the group's row, which
conflicts with FOR UPDATE, so two admissions that each inserted first would
each wait on the other — called first, the second waits on the first's lock
and then finds its container. It takes no photograph or cover-image lock, so
it adds no cycle to the cover order (photograph → subject → cover_images).

The models and SQLAlchemy only; no logger.
"""

from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Gathering, Group, Post
from app.models.enums import GatheringType, PostKind, PublicationState, RSVPListVisibility

# Fixed, and never shown in any body: nothing goes stale when the group is
# renamed, and no screen names the container.
CONTAINER_TITLE = "Group chat"


async def find_container(db: AsyncSession, group_id: UUID) -> Optional[UUID]:
    """The group's container's id, or None — one statement, no lock."""
    return await db.scalar(
        select(Gathering.id).where(
            Gathering.owning_group_id == group_id,
            Gathering.gathering_type == GatheringType.GROUP_MEDIA,
        )
    )


async def container_for(db: AsyncSession, group_id: UUID, account_id: UUID) -> UUID:
    """The group's container, made under the group's row lock if it is
    missing. `account_id` is the acting account, recorded as the
    container's `created_by_account_id` and nothing more. Never commits."""
    found = await find_container(db, group_id)
    if found is not None:
        return found
    await db.execute(select(Group.id).where(Group.id == group_id).with_for_update())
    found = await find_container(db, group_id)
    if found is not None:
        return found
    container = Gathering(
        created_by_account_id=account_id,
        owning_group_id=group_id,
        gathering_type=GatheringType.GROUP_MEDIA,
        title=CONTAINER_TITLE,
        # Explicit, as every create is (CK-16, CK-27, CK-77): nobody is
        # ever invited to the container, so neither is ever read.
        invitees_chosen=False,
        rsvp_list_visibility=RSVPListVisibility.INVITEES,
        # `requires_approval` deliberately unset (NULL — decision 33); no
        # host, no keeper of its own (the CHECK), no cover, no setting.
        publication_state=PublicationState.LIVE,
    )
    db.add(container)
    await db.flush()
    return container.id


async def write_join_line(
    db: AsyncSession, group_id: UUID, person_id: UUID, account_id: UUID
) -> None:
    """The join line (§9; Q3b): written by both ways into a group, in the
    transaction that writes the membership and BEFORE its INSERT (the module
    docstring's lock order), so it shares the membership's `now()` and the
    person who joined sees it. Into the group's container, made there if
    missing. Its author is the person who joined; it has no words, can never
    be removed (Q3a) and counts toward no limit. None at a group's creation
    and none backfilled; a person who comes back gets a second."""
    container = await container_for(db, group_id, account_id)
    db.add(
        Post(
            gathering_id=container,
            author_person_id=person_id,
            kind=PostKind.JOINED,
            publication_state=PublicationState.LIVE,
        )
    )


def setting_line(gathering_id: UUID, person_id: UUID, on: bool) -> Post:
    """The setting line (§9): `outside_invitations_on` or `_off`, into a
    group's gathering's chat, its author the person who changed the setting.
    The caller adds it in the setting's own transaction, under its lock, and
    only when the setting actually changed."""
    return Post(
        gathering_id=gathering_id,
        author_person_id=person_id,
        kind=PostKind.OUTSIDE_INVITATIONS_ON if on else PostKind.OUTSIDE_INVITATIONS_OFF,
        publication_state=PublicationState.LIVE,
    )
