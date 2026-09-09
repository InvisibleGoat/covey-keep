"""CK-33 — app/services/storage.py: the one home for R2 access.

No network anywhere in this file. botocore's presigner runs entirely locally
(SigV4 is arithmetic over the request and the secret), so these tests assert
on URLs GENUINELY produced by the signing configuration the application
uses — not on a stub's echo of its inputs. The conftest points the endpoint
at a reserved TLD so nothing could connect even by accident.

What is pinned:
- a presigned PUT targets the quarantine bucket, is signed by the UPLOAD key
  id, carries the body's Content-Length and Content-Type in the signed
  headers (§6.6 — the size limit is signed, not trusted), and expires after
  PRESIGN_TTL;
- a presigned GET targets the published bucket, is signed by the SERVE key
  id, and expires after PRESIGN_TTL;
- the two clients are not interchangeable: every function refuses the other
  type with a TypeError (structure, not discipline);
- nothing that could land in a log shows a URL or a key id;
- the client is configured the way R2 needs (Cloudflare's checksum guidance).

CK-36 adds the published side: `published_key` is a pure function of (row
id, layer) with no extension; `put_published_object` takes the WorkerClient
alone, sends the storage class and content type per object, and refuses the
two web types; and `delete_quarantine_object` treats an absent object as a
success — the two-live-workers rule — while every other error still raises.
The raw client is a recording stub for those three: no network.
"""

import logging
import urllib.parse
from uuid import UUID, uuid4

import pytest
from botocore.exceptions import ClientError

from app.config import settings
from app.models import MediaLayer
from app.services import storage
from app.services.storage import (
    PRESIGN_TTL,
    PresignedRead,
    PresignedUpload,
    ServeClient,
    UploadClient,
    WorkerClient,
    delete_quarantine_object,
    presign_read,
    presign_upload,
    published_key,
    put_published_object,
    quarantine_key,
)


def _query(url: str) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


def _path(url: str) -> str:
    return urllib.parse.urlsplit(url).path


@pytest.fixture
def upload() -> UploadClient:
    return storage.upload_client(settings)


@pytest.fixture
def serve() -> ServeClient:
    return storage.serve_client(settings)


# --- The presigned PUT --------------------------------------------------------


def test_presigned_put_targets_quarantine_and_signs_the_content_length(upload):
    presigned = presign_upload(
        upload, key="media/abc.jpg", content_length=4_200_000, content_type="image/jpeg"
    )

    assert isinstance(presigned, PresignedUpload)
    assert presigned.method == "PUT"
    # Path-style addressing: the bucket is the first path segment, and it is
    # the QUARANTINE bucket — the upload client knows no other.
    assert _path(presigned.url).startswith(f"/{settings.r2_bucket_quarantine}/")
    assert _path(presigned.url).endswith("/media/abc.jpg")
    assert settings.r2_bucket_published not in presigned.url

    query = _query(presigned.url)
    assert query["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    # Signed by the upload credential, never the serve one.
    assert query["X-Amz-Credential"].startswith(settings.r2_upload_access_key_id + "/")
    assert settings.r2_serve_access_key_id not in presigned.url
    # THE PIN: the size is signed. R2 rejects a body of any other length.
    signed_headers = set(query["X-Amz-SignedHeaders"].split(";"))
    assert "content-length" in signed_headers
    assert "content-type" in signed_headers
    assert "host" in signed_headers
    # And the caller is handed exactly the headers the signature expects.
    assert presigned.headers == {"Content-Length": "4200000", "Content-Type": "image/jpeg"}
    # Short-lived: one constant, never inline.
    assert int(query["X-Amz-Expires"]) == int(PRESIGN_TTL.total_seconds())
    assert presigned.expires_in == int(PRESIGN_TTL.total_seconds())


def test_a_different_size_produces_a_different_signature(upload):
    # Two intents for the same key differing only in size sign differently:
    # the Content-Length header is inside the canonical request, so a client
    # that lies about size after intent cannot reuse a signature.
    a = presign_upload(upload, key="k", content_length=100, content_type="image/jpeg")
    b = presign_upload(upload, key="k", content_length=101, content_type="image/jpeg")
    assert _query(a.url)["X-Amz-Signature"] != _query(b.url)["X-Amz-Signature"]


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(key="", content_length=1, content_type="image/jpeg"),
        dict(key="k", content_length=0, content_type="image/jpeg"),
        dict(key="k", content_length=-1, content_type="image/jpeg"),
        dict(key="k", content_length=1, content_type=""),
    ],
)
def test_presigned_put_refuses_an_unsignable_intent(upload, kwargs):
    with pytest.raises(ValueError):
        presign_upload(upload, **kwargs)


# --- The presigned GET --------------------------------------------------------


