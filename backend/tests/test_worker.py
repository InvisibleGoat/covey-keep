"""CK-35 — the ingest worker: claim, reclaim, retry, and the permanent
failure — and the config split that lets it boot without the web
credentials. CK-36 — the publish transaction: read, decode, strip, write
three layers, `ready` in one transaction, and the original deleted only
after that commit.

No network anywhere in this file: the worker's four blocking storage calls
are stubbed at `app.services.ingest._head/_read/_put/_delete` (the CK-34
pattern — `FakeStore` below is an in-memory pair of buckets), and the
WorkerSettings under test point at a reserved TLD. Everything else is real:
real rows in the migrated test database, a real `FOR UPDATE SKIP LOCKED`
across two sessions, a real missing column for the schema-not-ready case, a
real subprocess for the boot-with-six-variables case — and a REAL
photograph carrying EXIF GPS (`tests/fixtures/media/gps-oriented.jpg`)
through the real decoder, so the publish tests assert on layers the
pipeline genuinely produced.

The load-bearing pins (the kickoff's list, and what fell out of building it):
- a `pending_upload` row is NEVER claimed — nor a fresh `processing` row, a
  `ready` row, a `failed` row, or an `uploaded` row whose available_at is
  still in the future;
- two workers racing take different rows and never the same one;
- a stalled `processing` row is re-claimed, the abandoned attempt counted,
  and a row abandoned three times is dead-lettered at reclaim;
- a missing object dead-letters on the FIRST attempt (attempts = 1, never
  3), and its original is (harmlessly) deleted after that commit;
- a transient error climbs the ladder (1m, 5m) and dead-letters on the
  third; a rejected credential is a THIRD class that touches the row not
  at all and backs the loop off;
- THE PUBLISH TRANSACTION (CK-36): a present object is read, decoded,
  stripped and rendered; three objects land in the published bucket under
  deterministic keys with the right class and type; the row goes to
  `ready` with three derivative rows and `gatherings.total_bytes` moved by
  their actual sum, in ONE commit; `publication_state` stays `pending`;
  the reservation releases at `ready` through the one quota path; and the
  original is deleted ONLY AFTER that commit — observed from a second
  session at the moment of the delete;
- a re-processed row does not trip the derivative unique constraint; a
  delete of an absent original is a success; a delete that fails after the
  commit leaves the row `ready`; a claim lost to a reclaim writes nothing;
- an undecodable upload and an oversized one dead-letter on the FIRST
  attempt with the original deleted; a write failure is transient; a
  rejected credential on the write releases the row; an object taken by
  the lifecycle rule between the HEAD and the GET is the permanent case;
- dead-lettering releases the quota reservation through the one quota path;
- a missing-field ValidationError on either settings class never echoes
  the values that were present (hide_input_in_errors — the CK-36 rider);
- the worker retries rather than crash-loops against a schema missing a
  media column;
- WorkerSettings has no field for the upload or serve credential, Settings
  none for the worker's, and the worker's import graph constructs neither
  the web settings nor the web engine — booted for real in a subprocess
  with exactly six variables set.
"""

import asyncio
import io
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from PIL import ExifTags, Image
from pydantic import ValidationError
from sqlalchemy import func, select, text, update

from app.config import Settings, WorkerSettings, settings
from app.db import engine
from app.models import (
    Account,
    Gathering,
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    PublicationState,
)
from app.services import ingest, keeping, storage
from app.services.ingest import (
    ERROR_ABANDONED,
    ERROR_OBJECT_MISSING,
    MAX_ATTEMPTS,
    RECLAIM_AFTER,
    RETRY_BACKOFF,
    Outcome,
    claim_next,
    handle_claimed,
)
from app.services.processing import (
    STORAGE_CLASS_INFREQUENT_ACCESS,
    STORAGE_CLASS_STANDARD,
    render_layers,
)
from app.services.storage import (
    ServeClient,
    UploadClient,
    WorkerClient,
    head_quarantine_object,
    presign_read,
    presign_upload,
    published_key,
    quarantine_key,
    worker_client,
)
from app.worker import IDLE_JITTER, IDLE_POLL, Poll, poll_once, run
from tests.conftest import TEST_DATABASE_URL
from tests.test_keeping import _mk_account, _mk_gathering

BACKEND_DIR = Path(__file__).resolve().parent.parent
MB = 1_000_000

# A real photograph carrying EXIF GPS and an orientation tag (see
# tests/fixtures/media/make_fixtures.py for its provenance).
GPS_PHOTO = (BACKEND_DIR / "tests" / "fixtures" / "media" / "gps-oriented.jpg").read_bytes()

# The worker's six, and exactly six — on a reserved TLD, so nothing here
# could ever reach a real endpoint.
WORKER_ENV = {
    "DATABASE_URL": TEST_DATABASE_URL,
    "R2_ENDPOINT_URL": "https://r2.invalid",
    "R2_BUCKET_QUARANTINE": "test-quarantine",
    "R2_BUCKET_PUBLISHED": "test-published",
    "R2_WORKER_ACCESS_KEY_ID": "test-worker-key-id",
    "R2_WORKER_SECRET_ACCESS_KEY": "test-worker-secret-never-deployed",
}
SIX = frozenset(name.lower() for name in WORKER_ENV)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def worker_settings() -> WorkerSettings:
    return WorkerSettings(_env_file=None, **{k.lower(): v for k, v in WORKER_ENV.items()})


@pytest.fixture
def worker(worker_settings) -> WorkerClient:
    return worker_client(worker_settings)


def _media(
    gathering_id,
    *,
    status: MediaStatus,
    size: int = MB,
    created_at: datetime | None = None,
    available_at: datetime | None = None,
    claimed_at: datetime | None = None,
    attempts: int = 0,
    last_error: str | None = None,
) -> Media:
    born = created_at or _now()
    return Media(
        gathering_id=gathering_id,
        guest_name="fixture",
        upload_content_type="image/jpeg",
        upload_size_bytes=size,
        status=status,
        publication_state=PublicationState.PENDING,
        created_at=born,
        # Honest rows: everything past pending_upload carries the stamp (0017).
        uploaded_at=None if status == MediaStatus.PENDING_UPLOAD else born,
        available_at=available_at,
        claimed_at=claimed_at,
        attempts=attempts,
        last_error=last_error,
    )


def _stub_head(monkeypatch, result=None, *, raises: Exception | None = None):
    """The HEAD-only stub (CK-35's tests): the object is absent, or the
    HEAD fails. Reads and writes must not happen on those paths, so they
    are stubbed to fail loudly; the delete after a dead-letter is recorded
    and succeeds."""

    async def fake_head(client, key):
        fake_head.calls.append((client, key))
        if raises is not None:
            raise raises
        return result

    async def never(*args, **kwargs):
        raise AssertionError("no read or write may happen on this path")

    async def fake_delete(client, key):
        fake_head.deletes.append(key)

    fake_head.calls = []
    fake_head.deletes = []
    monkeypatch.setattr(ingest, "_head", fake_head)
    monkeypatch.setattr(ingest, "_read", never)
    monkeypatch.setattr(ingest, "_put", never)
    monkeypatch.setattr(ingest, "_delete", fake_delete)
    return fake_head


