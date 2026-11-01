"""CK-83b — uploaded covers: a cover picture from the device, processed by the
worker and kept apart from the photographs, replaced or cleared by the latest
act (decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 3;
migration 0036).

THE WORLD is CK-83a's (`tests.test_covers._world`): a group — its ADMIN, a
CO-ADMIN, a MEMBER, a member SHARED with its gathering and one LEFT out, and
a STRANGER — and one gathering in it hosted by the admin, the co-admin its
CO-HOST, with one published photograph the member uploaded. No network
anywhere: the cover ladder's store calls are stubbed at
`app.services.cover_ingest._head/_read/_put/_delete/_delete_published` and
the confirm's HEAD at `app.api.media._head` (`CoverStore`, two in-memory
buckets), presigning is local (the conftest's reserved TLD), and the picture
is the REAL GPS-bearing fixture through the real decoder.

The load-bearing pins:
- THE ROUTES BY SEAT: the organisers upload (host, co-host; admin,
  co-admin) and everyone else draws the subject 404, nothing written; only
  the uploader confirms and reads a cover image (another organiser
  included draws the 404 byte-identical to a missing id); the allowlist and
  the cap in the media router's words; `superseded`, `not_uploaded`,
  `not_pending` and `size_mismatch` on a confirm; no presigned URL in any
  log record at DEBUG;
- THE LATEST ACT WINS: an upload superseded by a second upload, a set from
  a photograph and a clear, at each of `pending_upload`, `uploaded` and
  `processing` — never the cover, its objects deleted; the old cover
  standing until `ready`; a replaced uploaded cover `destroying` in the
  same transaction;
- THE WORKER: `ready` sets the cover and retires the old; a superseded
  `processing` row settles to `destroying` after its writes; an undecodable
  upload fails with its reason and leaves the cover; a transient failure
  retries; a rejected credential (botocore's own parser) releases; a
  destruction deletes both objects and the original before it commits; ONE
  JOB OF EACH LADDER PER PASS; `--once` drains both; the reap;
- THE RACES, STAGED AND NEVER TIMED, BOTH ORDERS: the worker holding the
  subject's lock while an act waits and then retires what it made the
  cover; an act holding the subject's lock while the worker waits and then
  settles its row for destruction (mutation-checked in the report);
- WHAT A COVER IMAGE IS NOT: in no media list, search, bin or queue, and
  counted nowhere; account deletion leaves it the cover;
- THE BODIES: `{"source": "upload", "set_at"}` on both subjects with no id;
  the URL route serving `covers/<id>/<layer>`; a pointer at a cover image
  that is not `ready`, or not the subject's, raises and is never served;
- the shape: the keys, the shared render path's byte equality, the import
  boundary, the reaper's refusal, the 0036 round trip with an uploaded
  cover, and the verifier's eleven data lines, each fired by a plant.
"""

import ast
import asyncio
import logging
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from botocore.exceptions import EndpointConnectionError
from sqlalchemy import func, select, text, update
from sqlalchemy.sql import Select

