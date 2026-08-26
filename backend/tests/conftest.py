"""Test bootstrap.

The environment is configured BEFORE anything imports app.config — Settings()
reads the environment at import time, and real env vars outrank backend/.env
values, so the suite never touches the dev database or needs a real .env.

The test database is dropped and recreated every run, then brought to Alembic
head — tests exercise the real migration-owned schema (0002 included), never a
create_all() shortcut.
"""

import asyncio
import os
import urllib.parse
from pathlib import Path

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://covey:covey@localhost:5434/covey_keep_test",
)
if "render.com" in TEST_DATABASE_URL:
    raise RuntimeError("Tests must never target a deployed database.")

os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["SESSION_SECRET"] = "test-session-secret-never-deployed"
os.environ["APP_BASE_URL"] = "http://localhost:5173"
os.environ["API_BASE_URL"] = "http://testserver"
os.environ["EMAIL_MODE"] = "console"

import asyncpg  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import async_session_factory  # noqa: E402
from app.main import app  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parent.parent


async def _recreate_test_db() -> None:
    parts = urllib.parse.urlsplit(TEST_DATABASE_URL)
    db_name = parts.path.lstrip("/")
    admin = await asyncpg.connect(
        user=parts.username,
        password=parts.password,
        host=parts.hostname,
        port=parts.port,
        database="postgres",
    )
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')
        await admin.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await admin.close()


@pytest.fixture(scope="session", autouse=True)
def migrated_test_db():
    asyncio.run(_recreate_test_db())
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    # Alembic's async env.py calls asyncio.run itself — this fixture stays sync.
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
async def clean_tables(migrated_test_db):
    # Per-test isolation matters here: the rate limit counts magic_link_tokens
    # rows over a 15-minute window, so leftovers would trip it across tests.
    # Since CK-16 the truncate includes `accounts`: gathering CRUD creates
    # accounts-anchored rows (gatherings, occurrences, kept_gatherings) that a
    # people-only truncate leaves behind — CASCADE from accounts takes the
    # whole keeper spine with it. (Seed rows — the capability profile, the
    # role ladder — reference neither table and survive, as they must.)
    async with async_session_factory() as db:
        await db.execute(text("TRUNCATE magic_link_tokens, people, accounts CASCADE"))
        await db.commit()
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
def db_session_factory():
    return async_session_factory