class FakeStore:
    """Two in-memory buckets behind the four names ingest.py runs off the
    event loop. `raise_on[stage]` makes one stage fail; `on_delete` runs at
    the moment of the delete (to observe the database from a second
    session — the ordering pin)."""

    def __init__(self, monkeypatch, quarantine: dict[str, bytes] | None = None):
        self.quarantine: dict[str, bytes] = dict(quarantine or {})
        self.published: dict[str, tuple[bytes, str, str]] = {}
        self.calls: list[tuple[str, str]] = []
        self.raise_on: dict[str, Exception] = {}
        self.on_delete = None
        monkeypatch.setattr(ingest, "_head", self._head)
        monkeypatch.setattr(ingest, "_read", self._read)
        monkeypatch.setattr(ingest, "_put", self._put)
        monkeypatch.setattr(ingest, "_delete", self._delete)

    def _maybe_raise(self, stage: str) -> None:
        if stage in self.raise_on:
            raise self.raise_on[stage]

    async def _head(self, client, key):
        self.calls.append(("head", key))
        self._maybe_raise("head")
        data = self.quarantine.get(key)
        return None if data is None else (len(data), "image/jpeg")

    async def _read(self, client, key):
        self.calls.append(("read", key))
        self._maybe_raise("read")
        if key not in self.quarantine:
            raise _client_error("NoSuchKey", 404)
        return self.quarantine[key]

    async def _put(self, client, key, rendition):
        self.calls.append(("put", key))
        self._maybe_raise("put")
        self.published[key] = (rendition.data, rendition.content_type, rendition.storage_class)

    async def _delete(self, client, key):
        self.calls.append(("delete", key))
        if self.on_delete is not None:
            await self.on_delete(key)
        self._maybe_raise("delete")
        self.quarantine.pop(key, None)

    def stages(self) -> list[str]:
        return [stage for stage, _ in self.calls]


def _client_error(code: str, status: int) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "stub"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "HeadObject",
    )


async def _row(db_session_factory, media_id) -> Media:
    async with db_session_factory() as db:
        return await db.get(Media, media_id)


async def _uploaded_row(db_session_factory, **overrides) -> Media:
    """One claimable row on a fresh gathering, committed."""
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(gathering.id, status=MediaStatus.UPLOADED, **overrides)
        db.add(row)
        await db.commit()
        return row


# --- the config split (step 1) ------------------------------------------------


def test_worker_settings_expose_no_web_credential_and_settings_no_worker_credential(monkeypatch):
    # Structural, on the field lists: the worker cannot reach R2_UPLOAD_* or
    # R2_SERVE_* even by mistake, and the web service cannot reach
    # R2_WORKER_* — neither class has the field.
    assert set(WorkerSettings.model_fields) == SIX
    for name in WorkerSettings.model_fields:
        assert "upload" not in name and "serve" not in name and "session" not in name, name
    assert not any("worker" in name for name in Settings.model_fields)

    # Even with the web credentials IN the worker's environment, the worker
    # settings carry nothing of them (extra="ignore" — the value is unread).
    for name in ("R2_UPLOAD_ACCESS_KEY_ID", "R2_SERVE_ACCESS_KEY_ID", "SESSION_SECRET"):
        monkeypatch.setenv(name, "would-be-a-leak")
    for name, value in WORKER_ENV.items():
        monkeypatch.setenv(name, value)
    built = WorkerSettings(_env_file=None)
    assert not hasattr(built, "r2_upload_access_key_id")
    assert not hasattr(built, "r2_serve_access_key_id")
    assert not hasattr(built, "session_secret")
    assert built.r2_worker_access_key_id == "test-worker-key-id"
    # Render's bare scheme is normalised exactly as the web settings do it.
    assert built.database_url.startswith("postgresql+asyncpg://")


def test_worker_settings_are_required_with_no_default(monkeypatch):
    # The web Settings' own rule: an empty value can only mean misconfigured,
    # and it fails at boot naming every missing field.
    for name in WORKER_ENV:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as excinfo:
        WorkerSettings(_env_file=None)
    missing = {tuple(err["loc"])[0] for err in excinfo.value.errors() if err["type"] == "missing"}
    assert missing == SIX


def test_a_missing_field_error_never_echoes_the_values_that_were_present(monkeypatch):
    """The CK-36 rider. Pydantic's missing-field ValidationError renders
    `input_value=<the raw dict>` — every variable that WAS set — and a
    deploy log is where it lands; CK-33's first deploy printed 22 hex
    characters of a live credential's tail that way. hide_input_in_errors
    on both classes; the field is still named."""
    secret = "sk-would-be-in-a-deploy-log-315f563a948a5de1c631c6"
    for name in WORKER_ENV:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as excinfo:
        WorkerSettings(
            _env_file=None,
            database_url=f"postgresql://covey:{secret}@db.internal/covey",
            r2_worker_secret_access_key=secret,
        )
    rendered = str(excinfo.value) + repr(excinfo.value)
    assert secret not in rendered
    assert "db.internal" not in rendered
    assert "input_value" not in rendered
    assert "r2_worker_access_key_id" in rendered  # the missing field is still named

    monkeypatch.delenv("API_BASE_URL", raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, session_secret=secret)
    rendered = str(excinfo.value) + repr(excinfo.value)
    assert secret not in rendered
    assert "input_value" not in rendered
    assert "api_base_url" in rendered