def test_presigned_get_targets_published_with_the_serve_credential(serve):
    presigned = presign_read(serve, key="derivatives/abc/web.webp")

    assert isinstance(presigned, PresignedRead)
    assert presigned.method == "GET"
    assert _path(presigned.url).startswith(f"/{settings.r2_bucket_published}/")
    assert _path(presigned.url).endswith("/derivatives/abc/web.webp")
    assert settings.r2_bucket_quarantine not in presigned.url

    query = _query(presigned.url)
    assert query["X-Amz-Credential"].startswith(settings.r2_serve_access_key_id + "/")
    assert settings.r2_upload_access_key_id not in presigned.url
    assert int(query["X-Amz-Expires"]) == int(PRESIGN_TTL.total_seconds())
    assert presigned.expires_in == int(PRESIGN_TTL.total_seconds())


def test_presigned_get_refuses_an_empty_key(serve):
    with pytest.raises(ValueError):
        presign_read(serve, key="")


# --- Not interchangeable ----------------------------------------------------


def test_the_two_clients_are_distinct_types_bound_to_their_own_bucket(upload, serve):
    assert isinstance(upload, UploadClient)
    assert isinstance(serve, ServeClient)
    assert not isinstance(upload, ServeClient)
    assert not isinstance(serve, UploadClient)
    assert upload.bucket == settings.r2_bucket_quarantine
    assert serve.bucket == settings.r2_bucket_published


def test_presign_upload_refuses_the_serve_client(serve):
    # The wrong credential is a TypeError, not a presigned PUT into the wrong
    # bucket — the point of two types rather than one client and a bucket arg.
    with pytest.raises(TypeError, match="UploadClient"):
        presign_upload(serve, key="k", content_length=1, content_type="image/jpeg")


def test_presign_read_refuses_the_upload_client(upload):
    with pytest.raises(TypeError, match="ServeClient"):
        presign_read(upload, key="k")


def test_quarantine_object_operations_refuse_the_serve_client(serve):
    for fn in (
        storage.head_quarantine_object,
        storage.read_quarantine_object,
        storage.delete_quarantine_object,
    ):
        with pytest.raises(TypeError, match="UploadClient"):
            fn(serve, key="k")


def test_no_module_level_default_client():
    # Nothing importable is "the client": a default that could be either
    # credential is exactly what the two types exist to rule out.
    for name in dir(storage):
        value = getattr(storage, name)
        assert not isinstance(value, (UploadClient, ServeClient)), name


# --- Nothing loggable shows a credential -----------------------------------


def test_presigned_results_redact_the_url_from_their_repr(upload, serve):
    put = presign_upload(upload, key="k", content_length=1, content_type="image/jpeg")
    get = presign_read(serve, key="k")
    for shown in (repr(put), str(put), repr(get), str(get), f"{put}", f"{get}"):
        assert "X-Amz-Signature" not in shown
        assert "X-Amz-Credential" not in shown
        assert settings.r2_upload_access_key_id not in shown
        assert settings.r2_serve_access_key_id not in shown
        assert "<redacted>" in shown


def test_client_reprs_show_the_bucket_and_never_the_key_id(upload, serve):
    for shown in (repr(upload), str(upload), repr(serve), str(serve)):
        assert settings.r2_upload_access_key_id not in shown
        assert settings.r2_serve_access_key_id not in shown
        assert settings.r2_endpoint_url not in shown
    assert settings.r2_bucket_quarantine in repr(upload)
    assert settings.r2_bucket_published in repr(serve)


# --- The client is configured the way R2 needs -------------------------------


def test_client_configuration_matches_r2(upload, serve):
    for client in (upload.raw, serve.raw):
        config = client.meta.config
        assert config.signature_version == "s3v4"
        assert config.s3 == {"addressing_style": "path"}
        # Cloudflare's guidance for botocore >= 1.36: its newer checksum
        # defaults (CRC32 trailers, aws-chunked) are not supported by R2.
        assert config.request_checksum_calculation == "when_required"
        assert config.response_checksum_validation == "when_required"
        assert client.meta.endpoint_url == settings.r2_endpoint_url
        assert client.meta.region_name == "auto"


# --- The published side (CK-36) ------------------------------------------------


class _RecordingRaw:
    """A stand-in for the botocore client: records the call, raises what it
    is told to."""

    def __init__(self, raises: Exception | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.raises = raises

    def put_object(self, **kwargs):
        self.calls.append(("put_object", kwargs))
        if self.raises:
            raise self.raises

    def delete_object(self, **kwargs):
        self.calls.append(("delete_object", kwargs))
        if self.raises:
            raise self.raises


def _worker(raw=None) -> WorkerClient:
    return WorkerClient(raw=raw or _RecordingRaw(), quarantine_bucket="test-quarantine", published_bucket="test-published")


def _client_error(code: str, status: int) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "stub"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "DeleteObject",
    )


