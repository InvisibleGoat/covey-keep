"""Storage — the one home for R2 access (CK-33).

Two buckets, two credentials, and the point of this module is that they are
never interchangeable (media pipeline record §3, §8, §11):

- The UPLOAD credential (`R2_UPLOAD_*`) is scoped to the quarantine bucket
  only, Object Read & Write. It signs the presigned PUT a browser uploads
  through, and it can read, confirm (HEAD) and delete what landed there. R2
  has no write-only level, so "can read quarantine" is the honest bound of
  the split (§3 at 1.3.0) — pinned POSITIVELY by
  scripts/verify_r2_credentials.py so a later scope change is visible.
- The SERVE credential (`R2_SERVE_*`) is scoped to the published bucket
  only, Object Read only. It signs the presigned GET a reader fetches a
  published derivative through. IT CANNOT READ QUARANTINE — which is what
  makes "nothing is ever served from quarantine" a property of the
  credential rather than a rule every handler must remember. The verifier
  script proves that against live R2; until CK-33 nothing ever had.

The worker credential (`R2_WORKER_*`, both buckets) never enters this
process: the worker is its own service with its own environment (CK-35),
and neither service holds the other's keys (§11.1).

Structure, not discipline. UploadClient and ServeClient are distinct types,
each knowing exactly one bucket; every function here takes one specific type
and raises TypeError for the other; and there is no module-level default
client that could be either. Application code never names a bucket — the
client it holds already knows the only one it may touch. The raw botocore
client is reachable as `.raw` for the verifier's DELIBERATE wrong-bucket
probes and for nothing in application code.

A presigned URL is a bearer credential (record §9 — binding, restated here
because this is where it is minted):
  - short-lived: PRESIGN_TTL, one constant, never inline;
  - one object, one method: a PUT for one quarantine key with the body's
    Content-Length (and Content-Type) SIGNED INTO IT, so R2 itself rejects
    a body that differs (§6.6 — the size limit is signed, not trusted; a
    declared-size check at the endpoint alone would be a client-side check
    in a server-side costume); a GET for one published key;
  - issued only to a caller already authorised for the gathering — that
    authorisation is the endpoint's job (CK-34), never this module's,
    which is why nothing here takes a person or a gathering;
  - NEVER LOGGED, on any path, success or failure. It carries the Access
    Key ID and a valid signature (§11.3). The presigned result types
    redact the URL from their repr for the same reason: a repr lands in
    tracebacks, and a traceback lands in a log.

The quarantine key layout lives here too (CK-34): `quarantine_key` is the
one pure function of a media row's id that the intent endpoint signs a PUT
for, the confirm step HEADs, and the worker (CK-35) reads and deletes —
one home, imported by both services, so the two can never compute
different keys. The object functions below still take a key rather than a
row, because the verifier script writes its own test object under its own
key and must not look like a photograph.

No router, no FastAPI import: the callers are api/media.py (the intent
endpoint and the confirm step, CK-34) and the verifier script. botocore is
synchronous — presigning is pure computation (no network) and safe to call
from async code; the object operations below block on the network, and an
async caller runs them via asyncio.to_thread. Client construction loads the
S3 service model (tens of milliseconds); the endpoint phase decides how to
hold one per process — nothing here caches, so the two constructors stay
plain functions of their settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional
from uuid import UUID

from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.session import get_session

from app.config import Settings, settings as app_settings

# How long a presigned URL stays valid — one constant for both methods (§9:
# short-lived). Fifteen minutes clears a 25MB photograph over a slow cellular
# link with room for the browser's own retries; a reader fetching a
# derivative needs seconds of it. If the read side ever wants its own
# number, split this deliberately; never inline a second value.
PRESIGN_TTL = timedelta(minutes=15)

# botocore treats these HTTP statuses / codes as "the object is not there"
# on a HEAD (no body, so the code is the bare status) and on a GET.
_ABSENT_CODES = {"404", "NoSuchKey", "NotFound"}

# The quarantine key prefix. The media row stores no key (schema-shape
# record §5): the original's key is DERIVED from the row id, so nothing can
# drift, and the bucket's lifecycle rule is bucket-wide so the layout is
# free. The prefix keeps a photograph's object visibly apart from the
# verifier's `verify-r2-credentials/` test objects in a bucket listing.
QUARANTINE_PREFIX = "uploads/"


def quarantine_key(media_id: UUID) -> str:
    """The quarantine object key for one media row — a pure function of the
    row's id and nothing else (no extension, no content type: the declared
    type is advisory until the worker reads the bytes, and a key that
    encoded it would be a second representation of a fact the row already
    holds). The intent endpoint, the confirm step, and the worker all
    derive the same key from the same id through this one function."""
    return f"{QUARANTINE_PREFIX}{media_id}"


def _client(access_key_id: str, secret_access_key: str, endpoint_url: str):
    """One botocore S3 client for one credential. Region "auto" is what R2
    signs against; path-style addressing keeps the URL shape identical on
    every S3-compatible endpoint (the verifier is also run against a local
    one). The two checksum settings are Cloudflare's own guidance for
    botocore >= 1.36, whose newer defaults add CRC32 trailers (aws-chunked
    encoding) to uploads and expect checksum headers on downloads — R2
    supports neither, and without `when_required` a plain put_object fails."""
    return get_session().create_client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


@dataclass(frozen=True, repr=False)
class UploadClient:
    """The upload credential, bound to the quarantine bucket. Knows no other
    bucket; the functions that accept it presign PUTs into, and read / HEAD /
    delete objects in, quarantine and nothing else."""

    raw: Any
    bucket: str

    def __repr__(self) -> str:
        # The bucket only — never the key id, never the endpoint.
        return f"UploadClient(bucket={self.bucket!r})"


@dataclass(frozen=True, repr=False)
class ServeClient:
    """The serve credential, bound to the published bucket. Knows no other
    bucket; the one function that accepts it presigns GETs from published."""

    raw: Any
    bucket: str

    def __repr__(self) -> str:
        return f"ServeClient(bucket={self.bucket!r})"


def upload_client(settings: Settings = app_settings) -> UploadClient:
    """Build the upload-credential client from settings. Nothing caches it."""
    return UploadClient(
        raw=_client(
            settings.r2_upload_access_key_id,
            settings.r2_upload_secret_access_key,
            settings.r2_endpoint_url,
        ),
        bucket=settings.r2_bucket_quarantine,
    )


def serve_client(settings: Settings = app_settings) -> ServeClient:
    """Build the serve-credential client from settings. Nothing caches it."""
    return ServeClient(
        raw=_client(
            settings.r2_serve_access_key_id,
            settings.r2_serve_secret_access_key,
            settings.r2_endpoint_url,
        ),
        bucket=settings.r2_bucket_published,
    )


@dataclass(frozen=True, repr=False)
class PresignedUpload:
    """A presigned PUT: the URL, and the exact headers the uploader must send
    — R2 rejects the request if either differs from what was signed. A
    browser sets Content-Length from the body itself (it is a forbidden
    header name for scripts), which is precisely why the signed value must
    equal the file's real size. The repr never shows the URL."""

    url: str
    method: str
    headers: dict[str, str]
    expires_in: int

    def __repr__(self) -> str:
        return (
            f"PresignedUpload(method={self.method!r}, headers={self.headers!r}, "
            f"expires_in={self.expires_in}, url=<redacted>)"
        )