def test_worker_boots_with_only_its_six_variables():
    """The kickoff's hard gate, run for real: a fresh interpreter with exactly
    the six worker variables — no SESSION_SECRET, no R2_UPLOAD_*, no
    R2_SERVE_* — imports the worker without constructing the web Settings
    or the web engine, and `--once` boots, polls the (empty) test database,
    and exits 0. If the worker ever needs a web value, this fails."""
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(WORKER_ENV)

    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, app.config, app.worker; "
            "print('settings' in vars(app.config), 'app.db' in sys.modules)",
        ],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.split() == ["False", "False"], probe.stdout

    boot = subprocess.run(
        [sys.executable, "-m", "app.worker", "--once"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert boot.returncode == 0, boot.stdout + boot.stderr
    assert "ingest worker starting" in boot.stdout
    assert "ingest worker stopped" in boot.stdout
    # Buckets are logged; the key id and the secret never are.
    assert "test-quarantine" in boot.stdout
    for secret in ("test-worker-key-id", "test-worker-secret-never-deployed"):
        assert secret not in boot.stdout + boot.stderr


def test_the_web_settings_are_still_required_at_the_web_services_boot():
    # The lazy singleton changed WHEN the web Settings are built, never
    # WHETHER: a fresh interpreter importing the web app with the web
    # surface absent still fails at import naming the missing fields.
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(WORKER_ENV)  # the worker's six are not enough for the web service
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "from app.config import Settings\n"
            "try:\n"
            "    Settings(_env_file=None)\n"
            "except Exception as exc:\n"
            "    print(type(exc).__name__)\n",
        ],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == "ValidationError"


# --- the third client type ---------------------------------------------------


def test_worker_client_is_a_third_type_that_presigns_nothing(worker, worker_settings):
    assert isinstance(worker, WorkerClient)
    assert not isinstance(worker, (UploadClient, ServeClient))
    assert worker.quarantine_bucket == "test-quarantine"
    assert worker.published_bucket == "test-published"
    # The worker has no caller to authorise and never mints a URL: both
    # presign functions refuse it as a TypeError, the CK-33 shape.
    with pytest.raises(TypeError, match="UploadClient"):
        presign_upload(worker, key="k", content_length=1, content_type="image/jpeg")
    with pytest.raises(TypeError, match="ServeClient"):
        presign_read(worker, key="k")
    # The serve credential is still refused on quarantine, as it always was.
    with pytest.raises(TypeError, match="UploadClient"):
        head_quarantine_object(storage.serve_client(settings), key="k")
    # The web Settings cannot build a worker client — they have no field for it.
    with pytest.raises(TypeError, match="WorkerSettings"):
        worker_client(settings)  # type: ignore[arg-type]
    # No module-level default of ANY of the three types.
    for name in dir(storage):
        value = getattr(storage, name)
        assert not isinstance(value, (UploadClient, ServeClient, WorkerClient)), name
    # The repr shows buckets and never a key id or the endpoint.
    shown = repr(worker)
    assert "test-quarantine" in shown and "test-published" in shown
    assert "test-worker-key-id" not in shown and "r2.invalid" not in shown


def test_the_records_numbers_and_that_the_release_branch_is_gone():
    assert RECLAIM_AFTER == timedelta(minutes=15)
    assert MAX_ATTEMPTS == 3
    assert RETRY_BACKOFF == (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=15))
    assert IDLE_POLL == 5.0
    # CK-35's scaffolding — "object present, no processor, release for an
    # hour" — had a stated expiry, and this is it: no constant, no outcome,
    # no branch. A present object is processed.
    assert "NO_PROCESSOR_RECHECK" not in vars(ingest)
    assert not hasattr(Outcome, "RELEASED")
    assert Outcome.READY.value == "ready"
    # And the worker now deletes — through the one storage module, after
    # a commit (the ordering tests below), never anywhere else.
    assert ingest.delete_quarantine_object is storage.delete_quarantine_object
    assert ingest.read_quarantine_object is storage.read_quarantine_object
    assert ingest.put_published_object is storage.put_published_object


# --- claim -----------------------------------------------------------------------


async def test_pending_upload_rows_are_never_claimed(db_session_factory):
    now = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        rows = {
            "pending_no_available": _media(gathering.id, status=MediaStatus.PENDING_UPLOAD),
            "pending_available": _media(
                gathering.id, status=MediaStatus.PENDING_UPLOAD, available_at=now - timedelta(hours=1)
            ),
            "fresh_processing": _media(
                gathering.id, status=MediaStatus.PROCESSING, claimed_at=now - timedelta(minutes=1)
            ),
            "ready": _media(gathering.id, status=MediaStatus.READY),
            "failed": _media(gathering.id, status=MediaStatus.FAILED, last_error="fixture"),
            "uploaded_later": _media(
                gathering.id, status=MediaStatus.UPLOADED, available_at=now + timedelta(hours=1)
            ),
        }
        db.add_all(rows.values())
        await db.commit()
        before = {name: (r.status, r.claimed_at, r.attempts) for name, r in rows.items()}
        ids = {name: r.id for name, r in rows.items()}

    async with db_session_factory() as db:
        assert await claim_next(db, now) is None
        await db.commit()

    # Then one claimable row, and only it is taken.
    async with db_session_factory() as db:
        claimable = _media(gathering.id, status=MediaStatus.UPLOADED, available_at=now)
        db.add(claimable)
        await db.commit()
        claimable_id = claimable.id
    async with db_session_factory() as db:
        claimed = await claim_next(db, now)
        assert claimed is not None and claimed.id == claimable_id
        await db.commit()

    async with db_session_factory() as db:
        for name, media_id in ids.items():
            row = await db.get(Media, media_id)
            assert (row.status, row.claimed_at, row.attempts) == before[name], name


async def test_claim_takes_the_oldest_claimable_row_and_stamps_it(db_session_factory):
    now = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        newer = _media(gathering.id, status=MediaStatus.UPLOADED, created_at=now - timedelta(minutes=1), available_at=now)
        # Oldest first — and `available_at IS NULL` counts as claimable.
        older = _media(gathering.id, status=MediaStatus.UPLOADED, created_at=now - timedelta(minutes=2))
        db.add_all([newer, older])
        await db.commit()
        older_id, newer_id = older.id, newer.id

    async with db_session_factory() as db:
        claimed = await claim_next(db, now)
        await db.commit()
    assert claimed.id == older_id
    assert claimed.status == MediaStatus.PROCESSING
    assert claimed.claimed_at == now
    assert claimed.attempts == 0  # a fresh claim counts nothing
    row = await _row(db_session_factory, older_id)
    assert (row.status, row.claimed_at, row.attempts) == (MediaStatus.PROCESSING, now, 0)
    assert (await _row(db_session_factory, newer_id)).status == MediaStatus.UPLOADED


async def test_two_workers_racing_claim_different_rows(db_session_factory):
    # SKIP LOCKED is the whole reason two workers can share one queue: the
    # second claim, made while the first's transaction still holds its row,
    # takes the OTHER row; a third finds nothing.
    now = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        first = _media(gathering.id, status=MediaStatus.UPLOADED, created_at=now - timedelta(minutes=2))
        second = _media(gathering.id, status=MediaStatus.UPLOADED, created_at=now - timedelta(minutes=1))
        db.add_all([first, second])
        await db.commit()
        first_id, second_id = first.id, second.id

    async with db_session_factory() as a, db_session_factory() as b, db_session_factory() as c:
        claimed_a = await claim_next(a, now)
        claimed_b = await claim_next(b, now)
        claimed_c = await claim_next(c, now)
        assert claimed_a.id == first_id
        assert claimed_b.id == second_id
        assert claimed_c is None
        await a.commit()
        await b.commit()
        await c.commit()

    for media_id in (first_id, second_id):
        row = await _row(db_session_factory, media_id)
        assert row.status == MediaStatus.PROCESSING and row.claimed_at == now


# --- reclaim -------------------------------------------------------------------


