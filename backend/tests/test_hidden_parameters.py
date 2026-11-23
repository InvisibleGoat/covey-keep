"""A database error never prints what a person wrote (CK-102's fix-up).

SQLAlchemy puts a failed statement's PARAMETERS in its exception's text, and
uvicorn logs an escaped exception's traceback, so until this fix-up a
connection the database dropped under a send — a restart is an ordinary
event — wrote the message's words to the API's log, and one dropped under a
sign-in request wrote the address. Both engines (`app/db.py`, the API's, and
`app/worker.py::_serve`, the worker's) are built with `hide_parameters=True`
since then, and the line reads `[SQL parameters hidden due to
hide_parameters=True]`.

THE DROP IS STAGED, NEVER TIMED (`tests/test_race_backstops.py::_stage`,
`before=True`): immediately before one of the route's own statements, a
second session terminates every other connection to the test database, so
that statement is the one that fails, with its parameters. Each test asserts
the hook fired. The engine is disposed afterwards, because every pooled
connection is dead by then.

WHAT IS READ IS WHAT UVICORN WOULD LOG: the escaped exception formatted by
`logging.Formatter.formatException`, the chain of causes included. A
traceback prints the source lines of the frames it names, this file's among
them, so the words looked for are joined at run time: a literal here would
read as a leak that isn't one.
"""

import ast
import logging
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.sql import Insert

from app.db import engine
from tests.test_auth import _request_link
from tests.test_group_membership import _cast
from tests.test_race_backstops import _select_from, _stage

APP_DIR = Path(__file__).resolve().parent.parent / "app"

WORD = "".join(["zz", "never", "logged", "word"])
ADDRESS = "".join(["zz", "never", "logged", "address", "@", "example.com"])
HIDDEN = "SQL parameters hidden due to hide_parameters=True"

# Every name that builds an engine. A call to one of these under `app/` must
# carry `hide_parameters=True`.
ENGINE_BUILDERS = {
    "create_engine",
    "create_async_engine",
    "engine_from_config",
    "async_engine_from_config",
}


def _insert_into(table: str):
    def when(statement) -> bool:
        return isinstance(statement, Insert) and statement.table.name == table

    return when


def _logged(exc: BaseException) -> str:
    """What uvicorn's error line would carry: it logs the escaped exception
    with `exc_info`, and the handler's formatter writes it."""
    return logging.Formatter().formatException((type(exc), exc, exc.__traceback__))


def _drop_every_other_connection(db_session_factory):
    async def drop() -> None:
        async with db_session_factory() as db:
            await db.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND pid <> pg_backend_pid()"
                )
            )

    return drop


# --- what a dropped connection writes ------------------------------------------------


async def test_a_send_whose_connection_drops_writes_none_of_its_words(
    client, capsys, db_session_factory, monkeypatch
):
    cast = await _cast(client, capsys, db_session_factory)
    opened = await client.get(f"/groups/{cast.group_id}/chat", headers=cast.member)
    assert opened.status_code == 200, opened.text
    words = f"{WORD} and the rest of a private message"
    staged = _stage(
        monkeypatch,
        when=_insert_into("posts"),
        competitor=_drop_every_other_connection(db_session_factory),
        before=True,
    )
    try:
        with pytest.raises(DBAPIError) as caught:
            await client.post(f"/groups/{cast.group_id}/chat", json={"body": words}, headers=cast.member)
    finally:
        await engine.dispose()
    assert staged["fired"]
    written = _logged(caught.value)
    assert "INSERT INTO posts" in written  # the error is the one staged
    assert WORD not in written
    # Its parameters are hidden, not merely missing: the absence is not vacuous.
    assert HIDDEN in written


async def test_a_sign_in_request_whose_connection_drops_writes_no_address(
    client, db_session_factory, monkeypatch
):
    staged = _stage(
        monkeypatch,
        when=_select_from("magic_link_tokens"),
        competitor=_drop_every_other_connection(db_session_factory),
        before=True,
    )
    try:
        with pytest.raises(DBAPIError) as caught:
            await _request_link(client, ADDRESS)
    finally:
        await engine.dispose()
    assert staged["fired"]
    written = _logged(caught.value)
    assert "FROM magic_link_tokens" in written
    assert ADDRESS not in written
    assert HIDDEN in written


# --- the two engines -------------------------------------------------------------------


def test_the_apis_engine_hides_its_parameters():
    assert engine.sync_engine.hide_parameters is True


def _engine_calls(tree: ast.AST):
    """Every call that builds an engine, with whether it hides its
    parameters. The syntax tree holds no comments and no strings' insides,
    so neither can pass for a call or hide one."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name not in ENGINE_BUILDERS:
            continue
        hidden = any(
            keyword.arg == "hide_parameters"
            and isinstance(keyword.value, ast.Constant)
            and keyword.value.value is True
            for keyword in node.keywords
        )
        yield node.lineno, hidden


def test_every_engine_in_the_application_hides_its_parameters():
    """The worker's engine is built inside `_serve`, so it is read from the
    syntax tree; a third engine built without the setting is caught here
    too. The scan is not vacuous: both of today's are found."""
    found: dict[str, list[tuple[int, bool]]] = {}
    for path in sorted(APP_DIR.rglob("*.py")):
        calls = list(_engine_calls(ast.parse(path.read_text(encoding="utf-8"))))
        if calls:
            found[path.relative_to(APP_DIR).as_posix()] = calls
    showing = [f"{name}:{line}" for name, calls in found.items() for line, hidden in calls if not hidden]
    assert showing == []
    for module in ("db.py", "worker.py"):
        assert len(found.get(module, [])) == 1, module