from app import worker as worker_module
from app.api import media as media_api
from app.api.covers import NOT_UPLOADED, SUPERSEDED
from app.api.media import NOT_PENDING, SIZE_MISMATCH
from app.config import settings
from app.models import (
    Account,
    CoverImage,
    Gathering,
    Group,
    Media,
    MediaFailureReason,
    MediaLayer,
    MediaStatus,
)
from app.services import cover_ingest, keeping, processing
from app.services.ingest import RETRY_BACKOFF
from app.services.retention import purge_stale
from app.services.storage import (
    COVER_PREFIX,
    cover_published_key,
    cover_quarantine_key,
    published_key,
    quarantine_key,
)
from app.worker import IDLE_JITTER, IDLE_POLL, Poll, poll_cover_once, run
from tests.test_covers import (
    GATHERINGS,
    GROUPS,
    MISSING,
    URL_KEYS,
    World,
    _clear,
    _cover_url,
    _set,
    _stored,
    _subject,
    _subject_404,
    _world,
)
from tests.test_destruction import _verifier
from tests.test_double_requests import _until_the_route_waits_or_finishes
from tests.test_media_reads import _url as _media_url
from tests.test_photo_count import _migrate, at_head_afterwards  # noqa: F401 — the round-trip rider
from tests.test_race_backstops import _sql, _stage
from tests.test_worker import GPS_PHOTO, MPO_PHOTO, _botocore_error, _media, _stub_head
from tests.test_worker import worker, worker_settings  # noqa: F401 — fixtures

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = BACKEND_DIR / "tests" / "fixtures" / "media"
# The verifier's total at 0036 (test_covers.py says how it got here).
VERIFIER_TOTAL = 438
UPLOAD_KEYS = {"cover_image", "upload"}
IMAGE_BODY_KEYS = {"id", "status", "failure_reason"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CoverStore:
    """Two in-memory buckets behind this ladder's own five names, and the
    confirm's HEAD (through the upload credential, at `app.api.media._head`).
    `raise_on[stage]` makes one stage fail; `on_delete` runs at the moment of
    any delete, to observe the database from a second session (the
    delete-before-commit order)."""

    def __init__(self, monkeypatch):
        self.quarantine: dict[str, bytes] = {}
        self.published: dict[str, tuple[bytes, str, str]] = {}
        self.calls: list[tuple[str, str]] = []
        self.raise_on: dict[str, Exception] = {}
        self.on_delete = None
        for name in ("_head", "_read", "_put", "_delete", "_delete_published"):
            monkeypatch.setattr(cover_ingest, name, getattr(self, name))
        monkeypatch.setattr(media_api, "_head", self._confirm_head)

    def _maybe_raise(self, stage: str) -> None:
        if stage in self.raise_on:
            raise self.raise_on[stage]

    async def _confirm_head(self, upload, key):
        self.calls.append(("confirm_head", key))
        data = self.quarantine.get(key)
        return None if data is None else (len(data), "image/jpeg")

    async def _head(self, client, key):
        self.calls.append(("head", key))
        self._maybe_raise("head")
        data = self.quarantine.get(key)
        return None if data is None else (len(data), "image/jpeg")

    async def _read(self, client, key):
        self.calls.append(("read", key))
        self._maybe_raise("read")
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

    async def _delete_published(self, client, key):
        self.calls.append(("delete_published", key))
        if self.on_delete is not None:
            await self.on_delete(key)
        self._maybe_raise("delete_published")
        self.published.pop(key, None)

    def keys_of(self, image_id: str) -> set[str]:
        return {key for key in [*self.quarantine, *self.published] if key.startswith(f"{COVER_PREFIX}{image_id}")}


# --- helpers ---------------------------------------------------------------------------


async def _upload(client, headers, kind: str, subject_id: str, *, size: int = len(GPS_PHOTO), content_type="image/jpeg", **extra):
    body = {"content_type": content_type, "size_bytes": size, **extra}
    return await client.post(f"/{kind}/{subject_id}/cover/upload", json=body, headers=headers)


async def _intent(client, headers, kind: str, subject_id: str, data: bytes = GPS_PHOTO) -> str:
    response = await _upload(client, headers, kind, subject_id, size=len(data))
    assert response.status_code == 201, response.text
    return response.json()["cover_image"]["id"]


async def _confirm(client, headers, image_id: str):
    return await client.post(f"/cover-images/{image_id}/confirm", headers=headers)


async def _uploaded(client, store: CoverStore, headers, kind: str, subject_id: str, data: bytes = GPS_PHOTO) -> str:
    """An intent, its PUT landing in the fake quarantine, and the confirm —
    a cover image at `uploaded`, claimable."""
    image_id = await _intent(client, headers, kind, subject_id, data)
    store.quarantine[cover_quarantine_key(UUID(image_id))] = data
    confirmed = await _confirm(client, headers, image_id)
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "uploaded"
    return image_id


async def _image(db_session_factory, image_id) -> CoverImage:
    async with db_session_factory() as db:
        return await db.get(CoverImage, UUID(str(image_id)))


async def _pointer(db_session_factory, kind: str, subject_id: str) -> tuple:
    """(cover_media_id, cover_image_id, cover_set_at, cover_set_by_person_id)."""
    model = Gathering if kind == GATHERINGS else Group
    async with db_session_factory() as db:
        return tuple(
            (
                await db.execute(
                    select(
                        model.cover_media_id, model.cover_image_id, model.cover_set_at, model.cover_set_by_person_id
                    ).where(model.id == UUID(subject_id))
                )
            ).one()
        )


async def _drain(db_session_factory, worker, *, now=None) -> list:
    """Poll the cover ladder until idle, bounded; the outcomes in order."""
    seen = []
    for _ in range(20):
        outcome = await poll_cover_once(db_session_factory, worker, now)
        seen.append(outcome)
        if outcome is not Poll.PROCESSED:
            return seen
    raise AssertionError(f"the cover ladder did not drain: {seen}")


async def _ready_cover(client, db_session_factory, store, worker, headers, kind, subject_id, data=GPS_PHOTO) -> str:
    image_id = await _uploaded(client, store, headers, kind, subject_id, data)
    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    assert (await _image(db_session_factory, image_id)).status is MediaStatus.READY
    assert (await _pointer(db_session_factory, kind, subject_id))[1] == UUID(image_id)
    return image_id


def _query(url: str) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


async def _act(client, w: World, act: str, kind: str):
    """One of the three acts on a subject, by its co-organiser."""
    subject = _subject(w, kind)
    if act == "upload":
        response = await _upload(client, w.co_admin, kind, subject)
        assert response.status_code == 201, response.text
        return response
    if act == "set":
        response = await _set(client, w.co_admin, kind, subject, w.photo)
        assert response.status_code == 200, response.text
        return response
    response = await _clear(client, w.co_admin, kind, subject)
    assert response.status_code == 204, response.text
    return response


ACTS = ("upload", "set", "clear")


def _expected_after(act: str, w: World) -> tuple:
    """(cover_media_id, has an uploaded cover) after the act wins."""
    if act == "set":
        return (UUID(w.photo), False)
    return (None, False)


# --- auth and shape ------------------------------------------------------------------


async def test_the_upload_routes_require_auth(client):
    for kind in (GATHERINGS, GROUPS):
        assert (await client.post(f"/{kind}/{MISSING}/cover/upload", json={})).status_code == 401
    assert (await client.post(f"/cover-images/{MISSING}/confirm")).status_code == 401
    assert (await client.get(f"/cover-images/{MISSING}")).status_code == 401


def test_the_keys_are_derived_under_covers_and_never_under_media():
    image_id = uuid4()
    assert cover_quarantine_key(image_id) == f"covers/{image_id}"
    assert cover_published_key(image_id, MediaLayer.WEB) == f"covers/{image_id}/web"
    assert cover_published_key(image_id, MediaLayer.THUMBNAIL) == f"covers/{image_id}/thumbnail"
    with pytest.raises(ValueError):
        cover_published_key(image_id, MediaLayer.ARCHIVAL)  # a cover is never printed
    for key in (cover_quarantine_key(image_id), cover_published_key(image_id, MediaLayer.WEB)):
        assert not key.startswith(("media/", "uploads/"))
        assert key not in (quarantine_key(image_id), published_key(image_id, MediaLayer.WEB))


@pytest.mark.parametrize("fixture", ["gps-oriented.jpg", "gps-mpo.jpg", "gps.png", "gps.heic"])
def test_a_covers_two_layers_are_byte_for_byte_a_photographs(fixture):
    """THE SHARED PATH: for the same bytes, `render_cover_layers` makes the
    web and thumbnail layers `render_layers` makes, byte for byte — over the
    real fixtures, the MPO and the HEIC among them — so a cover's metadata is
    stripped by exactly the photographs' code. No archival layer."""
    data = (FIXTURES / fixture).read_bytes()
    _archival, web, thumbnail = processing.render_layers(data)
    cover = processing.render_cover_layers(data)
    assert [r.layer for r in cover] == [MediaLayer.WEB, MediaLayer.THUMBNAIL]
    assert (cover[0].data, cover[1].data) == (web.data, thumbnail.data)
    assert [(r.content_type, r.storage_class) for r in cover] == [
        (web.content_type, web.storage_class),
        (thumbnail.content_type, thumbnail.storage_class),
    ]
    with pytest.raises(processing.Undecodable):
        processing.render_cover_layers(b"not a picture")
    # One path: render_cover_layers decodes through `_pixels`, never its own.
    source = pathlib.Path(processing.__file__).read_text(encoding="utf-8")
    body = source[source.index("def render_cover_layers"):]
    assert "_pixels(data)" in body and "Image.open" not in body


def _imports(path: pathlib.Path) -> set[str]:
    imported = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    return imported


def test_the_import_boundary_holds_for_the_cover_ladder():
    """The API never imports `cover_ingest`, `ingest` or `processing` — no
    router names them, and `import app.main` loads none of them nor PIL —
    and `services/covers.py`, which both sides call, imports the models and
    SQLAlchemy alone (the CK-59 boundary; test_covers.py pins the set)."""
    for path in (BACKEND_DIR / "app" / "api").glob("*.py"):
        forbidden = {
            m for m in _imports(path)
            if m in ("app.services.cover_ingest", "app.services.ingest", "app.services.processing")
            or (m or "").split(".")[0] == "PIL"
        }
        assert not forbidden, (path.name, forbidden)
    assert _imports(BACKEND_DIR / "app" / "services" / "covers.py") == {
        "__future__", "uuid", "sqlalchemy", "sqlalchemy.ext.asyncio", "app.models",
    }
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    for name in (
        "DATABASE_URL", "SESSION_SECRET", "APP_BASE_URL", "API_BASE_URL",
        "R2_ENDPOINT_URL", "R2_BUCKET_QUARANTINE", "R2_BUCKET_PUBLISHED",
        "R2_UPLOAD_ACCESS_KEY_ID", "R2_UPLOAD_SECRET_ACCESS_KEY",
        "R2_SERVE_ACCESS_KEY_ID", "R2_SERVE_SECRET_ACCESS_KEY",
        "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_LOOKUP_100K", "STRIPE_PRICE_LOOKUP_300K",
    ):
        env[name] = os.environ[name]
    probe = (
        "import sys, app.main; "
        "loaded = sorted(m for m in sys.modules if m in ('app.services.processing', 'app.services.ingest', "
        "'app.services.cover_ingest') or m == 'PIL' or m.startswith('PIL.')); "
        "print('app.services.covers' in sys.modules, loaded)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True []", result.stdout


async def test_the_reaper_refuses_cover_images_without_a_criterion(db_session_factory):
    """`cover_images` holds covers beside abandoned intents, so it is a
    content table, never an ephemeral one: purge_stale refuses it by age
    alone, before executing anything (retention.py's SECOND INVARIANT)."""
    async with db_session_factory() as db:
        with pytest.raises(ValueError, match="not an ephemeral table"):
            await purge_stale(db, CoverImage, CoverImage.created_at, _now())


# --- the routes, by seat ----------------------------------------------------------------


@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_the_organisers_upload_and_nobody_else_can(kind, client, capsys, db_session_factory):
    """The host and a co-host (a gathering), the admin and a co-admin (a
    group) upload; an ordinary member, a member who sees the photos only, a
    left-out member and a stranger draw the subject's 404 byte-identical to a
    missing id, and no row is written. The answer: 201, the cover image's id
    and `pending_upload`, and a presigned PUT into quarantine under
    `covers/<id>` with the type and the size signed in."""
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    for headers in (w.member, w.shared, w.left, w.stranger):
        refused = await _upload(client, headers, kind, subject)
        assert refused.status_code == 404
        assert refused.content == await _subject_404(client, headers, kind)
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(CoverImage)) == 0

    for headers in (w.admin, w.co_admin):
        response = await _upload(client, headers, kind, subject)
        assert response.status_code == 201, response.text
        body = response.json()
        assert set(body) == UPLOAD_KEYS
        assert set(body["cover_image"]) == {"id", "status"} and body["cover_image"]["status"] == "pending_upload"
        upload = body["upload"]
        assert set(upload) == {"url", "method", "headers", "expires_in"} and upload["method"] == "PUT"
        assert upload["headers"] == {"Content-Length": str(len(GPS_PHOTO)), "Content-Type": "image/jpeg"}
        path = urllib.parse.urlsplit(upload["url"]).path
        assert path.endswith(f"/covers/{body['cover_image']['id']}")
        assert "/media/" not in path and "/uploads/" not in path
        row = await _image(db_session_factory, body["cover_image"]["id"])
        assert (row.gathering_id is not None) == (kind == GATHERINGS)
        assert (row.group_id is not None) == (kind == GROUPS)
        assert (row.content_type, row.size_bytes, row.status) == ("image/jpeg", len(GPS_PHOTO), MediaStatus.PENDING_UPLOAD)


async def test_the_photographs_allowlist_and_cap_apply_in_the_media_routers_words(client, capsys, db_session_factory):
    """The same validators as a photo intent, the same words; no filename is
    taken (extra fields are refused); a refusal writes nothing."""
    w = await _world(client, capsys, db_session_factory)
    video = await _upload(client, w.admin, GATHERINGS, w.gathering_id, content_type="video/quicktime")
    too_big = await _upload(client, w.admin, GATHERINGS, w.gathering_id, size=media_api.MAX_UPLOAD_BYTES + 1)
    empty = await _upload(client, w.admin, GATHERINGS, w.gathering_id, size=0)
    named = await _upload(client, w.admin, GATHERINGS, w.gathering_id, filename="cover.jpg")
    for response in (video, too_big, empty, named):
        assert response.status_code == 422, response.text
    (error,) = video.json()["detail"]
    assert error["loc"] == ["body", "content_type"]
    assert "only photos can be uploaded (JPEG, PNG, WebP, or HEIC)" in error["msg"]
    assert too_big.json()["detail"][0]["msg"] == "Value error, each photo is limited to 25 MB"
    assert empty.json()["detail"][0]["msg"] == "Value error, a photo's size must be a positive number of bytes"
    assert named.json()["detail"][0]["type"] == "extra_forbidden"
    heic = await _upload(client, w.admin, GATHERINGS, w.gathering_id, content_type=" IMAGE/HEIC ")
    assert heic.status_code == 201 and heic.json()["upload"]["headers"]["Content-Type"] == "image/heic"
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(CoverImage)) == 1


