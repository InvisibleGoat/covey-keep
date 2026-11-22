"""The end of a held message (CK-102; the chat record §6, Q2): at
`removed_at + REMOVED_BIN` the read criterion shows it to nobody, and the
worker's sweep then DELETES it — `services/destruction.py::
sweep_expired_messages(db, now)`, one statement, in the photo sweep's pass,
under `SWEEP_ENABLED`, once every `SWEEP_INTERVAL`. One INFO line naming the
count and nothing else; silence when there is none.

One statement where the photo sweep goes row by row: that sweep decrements
counters and queues destroy jobs, and this has neither. The module boundary
is unchanged — models and SQLAlchemy only (tests/test_destruction.py pins it
from the import graph).
"""

import asyncio
import logging
from datetime import timedelta
from uuid import UUID

from sqlalchemy import event, text

from app.db import engine
from app.services import destruction
from app.services.retention import REMOVED_BIN
from app.worker import SWEEP_INTERVAL, run
from tests.test_chat_container import _container
from tests.test_group_membership import ADMIN, MEMBER, _cast
from tests.test_worker import _Clock, worker, worker_settings  # noqa: F401 — the fixtures

_DELETE_PREDICATE = "DELETE FROM posts"


async def _world(client, capsys, db_session_factory, *, margin: timedelta = timedelta(0)) -> tuple[str, dict]:
    """A group's container holding: a live message, a held message
    `removed_at` exactly REMOVED_BIN ago (at its window), one held a second
    short of it, one held long past it, and a join-shaped line — every
    instant measured from `at`, a fixed now the caller passes to the sweep.
    A `margin` moves the two edge cases away from the edge — the one at the
    window that far past it, the one short of it that far short — for a
    driven worker, whose clock is its own. Returns (container id, {name:
    post id}, with `now` the instant `at`)."""
    cast = await _cast(client, capsys, db_session_factory)
    assert (await client.get(f"/groups/{cast.group_id}/chat", headers=cast.admin)).status_code == 200
    container = await _container(db_session_factory, cast.group_id)
    ids: dict = {}
    async with db_session_factory() as db:
        member = await db.scalar(text("SELECT id FROM people WHERE email = :e"), {"e": MEMBER})
        admin = await db.scalar(text("SELECT id FROM people WHERE email = :e"), {"e": ADMIN})
        at = await db.scalar(text("SELECT date_trunc('second', now())"))
        for name, state, removed_at in (
            ("live", "live", None),
            ("at the window", "removed", at - REMOVED_BIN - margin),
            ("a second short", "removed", at - REMOVED_BIN + timedelta(seconds=1) + margin),
            ("long past", "removed", at - REMOVED_BIN - timedelta(days=9)),
        ):
            ids[name] = await db.scalar(
                text(
                    "INSERT INTO posts (gathering_id, author_person_id, kind, body, publication_state, "
                    "removed_at, removed_by_person_id, created_at) "
                    "VALUES (:g, :a, 'message', :b, CAST(:s AS publication_state), :r, :by, :c) RETURNING id"
                ),
                {
                    "g": UUID(container),
                    "a": member,
                    "b": f"Words {name}",
                    "s": state,
                    "r": removed_at,
                    "by": admin if removed_at else None,
                    "c": at - REMOVED_BIN - timedelta(days=40),
                },
            )
        ids["line"] = await db.scalar(
            text(
                "INSERT INTO posts (gathering_id, author_person_id, kind, publication_state, created_at) "
                "VALUES (:g, :a, 'joined', 'live', :c) RETURNING id"
            ),
            {"g": UUID(container), "a": member, "c": at - REMOVED_BIN - timedelta(days=40)},
        )
        await db.commit()
    ids["now"] = at
    return container, ids


async def _surviving(db_session_factory, container: str) -> set[UUID]:
    async with db_session_factory() as db:
        return set((await db.execute(text("SELECT id FROM posts WHERE gathering_id = :g"), {"g": UUID(container)})).scalars())


async def test_the_sweep_deletes_a_held_message_at_its_window_and_keeps_one_a_second_short(
    client, capsys, db_session_factory
):
    container, ids = await _world(client, capsys, db_session_factory)
    now = ids["now"]
    async with db_session_factory() as db:
        assert await destruction.sweep_expired_messages(db, now) == 2
    assert await _surviving(db_session_factory, container) == {ids["live"], ids["a second short"], ids["line"]}
    async with db_session_factory() as db:
        assert await destruction.sweep_expired_messages(db, now) == 0
    async with db_session_factory() as db:
        assert await destruction.sweep_expired_messages(db, now + timedelta(seconds=1)) == 1
    assert await _surviving(db_session_factory, container) == {ids["live"], ids["line"]}


