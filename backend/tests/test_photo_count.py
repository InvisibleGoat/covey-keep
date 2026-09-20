"""CK-51a — the photograph count arrives, maintained and unread
(decisions/2026-09-20-photographs-are-the-currency.md 2.1.0 §3, §6; migration
0024). The EXPAND half of the quota's change of currency: `gatherings.
photo_count` exists, is backfilled from the ready rows, and is incremented
by the worker's publish transaction in the SAME UPDATE statement as
`total_bytes` — and NOTHING READS IT until CK-51b (the deploy-window split,
0024's docstring). The keeper-column indexes ride the migration.

What this file pins, and what fell out of building it:
- THE 0024 ROUND TRIP, in the test database, against planted rows: down to
  0023 (the column and both indexes gone, genuinely), rows planted at 0023
  by raw SQL — a gathering with ready rows (a removed-but-ready one among
  them), one with none, one with only rows that never reached `ready` —
  up to 0024 with the backfill correct against them and the INFO line
  naming the total, down again, up again to the same numbers;
- the publish transaction moves photo_count by EXACTLY ONE per photograph
  in ONE `UPDATE gatherings` statement that names both columns — counted
  at the cursor, not inferred — and a second session sees the count and
  the bytes move together at the instant of the delete;
- a removed photograph leaves BOTH columns unchanged (the decline path is
  pinned in test_review.py; here, the worker's own removed-row guard);
- a failed row — undecodable, dead-lettered on its first attempt — moves
  neither column (the missing-object and transient paths are pinned in
  test_worker.py beside their total_bytes assertions).

The migration runs in a worker thread: alembic's async env.py calls
`asyncio.run()` itself, which cannot happen on the session loop this suite
runs every test on; a thread has no running loop and leaves the session
loop untouched. Everything at 0023 is read and written with raw SQL — the
ORM maps `photo_count`, and a mapped column that does not exist is a crash,
not a finding.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import event, text

from app.db import engine
from app.models import Gathering, Media, MediaStatus, PublicationState
from app.services import keeping
from app.services.storage import quarantine_key
from app.worker import Poll, poll_once
from tests.test_keeping import _mk_account, _mk_gathering
from tests.test_worker import (
    GPS_PHOTO,
    RECLAIM_AFTER,
    FakeStore,
    _media,
    _now,
    _ready_state,
    worker,  # noqa: F401 — the fixture
    worker_settings,  # noqa: F401 — the fixture
)

BACKEND_DIR = Path(__file__).resolve().parent.parent

MIGRATION_LOGGER = "alembic.runtime.migration"


def _alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


async def _migrate(direction: str, target: str, capsys) -> list[str]:
    """Run one alembic command off the session loop, returning the INFO
    lines the migration itself logged — read from captured stderr, the way
    the suite reads console-mode magic links. Not from a handler: alembic's
    env.py re-runs fileConfig on every command, and fileConfig empties the
    handler list of every existing child of a configured logger
    (`alembic.runtime.migration` is a child of `alembic`), so a handler
    attached before the command is gone by the time the migration logs.
    The configured console handler writes to sys.stderr, which under capsys
    is the capture stream."""
    capsys.readouterr()  # start from empty
    cfg = _alembic_config()
    fn = {"upgrade": command.upgrade, "downgrade": command.downgrade}[direction]
    await asyncio.to_thread(fn, cfg, target)
    # The app's pool holds asyncpg connections whose prepared-statement
    # caches predate the DDL; dispose them so every later statement is
    # prepared against the schema as it now is (new connections are made
    # lazily — nothing else notices).
    await engine.dispose()
    prefix = f"INFO  [{MIGRATION_LOGGER}] "
    return [
        line[len(prefix):].rstrip()
        for line in capsys.readouterr().err.splitlines()
        if line.startswith(prefix)
    ]


async def _schema(db) -> tuple[str, bool, set[str]]:
    """(alembic head, photo_count present, the keeper-column indexes present)."""
    head = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
    column = (
        await db.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'gatherings' AND column_name = 'photo_count'"
            )
        )
    ).first()
    indexes = {
        row[0]
        for row in (
            await db.execute(
                text(
                    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                    "AND indexname IN ('ix_gatherings_keeper_account_id', 'ix_groups_keeper_account_id')"
                )
            )
        ).all()
    }
    return head, column is not None, indexes


BOTH_INDEXES = {"ix_gatherings_keeper_account_id", "ix_groups_keeper_account_id"}


async def test_0024_round_trip_backfills_the_count_and_the_downgrade_is_genuine(db_session_factory, capsys):
    """Down to 0023 — the column and both indexes gone. Rows planted THERE by
    raw SQL, so the backfill has subjects the column never saw: A holds two
    ready+pending rows, one ready+REMOVED row (it counts: the criterion is
    the rung, and the bin holds its layers), one `uploaded` row and one
    `failed` row → 3; B holds nothing → 0; C holds a `failed` row and a
    `pending_upload` row → 0. Up: the counts, the INFO line's total (3
    across 1 of 3), both indexes. Down: gone again. Up: the same numbers —
    up / down / up is idempotent, because the count is recomputed from
    `media` every time."""
    async with db_session_factory() as db:
        head, has_column, indexes = await _schema(db)
    assert head == "0024" and has_column and indexes == BOTH_INDEXES

    await _migrate("downgrade", "0023", capsys)
    async with db_session_factory() as db:
        head, has_column, indexes = await _schema(db)
        assert (head, has_column, indexes) == ("0023", False, set())

        # Planted at 0023, where the ORM cannot be used (it maps the column).
        account_id = (
            await db.execute(text("INSERT INTO accounts (kind) VALUES ('PERSON') RETURNING id"))
        ).scalar_one()
        ids = {}
        for key, title in (("A", "ready rows"), ("B", "no media"), ("C", "nothing ready")):
            ids[key] = (
                await db.execute(
                    text(
                        "INSERT INTO gatherings (created_by_account_id, keeper_account_id, "
                        "gathering_type, title, publication_state) "
                        "VALUES (:a, :a, 'potluck', :t, 'live') RETURNING id"
                    ),
                    {"a": account_id, "t": f"CK-51a round trip {key}: {title}"},
                )
            ).scalar_one()
        media = (
            ("A", "ready", "pending", None),
            ("A", "ready", "pending", None),
            ("A", "ready", "removed", datetime.now(timezone.utc) - timedelta(days=1)),
            ("A", "uploaded", "pending", None),
            ("A", "failed", "pending", None),
            ("C", "failed", "pending", None),
            ("C", "pending_upload", "pending", None),
        )
        for key, status, state, removed_at in media:
            # Honest rows: everything past pending_upload carries the stamp (0017).
            uploaded_at = None if status == "pending_upload" else datetime.now(timezone.utc)
            await db.execute(
                text(
                    "INSERT INTO media (gathering_id, guest_name, upload_content_type, "
                    "upload_size_bytes, status, publication_state, removed_at, uploaded_at) "
                    "VALUES (:g, 'fixture', 'image/jpeg', 1000, :s, :p, :r, :u)"
                ),
                {"g": ids[key], "s": status, "p": state, "r": removed_at, "u": uploaded_at},
            )
        await db.commit()

    lines = await _migrate("upgrade", "head", capsys)
    backfill = [m for m in lines if m.startswith("0024 backfilled gatherings.photo_count")]
    assert len(backfill) == 1, lines
    assert "3 photograph(s) across 1 of 3 gathering(s)" in backfill[0]
    assert backfill[0].isascii()
    # And it sits beside alembic's own line, on the same logger.
    assert any(m.startswith("Running upgrade 0023 -> 0024") for m in lines), lines

    async def counts() -> dict[str, int]:
        async with db_session_factory() as db:
            head, has_column, indexes = await _schema(db)
            assert (head, has_column, indexes) == ("0024", True, BOTH_INDEXES)
            rows = (
                await db.execute(
                    text("SELECT id, photo_count FROM gatherings WHERE id IN (:a, :b, :c)"),
                    {"a": ids["A"], "b": ids["B"], "c": ids["C"]},
                )
            ).all()
            by_id = {row[0]: row[1] for row in rows}
            return {key: by_id[ids[key]] for key in ("A", "B", "C")}

    assert await counts() == {"A": 3, "B": 0, "C": 0}

    # The downgrade is genuine, and the second upgrade recounts to the same
    # numbers — nothing about the count lives anywhere but `media`.
    await _migrate("downgrade", "0023", capsys)
    async with db_session_factory() as db:
        assert await _schema(db) == ("0023", False, set())
    lines = await _migrate("upgrade", "head", capsys)
    assert any("3 photograph(s) across 1 of 3 gathering(s)" in m for m in lines), lines
    assert await counts() == {"A": 3, "B": 0, "C": 0}

    # And the ORM sees what the migration wrote: the same rows through the
    # mapped column, the verifier's criterion agreeing with the backfill.
    async with db_session_factory() as db:
        assert (await db.get(Gathering, ids["A"])).photo_count == 3
        miscounted = (
            await db.execute(
                text(
                    "SELECT count(*) FROM gatherings g WHERE g.photo_count <> "
                    "(SELECT count(*) FROM media m WHERE m.gathering_id = g.id AND m.status = 'ready')"
                )
            )
        ).scalar_one()
        assert miscounted == 0


async def test_ready_moves_photo_count_by_one_in_the_statement_that_moves_total_bytes(
    db_session_factory, worker, monkeypatch
):
    """Two photographs on one gathering, published one after the other: the
    count reads 1 then 2 and the bytes move with it — and each publish
    issues EXACTLY ONE `UPDATE gatherings` statement, naming both columns.
    Counted at the cursor (a before_cursor_execute listener on the app's
    engine), because "one statement, both columns" is the whole reason the
    two cannot diverge, and a second statement beside the first would pass
    every value assertion here while breaking exactly that."""
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if "UPDATE gatherings" in statement:
            statements.append(statement)

    t0 = _now()
    async with db_session_factory() as db:
        keeper = await _mk_account(db)
        gathering = await _mk_gathering(db, host_account_id=keeper.id)
        await keeping.keep(db, keeper, gathering)  # its own UPDATE — before the listener
        first = _media(gathering.id, status=MediaStatus.UPLOADED, size=len(GPS_PHOTO), created_at=t0, available_at=t0)
        second = _media(
            gathering.id,
            status=MediaStatus.UPLOADED,
            size=len(GPS_PHOTO),
            created_at=t0 + timedelta(seconds=1),
            available_at=t0,
        )
        db.add_all([first, second])
        await db.commit()
        gathering_id, first_id, second_id = gathering.id, first.id, second.id
    FakeStore(monkeypatch, {quarantine_key(first_id): GPS_PHOTO, quarantine_key(second_id): GPS_PHOTO})

    # Listen from here: only the worker's polls run under the counter.
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
        _, first_layers, gathering = await _ready_state(db_session_factory, first_id)
        first_bytes = sum(d.size_bytes for d in first_layers)
        assert (gathering.total_bytes, gathering.photo_count) == (first_bytes, 1)
        assert len(statements) == 1, statements

        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
        _, second_layers, gathering = await _ready_state(db_session_factory, second_id)
        second_bytes = sum(d.size_bytes for d in second_layers)
        assert (gathering.total_bytes, gathering.photo_count) == (first_bytes + second_bytes, 2)
        assert len(statements) == 2, statements

        # One statement per publish, and it names both columns: the pin.
        for statement in statements:
            assert "total_bytes" in statement and "photo_count" in statement
        # Nothing else in the suite's write paths touches the row: idle
        # afterwards, and the count where the second publish left it.
        assert await poll_once(db_session_factory, worker, t0 + timedelta(hours=1)) is Poll.IDLE
        async with db_session_factory() as db:
            assert (await db.get(Gathering, gathering_id)).photo_count == 2
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def test_a_second_session_sees_the_count_and_the_bytes_move_together(
    db_session_factory, worker, monkeypatch
):
    """The same-transaction proof from outside: at the instant the original
    is deleted — after the ready commit — a second session already reads
    photo_count 1 beside the moved bytes. Before that commit both read
    zero (the guarded update is first in the transaction and nothing is
    visible until it commits); a crash between the two columns' writes is
    impossible because there is only one write."""
    t0 = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(gathering.id, status=MediaStatus.UPLOADED, size=len(GPS_PHOTO), available_at=t0)
        db.add(row)
        await db.commit()
        gathering_id, media_id = gathering.id, row.id
    store = FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})
    seen: list[tuple[int, int]] = []

    async def observe(key):
        async with db_session_factory() as db:
            g = await db.get(Gathering, gathering_id)
            seen.append((g.total_bytes, g.photo_count))

    store.on_delete = observe
    async with db_session_factory() as db:
        g = await db.get(Gathering, gathering_id)
        assert (g.total_bytes, g.photo_count) == (0, 0)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    assert len(seen) == 1
    total_bytes, photo_count = seen[0]
    assert total_bytes > 0 and photo_count == 1


async def test_a_failed_photograph_moves_neither_column(db_session_factory, worker, monkeypatch):
    """An undecodable upload dead-letters on its first attempt (CK-36), and
    the gathering's two columns are exactly where they were: the increment
    lives in the ready transaction alone, and a failed row never reaches
    it. Planted against a gathering that already holds a photograph, so
    "unchanged" is a real number and not zero-equals-zero."""
    t0 = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db, total_bytes=4321)
        gathering.photo_count = 3
        row = _media(gathering.id, status=MediaStatus.UPLOADED, size=64, available_at=t0)
        db.add(row)
        await db.commit()
        gathering_id, media_id = gathering.id, row.id
    FakeStore(monkeypatch, {quarantine_key(media_id): b"not a photograph at all"})

    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        assert row.status == MediaStatus.FAILED and row.attempts == 1
        assert row.publication_state == PublicationState.PENDING
        g = await db.get(Gathering, gathering_id)
        assert (g.total_bytes, g.photo_count) == (4321, 3)


async def test_a_removed_row_that_reaches_ready_counts_and_removal_itself_moves_nothing(
    db_session_factory, worker, monkeypatch
):
    """The criterion is the rung, never the publication state — the same
    statement the backfill and the verifier make. A stalled `processing`
    row already `removed` is re-claimed and published to `ready`
    (test_worker.py's removed-row guard): it holds its layers and its
    bytes, and it counts, so the verifier's invariant (photo_count equals
    the count of ready rows) holds on this shape too. The removal ACT — a
    decline through the API, `ready` + `pending` → `removed` — is pinned
    in test_review.py to leave both columns untouched."""
    t0 = _now()
    stale = t0 - RECLAIM_AFTER - timedelta(minutes=1)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(gathering.id, status=MediaStatus.PROCESSING, size=len(GPS_PHOTO), claimed_at=stale)
        row.publication_state = PublicationState.REMOVED
        row.removed_at = t0 - timedelta(hours=1)
        db.add(row)
        await db.commit()
        gathering_id, media_id = gathering.id, row.id
    FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, layers, gathering = await _ready_state(db_session_factory, media_id)
    assert (r.status, r.publication_state) == (MediaStatus.READY, PublicationState.REMOVED)
    assert (gathering.total_bytes, gathering.photo_count) == (sum(d.size_bytes for d in layers), 1)
    async with db_session_factory() as db:
        ready = (
            await db.execute(
                text("SELECT count(*) FROM media WHERE gathering_id = :g AND status = 'ready'"),
                {"g": gathering_id},
            )
        ).scalar_one()
        assert ready == 1 == gathering.photo_count