async def test_only_the_uploader_confirms_and_reads_a_cover_image(client, capsys, db_session_factory, monkeypatch):
    """The uploader alone: another organiser of the same subject, a member and
    a stranger draw the 404 byte-identical to a missing id on the confirm and
    on the read, and nothing moves. The read answers the rung and why."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    image_id = await _intent(client, w.co_admin, GATHERINGS, w.gathering_id)
    store.quarantine[cover_quarantine_key(UUID(image_id))] = GPS_PHOTO
    missing_confirm = await _confirm(client, w.admin, MISSING)
    missing_read = await client.get(f"/cover-images/{MISSING}", headers=w.admin)
    assert missing_confirm.status_code == missing_read.status_code == 404
    for headers in (w.admin, w.member, w.stranger):
        confirm = await _confirm(client, headers, image_id)
        read = await client.get(f"/cover-images/{image_id}", headers=headers)
        assert (confirm.status_code, confirm.content) == (404, missing_confirm.content)
        assert (read.status_code, read.content) == (404, missing_read.content)
    assert (await _image(db_session_factory, image_id)).status is MediaStatus.PENDING_UPLOAD

    read = await client.get(f"/cover-images/{image_id}", headers=w.co_admin)
    assert set(read.json()) == IMAGE_BODY_KEYS
    assert read.json() == {"id": image_id, "status": "pending_upload", "failure_reason": None}
    confirmed = await _confirm(client, w.co_admin, image_id)
    assert confirmed.status_code == 200 and confirmed.json() == {"id": image_id, "status": "uploaded", "failure_reason": None}
    row = await _image(db_session_factory, image_id)
    assert row.status is MediaStatus.UPLOADED and row.available_at is not None
    assert ("confirm_head", f"covers/{image_id}") in store.calls


async def test_the_confirms_refusals(client, capsys, db_session_factory, monkeypatch):
    """`not_uploaded` when the bytes have not arrived; `size_mismatch` when
    they are not the declared size; `not_pending` on a second confirm; and
    `superseded` on an upload a later act superseded, whatever its rung now —
    each a 409 that changes nothing."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    first = await _intent(client, w.admin, GATHERINGS, w.gathering_id)
    response = await _confirm(client, w.admin, first)
    assert response.status_code == 409 and response.json()["detail"]["code"] == NOT_UPLOADED
    store.quarantine[f"covers/{first}"] = GPS_PHOTO + b"x"
    response = await _confirm(client, w.admin, first)
    assert response.status_code == 409 and response.json()["detail"]["code"] == SIZE_MISMATCH
    store.quarantine[f"covers/{first}"] = GPS_PHOTO
    assert (await _confirm(client, w.admin, first)).status_code == 200
    response = await _confirm(client, w.admin, first)
    assert response.status_code == 409 and response.json()["detail"]["code"] == NOT_PENDING

    # A second upload supersedes the first (now `uploaded`) and a confirm of a
    # third intent superseded by a clear: both `superseded`.
    second = await _intent(client, w.admin, GATHERINGS, w.gathering_id)
    assert (await _image(db_session_factory, first)).superseded_at is not None
    response = await _confirm(client, w.admin, first)
    assert response.status_code == 409 and response.json()["detail"]["code"] == SUPERSEDED
    store.quarantine[f"covers/{second}"] = GPS_PHOTO
    assert (await _clear(client, w.admin, GATHERINGS, w.gathering_id)).status_code == 204
    response = await _confirm(client, w.admin, second)
    assert response.status_code == 409 and response.json()["detail"]["code"] == SUPERSEDED
    assert (await _image(db_session_factory, second)).status is MediaStatus.DESTROYING


async def test_a_confirm_racing_a_supersede_answers_superseded(client, capsys, db_session_factory, monkeypatch):
    """STAGED: a second upload intent commits while the first upload's confirm
    is between its HEAD and its guarded UPDATE. The UPDATE matches nothing,
    the answer is `superseded`, and the row stays where the supersede put it
    — the confirm touches its own row, by one guarded statement."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    first = await _intent(client, w.admin, GATHERINGS, w.gathering_id)
    store.quarantine[f"covers/{first}"] = GPS_PHOTO

    async def second_intent() -> None:
        assert (await _upload(client, w.co_admin, GATHERINGS, w.gathering_id)).status_code == 201

    def the_confirms_update(statement) -> bool:
        table = getattr(statement, "table", None)
        return getattr(table, "name", None) == "cover_images" and "status" in _sql(statement)

    state = _stage(monkeypatch, when=the_confirms_update, competitor=second_intent, before=True)
    response = await _confirm(client, w.admin, first)
    assert state["fired"]
    assert response.status_code == 409 and response.json()["detail"]["code"] == SUPERSEDED
    row = await _image(db_session_factory, first)
    assert row.status is MediaStatus.DESTROYING and row.superseded_at is not None


async def test_no_presigned_url_reaches_a_log_even_at_debug(client, capsys, db_session_factory, monkeypatch, caplog, worker):
    """With the ROOT logger at DEBUG: the upload intent, the confirm, the read
    and both cover URLs of an uploaded cover put no URL, no signature, no key
    and no key id into any log record, and the routers log nothing of their
    own. The worker's lines name the cover image and its outcome, never a
    key."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    caplog.clear()
    urls = []
    with caplog.at_level(logging.DEBUG):
        for kind in (GATHERINGS, GROUPS):
            response = await _upload(client, w.admin, kind, _subject(w, kind))
            urls.append(response.json()["upload"]["url"])
            image_id = response.json()["cover_image"]["id"]
            store.quarantine[f"covers/{image_id}"] = GPS_PHOTO
            assert (await _confirm(client, w.admin, image_id)).status_code == 200
            assert (await client.get(f"/cover-images/{image_id}", headers=w.admin)).status_code == 200
            assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
            for layer in ("web", "thumbnail"):
                urls.append((await _cover_url(client, w.member, kind, _subject(w, kind), layer)).json()["url"])
    logged = caplog.text
    for url in urls:
        assert url not in logged and _query(url)["X-Amz-Signature"] not in logged
    assert "X-Amz" not in logged and "Signature:" not in logged
    for key_id in (settings.r2_upload_access_key_id, settings.r2_serve_access_key_id):
        assert key_id not in logged
    assert "covers/" not in logged
    app_records = [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]
    assert app_records and all(r.name == "covey-keep.worker" for r in app_records)
    assert any("cover image" in r.getMessage() and "ready" in r.getMessage() for r in app_records)