def test_published_key_is_a_pure_function_of_the_row_id_and_the_layer():
    media_id = UUID("11111111-2222-3333-4444-555555555555")
    assert published_key(media_id, MediaLayer.ARCHIVAL) == "media/11111111-2222-3333-4444-555555555555/archival"
    assert published_key(media_id, MediaLayer.WEB) == "media/11111111-2222-3333-4444-555555555555/web"
    assert published_key(media_id, MediaLayer.THUMBNAIL) == "media/11111111-2222-3333-4444-555555555555/thumbnail"
    # Deterministic (a retry overwrites its own keys), distinct per layer,
    # no extension (the row records the format), and never in the
    # quarantine keyspace.
    assert published_key(media_id, MediaLayer.WEB) == published_key(media_id, MediaLayer.WEB)
    assert len({published_key(media_id, layer) for layer in MediaLayer}) == 3
    assert "." not in published_key(media_id, MediaLayer.WEB).rsplit("/", 1)[1]
    assert not published_key(media_id, MediaLayer.WEB).startswith(storage.QUARANTINE_PREFIX)
    assert not quarantine_key(media_id).startswith(storage.PUBLISHED_PREFIX)


def test_put_published_object_writes_to_published_with_the_class_and_type_per_object():
    raw = _RecordingRaw()
    put_published_object(
        _worker(raw), key="media/x/archival", body=b"jpeg-bytes", content_type="image/jpeg", storage_class="STANDARD_IA"
    )
    assert raw.calls == [
        (
            "put_object",
            {
                "Bucket": "test-published",
                "Key": "media/x/archival",
                "Body": b"jpeg-bytes",
                "ContentType": "image/jpeg",
                "ContentLength": 10,
                "StorageClass": "STANDARD_IA",
            },
        )
    ]


def test_put_published_object_refuses_both_web_clients(upload, serve):
    for client in (upload, serve):
        with pytest.raises(TypeError, match="WorkerClient"):
            put_published_object(client, key="k", body=b"x", content_type="image/jpeg", storage_class="STANDARD")


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(key="", body=b"x", content_type="image/jpeg", storage_class="STANDARD"),
        dict(key="k", body=b"", content_type="image/jpeg", storage_class="STANDARD"),
        dict(key="k", body=b"x", content_type="", storage_class="STANDARD"),
        dict(key="k", body=b"x", content_type="image/jpeg", storage_class=""),
    ],
)
def test_put_published_object_refuses_an_incomplete_write(kwargs):
    raw = _RecordingRaw()
    with pytest.raises(ValueError):
        put_published_object(_worker(raw), **kwargs)
    assert raw.calls == []


def test_deleting_an_absent_quarantine_object_is_a_success():
    # Two live workers for ~61 seconds on every deploy (CK-35's (cw)): the
    # predecessor's delete may land first. R2 answers 204 regardless; a
    # store that answers 404 is swallowed here.
    for code, status in (("NoSuchKey", 404), ("404", 404), ("NotFound", 404)):
        raw = _RecordingRaw(raises=_client_error(code, status))
        assert delete_quarantine_object(_worker(raw), key="uploads/x") is None
        assert raw.calls == [("delete_object", {"Bucket": "test-quarantine", "Key": "uploads/x"})]


def test_every_other_delete_failure_still_raises():
    raw = _RecordingRaw(raises=_client_error("AccessDenied", 403))
    with pytest.raises(ClientError):
        delete_quarantine_object(_worker(raw), key="uploads/x")
    raw = _RecordingRaw(raises=_client_error("InternalError", 500))
    with pytest.raises(ClientError):
        delete_quarantine_object(_worker(raw), key="uploads/x")


def test_the_serve_client_is_still_refused_on_the_published_write(serve):
    # Read-only by credential (the verifier proves the bucket refuses it);
    # refused here by type before any request is made.
    with pytest.raises(TypeError, match="WorkerClient"):
        put_published_object(serve, key=published_key(uuid4(), MediaLayer.WEB), body=b"x", content_type="image/webp", storage_class="STANDARD")


def test_the_signing_librarys_debug_logging_never_prints_a_signature(upload, serve, caplog):
    """botocore.auth logs the canonical request, the string to sign and the
    signature itself at DEBUG. storage.py pins that logger above DEBUG at
    import, so even a root logger at DEBUG — someone chasing a deploy — sees
    no signature and no key id. Found at CK-36 when the suite's loggers were
    re-enabled; before that CK-34's never-log pins could not have seen it."""
    with caplog.at_level(logging.DEBUG):
        put = presign_upload(upload, key="uploads/x", content_length=10, content_type="image/jpeg")
        get = presign_read(serve, key="media/x/web")
    for presigned in (put, get):
        signature = _query(presigned.url)["X-Amz-Signature"]
        assert signature not in caplog.text
        assert presigned.url not in caplog.text
    assert settings.r2_upload_access_key_id not in caplog.text
    assert settings.r2_serve_access_key_id not in caplog.text
    assert "Signature:" not in caplog.text
    assert logging.getLogger("botocore.auth").level >= logging.INFO
