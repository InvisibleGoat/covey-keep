"""Who is typing in a chat, right now (CK-104;
decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §8.3, §18).

IN MEMORY, AND NOWHERE ELSE: one instant a person a chat, overwritten by the
next signal, read for `TYPING_WINDOW` seconds and then ignored — nothing is
stored, logged, sent or kept. The API runs one process, so one store is
every reader's; a second process would only ever show a person typing to
fewer people, never to more. A restart forgets everyone, who are typing again
at their next poll.

The signal rides on the chat's poll, in a header, so there is no typing route
and no address or access line says anyone typed (api/chat.py). The poll's own
door is the signal's door. An entry ends at once when its person sends in
that chat, when their reading of it ends, and when their account is deleted.

The standard library only, and no logger: nothing about typing is ever
written down. Every caller reaches the store as `chat_typing.store`, so a
test can stand its own clock in its place.
"""

import time
from typing import Callable
from uuid import UUID

# How long one signal is read for, in seconds. The client sends another while
# the person goes on writing.
TYPING_WINDOW = 6.0


class TypingStore:
    """Chats, to the people typing in each, to the instant of their newest
    signal. The clock is the process's monotonic one: the server's own, never
    the device's, and never a wall clock that can be set back."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._chats: dict[UUID, dict[UUID, float]] = {}

    def _forget_stale(self, now: float) -> None:
        for chat_id in list(self._chats):
            people = self._chats[chat_id]
            for person_id in [p for p, at in people.items() if now - at >= TYPING_WINDOW]:
                del people[person_id]
            if not people:
                del self._chats[chat_id]

    def note(self, chat_id: UUID, person_id: UUID) -> None:
        """This person is typing in this chat, as of now."""
        now = self._clock()
        self._forget_stale(now)
        self._chats.setdefault(chat_id, {})[person_id] = now

    def others(self, chat_id: UUID, person_id: UUID) -> list[UUID]:
        """The other people typing in this chat, the oldest signal first."""
        self._forget_stale(self._clock())
        signals = self._chats.get(chat_id, {})
        return sorted((p for p in signals if p != person_id), key=lambda p: signals[p])

    def drop(self, chat_id: UUID, person_id: UUID) -> None:
        """They sent, or can no longer read this chat."""
        people = self._chats.get(chat_id)
        if people is None:
            return
        people.pop(person_id, None)
        if not people:
            del self._chats[chat_id]

    def drop_person(self, person_id: UUID) -> None:
        """Their account is gone: every chat forgets them."""
        for chat_id in list(self._chats):
            self.drop(chat_id, person_id)

    def entries(self) -> int:
        """How many signals are held, across every chat."""
        return sum(len(people) for people in self._chats.values())


store = TypingStore()
