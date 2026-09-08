"""CK-35 — the ingest worker: claim, reclaim, retry, and the permanent
failure — and the config split that lets it boot without the web
credentials.

No network anywhere in this file: the worker's HEAD is stubbed at
`app.services.ingest._head` (the CK-34 pattern), and the WorkerSettings under
test point at a reserved TLD. Everything else is real: real rows in the
migrated test database, a real `FOR UPDATE SKIP LOCKED` across two sessions,
a real missing column for the schema-not-ready case, and a real subprocess
for the boot-with-six-variables case.

The load-bearing pins (the kickoff's list, and what fell out of building it):
- a `pending_upload` row is NEVER claimed — nor a fresh `processing` row, a
  `ready` row, a `failed` row, or an `uploaded` row whose available_at is
  still in the future;
- two workers racing take different rows and never the same one;
- a stalled `processing` row is re-claimed, the abandoned attempt counted,
  and a row abandoned three times is dead-lettered at reclaim;
- a missing object dead-letters on the FIRST attempt (attempts = 1, never
  3), and the worker deletes nothing — it does not even import a delete;
- a transient error climbs the ladder (1m, 5m) and dead-letters on the
  third; a rejected credential is a THIRD class that touches the row not
  at all and backs the loop off;
- a present object releases the claim unprocessed: attempts stays 0, the
  row returns to `uploaded`, and it is not re-examined on the next poll;
- dead-lettering releases the quota reservation through the one quota path;
- the worker retries rather than crash-loops against a schema missing a
  media column;
- WorkerSettings has no field for the upload or serve credential, Settings
  none for the worker's, and the worker's import graph constructs neither
  the web settings nor the web engine — booted for real in a subprocess
  with exactly six variables set.
"""

import asyncio
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from pydantic import ValidationError
from sqlalchemy import func, select, text, update

from app.config import Settings, WorkerSettings, settings
from app.db import engine
from app.models import Account, Gathering, Media, MediaDerivative, MediaStatus, PublicationState
from app.services import ingest, keeping, storage
from app.services.ingest import (
    ERROR_ABANDONED,
    MAX_ATTEMPTS,
    NO_PROCESSOR_RECHECK,
    RECLAIM_AFTER,
    RETRY_BACKOFF,
    Outcome,
    claim_next,
    handle_claimed,
)
from app.services.storage import (
    ServeClient,
    UploadClient,
    WorkerClient,
    head_quarantine_object,
    presign_read,
    presign_upload,
    quarantine_key,
    worker_client,
)
from app.worker import IDLE_JITTER, IDLE_POLL, Poll, poll_once, run
from tests.conftest import TEST_DATABASE_URL
from tests.test_keeping import _mk_account, _mk_gathering

BACKEND_DIR = Path(__file__).resolve().parent.parent
MB = 1_000_000

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
    async def fake_head(client, key):
        fake_head.calls.append((client, key))
        if raises is not None:
            raise raises
        return result

    fake_head.calls = []
    monkeypatch.setattr(ingest, "_head", fake_head)
    return fake_head


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


def test_the_records_numbers_and_that_the_worker_deletes_nothing():
    assert RECLAIM_AFTER == timedelta(minutes=15)
    assert MAX_ATTEMPTS == 3
    assert RETRY_BACKOFF == (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=15))
    assert IDLE_POLL == 5.0
    # The release branch must not re-claim on the very next poll.
    assert NO_PROCESSOR_RECHECK > timedelta(seconds=IDLE_POLL + IDLE_JITTER)
    # THIS WORKER DELETES NOTHING (CK-35): the claim service does not even
    # import a delete — or a read. The first component able to destroy an
    # uploaded photograph destroys none until CK-36's publish transaction.
    assert "delete_quarantine_object" not in vars(ingest)
    assert "read_quarantine_object" not in vars(ingest)


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


async def test_a_present_object_releases_the_claim_unprocessed(db_session_factory, worker, monkeypatch):
    """§3 scaffolding (deleted at CK-36): no processor exists, so the row
    goes back to `uploaded` with nothing counted — not left `processing`
    (a stuck row the reclaim rescues forever), not dead-lettered (a healthy
    photograph destroyed) — and is not re-examined on the very next poll."""
    head = _stub_head(monkeypatch, (MB, "image/jpeg"))
    t0 = _now()
    row = await _uploaded_row(db_session_factory, available_at=t0)
    uploaded_at = row.uploaded_at

    assert await poll_once(db_session_factory, worker, t0) is Poll.PROCESSED
    async with db_session_factory() as db:
        row = await db.get(Media, row.id)
        assert row.status == MediaStatus.UPLOADED
        assert row.attempts == 0  # nothing failed — nothing was attempted
        assert row.claimed_at is None
        assert row.last_error is None
        assert row.available_at == t0 + NO_PROCESSOR_RECHECK
        assert row.uploaded_at == uploaded_at
        assert row.publication_state == PublicationState.PENDING
        assert await db.scalar(select(func.count()).select_from(MediaDerivative)) == 0

    # Not a hot loop: the next poll finds nothing claimable...
    assert await poll_once(db_session_factory, worker, t0 + timedelta(seconds=1)) is Poll.IDLE
    assert len(head.calls) == 1
    # ...and the row is looked at again once the recheck interval has passed
    # (which is how a row whose object the lifecycle rule takes meanwhile
    # gets dead-lettered within the hour).
    assert await poll_once(db_session_factory, worker, t0 + NO_PROCESSOR_RECHECK) is Poll.PROCESSED
    assert len(head.calls) == 2


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


async def test_no_derivative_row_and_no_total_bytes_move_on_any_path(db_session_factory, worker, monkeypatch):
    # CK-36's half, asserted absent across every outcome this phase has.
    outcomes = [None, (MB, "image/jpeg"), _client_error("InternalError", 500)]
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