async def test_a_stalled_processing_row_is_reclaimed_and_the_abandoned_attempt_counted(
    db_session_factory,
):
    now = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        recent = _media(
            gathering.id, status=MediaStatus.PROCESSING, claimed_at=now - RECLAIM_AFTER + timedelta(minutes=1)
        )
        db.add(recent)
        await db.commit()
        recent_id = recent.id
    # Fourteen minutes in: a worker may still be on it.
    async with db_session_factory() as db:
        assert await claim_next(db, now) is None
        await db.commit()

    async with db_session_factory() as db:
        stalled = _media(
            gathering.id, status=MediaStatus.PROCESSING, claimed_at=now - RECLAIM_AFTER - timedelta(minutes=1)
        )
        db.add(stalled)
        await db.commit()
        stalled_id = stalled.id
    # Sixteen minutes in: the deploy killed that worker (record §8). A
    # RE-CLAIM — the same row, its provenance intact — with the abandoned
    # attempt counted.
    async with db_session_factory() as db:
        claimed = await claim_next(db, now)
        await db.commit()
    assert claimed.id == stalled_id
    row = await _row(db_session_factory, stalled_id)
    assert row.status == MediaStatus.PROCESSING
    assert row.claimed_at == now
    assert row.attempts == 1
    assert (await _row(db_session_factory, recent_id)).attempts == 0


async def test_a_row_abandoned_three_times_is_dead_lettered_at_reclaim(db_session_factory):
    # Two attempts already counted, the third claim stalled: a row that
    # keeps killing the worker must not get a fourth run — that is a crash
    # loop by another name.
    now = _now()
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(
            gathering.id,
            status=MediaStatus.PROCESSING,
            claimed_at=now - RECLAIM_AFTER - timedelta(minutes=1),
            attempts=MAX_ATTEMPTS - 1,
        )
        db.add(row)
        await db.commit()
        media_id = row.id
    async with db_session_factory() as db:
        claimed = await claim_next(db, now)
        await db.commit()
    assert claimed.id == media_id
    row = await _row(db_session_factory, media_id)
    assert row.status == MediaStatus.FAILED
    assert row.attempts == MAX_ATTEMPTS
    assert row.claimed_at is None
    assert row.last_error == ERROR_ABANDONED
    # The loop reports it as work done, not as a row to handle: nothing is
    # claimable afterwards.
    async with db_session_factory() as db:
        assert await claim_next(db, now) is None
        await db.commit()


# --- the outcomes: missing, present, transient, rejected credential, lost ----


async def test_a_missing_object_dead_letters_on_the_first_attempt(db_session_factory, worker, monkeypatch):
    """The two orphaned deployed rows' case: `uploaded`, object gone by the
    24-hour rule. PERMANENT — attempts = 1, never 3."""
    head = _stub_head(monkeypatch, None)
    row = await _uploaded_row(db_session_factory, size=2048)
    gathering_id = row.gathering_id

    assert await poll_once(db_session_factory, worker, _now()) is Poll.PROCESSED
    assert head.calls == [(worker, quarantine_key(row.id))]

    async with db_session_factory() as db:
        row = await db.get(Media, row.id)
        assert row.status == MediaStatus.FAILED
        assert row.attempts == 1
        assert row.claimed_at is None
        assert "quarantine object missing" in row.last_error
        assert "24-hour" in row.last_error
        # Operator terms only: no key id, no URL, no key.
        for never in ("test-worker-key-id", "X-Amz", "uploads/"):
            assert never not in row.last_error
        # Nothing else moved — processing is not publishing, and neither is
        # failing.
        assert row.publication_state == PublicationState.PENDING
        assert (await db.get(Gathering, gathering_id)).total_bytes == 0
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 0
    # Dead-lettered rows are never claimed again.
    assert await poll_once(db_session_factory, worker, _now()) is Poll.IDLE
    assert len(head.calls) == 1
    # The dead-letter's object deletion (record §6.2, "at that moment"):
    # issued after the commit; against an absent object it is a success.
    assert head.deletes == [quarantine_key(row.id)]


# --- the publish transaction (CK-36) ---------------------------------------------


async def _ready_state(db_session_factory, media_id):
    async with db_session_factory() as db:
        row = await db.get(Media, media_id)
        derivatives = (
            await db.execute(
                select(MediaDerivative).where(MediaDerivative.media_id == media_id).order_by(MediaDerivative.layer)
            )
        ).scalars().all()
        gathering = await db.get(Gathering, row.gathering_id)
        return row, derivatives, gathering


async def test_a_present_photograph_is_processed_and_published_in_one_transaction(
    db_session_factory, worker, monkeypatch
):
    """The crux (ingest.py PUBLISH; record §8): the REAL GPS-bearing fixture
    goes through the real decoder; three objects land in the published
    bucket under deterministic keys with the class and type per layer; the
    row goes to `ready` with three derivative rows and total_bytes moved by
    their ACTUAL sum in one commit; `publication_state` is untouched; and
    none of the three stored layers carries the GPS the original did."""
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    assert dict(Image.open(io.BytesIO(GPS_PHOTO)).getexif().get_ifd(ExifTags.IFD.GPSInfo))  # the subject has GPS

    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED

    # The store: three objects in published, keyed by (id, layer); the
    # original gone from quarantine; the order read -> put x3 -> delete.
    keys = {layer: published_key(row.id, layer) for layer in MediaLayer}
    assert set(store.published) == set(keys.values())
    assert store.quarantine == {}
    assert store.stages() == ["head", "read", "put", "put", "put", "delete"]
    assert store.published[keys[MediaLayer.ARCHIVAL]][1:] == ("image/jpeg", STORAGE_CLASS_INFREQUENT_ACCESS)
    assert store.published[keys[MediaLayer.WEB]][1:] == ("image/webp", STORAGE_CLASS_STANDARD)
    assert store.published[keys[MediaLayer.THUMBNAIL]][1:] == ("image/webp", STORAGE_CLASS_STANDARD)
    for data, _, _ in store.published.values():
        image = Image.open(io.BytesIO(data))
        assert dict(image.getexif()) == {}  # no GPS, no orientation, nothing
        assert image.size == (64, 96)  # upright: the orientation was applied
        assert b"Exif\x00\x00" not in data and b"EXIF" not in data

    # The database: one transaction's worth of consequences.
    row, derivatives, gathering = await _ready_state(db_session_factory, row.id)
    assert row.status == MediaStatus.READY
    assert row.claimed_at is None
    assert row.last_error is None
    # The attempt that succeeded is counted, and a terminal row carries no
    # deferral (CK-37): the row says what the log line says.
    assert row.attempts == 1
    assert row.available_at is None
    assert row.publication_state == PublicationState.PENDING  # processing is not publishing
    assert [d.layer for d in derivatives] == [MediaLayer.ARCHIVAL, MediaLayer.WEB, MediaLayer.THUMBNAIL]
    for derivative in derivatives:
        stored, content_type, storage_class = store.published[derivative.storage_key]
        assert derivative.storage_key == keys[derivative.layer]
        assert derivative.size_bytes == len(stored)
        assert derivative.content_type == content_type
        assert derivative.storage_class == storage_class
        assert derivative.last_accessed is None
    assert gathering.total_bytes == sum(d.size_bytes for d in derivatives) > 0
    # total_bytes moved by the ACTUAL stored sum, not the declared upload
    # size — the reservation over-counts in the safe direction.
    assert gathering.total_bytes != row.upload_size_bytes
    # A ready row is never claimed again.
    assert await poll_once(db_session_factory, worker, t0 + timedelta(hours=1)) is Poll.IDLE