@dataclass(frozen=True, repr=False)
class PresignedRead:
    """A presigned GET for one published object. The repr never shows the URL."""

    url: str
    method: str
    expires_in: int

    def __repr__(self) -> str:
        return f"PresignedRead(method={self.method!r}, expires_in={self.expires_in}, url=<redacted>)"


def _require_upload(client: object, what: str) -> UploadClient:
    if not isinstance(client, UploadClient):
        raise TypeError(
            f"{what} takes the UploadClient: quarantine is touched by the upload "
            f"credential and nothing else (got {client.__class__.__name__})"
        )
    return client


def _require_serve(client: object, what: str) -> ServeClient:
    if not isinstance(client, ServeClient):
        raise TypeError(
            f"{what} takes the ServeClient: published media is served by the serve "
            f"credential and nothing else (got {client.__class__.__name__})"
        )
    return client


def presign_upload(
    upload: UploadClient, *, key: str, content_length: int, content_type: str
) -> PresignedUpload:
    """A presigned PUT into quarantine for ONE key, with the body's size and
    type signed in. `key` is the quarantine key derived from the media row's
    id — the derivation belongs beside the row's creator (CK-34) and the
    worker computes the same one; this module takes the key it is given."""
    upload = _require_upload(upload, "presign_upload")
    if not key:
        raise ValueError("key must not be empty")
    if content_length <= 0:
        raise ValueError("content_length must be positive")
    if not content_type:
        raise ValueError("content_type must not be empty")
    expires_in = int(PRESIGN_TTL.total_seconds())
    url = upload.raw.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": upload.bucket,
            "Key": key,
            # Serialised as the Content-Length / Content-Type headers of the
            # request being signed, so both land in X-Amz-SignedHeaders: a
            # body of any other length, or another declared type, fails the
            # signature at R2 (§6.6). This is the size limit being enforced
            # by the object store rather than trusted from the client.
            "ContentLength": content_length,
            "ContentType": content_type,
        },
        ExpiresIn=expires_in,
        HttpMethod="PUT",
    )
    # DO NOT LOG `url` — not here, not in the caller, not on a failure path.
    # It is a bearer credential for one write into the bucket that holds
    # unprocessed photographs, valid for PRESIGN_TTL to whoever holds it.
    return PresignedUpload(
        url=url,
        method="PUT",
        headers={"Content-Length": str(content_length), "Content-Type": content_type},
        expires_in=expires_in,
    )