# --- the latest act wins ------------------------------------------------------------------


@pytest.mark.parametrize("act", ACTS)
@pytest.mark.parametrize("rung", ["pending_upload", "uploaded"])
async def test_an_unheld_upload_superseded_by_each_act_goes_straight_to_destroying(
    act, rung, client, capsys, db_session_factory, monkeypatch, worker
):
    """An upload no worker holds — `pending_upload` or `uploaded` — is moved
    straight to `destroying` by a later upload, a set or a clear, stamped
    `superseded_at`, never becomes the cover, and the destruction step
    deletes whatever it had (both published keys and the original, each an
    absent object being a success)."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    if rung == "pending_upload":
        image_id = await _intent(client, w.admin, GATHERINGS, w.gathering_id)
    else:
        image_id = await _uploaded(client, store, w.admin, GATHERINGS, w.gathering_id)
    await _act(client, w, act, GATHERINGS)
    row = await _image(db_session_factory, image_id)
    assert row.status is MediaStatus.DESTROYING and row.superseded_at is not None
    assert (row.attempts, row.claimed_at, row.last_error) == (0, None, None)
    media_id, cover_image_id, _set_at, _by = await _pointer(db_session_factory, GATHERINGS, w.gathering_id)
    assert cover_image_id is None and media_id == _expected_after(act, w)[0]

    store.calls.clear()
    outcomes = await _drain(db_session_factory, worker)
    assert outcomes[-1] is Poll.IDLE
    row = await _image(db_session_factory, image_id)
    assert row.status is MediaStatus.DESTROYED
    assert ("delete", f"covers/{image_id}") in store.calls
    assert ("delete_published", f"covers/{image_id}/web") in store.calls
    assert store.keys_of(image_id) == set()
    assert (await _pointer(db_session_factory, GATHERINGS, w.gathering_id))[1] is None


@pytest.mark.parametrize("act", ACTS)
async def test_a_processing_upload_superseded_is_flagged_and_settled_after_its_writes(
    act, client, capsys, db_session_factory, monkeypatch, worker
):
    """A `processing` upload — a worker holds it — is only FLAGGED by a later
    act: the rung stays, the worker writes its two layers (it never has an
    object deleted under it), and then settles the row to `destroying`
    instead of `ready`; the subject's cover is the act's, and the destruction
    step deletes what the worker wrote."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    image_id = await _uploaded(client, store, w.admin, GATHERINGS, w.gathering_id)
    async with db_session_factory() as db:
        # The worker's two halves, with the act between them: the claim (and
        # its commit), then — once the act has flagged the row — the outcome,
        # in the session that holds the claimed row, as poll_cover_once has it.
        row = await cover_ingest.claim_next(db, _now())
        await db.commit()
        assert str(row.id) == image_id and row.status is MediaStatus.PROCESSING

        await _act(client, w, act, GATHERINGS)
        flagged = await _image(db_session_factory, image_id)
        assert flagged.status is MediaStatus.PROCESSING and flagged.superseded_at is not None
        after_act = await _pointer(db_session_factory, GATHERINGS, w.gathering_id)

        outcome = await cover_ingest.handle_claimed(db, worker, row, _now())
        await db.commit()
    assert outcome is cover_ingest.Outcome.SUPERSEDED
    assert {f"covers/{image_id}/web", f"covers/{image_id}/thumbnail"} <= set(store.published)  # its writes happened
    settled = await _image(db_session_factory, image_id)
    assert settled.status is MediaStatus.DESTROYING and settled.web_size_bytes is None
    assert await _pointer(db_session_factory, GATHERINGS, w.gathering_id) == after_act  # the worker wrote no cover

    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    assert (await _image(db_session_factory, image_id)).status is MediaStatus.DESTROYED
    assert store.keys_of(image_id) == set()


@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_the_old_cover_stands_until_ready_and_ready_retires_it(kind, client, capsys, db_session_factory, monkeypatch, worker):
    """Until an upload is `ready`, the old cover — a photograph, then an
    earlier uploaded picture — stands. At `ready` the worker points the
    subject at the new image (`cover_media_id` NULL, the uploader as setter,
    a new version) and RETIRES the image it replaced, in the same
    transaction; the retired image's objects are then destroyed."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    assert (await _set(client, w.admin, kind, subject, w.photo)).status_code == 200
    photo_cover = await _pointer(db_session_factory, kind, subject)

    first = await _uploaded(client, store, w.co_admin, kind, subject)
    assert await _pointer(db_session_factory, kind, subject) == photo_cover  # in flight: the photograph stands
    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    media_id, image_id, set_at, set_by = await _pointer(db_session_factory, kind, subject)
    assert (media_id, image_id, set_by) == (None, UUID(first), w.co_admin_person)
    assert set_at > photo_cover[2]
    ready = await _image(db_session_factory, first)
    assert ready.status is MediaStatus.READY and ready.attempts == 1 and ready.last_error is None
    assert (ready.web_content_type, ready.thumbnail_content_type) == ("image/webp", "image/webp")
    assert (ready.web_size_bytes, ready.thumbnail_size_bytes) == (
        len(store.published[f"covers/{first}/web"][0]),
        len(store.published[f"covers/{first}/thumbnail"][0]),
    )
    assert f"covers/{first}" not in store.quarantine  # the original went after the commit

    second = await _uploaded(client, store, w.admin, kind, subject, MPO_PHOTO)
    assert (await _pointer(db_session_factory, kind, subject))[1] == UUID(first)  # the first stands
    outcomes = await _drain(db_session_factory, worker)
    assert outcomes == [Poll.PROCESSED, Poll.PROCESSED, Poll.IDLE]  # the second's ready, the first's destruction
    assert (await _pointer(db_session_factory, kind, subject))[1:4:2] == (UUID(second), w.admin_person)
    assert (await _image(db_session_factory, first)).status is MediaStatus.DESTROYED
    assert store.keys_of(first) == set()
    assert (await _image(db_session_factory, second)).superseded_at is None


@pytest.mark.parametrize("act", ["set", "clear"])
@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_a_replaced_uploaded_cover_goes_to_destroying_in_the_acts_transaction(
    act, kind, client, capsys, db_session_factory, monkeypatch, worker
):
    """A set from a photograph and a clear each retire the uploaded cover the
    subject carries: by the time the response returns, the image is
    `destroying` (fresh job columns, NOT superseded — it was the cover) and
    the subject points elsewhere, or nowhere. A second clear writes
    nothing."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    image_id = await _ready_cover(client, db_session_factory, store, worker, w.admin, kind, subject)
    await _act(client, w, act, kind)
    row = await _image(db_session_factory, image_id)
    assert row.status is MediaStatus.DESTROYING and row.superseded_at is None
    assert (row.attempts, row.claimed_at) == (0, None)
    media_id, cover_image_id, set_at, set_by = await _pointer(db_session_factory, kind, subject)
    assert cover_image_id is None
    if act == "set":
        assert (media_id, set_by) == (UUID(w.photo), w.co_admin_person)
    else:
        assert (media_id, set_at, set_by) == (None, None, None)
        assert (await _clear(client, w.admin, kind, subject)).status_code == 204
    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    assert (await _image(db_session_factory, image_id)).status is MediaStatus.DESTROYED


# --- the worker ---------------------------------------------------------------------------