async def test_the_original_is_deleted_only_after_the_ready_transaction_has_committed(
    db_session_factory, worker, monkeypatch
):
    """The whole of the phase's data-handling in one assertion: at the
    moment the delete is issued, a SECOND session already sees the row
    `ready` with its three rows and the bytes moved. A crash before the
    delete costs a lingering original the lifecycle rule takes; the other
    order would cost the photograph."""
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    seen: list[tuple] = []

    async def observe(key):
        r, derivatives, gathering = await _ready_state(db_session_factory, row.id)
        seen.append((key, r.status, len(derivatives), gathering.total_bytes))

    store.on_delete = observe
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    assert len(seen) == 1
    key, status, derivative_count, total_bytes = seen[0]
    assert key == quarantine_key(row.id)
    assert status == MediaStatus.READY
    assert derivative_count == 3
    assert total_bytes > 0


async def test_a_reprocessed_row_does_not_trip_the_derivative_unique_constraint(
    db_session_factory, worker, monkeypatch
):
    """Derivative rows already present under a row that is claimable again
    (a re-queued photograph; or any future path that lands rows without
    the rung) must not turn the ready transaction into an IntegrityError
    dead-letter that reads as a decode bug. Step 4 replaces them."""
    t0 = _now()
    stale = t0 - RECLAIM_AFTER - timedelta(minutes=1)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(gathering.id, status=MediaStatus.PROCESSING, size=len(GPS_PHOTO), claimed_at=stale)
        db.add(row)
        await db.flush()
        for layer in MediaLayer:
            db.add(
                MediaDerivative(
                    media_id=row.id,
                    layer=layer,
                    storage_key=published_key(row.id, layer),
                    content_type="image/x-earlier-attempt",
                    size_bytes=1,
                    storage_class="STANDARD",
                )
            )
        await db.commit()
        media_id, gathering_id = row.id, gathering.id
    store = FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})

    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    row, derivatives, gathering = await _ready_state(db_session_factory, media_id)
    assert row.status == MediaStatus.READY
    # The abandoned claim counted at reclaim, plus the attempt that
    # succeeded (CK-37): "attempt 2" in the log, 2 on the row.
    assert row.attempts == 2
    assert len(derivatives) == 3
    assert {d.content_type for d in derivatives} == {"image/jpeg", "image/webp"}
    assert gathering.total_bytes == sum(d.size_bytes for d in derivatives)
    assert set(store.published) == {published_key(media_id, layer) for layer in MediaLayer}


async def test_deleting_an_absent_original_is_a_success(db_session_factory, worker, monkeypatch, caplog):
    # Two live workers for ~61 seconds on every deploy: a predecessor's
    # delete may land first. The row is ready either way.
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})

    async def vanish(key):
        store.quarantine.pop(key, None)  # gone before our delete lands

    store.on_delete = vanish
    with caplog.at_level(logging.INFO, logger="covey-keep.worker"):
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    row, derivatives, _ = await _ready_state(db_session_factory, row.id)
    assert row.status == MediaStatus.READY and len(derivatives) == 3
    assert "quarantine original deleted" in caplog.text
    assert "could not be deleted" not in caplog.text


async def test_a_delete_that_fails_after_the_commit_leaves_the_row_ready(
    db_session_factory, worker, monkeypatch, caplog
):
    # The photograph is published; the original lingers for the lifecycle
    # rule. Never a failure of the row, never a retry of the publish.
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    store.raise_on["delete"] = EndpointConnectionError(endpoint_url="https://r2.invalid")
    with caplog.at_level(logging.INFO, logger="covey-keep.worker"):
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    row, derivatives, gathering = await _ready_state(db_session_factory, row.id)
    assert row.status == MediaStatus.READY
    assert row.attempts == 1 and row.last_error is None
    assert len(derivatives) == 3 and gathering.total_bytes > 0
    assert "could not be deleted" in caplog.text and "24-hour lifecycle" in caplog.text
    assert "r2.invalid" not in caplog.text
    assert await poll_once(db_session_factory, worker, t0 + timedelta(hours=1)) is Poll.IDLE


async def test_the_reservation_releases_at_ready_and_total_bytes_takes_over(
    db_session_factory, worker, monkeypatch
):
    """The baton keeping.py already holds (`ready` is outside
    IN_FLIGHT_STATUSES), verified and not rebuilt: before, the account's
    usage is the DECLARED size; after, it is the derivatives' ACTUAL sum —
    the two differ, on purpose."""
    declared = 4 * MB
    async with db_session_factory() as db:
        keeper = await _mk_account(db)
        gathering = await _mk_gathering(db, host_account_id=keeper.id)
        await keeping.keep(db, keeper, gathering)
        row = _media(gathering.id, status=MediaStatus.UPLOADED, size=declared, available_at=_now())
        db.add(row)
        await db.commit()
        keeper_id, media_id = keeper.id, row.id
    FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})

    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await db.get(Account, keeper_id)) == declared
    assert await poll_once(db_session_factory, worker, _now()) is Poll.PROCESSED
    _, derivatives, gathering = await _ready_state(db_session_factory, media_id)
    stored = sum(d.size_bytes for d in derivatives)
    async with db_session_factory() as db:
        assert await keeping.account_usage(db, await db.get(Account, keeper_id)) == stored
    assert 0 < stored < declared
    assert gathering.total_bytes == stored


async def test_an_undecodable_upload_dead_letters_on_the_first_attempt_and_its_original_goes(
    db_session_factory, worker, monkeypatch
):
    # A renamed .mov: passes the advisory allowlist, fails here, once.
    mov = b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  " + bytes(300)
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(mov), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): mov})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, derivatives, gathering = await _ready_state(db_session_factory, row.id)
    assert r.status == MediaStatus.FAILED
    assert r.attempts == 1
    assert r.claimed_at is None
    assert "could not process the upload as a photograph" in r.last_error
    assert "UnidentifiedImageError" in r.last_error and "(permanent)" in r.last_error
    for never in ("test-worker-key-id", "X-Amz", "uploads/", "ftyp"):
        assert never not in r.last_error
    assert derivatives == [] and gathering.total_bytes == 0
    assert store.published == {}
    assert store.quarantine == {}  # deleted after the dead-letter committed
    assert store.stages() == ["head", "read", "delete"]
    assert await poll_once(db_session_factory, worker, t0 + timedelta(hours=1)) is Poll.IDLE