def presign_read(serve: ServeClient, *, key: str) -> PresignedRead:
    """A presigned GET from published for ONE key. Never for a quarantine key
    — this function cannot name that bucket, and the credential it signs
    with cannot read it (the verifier proves the second half)."""
    serve = _require_serve(serve, "presign_read")
    if not key:
        raise ValueError("key must not be empty")
    expires_in = int(PRESIGN_TTL.total_seconds())
    url = serve.raw.generate_presigned_url(
        "get_object",
        Params={"Bucket": serve.bucket, "Key": key},
        ExpiresIn=expires_in,
        HttpMethod="GET",
    )
    # DO NOT LOG `url` — a bearer credential for one read, carrying the
    # serve Access Key ID and a valid signature (§11.3).
    return PresignedRead(url=url, method="GET", expires_in=expires_in)


def head_quarantine_object(upload: UploadClient, *, key: str) -> Optional[tuple[int, str]]:
    """(size in bytes, content type) of a quarantine object, or None when no
    such object exists. The confirm step's question (CK-34): did the bytes
    the intent signed for actually land? Blocks on the network."""
    upload = _require_upload(upload, "head_quarantine_object")
    try:
        response = upload.raw.head_object(Bucket=upload.bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _ABSENT_CODES:
            return None
        raise
    return int(response["ContentLength"]), str(response.get("ContentType", ""))


def read_quarantine_object(upload: UploadClient, *, key: str) -> bytes:
    """The bytes of a quarantine object. The upload credential can read what
    it wrote (§3's honest bound); the verifier reads its own test object back
    through this. Blocks on the network."""
    upload = _require_upload(upload, "read_quarantine_object")
    response = upload.raw.get_object(Bucket=upload.bucket, Key=key)
    return response["Body"].read()


def delete_quarantine_object(upload: UploadClient, *, key: str) -> None:
    """Delete one quarantine object. Idempotent at R2 (deleting an absent key
    succeeds). Blocks on the network."""
    upload = _require_upload(upload, "delete_quarantine_object")
    upload.raw.delete_object(Bucket=upload.bucket, Key=key)