async def test_the_sweep_is_one_statement(client, capsys, db_session_factory):
    _, ids = await _world(client, capsys, db_session_factory)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        async with db_session_factory() as db:
            assert await destruction.sweep_expired_messages(db, ids["now"]) == 2
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)
    touching_posts = [s for s in statements if "posts" in s]
    assert len(touching_posts) == 1 and touching_posts[0].lstrip().startswith(_DELETE_PREDICATE), statements


async def _drive(db_session_factory, worker, *, sweep_enabled: bool, passes: int, caplog) -> list[str]:
    """Run the loop past `passes` idle sleeps, each crossing a whole
    SWEEP_INTERVAL; return every statement it sent."""
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    clock = _Clock()
    sleeps: list[float] = []
    stop = asyncio.Event()

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        clock.t += SWEEP_INTERVAL
        if len(sleeps) == passes:
            stop.set()

    caplog.set_level(logging.INFO, logger="covey-keep.worker")
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert await run(db_session_factory, worker, stop=stop, sleep=fake_sleep, sweep_enabled=sweep_enabled, clock=clock) == 0
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)
    return statements


async def test_with_the_switch_off_the_worker_deletes_no_message(client, capsys, db_session_factory, worker, caplog):
    container, ids = await _world(client, capsys, db_session_factory)
    before = await _surviving(db_session_factory, container)
    statements = await _drive(db_session_factory, worker, sweep_enabled=False, passes=4, caplog=caplog)
    assert statements, "the loop polled"
    assert not [s for s in statements if _DELETE_PREDICATE in s]
    assert await _surviving(db_session_factory, container) == before
    assert not [r for r in caplog.records if "message" in r.getMessage() and "sweep" in r.getMessage()]


async def test_with_the_switch_on_the_worker_deletes_them_in_the_sweeps_pass_with_one_line_naming_the_count(
    client, capsys, db_session_factory, worker, caplog
):
    container, ids = await _world(client, capsys, db_session_factory, margin=timedelta(hours=1))
    caplog.clear()
    statements = await _drive(db_session_factory, worker, sweep_enabled=True, passes=3, caplog=caplog)
    assert [s for s in statements if _DELETE_PREDICATE in s], "the sweep ran"
    assert await _surviving(db_session_factory, container) == {ids["live"], ids["a second short"], ids["line"]}
    lines = [r for r in caplog.records if r.name == "covey-keep.worker" and "message sweep" in r.getMessage()]
    assert len(lines) == 1, [r.getMessage() for r in lines]
    (line,) = lines
    assert line.levelno == logging.INFO
    assert line.getMessage() == "message sweep: 2 held message(s) deleted; their 30 days have passed"
    for banned in ("Words", container, str(ids["live"]), "member", "admin"):
        assert banned not in line.getMessage()


async def test_a_pass_with_nothing_held_past_its_window_says_nothing(client, capsys, db_session_factory, worker, caplog):
    await _cast(client, capsys, db_session_factory)
    caplog.clear()
    statements = await _drive(db_session_factory, worker, sweep_enabled=True, passes=2, caplog=caplog)
    assert [s for s in statements if _DELETE_PREDICATE in s], "the sweep ran"
    assert not [r for r in caplog.records if "message sweep" in r.getMessage()]


async def test_a_failing_message_sweep_is_logged_and_the_photo_sweep_and_the_worker_go_on(
    client, capsys, db_session_factory, worker, caplog, monkeypatch
):
    async def broken(db, now):
        raise RuntimeError("boom")

    monkeypatch.setattr(destruction, "sweep_expired_messages", broken)
    photo_passes: list[int] = []
    real_photo_sweep = destruction.sweep_expired_bin

    async def photo_sweep(db, now, *, limit):
        marked = await real_photo_sweep(db, now, limit=limit)
        photo_passes.append(marked)
        return marked

    monkeypatch.setattr(destruction, "sweep_expired_bin", photo_sweep)
    await _drive(db_session_factory, worker, sweep_enabled=True, passes=2, caplog=caplog)
    assert len(photo_passes) == 2
    errors = [r for r in caplog.records if r.name == "covey-keep.worker" and r.levelno == logging.ERROR]
    assert errors and all("message sweep" in r.getMessage() for r in errors)