async def test_an_oversized_image_dead_letters_on_the_first_attempt(db_session_factory, worker, monkeypatch):
    # 50.4 megapixels in a 20 KB file — the byte cap bounds nothing, the
    # pixel guard refuses from the header, permanently (never the ladder:
    # a row that kept killing the worker would be the crash loop by another
    # name that reclaim only counts its way out of).
    buffer = io.BytesIO()
    Image.new("1", (7100, 7100), 1).save(buffer, "PNG")
    bomb = buffer.getvalue()
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(bomb), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): bomb})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, derivatives, _ = await _ready_state(db_session_factory, row.id)
    assert (r.status, r.attempts) == (MediaStatus.FAILED, 1)
    assert "50 megapixel" in r.last_error and "(permanent)" in r.last_error
    assert derivatives == [] and store.published == {} and store.quarantine == {}


async def test_an_object_taken_between_the_head_and_the_read_is_the_permanent_case(
    db_session_factory, worker, monkeypatch
):
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    store.raise_on["read"] = _client_error("NoSuchKey", 404)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, _, _ = await _ready_state(db_session_factory, row.id)
    assert (r.status, r.attempts, r.last_error) == (MediaStatus.FAILED, 1, ERROR_OBJECT_MISSING)


async def test_a_write_failure_is_transient_and_the_retry_rewrites_all_three(
    db_session_factory, worker, monkeypatch
):
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    store.raise_on["put"] = _client_error("InternalError", 500)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, derivatives, gathering = await _ready_state(db_session_factory, row.id)
    assert (r.status, r.attempts, r.claimed_at) == (MediaStatus.UPLOADED, 1, None)
    assert r.available_at == t0 + RETRY_BACKOFF[0]
    assert "write: ClientError (InternalError)" in r.last_error
    assert derivatives == [] and gathering.total_bytes == 0
    assert quarantine_key(row.id) in store.quarantine  # nothing deleted on a retry

    # The store recovers: the retry writes all three and publishes; the
    # stale retry text is cleared at ready.
    del store.raise_on["put"]
    assert await poll_once(db_session_factory, worker, t0 + RETRY_BACKOFF[0]) is Poll.PROCESSED
    r, derivatives, _ = await _ready_state(db_session_factory, row.id)
    # One failed attempt plus the one that succeeded (CK-37): attempt 2 in
    # the log, 2 on the row; the retry's deferral does not outlive `ready`.
    assert (r.status, r.attempts, r.last_error) == (MediaStatus.READY, 2, None)
    assert r.available_at is None
    assert len(derivatives) == 3 and len(store.published) == 3


async def test_a_rejected_credential_on_the_write_releases_the_row_untouched(
    db_session_factory, worker, monkeypatch
):
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    store.raise_on["put"] = _client_error("AccessDenied", 403)
    assert await poll_once(db_session_factory, worker, t0) is Poll.BACKOFF
    r, derivatives, _ = await _ready_state(db_session_factory, row.id)
    assert (r.status, r.attempts, r.claimed_at, r.available_at, r.last_error) == (
        MediaStatus.UPLOADED, 0, None, t0, None,
    )
    assert derivatives == [] and quarantine_key(row.id) in store.quarantine


async def test_a_claim_lost_to_a_reclaim_writes_nothing_on_the_ready_transaction(
    db_session_factory, worker, monkeypatch
):
    # This worker stalled past RECLAIM_AFTER with the objects already
    # written; another reclaimed the row. The guarded update goes first,
    # so no derivative row and no total_bytes move — the other worker's
    # publish will overwrite the same three keys.
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    store = FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    async with db_session_factory() as db:
        mine = await claim_next(db, t0)
        await db.commit()
    theirs = t0 + RECLAIM_AFTER + timedelta(minutes=1)
    async with db_session_factory() as db:
        other = await claim_next(db, theirs)
        await db.commit()
    assert other.id == row.id
    async with db_session_factory() as db:
        assert await handle_claimed(db, worker, mine, theirs + timedelta(minutes=1)) is Outcome.LOST_CLAIM
        await db.commit()
    r, derivatives, gathering = await _ready_state(db_session_factory, row.id)
    assert (r.status, r.claimed_at, r.attempts) == (MediaStatus.PROCESSING, theirs, 1)
    assert derivatives == [] and gathering.total_bytes == 0
    assert "delete" not in store.stages()  # the original is the other worker's to delete


async def test_a_row_dead_lettered_at_reclaim_has_its_original_deleted(db_session_factory, worker, monkeypatch):
    t0 = _now()
    stale = t0 - RECLAIM_AFTER - timedelta(minutes=1)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        row = _media(gathering.id, status=MediaStatus.PROCESSING, claimed_at=stale, attempts=MAX_ATTEMPTS - 1)
        db.add(row)
        await db.commit()
        media_id = row.id
    store = FakeStore(monkeypatch, {quarantine_key(media_id): GPS_PHOTO})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r, _, _ = await _ready_state(db_session_factory, media_id)
    assert (r.status, r.attempts, r.last_error) == (MediaStatus.FAILED, MAX_ATTEMPTS, ERROR_ABANDONED)
    assert store.stages() == ["delete"] and store.quarantine == {}


async def test_a_transient_error_climbs_the_ladder_and_dead_letters_on_the_third(
    db_session_factory, worker, monkeypatch
):
    _stub_head(monkeypatch, raises=_client_error("InternalError", 500))
    t0 = _now()
    row = await _uploaded_row(db_session_factory, available_at=t0)

    async def state():
        r = await _row(db_session_factory, row.id)
        return r.status, r.attempts, r.available_at, r.claimed_at, r.last_error

    # Attempt 1 fails: back to uploaded, one minute down the ladder.
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    status, attempts, available_at, claimed_at, last_error = await state()
    assert (status, attempts, claimed_at) == (MediaStatus.UPLOADED, 1, None)
    assert available_at == t0 + RETRY_BACKOFF[0]
    assert "attempt 1 of 3" in last_error and "ClientError" in last_error and "InternalError" in last_error

    # Not claimable until then.
    assert await poll_once(db_session_factory, worker, t0 + timedelta(seconds=30)) is Poll.IDLE

    # Attempt 2 fails: five minutes.
    t1 = t0 + RETRY_BACKOFF[0]
    assert await poll_once(db_session_factory, worker, t1) is Poll.PROCESSED
    status, attempts, available_at, claimed_at, _ = await state()
    assert (status, attempts, claimed_at) == (MediaStatus.UPLOADED, 2, None)
    assert available_at == t1 + RETRY_BACKOFF[1]

    # Attempt 3 fails: dead-letter.
    t2 = t1 + RETRY_BACKOFF[1]
    assert await poll_once(db_session_factory, worker, t2) is Poll.PROCESSED
    status, attempts, _, claimed_at, last_error = await state()
    assert (status, attempts, claimed_at) == (MediaStatus.FAILED, MAX_ATTEMPTS, None)
    assert "after 3 attempts" in last_error
    for never in ("test-worker-key-id", "X-Amz", "uploads/"):
        assert never not in last_error
    assert await poll_once(db_session_factory, worker, t2 + timedelta(hours=1)) is Poll.IDLE


