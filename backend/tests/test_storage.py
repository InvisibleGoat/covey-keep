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
"""

import urllib.parse

import pytest

from app.config import settings
from app.services import storage
from app.services.storage import (
    PRESIGN_TTL,
    PresignedRead,
    PresignedUpload,
    ServeClient,
    UploadClient,
    presign_read,
    presign_upload,
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