async def test_an_undecodable_upload_fails_with_its_reason_and_leaves_the_cover(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """Not a picture: dead-lettered on its first attempt — `failed`, the
    person's reason and the operator's text — the subject's cover (a
    photograph here) untouched, and the original deleted after that commit."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    assert (await _set(client, w.admin, GATHERINGS, w.gathering_id, w.photo)).status_code == 200
    before = await _pointer(db_session_factory, GATHERINGS, w.gathering_id)
    junk = b"this is not a photograph at all"
    image_id = await _uploaded(client, store, w.admin, GATHERINGS, w.gathering_id, junk)
    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    row = await _image(db_session_factory, image_id)
    assert (row.status, row.failure_reason, row.attempts) == (MediaStatus.FAILED, MediaFailureReason.UNREADABLE, 1)
    assert row.last_error.startswith("could not process the upload as a cover picture")
    assert await _pointer(db_session_factory, GATHERINGS, w.gathering_id) == before
    assert store.keys_of(image_id) == set()
    read = await client.get(f"/cover-images/{image_id}", headers=w.admin)
    assert read.json() == {"id": image_id, "status": "failed", "failure_reason": "unreadable"}


async def test_a_transient_failure_retries_and_then_succeeds(client, capsys, db_session_factory, monkeypatch, worker):
    """The store not answering on the read: back to `uploaded`, attempts 1,
    deferred down the ladder, the reason written; at the deferral the next
    claim succeeds and the reason clears."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    image_id = await _uploaded(client, store, w.admin, GATHERINGS, w.gathering_id)
    store.raise_on["read"] = EndpointConnectionError(endpoint_url="https://r2.invalid")
    t0 = _now()
    assert await poll_cover_once(db_session_factory, worker, t0) is Poll.PROCESSED
    row = await _image(db_session_factory, image_id)
    assert (row.status, row.attempts, row.claimed_at) == (MediaStatus.UPLOADED, 1, None)
    assert row.available_at == t0 + RETRY_BACKOFF[0]
    assert row.last_error.startswith("attempt 1 of 3: storage did not answer")
    assert await poll_cover_once(db_session_factory, worker, t0 + timedelta(seconds=30)) is Poll.IDLE
    del store.raise_on["read"]
    assert await poll_cover_once(db_session_factory, worker, t0 + RETRY_BACKOFF[0]) is Poll.PROCESSED
    row = await _image(db_session_factory, image_id)
    assert (row.status, row.attempts, row.last_error) == (MediaStatus.READY, 2, None)


async def test_a_rejected_credential_releases_the_row_unpenalised(client, capsys, db_session_factory, monkeypatch, worker):
    """A bodiless 401 on the HEAD — the shape botocore actually delivers there
    (`_botocore_error`, its own parser; the CK-61 Gotcha) — releases the row
    to `uploaded`, attempts and the deferral untouched, the reason written,
    and the poll backs off. A transient-looking 400 does not release."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    image_id = await _uploaded(client, store, w.admin, GATHERINGS, w.gathering_id)
    available = (await _image(db_session_factory, image_id)).available_at
    store.raise_on["head"] = _botocore_error(401)
    assert await poll_cover_once(db_session_factory, worker) is Poll.BACKOFF
    row = await _image(db_session_factory, image_id)
    assert (row.status, row.attempts, row.claimed_at, row.available_at) == (MediaStatus.UPLOADED, 0, None, available)
    assert row.last_error == cover_ingest.ERROR_CREDENTIAL_REJECTED
    store.raise_on["head"] = _botocore_error(400)
    assert await poll_cover_once(db_session_factory, worker) is Poll.PROCESSED
    assert (await _image(db_session_factory, image_id)).attempts == 1  # the transient ladder, not a release


async def test_a_destruction_deletes_both_objects_and_the_original_before_it_commits(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """CK-54's order on the cover ladder: both published objects, then the
    quarantine original, each deleted while the row still reads `destroying`
    from a second session; only then `destroyed`, the layers' facts cleared
    (a tombstone carries no image), the row kept."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    image_id = await _ready_cover(client, db_session_factory, store, worker, w.admin, GATHERINGS, w.gathering_id)
    store.quarantine[f"covers/{image_id}"] = b"a lingering original"
    assert (await _clear(client, w.admin, GATHERINGS, w.gathering_id)).status_code == 204
    seen = []

    async def observe(key):
        seen.append((key, (await _image(db_session_factory, image_id)).status))

    store.on_delete = observe
    store.calls.clear()
    assert await poll_cover_once(db_session_factory, worker) is Poll.PROCESSED
    assert [stage for stage, _ in store.calls] == ["delete_published", "delete_published", "delete"]
    assert seen == [
        (f"covers/{image_id}/web", MediaStatus.DESTROYING),
        (f"covers/{image_id}/thumbnail", MediaStatus.DESTROYING),
        (f"covers/{image_id}", MediaStatus.DESTROYING),
    ]
    row = await _image(db_session_factory, image_id)
    assert (row.status, row.attempts, row.last_error) == (MediaStatus.DESTROYED, 1, None)
    assert (row.web_content_type, row.web_size_bytes, row.thumbnail_content_type, row.thumbnail_size_bytes) == (None,) * 4
    assert store.keys_of(image_id) == set()


async def test_one_job_of_each_ladder_per_pass_and_once_drains_both(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """THE FAIRNESS RULE: three photographs queued ahead of one cover — the
    cover is settled in the FIRST pass, beside the first photograph, never
    behind all three; and `--once` drains both ladders and exits 0 without
    sleeping. The media ladder is asked exactly as before (`poll_once`, its
    own outcomes)."""
    store = CoverStore(monkeypatch)
    _stub_head(monkeypatch, None)  # the photographs: no original, dead-lettered on their first attempt
    w = await _world(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        for minutes in (3, 2, 1):
            db.add(_media(UUID(w.gathering_id), status=MediaStatus.UPLOADED, created_at=_now() - timedelta(minutes=minutes)))
        await db.commit()
    image_id = await _uploaded(client, store, w.admin, GROUPS, w.group_id)
    events: list = []
    real_media, real_cover = worker_module.poll_once, worker_module.poll_cover_once

    async def media(*args, **kwargs):
        outcome = await real_media(*args, **kwargs)
        events.append(("media", outcome))
        return outcome

    async def cover(*args, **kwargs):
        outcome = await real_cover(*args, **kwargs)
        events.append(("cover", outcome))
        return outcome

    monkeypatch.setattr(worker_module, "poll_once", media)
    monkeypatch.setattr(worker_module, "poll_cover_once", cover)
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    assert await run(db_session_factory, worker, stop=asyncio.Event(), once=True, sleep=fake_sleep) == 0
    assert events == [
        ("media", Poll.PROCESSED), ("cover", Poll.PROCESSED),
        ("media", Poll.PROCESSED), ("cover", Poll.IDLE),
        ("media", Poll.PROCESSED), ("cover", Poll.IDLE),
        ("media", Poll.IDLE), ("cover", Poll.IDLE),
    ]
    assert sleeps == []
    assert (await _image(db_session_factory, image_id)).status is MediaStatus.READY
    async with db_session_factory() as db:
        assert set((await db.execute(select(Media.status))).scalars()) == {MediaStatus.READY, MediaStatus.FAILED}

    # And the other way: covers queued, no photographs — each pass settles one
    # cover, and an idle pass of both is the only exit.
    events.clear()
    for headers, kind in ((w.admin, GATHERINGS), (w.co_admin, GROUPS)):
        await _uploaded(client, store, headers, kind, _subject(w, kind))
    assert await run(db_session_factory, worker, stop=asyncio.Event(), once=True, sleep=fake_sleep) == 0
    covers = [outcome for ladder, outcome in events if ladder == "cover"]
    # Two uploads (the group's retiring the first ready one, whose destruction
    # is a third job), then idle.
    assert covers == [Poll.PROCESSED] * 3 + [Poll.IDLE]
    assert sleeps == []


async def test_a_pass_is_as_loud_as_its_louder_ladder():
    """The pass's answer: PROCESSED if either ladder settled anything, then
    BACKOFF, then NOT_READY, then IDLE — so `--once` exits 0 only when both
    are idle, and a missing `cover_images` table (the deploy window) reads
    NOT_READY with the idle interval while photographs go on draining."""
    combine = worker_module._pass_outcome
    assert combine(Poll.PROCESSED, Poll.NOT_READY) is Poll.PROCESSED
    assert combine(Poll.IDLE, Poll.PROCESSED) is Poll.PROCESSED
    assert combine(Poll.BACKOFF, Poll.IDLE) is Poll.BACKOFF
    assert combine(Poll.NOT_READY, Poll.BACKOFF) is Poll.BACKOFF
    assert combine(Poll.IDLE, Poll.NOT_READY) is Poll.NOT_READY
    assert combine(Poll.IDLE, Poll.IDLE) is Poll.IDLE


async def test_the_cover_ladder_tolerates_a_schema_without_its_table(client, capsys, db_session_factory, worker):
    """The deploy window: a new worker before 0036 lands. With `cover_images`
    renamed away the cover poll reports NOT_READY, the loop sleeps the IDLE
    interval (never the backoff), and the media ladder is unaffected."""
    async with db_session_factory() as db:
        await db.execute(text("ALTER TABLE cover_images RENAME TO cover_images_not_yet"))
        await db.commit()
    try:
        assert await poll_cover_once(db_session_factory, worker) is Poll.NOT_READY
        sleeps: list[float] = []
        stop = asyncio.Event()

        async def fake_sleep(delay: float) -> None:
            sleeps.append(delay)
            if len(sleeps) == 2:
                stop.set()

        assert await run(db_session_factory, worker, stop=stop, sleep=fake_sleep) == 0
        assert all(IDLE_POLL - IDLE_JITTER <= d <= IDLE_POLL + IDLE_JITTER for d in sleeps)
        assert await run(db_session_factory, worker, stop=asyncio.Event(), once=True, sleep=fake_sleep) == 1
    finally:
        async with db_session_factory() as db:
            await db.execute(text("ALTER TABLE cover_images_not_yet RENAME TO cover_images"))
            await db.commit()
    assert await poll_cover_once(db_session_factory, worker) is Poll.IDLE


async def test_the_reap_takes_a_day_old_intent_and_nothing_else(client, capsys, db_session_factory, monkeypatch, worker):
    """`purge_stale`'s next customer: at the top of any cover upload intent
    (after the subject's lock), a `pending_upload` cover image older than the
    quarantine rule's one number (INTENT_REAP_AFTER, 24 hours) is deleted —
    ANY subject's, here the group's while the upload is the gathering's — and
    nothing else: a fresh intent stays, and so does a day-old cover image
    that is `ready`."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    ready = await _ready_cover(client, db_session_factory, store, worker, w.admin, GATHERINGS, w.gathering_id)
    fresh = await _intent(client, w.co_admin, GROUPS, w.group_id)
    day_old = _now() - media_api.INTENT_REAP_AFTER - timedelta(minutes=1)
    abandoned = await _plant_image(
        db_session_factory, group_id=w.group_id, person_id=w.admin_person, status=MediaStatus.PENDING_UPLOAD,
        created_at=day_old,
    )
    async with db_session_factory() as db:
        await db.execute(update(CoverImage).where(CoverImage.id == UUID(ready)).values(created_at=day_old))
        await db.commit()
    response = await _upload(client, w.admin, GATHERINGS, w.gathering_id)
    assert response.status_code == 201
    assert await _image(db_session_factory, abandoned) is None
    assert (await _image(db_session_factory, ready)).status is MediaStatus.READY
    assert (await _image(db_session_factory, fresh)).status is MediaStatus.PENDING_UPLOAD


# --- the races, staged and never timed ------------------------------------------------------


def _worker_ready_update(statement) -> bool:
    """The worker's guarded UPDATE to `ready` — the first UPDATE on
    `cover_images` through `AsyncSession.execute` in a poll (the claim writes
    through a flush). Keyed on the statement, never on a lock clause."""
    table = getattr(statement, "table", None)
    return getattr(table, "name", None) == "cover_images" and "web_content_type" in _sql(statement)


_SUBJECT_READ = re.compile(r"^SELECT (gatherings|groups)\.cover_image_id\s+FROM (gatherings|groups)\b")


def _subject_lock_read(statement) -> bool:
    """`lock_subject`'s SELECT — the subject's `cover_image_id` and nothing
    else. Matched WITHOUT its `FOR UPDATE`, so a mutation that drops the lock
    still fires the hook and fails on the behaviour (CK-83a's rule (3))."""
    return isinstance(statement, Select) and bool(_SUBJECT_READ.search(_sql(statement)))


@pytest.mark.parametrize("act", ACTS)
@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_an_act_waits_behind_the_workers_ready_and_then_wins(
    act, kind, client, capsys, db_session_factory, monkeypatch, worker
):
    """STAGED, NEVER TIMED — THE WORKER FIRST: the worker's `ready`
    transaction holds the subject's lock (its guarded UPDATE has run) when the
    act — the real route, as a concurrent request — starts. The act WAITS (an
    ungranted lock in `pg_locks`), the worker commits the upload as the
    cover, and the act then sees it: a set or a clear RETIRES it (`ready` →
    `destroying`) and points the subject at its own choice; a newer upload
    intent retires nothing and leaves it the cover. Without the act's subject
    lock the act would read the cover before the worker's commit and leave a
    ready image no subject points at — the mutation run in the report."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    image_id = await _uploaded(client, store, w.admin, kind, subject)
    acts: list[asyncio.Task] = []
    seen: dict[str, str] = {}

    async def act_behind() -> None:
        task = asyncio.create_task(_act(client, w, act, kind))
        acts.append(task)
        seen["act"] = await _until_the_route_waits_or_finishes(db_session_factory, task)

    state = _stage(monkeypatch, when=_worker_ready_update, competitor=act_behind)
    assert await poll_cover_once(db_session_factory, worker) is Poll.PROCESSED
    (task,) = acts
    await task
    assert state["fired"], "the race was not staged — the hook never fired"
    assert seen["act"] == "waiting", f"the act never waited on the subject's lock ({seen})"
    row = await _image(db_session_factory, image_id)
    media_id, cover_image_id, _set_at, _by = await _pointer(db_session_factory, kind, subject)
    if act == "upload":
        assert row.status is MediaStatus.READY and cover_image_id == UUID(image_id)
    else:
        assert row.status is MediaStatus.DESTROYING and row.superseded_at is None
        assert cover_image_id is None and media_id == _expected_after(act, w)[0]
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)  # and no ready image is left that nothing points at


@pytest.mark.parametrize("act", ACTS)
@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_the_worker_waits_behind_an_act_and_settles_its_row_for_destruction(
    act, kind, client, capsys, db_session_factory, monkeypatch, worker
):
    """STAGED, NEVER TIMED — THE ACT FIRST: the act has taken the subject's
    lock and nothing else when the worker — claiming the upload, writing its
    layers — reaches its `ready` transaction. The worker WAITS on the
    subject's lock; the act supersedes the now-`processing` row (flagging it),
    writes its choice and commits; the worker then finds the flag, writes no
    cover, and settles its row to `destroying` after its writes. Without the
    worker's subject lock the two would deadlock (the worker's row against the
    act's subject) — the mutation run in the report."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    image_id = await _uploaded(client, store, w.admin, kind, subject)
    polls: list[asyncio.Task] = []
    seen: dict[str, str] = {}

    async def worker_behind() -> None:
        task = asyncio.create_task(poll_cover_once(db_session_factory, worker))
        polls.append(task)
        seen["worker"] = await _until_the_route_waits_or_finishes(db_session_factory, task)

    state = _stage(monkeypatch, when=_subject_lock_read, competitor=worker_behind)
    await _act(client, w, act, kind)
    (task,) = polls
    assert await task is Poll.PROCESSED
    assert state["fired"], "the race was not staged — the hook never fired"
    assert seen["worker"] == "waiting", f"the worker never waited on the subject's lock ({seen})"
    row = await _image(db_session_factory, image_id)
    assert row.status is MediaStatus.DESTROYING and row.superseded_at is not None
    assert {f"covers/{image_id}/web", f"covers/{image_id}/thumbnail"} <= set(store.published)  # after its writes
    media_id, cover_image_id, _set_at, _by = await _pointer(db_session_factory, kind, subject)
    assert cover_image_id is None and media_id == _expected_after(act, w)[0]
    assert await _drain(db_session_factory, worker) == [Poll.PROCESSED, Poll.IDLE]
    assert store.keys_of(image_id) == set()


# --- what a cover image is not ----------------------------------------------------------------


async def test_a_cover_image_is_in_no_photo_list_and_counts_against_nobody(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """Not a photograph: absent from the gathering's media list, its search,
    its review queue and its Removed view; no media URL for its id; and
    `photo_count`, `total_bytes` and the keeper's charged count unchanged by
    its upload, its `ready` and its destruction."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    async def usage_of_keeper() -> int:
        async with db_session_factory() as db:
            gathering = await db.get(Gathering, UUID(w.gathering_id))
            resolution = await keeping.resolved_keeper_of(db, gathering)
            return await keeping.account_usage(db, await db.get(Account, resolution.keeper_account_id))

    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(w.gathering_id))
        counts = (gathering.photo_count, gathering.total_bytes)
    usage = await usage_of_keeper()
    image_id = await _ready_cover(client, db_session_factory, store, worker, w.admin, GATHERINGS, w.gathering_id)
    for headers in (w.admin, w.member):
        for params in ({}, {"q": "jpg"}, {"awaiting_review": "true"}, {"removed": "true"}):
            listed = await client.get(f"/gatherings/{w.gathering_id}/media", params=params, headers=headers)
            if listed.status_code == 200:
                assert image_id not in listed.text, params
    assert (await _media_url(client, w.admin, image_id)).status_code == 404
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(w.gathering_id))
        assert (gathering.photo_count, gathering.total_bytes) == counts
    assert await usage_of_keeper() == usage
    assert (await _clear(client, w.admin, GATHERINGS, w.gathering_id)).status_code == 204
    await _drain(db_session_factory, worker)
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(w.gathering_id))
        assert (gathering.photo_count, gathering.total_bytes) == counts
    assert await usage_of_keeper() == usage


async def test_the_uploader_deleting_their_account_leaves_the_cover(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """Not a person's (Steven, 2026-11-01): the co-admin who uploaded both
    covers deletes their account; both stay the covers, still served, and the
    rows still point at the anonymized person."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    images = {}
    for kind in (GATHERINGS, GROUPS):
        images[kind] = await _ready_cover(client, db_session_factory, store, worker, w.co_admin, kind, _subject(w, kind))
    deleted = await client.post("/me/delete", json={"confirm": "DELETE"}, headers=w.co_admin)
    assert deleted.status_code == 204, deleted.text
    for kind in (GATHERINGS, GROUPS):
        _media_id, cover_image_id, _set_at, set_by = await _pointer(db_session_factory, kind, _subject(w, kind))
        assert (cover_image_id, set_by) == (UUID(images[kind]), w.co_admin_person)
        row = await _image(db_session_factory, images[kind])
        assert row.status is MediaStatus.READY and row.uploaded_by_person_id == w.co_admin_person
        assert (await _cover_url(client, w.admin, kind, _subject(w, kind))).status_code == 200


# --- the bodies and the URL ----------------------------------------------------------------------


async def test_an_uploaded_cover_rides_every_body_as_upload_with_no_id(
    client, capsys, db_session_factory, monkeypatch, worker
):
    """`{"source": "upload", "set_at"}` on the gathering's detail (the memory
    view too), both lists and the patch, and on the group's detail, list and
    rename — and the cover image's id, the uploader's handle, in none of
    them."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    images = {}
    for kind in (GATHERINGS, GROUPS):
        images[kind] = await _ready_cover(client, db_session_factory, store, worker, w.co_admin, kind, _subject(w, kind))
    for kind in (GATHERINGS, GROUPS):
        set_at = (await _pointer(db_session_factory, kind, _subject(w, kind)))[2]
        expected = {"source": "upload", "set_at": set_at.isoformat()}
        detail = await client.get(f"/{kind}/{_subject(w, kind)}", headers=w.admin)
        assert detail.json()["cover"] == expected
    gathering_cover = (await client.get(f"/gatherings/{w.gathering_id}", headers=w.admin)).json()["cover"]
    group_cover = (await client.get(f"/groups/{w.group_id}", headers=w.admin)).json()["cover"]
    bodies = []
    for headers in (w.admin, w.member, w.shared):
        detail = await client.get(f"/gatherings/{w.gathering_id}", headers=headers)
        assert detail.json()["cover"] == gathering_cover
        bodies.append(detail.text)
        for path in ("/gatherings", f"/groups/{w.group_id}/gatherings"):
            listed = await client.get(path, headers=headers)
            (item,) = [g for g in listed.json()["gatherings"] if g["id"] == w.gathering_id]
            assert item["cover"] == gathering_cover
            bodies.append(listed.text)
    for headers in (w.admin, w.member, w.left):
        assert (await client.get(f"/groups/{w.group_id}", headers=headers)).json()["cover"] == group_cover
        bodies.append((await client.get(f"/groups/{w.group_id}", headers=headers)).text)
        bodies.append((await client.get("/groups", headers=headers)).text)
    patched = await client.patch(f"/gatherings/{w.gathering_id}", json={"title": "Renamed"}, headers=w.admin)
    assert patched.json()["cover"] == gathering_cover
    renamed = await client.patch(f"/groups/{w.group_id}", json={"name": "Renamed"}, headers=w.admin)
    assert renamed.json()["cover"] == group_cover
    bodies += [patched.text, renamed.text]
    for body in bodies:
        for image_id in images.values():
            assert image_id not in body
        assert str(w.co_admin_person) not in body


@pytest.mark.parametrize("kind", [GATHERINGS, GROUPS])
async def test_the_cover_url_serves_an_uploaded_cover_from_its_own_keyspace(
    kind, client, capsys, db_session_factory, monkeypatch, worker
):
    """Every reader of the subject reads it — the memory tier for a
    gathering, every member (the left-out one included) for a group — from
    `covers/<id>/<layer>` through the serve credential, with the layer's
    recorded facts and no id field; `archival` is the media router's 422; a
    stranger the subject's 404."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    subject = _subject(w, kind)
    image_id = await _ready_cover(client, db_session_factory, store, worker, w.admin, kind, subject)
    row = await _image(db_session_factory, image_id)
    readers = (w.admin, w.co_admin, w.member, w.shared) + ((w.left,) if kind == GROUPS else ())
    for headers in readers:
        for layer, size in (("web", row.web_size_bytes), ("thumbnail", row.thumbnail_size_bytes)):
            response = await _cover_url(client, headers, kind, subject, layer)
            assert response.status_code == 200, response.text
            body = response.json()
            assert set(body) == URL_KEYS
            assert (body["layer"], body["content_type"], body["size_bytes"]) == (layer, "image/webp", size)
            assert urllib.parse.urlsplit(body["url"]).path.endswith(f"/covers/{image_id}/{layer}")
            assert _query(body["url"])["X-Amz-Credential"].startswith(settings.r2_serve_access_key_id)
    assert (await _cover_url(client, w.admin, kind, subject, "archival")).status_code == 422
    assert (await _cover_url(client, w.stranger, kind, subject)).status_code == 404


async def _plant_image(db_session_factory, *, gathering_id=None, group_id=None, person_id, status, **values) -> UUID:
    image_id = uuid4()
    async with db_session_factory() as db:
        db.add(
            CoverImage(
                id=image_id,
                gathering_id=UUID(gathering_id) if gathering_id else None,
                group_id=UUID(group_id) if group_id else None,
                uploaded_by_person_id=person_id,
                content_type="image/jpeg",
                size_bytes=1000,
                status=status,
                **values,
            )
        )
        await db.commit()
    assert await _image(db_session_factory, image_id) is not None, "the plant did not land"
    return image_id


FACTS = dict(web_content_type="image/webp", web_size_bytes=900, thumbnail_content_type="image/webp", thumbnail_size_bytes=90)


async def _point(db_session_factory, kind: str, subject_id: str, image_id, person_id) -> None:
    """Write a subject's uploaded-cover pointer directly — around every writer
    — and confirm it landed with its own SELECT."""
    table = GATHERINGS if kind == GATHERINGS else GROUPS
    async with db_session_factory() as db:
        await db.execute(
            text(
                f"UPDATE {table} SET cover_media_id = NULL, cover_image_id = :i, "
                "cover_set_at = CASE WHEN CAST(:i AS uuid) IS NULL THEN NULL ELSE now() END, "
                "cover_set_by_person_id = :p WHERE id = :s"
            ),
            {"i": image_id, "p": person_id if image_id else None, "s": UUID(subject_id)},
        )
        await db.commit()
    assert (await _pointer(db_session_factory, kind, subject_id))[1] == image_id, "the plant did not land"


async def test_a_pointer_at_anything_but_a_ready_cover_image_of_its_own_is_never_served(
    client, capsys, db_session_factory
):
    """A pointer no writer can leave — at a `destroying` image, or at another
    subject's `ready` one — is an integrity failure: the URL route raises
    rather than serving, the message naming no id."""
    w = await _world(client, capsys, db_session_factory)
    # A retired cover keeps its layers' facts while it is owed a destruction
    # — the realistic shape, so the rung alone is what refuses it.
    retired = await _plant_image(
        db_session_factory, gathering_id=w.gathering_id, person_id=w.admin_person, status=MediaStatus.DESTROYING, **FACTS
    )
    the_groups = await _plant_image(db_session_factory, group_id=w.group_id, person_id=w.admin_person, status=MediaStatus.READY, **FACTS)
    the_gatherings = await _plant_image(db_session_factory, gathering_id=w.gathering_id, person_id=w.admin_person, status=MediaStatus.READY, **FACTS)
    for kind, image_id in ((GATHERINGS, retired), (GATHERINGS, the_groups), (GROUPS, the_gatherings)):
        await _point(db_session_factory, kind, _subject(w, kind), image_id, w.admin_person)
        with pytest.raises(RuntimeError) as raised:
            await _cover_url(client, w.admin, kind, _subject(w, kind))
        assert str(image_id) not in str(raised.value) and "integrity" in str(raised.value)
        await _point(db_session_factory, kind, _subject(w, kind), None, None)


# --- the migration ------------------------------------------------------------------------------


async def test_0036_round_trip_takes_an_uploaded_cover_with_it_and_comes_back(
    client, capsys, db_session_factory, monkeypatch, worker, at_head_afterwards  # noqa: F811
):
    """Down to 0035 with an uploaded cover on a gathering and a photograph
    cover on the group: the uploaded cover is cleared whole (its version and
    setter too, so the 0035 CHECK stands again), the table and the column
    gone, the photograph cover untouched; up again — the table back and
    empty, the column back, the widened CHECK refusing two sources."""
    store = CoverStore(monkeypatch)
    w = await _world(client, capsys, db_session_factory)
    await _ready_cover(client, db_session_factory, store, worker, w.admin, GATHERINGS, w.gathering_id)
    assert (await _set(client, w.admin, GROUPS, w.group_id, w.photo)).status_code == 200
    group_cover = await _stored(db_session_factory, GROUPS, w.group_id)

    lines = await _migrate("downgrade", "0035", capsys)
    assert any(m.startswith("Running downgrade 0036 -> 0035") for m in lines), lines
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT to_regclass('cover_images') IS NULL"))
        row = (await db.execute(text(
            "SELECT cover_media_id, cover_set_at, cover_set_by_person_id FROM gatherings WHERE id = :g"
        ), {"g": UUID(w.gathering_id)})).one()
        assert tuple(row) == (None, None, None)
        group_row = (await db.execute(text(
            "SELECT cover_media_id, cover_set_at, cover_set_by_person_id FROM groups WHERE id = :g"
        ), {"g": UUID(w.group_id)})).one()
        assert tuple(group_row) == group_cover
        assert not await db.scalar(text(
            "SELECT count(*) FROM information_schema.columns WHERE column_name = 'cover_image_id'"
        ))

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0035 -> 0036") for m in lines), lines
    async with db_session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(CoverImage)) == 0
        image_id = await db.scalar(text(
            "INSERT INTO cover_images (group_id, uploaded_by_person_id, content_type, size_bytes, status) "
            "VALUES (:g, :p, 'image/jpeg', 10, 'pending_upload') RETURNING id"
        ), {"g": UUID(w.group_id), "p": w.admin_person})
        await db.commit()
    async with db_session_factory() as db:
        with pytest.raises(Exception):  # two sources at once: the widened CHECK refuses
            await db.execute(
                text("UPDATE groups SET cover_image_id = :i WHERE id = :g"), {"i": image_id, "g": UUID(w.group_id)}
            )
        await db.rollback()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)


# --- the verifier's eleven data lines ---------------------------------------------------------------


async def test_the_verifier_names_every_broken_uploaded_cover(client, capsys, db_session_factory):
    """scripts/verify_schema.py's eleven CK-83b data lines, each fired by
    exactly one plant written around every writer and confirmed by its own
    SELECT, then removed: clean before, between and after. The one-subject
    line's CHECK is dropped for its plant and recreated (its shape line fails
    beside it)."""
    w = await _world(client, capsys, db_session_factory)
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)
    person = w.admin_person
    G, R = w.gathering_id, w.group_id

    async def fires(line: str, plant, *, point=None, extra_fails=0) -> None:
        image_id = await plant()
        if point:
            await _point(db_session_factory, point[0], point[1], image_id, person)
        passed, failed, code, out = _verifier()
        assert (passed, failed, code) == (VERIFIER_TOTAL - 1 - extra_fails, 1 + extra_fails, 1), (line, out)
        assert f"FAIL  {line}" in out, (line, out)
        if point:
            await _point(db_session_factory, point[0], point[1], None, None)
        async with db_session_factory() as db:
            await db.execute(text("DELETE FROM cover_images WHERE id = :i"), {"i": image_id})
            await db.commit()

    def plant(**kwargs):
        return lambda: _plant_image(db_session_factory, person_id=person, **kwargs)

    await fires(
        "every gathering's uploaded cover is a ready cover image of that gathering",
        plant(gathering_id=G, status=MediaStatus.DESTROYING),
        point=(GATHERINGS, G),
    )
    await fires(
        "every group's uploaded cover is a ready cover image of that group",
        plant(group_id=R, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UNREADABLE, last_error="planted"),
        point=(GROUPS, R),
    )
    await fires(
        "every ready cover image is its subject's cover (none replaced and still stored)",
        plant(gathering_id=G, status=MediaStatus.READY, **FACTS),
    )
    await fires(
        "every failed cover image says why, and no other cover image does",
        plant(gathering_id=G, status=MediaStatus.UPLOADED, failure_reason=MediaFailureReason.UNREADABLE),
    )
    await fires(
        "every failed cover image carries a last_error",
        plant(gathering_id=G, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.TOO_LARGE),
    )
    await fires(
        "claimed_at is always set on a processing cover image, and set only on a processing or destroying one",
        plant(gathering_id=G, status=MediaStatus.PROCESSING),
    )
    await fires(
        "every destroying cover image that has spent an attempt and is not held carries a last_error",
        plant(gathering_id=G, status=MediaStatus.DESTROYING, attempts=1),
    )
    await fires(
        "every ready cover image carries its two layers' facts",
        plant(gathering_id=G, status=MediaStatus.READY),
        point=(GATHERINGS, G),
    )
    await fires(
        "no cover image outside ready or destroying carries layer facts",
        plant(gathering_id=G, status=MediaStatus.FAILED, failure_reason=MediaFailureReason.UNREADABLE, last_error="planted", **FACTS),
    )
    await fires(
        "superseded_at is only on a processing, destroying or destroyed cover image",
        plant(gathering_id=G, status=MediaStatus.UPLOADED, superseded_at=_now()),
    )
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)

    # Two subjects at once: the CHECK refuses it, so it is dropped for the
    # plant and recreated after — its shape line fails beside the data line.
    async with db_session_factory() as db:
        await db.execute(text("ALTER TABLE cover_images DROP CONSTRAINT ck_cover_images_one_subject"))
        await db.commit()
    try:
        await fires(
            "every cover image names exactly one subject",
            plant(gathering_id=G, group_id=R, status=MediaStatus.PENDING_UPLOAD),
            extra_fails=1,
        )
    finally:
        async with db_session_factory() as db:
            await db.execute(text(
                "ALTER TABLE cover_images ADD CONSTRAINT ck_cover_images_one_subject "
                "CHECK (num_nonnulls(gathering_id, group_id) = 1)"
            ))
            await db.commit()
    assert _verifier()[:3] == (VERIFIER_TOTAL, 0, 0)