async def test_a_network_error_is_transient_too(db_session_factory, worker, monkeypatch):
    _stub_head(monkeypatch, raises=EndpointConnectionError(endpoint_url="https://r2.invalid"))
    t0 = _now()
    row = await _uploaded_row(db_session_factory, available_at=t0)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r = await _row(db_session_factory, row.id)
    assert (r.status, r.attempts, r.available_at) == (MediaStatus.UPLOADED, 1, t0 + RETRY_BACKOFF[0])
    assert "EndpointConnectionError" in r.last_error
    assert "r2.invalid" not in r.last_error  # the endpoint is configuration, not the outcome


async def test_a_rejected_credential_leaves_the_row_untouched_and_backs_off(
    db_session_factory, worker, monkeypatch
):
    # The third class: the store rejected the WORKER, not the row. A
    # mistyped dashboard value must not dead-letter every photograph in the
    # queue within minutes — the row is released exactly as it was, and the
    # loop backs off instead of draining.
    _stub_head(monkeypatch, raises=_client_error("AccessDenied", 403))
    t0 = _now()
    row = await _uploaded_row(db_session_factory, available_at=t0)
    assert await poll_once(db_session_factory, worker, t0) is Poll.BACKOFF
    r = await _row(db_session_factory, row.id)
    assert r.status == MediaStatus.UPLOADED
    assert r.attempts == 0
    assert r.claimed_at is None
    assert r.available_at == t0  # unchanged: claimable the moment the credential is fixed
    assert r.last_error is None


async def test_a_claim_lost_to_a_reclaim_cannot_overwrite_the_other_workers_outcome(
    db_session_factory, worker, monkeypatch
):
    # This worker stalled past RECLAIM_AFTER; another reclaimed the row. Its
    # late outcome is void: the guarded update writes nothing.
    _stub_head(monkeypatch, None)
    t0 = _now()
    row = await _uploaded_row(db_session_factory, available_at=t0)
    async with db_session_factory() as db:
        mine = await claim_next(db, t0)
        await db.commit()
    assert mine.claimed_at == t0

    theirs = t0 + RECLAIM_AFTER + timedelta(minutes=1)
    async with db_session_factory() as db:
        other = await claim_next(db, theirs)  # the reclaim
        await db.commit()
    assert other.id == row.id and other.claimed_at == theirs and other.attempts == 1

    async with db_session_factory() as db:
        assert await handle_claimed(db, worker, mine, theirs + timedelta(minutes=1)) is Outcome.LOST_CLAIM
        await db.commit()
    r = await _row(db_session_factory, row.id)
    assert (r.status, r.claimed_at, r.attempts, r.last_error) == (MediaStatus.PROCESSING, theirs, 1, None)


# --- the reservation (step 4) ---------------------------------------------------


async def test_dead_lettering_releases_the_quota_reservation(db_session_factory, worker, monkeypatch):
    # No second mechanism: `failed` is outside IN_FLIGHT_STATUSES, so the one
    # quota path stops counting the row the moment the worker marks it.
    _stub_head(monkeypatch, None)
    async with db_session_factory() as db:
        keeper = await _mk_account(db)
        gathering = await _mk_gathering(db, host_account_id=keeper.id)
        await keeping.keep(db, keeper, gathering)
        db.add(_media(gathering.id, status=MediaStatus.UPLOADED, size=4096))
        db.add(_media(gathering.id, status=MediaStatus.UPLOADED, size=2048, created_at=_now() + timedelta(seconds=1)))
        await db.commit()
        keeper_id, gathering_id = keeper.id, gathering.id

    async with db_session_factory() as db:
        keeper = await db.get(Account, keeper_id)
        assert await keeping.account_usage(db, keeper) == 4096 + 2048

    assert await poll_once(db_session_factory, worker, _now()) is Poll.PROCESSED
    async with db_session_factory() as db:
        keeper = await db.get(Account, keeper_id)
        assert await keeping.account_usage(db, keeper) == 2048  # one released
    assert await poll_once(db_session_factory, worker, _now()) is Poll.PROCESSED
    async with db_session_factory() as db:
        keeper = await db.get(Account, keeper_id)
        assert await keeping.account_usage(db, keeper) == 0
        assert (await db.get(Gathering, gathering_id)).total_bytes == 0  # untouched, CK-36's


# --- the loop --------------------------------------------------------------------


async def test_run_once_drains_the_queue_without_sleeping_then_exits(db_session_factory, worker, monkeypatch):
    _stub_head(monkeypatch, None)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        db.add_all(
            [
                _media(gathering.id, status=MediaStatus.UPLOADED, created_at=_now() - timedelta(minutes=2)),
                _media(gathering.id, status=MediaStatus.UPLOADED, created_at=_now() - timedelta(minutes=1)),
            ]
        )
        await db.commit()
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    code = await run(db_session_factory, worker, stop=asyncio.Event(), once=True, sleep=fake_sleep)
    assert code == 0
    assert sleeps == []  # continuous drain while work remains
    async with db_session_factory() as db:
        statuses = (await db.execute(select(Media.status))).scalars().all()
        assert statuses == [MediaStatus.FAILED, MediaStatus.FAILED]


async def test_idle_polling_is_five_seconds_jittered(db_session_factory, worker):
    sleeps: list[float] = []
    stop = asyncio.Event()

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        if len(sleeps) == 4:
            stop.set()

    assert await run(db_session_factory, worker, stop=stop, sleep=fake_sleep) == 0
    assert len(sleeps) == 4
    assert all(IDLE_POLL - IDLE_JITTER <= d <= IDLE_POLL + IDLE_JITTER for d in sleeps)


async def test_the_worker_retries_rather_than_crash_looping_when_the_schema_is_not_ready(
    db_session_factory, worker, monkeypatch
):
    """Record §8: a push deploys both services, only the web service
    migrates, and the worker may start against a schema that is not there
    yet. Against a REAL missing column — renamed away for the duration —
    the poll reports not-ready, the loop keeps polling, and once the column
    is back the next poll succeeds. Nobody tests this until it bites on a
    deploy; this is the test."""
    _stub_head(monkeypatch, None)
    await _uploaded_row(db_session_factory)

    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE media RENAME COLUMN claimed_at TO claimed_at_not_yet"))
    try:
        assert await poll_once(db_session_factory, worker) is Poll.NOT_READY

        sleeps: list[float] = []
        stop = asyncio.Event()

        async def fake_sleep(delay: float) -> None:
            sleeps.append(delay)
            if len(sleeps) == 3:
                stop.set()

        # Three failed polls, three sleeps, no exception, no exit.
        assert await run(db_session_factory, worker, stop=stop, sleep=fake_sleep) == 0
        assert len(sleeps) == 3
        # --once reports the condition rather than pretending the queue was empty.
        assert await run(db_session_factory, worker, stop=asyncio.Event(), once=True, sleep=fake_sleep) == 1
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE media RENAME COLUMN claimed_at_not_yet TO claimed_at"))

    # The migration landed: the same worker, untouched, gets on with it.
    assert await poll_once(db_session_factory, worker) is Poll.PROCESSED
    assert await poll_once(db_session_factory, worker) is Poll.IDLE


async def test_an_unexpected_exception_in_a_poll_does_not_kill_the_loop(db_session_factory, worker, monkeypatch):
    # Beyond the schema case: the loop boundary survives anything, logs it,
    # and keeps polling — a worker that dies takes every upload with it.
    async def boom(*args, **kwargs):
        raise RuntimeError("a bug")

    monkeypatch.setattr(ingest, "claim_next", boom)
    sleeps: list[float] = []
    stop = asyncio.Event()

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        stop.set()

    assert await run(db_session_factory, worker, stop=stop, sleep=fake_sleep) == 0
    assert len(sleeps) == 1


async def test_no_derivative_row_and_no_total_bytes_move_on_any_failure_path(db_session_factory, worker, monkeypatch):
    # Only the ready transaction writes a derivative row or moves
    # total_bytes; every failure outcome leaves both alone.
    outcomes = [None, _client_error("InternalError", 500)]
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        for i in range(len(outcomes)):
            db.add(_media(gathering.id, status=MediaStatus.UPLOADED, created_at=_now() + timedelta(seconds=i)))
        await db.commit()
        gathering_id = gathering.id
    for outcome in outcomes:
        if isinstance(outcome, Exception):
            _stub_head(monkeypatch, raises=outcome)
        else:
            _stub_head(monkeypatch, outcome)
        assert await poll_once(db_session_factory, worker, _now()) is Poll.PROCESSED
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 0
        assert (await db.get(Gathering, gathering_id)).total_bytes == 0
        states = set((await db.execute(select(Media.publication_state))).scalars().all())
        assert states == {PublicationState.PENDING}
        # And every row left `processing` behind: claimed_at is NULL on all.
        assert (await db.execute(select(func.count()).select_from(Media).where(Media.claimed_at.is_not(None)))).scalar_one() == 0


# --- CK-37 riders: the ready line, the attempt count, terminal rows ------------


async def test_the_ready_line_carries_the_rows_attempt_count_and_the_claim_to_ready_time(
    db_session_factory, worker, monkeypatch, caplog
):
    """Record §6.3's p95 target is stated on claim-to-ready, and until CK-37
    nothing the worker emitted could measure it (claimed_at is cleared at
    the outcome; CK-36's 4.712 s came from sampling the row). The `ready`
    line now carries the elapsed milliseconds — and the attempt number it
    prints is the row's own, persisted by the ready transaction, so the two
    surfaces can no longer disagree."""
    t0 = _now()
    row = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    FakeStore(monkeypatch, {quarantine_key(row.id): GPS_PHOTO})
    with caplog.at_level(logging.INFO, logger="covey-keep.worker"):
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    match = re.search(
        rf"media {row.id}: ready — three layers written \(attempt (\d+), (\d+) ms claim-to-ready\)",
        caplog.text,
    )
    assert match, caplog.text
    attempt, elapsed_ms = int(match.group(1)), int(match.group(2))
    assert attempt == (await _row(db_session_factory, row.id)).attempts == 1
    # A real decode of a real photograph took a real, bounded time.
    assert 0 <= elapsed_ms < 60_000

    # After one abandoned claim the row says 2 — and so does the line.
    caplog.clear()
    stale = t0 - RECLAIM_AFTER - timedelta(minutes=1)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        again = _media(gathering.id, status=MediaStatus.PROCESSING, size=len(GPS_PHOTO), claimed_at=stale)
        db.add(again)
        await db.commit()
        again_id = again.id
    FakeStore(monkeypatch, {quarantine_key(again_id): GPS_PHOTO})
    with caplog.at_level(logging.INFO, logger="covey-keep.worker"):
        assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    assert f"media {again_id}: ready — three layers written (attempt 2, " in caplog.text
    assert (await _row(db_session_factory, again_id)).attempts == 2


async def test_terminal_rows_carry_no_deferral(db_session_factory, worker, monkeypatch):
    """`ready` and `failed` are never claimed again, so neither keeps an
    `available_at` (CK-37). CK-36's two deployed dead-letters kept the hour
    the CK-35 release had set — harmless while the claim predicate reads
    only `uploaded`/`processing`, and exactly the stale state a later
    predicate change would trip over. All four terminal paths: ready, the
    permanent failure, the third transient failure, the third abandonment."""
    t0 = _now()

    # ready — the deferral confirm stamped is cleared with the claim stamp.
    ready = await _uploaded_row(db_session_factory, size=len(GPS_PHOTO), available_at=t0)
    FakeStore(monkeypatch, {quarantine_key(ready.id): GPS_PHOTO})
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r = await _row(db_session_factory, ready.id)
    assert (r.status, r.available_at, r.claimed_at) == (MediaStatus.READY, None, None)

    # permanent — the object is missing.
    missing = await _uploaded_row(db_session_factory, available_at=t0)
    _stub_head(monkeypatch, None)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r = await _row(db_session_factory, missing.id)
    assert (r.status, r.available_at, r.claimed_at) == (MediaStatus.FAILED, None, None)

    # transient, three times — the ladder sets a deferral twice, and the
    # dead-letter on the third clears it.
    flaky = await _uploaded_row(db_session_factory, available_at=t0)
    _stub_head(monkeypatch, raises=_client_error("InternalError", 500))
    t = t0
    for _ in range(MAX_ATTEMPTS):
        assert await poll_once(db_session_factory, worker, t) is Poll.PROCESSED
        r = await _row(db_session_factory, flaky.id)
        t = r.available_at or t
    assert (r.status, r.attempts, r.available_at, r.claimed_at) == (
        MediaStatus.FAILED,
        MAX_ATTEMPTS,
        None,
        None,
    )

    # abandoned three times — dead-lettered at reclaim.
    stale = t0 - RECLAIM_AFTER - timedelta(minutes=1)
    async with db_session_factory() as db:
        gathering = await _mk_gathering(db)
        abandoned = _media(
            gathering.id,
            status=MediaStatus.PROCESSING,
            claimed_at=stale,
            attempts=MAX_ATTEMPTS - 1,
            available_at=t0,
        )
        db.add(abandoned)
        await db.commit()
        abandoned_id = abandoned.id
    FakeStore(monkeypatch)
    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    r = await _row(db_session_factory, abandoned_id)
    assert (r.status, r.available_at, r.claimed_at, r.last_error) == (
        MediaStatus.FAILED,
        None,
        None,
        ERROR_ABANDONED,
    )
