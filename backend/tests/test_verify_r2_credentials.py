"""CK-33 — scripts/verify_r2_credentials.py: the negative tests, committed.

The script's whole value is in telling "refused" apart from "didn't work".
These tests drive its check runner with stub clients standing in for R2 and
make each assertion FAIL the way the kickoff demands (CK-21's rule: make it
fail before believing it): the serve credential able to read quarantine, a
network error, a missing bucket, a broken key, a store that accepts a
mismatched body — each must report FAIL, never pass over an error. A live
run against the real buckets is the phase's deliverable; this file is what
makes the script's verdicts trustworthy before that run.

No network: the stubs are in-memory dictionaries, and the "HTTP" function
handed to the runner honours the signed Content-Length the way R2 does.
"""

import importlib.util
import sys
from pathlib import Path

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from app.services.storage import ServeClient, UploadClient

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "verify_r2_credentials.py"


@pytest.fixture(scope="module")
def script():
    spec = importlib.util.spec_from_file_location("verify_r2_credentials", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# --- Stubs -------------------------------------------------------------------


def _client_error(code: str, status: int, operation: str = "GetObject") -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "stub"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        operation,
    )


def denied(operation: str = "GetObject") -> ClientError:
    return _client_error("AccessDenied", 403, operation)


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data


class StubRaw:
    """A botocore-shaped client over an in-memory store per bucket. `rules`
    maps (operation, bucket) to an exception to raise or a callable; an
    operation with no rule behaves like an S3 bucket the credential may use."""

    def __init__(self, stores: dict[str, dict[str, bytes]], rules: dict | None = None) -> None:
        self.stores = stores
        self.rules = rules or {}
        self.calls: list[tuple[str, str, str | None]] = []

    def _apply(self, op: str, bucket: str, key: str | None):
        self.calls.append((op, bucket, key))
        rule = self.rules.get((op, bucket))
        if isinstance(rule, BaseException):
            raise rule
        if callable(rule):
            return rule()
        if bucket not in self.stores:
            raise _client_error("NoSuchBucket", 404, op)
        return None

    def generate_presigned_url(self, method, Params, ExpiresIn, HttpMethod=None):
        return f"https://stub.invalid/{Params['Bucket']}/{Params['Key']}?X-Amz-Expires={ExpiresIn}"

    def get_object(self, Bucket, Key):
        result = self._apply("get", Bucket, Key)
        if result is not None:
            return result
        if Key not in self.stores[Bucket]:
            raise _client_error("NoSuchKey", 404, "GetObject")
        return {"Body": _Body(self.stores[Bucket][Key])}

    def put_object(self, Bucket, Key, Body, **_):
        result = self._apply("put", Bucket, Key)
        if result is not None:
            return result
        self.stores[Bucket][Key] = Body
        return {}

    def delete_object(self, Bucket, Key):
        result = self._apply("delete", Bucket, Key)
        if result is not None:
            return result
        self.stores[Bucket].pop(Key, None)
        return {}

    def head_object(self, Bucket, Key):
        result = self._apply("head", Bucket, Key)
        if result is not None:
            return result
        if Key not in self.stores[Bucket]:
            raise _client_error("404", 404, "HeadObject")
        data = self.stores[Bucket][Key]
        return {"ContentLength": len(data), "ContentType": "application/octet-stream"}

    def list_objects_v2(self, Bucket, MaxKeys=1000):
        result = self._apply("list", Bucket, None)
        if result is not None:
            return result
        return {"KeyCount": 0}


QUARANTINE = "stub-quarantine"
PUBLISHED = "stub-published"


def _http_honouring_signed_length(stores):
    """Stands in for R2 answering a presigned request: a PUT whose body length
    matches the signed Content-Length lands in the store; any other length is
    refused with 403; a GET answers 200/404 by presence."""

    def http(method, url, headers, body):
        bucket, key = url.split("stub.invalid/", 1)[1].split("?", 1)[0].split("/", 1)
        if method == "PUT":
            signed = headers.get("Content-Length")
            if signed is None or int(signed) != len(body):
                return 403
            stores[bucket][key] = body
            return 200
        if method == "GET":
            return 200 if key in stores.get(bucket, {}) else 404
        raise AssertionError(method)

    return http


def _correct_split(serve_rules=None, upload_rules=None):
    """The as-provisioned scopes (record §11.1): upload = quarantine only,
    read+write; serve = published only, read only."""
    stores = {QUARANTINE: {}, PUBLISHED: {}}
    upload_raw = StubRaw(
        stores,
        {("get", PUBLISHED): denied(), ("put", PUBLISHED): denied("PutObject"), **(upload_rules or {})},
    )
    serve_raw = StubRaw(
        stores,
        {
            ("get", QUARANTINE): denied(),
            ("put", QUARANTINE): denied("PutObject"),
            ("put", PUBLISHED): denied("PutObject"),
            ("delete", PUBLISHED): denied("DeleteObject"),
            **(serve_rules or {}),
        },
    )
    upload = UploadClient(raw=upload_raw, bucket=QUARANTINE)
    serve = ServeClient(raw=serve_raw, bucket=PUBLISHED)
    return stores, upload, serve


def _run(script, stores, upload, serve, capsys, http=None):
    ck = script.Checks()
    script.verify(upload, serve, ck, key="verify-r2-credentials/test.bin", http=http or _http_honouring_signed_length(stores))
    out = capsys.readouterr().out
    return ck, out


def _failed_labels(out: str) -> list[str]:
    return [line for line in out.splitlines() if line.startswith("FAIL")]


# --- The correct split passes cleanly ---------------------------------------


def test_the_as_provisioned_split_passes_every_check(script, capsys):
    stores, upload, serve = _correct_split()
    ck, out = _run(script, stores, upload, serve, capsys)
    assert ck.failed == 0, _failed_labels(out)
    assert ck.passed == 10
    assert "REFUSED reading quarantine (ClientError AccessDenied (HTTP 403))" in out
    # Cleanup ran: nothing left in either bucket.
    assert stores == {QUARANTINE: {}, PUBLISHED: {}}


def test_output_never_shows_a_url_or_a_key_id(script, capsys):
    stores, upload, serve = _correct_split()
    _, out = _run(script, stores, upload, serve, capsys)
    assert "stub.invalid" not in out
    assert "X-Amz" not in out
    assert "https://" not in out


# --- Assertion 3: refusal, and only refusal, passes -------------------------


def test_serve_reading_quarantine_is_a_fail_not_a_pass(script, capsys):
    stores, upload, serve = _correct_split(serve_rules={("get", QUARANTINE): None})
    ck, out = _run(script, stores, upload, serve, capsys)
    assert ck.failed == 1
    [line] = _failed_labels(out)
    assert "serve credential is REFUSED reading quarantine" in line
    assert "READ the quarantine object" in line
    assert "finding" in line


def test_a_network_error_on_the_serve_probe_is_a_fail(script, capsys):
    stores, upload, serve = _correct_split(
        serve_rules={("get", QUARANTINE): EndpointConnectionError(endpoint_url="https://stub.invalid")}
    )
    ck, out = _run(script, stores, upload, serve, capsys)
    [line] = _failed_labels(out)
    assert "REFUSED reading quarantine" in line
    assert "network" in line
    assert "EndpointConnectionError" in line
    # The endpoint URL inside the exception message never reaches the output.
    assert "stub.invalid" not in out


def test_a_missing_bucket_on_the_serve_probe_is_a_fail(script, capsys):
    stores, upload, serve = _correct_split(
        serve_rules={("get", QUARANTINE): _client_error("NoSuchBucket", 404)}
    )
    ck, out = _run(script, stores, upload, serve, capsys)
    [line] = _failed_labels(out)
    assert "REFUSED reading quarantine" in line
    assert "not found" in line
    assert "NoSuchBucket" in line


def test_a_broken_serve_key_is_a_fail_not_a_narrow_scope(script, capsys):
    stores, upload, serve = _correct_split(
        serve_rules={
            ("get", QUARANTINE): _client_error("SignatureDoesNotMatch", 403),
            ("put", PUBLISHED): _client_error("SignatureDoesNotMatch", 403, "PutObject"),
            ("list", PUBLISHED): _client_error("SignatureDoesNotMatch", 403, "ListObjectsV2"),
        }
    )
    ck, out = _run(script, stores, upload, serve, capsys)
    lines = _failed_labels(out)
    assert any("REFUSED reading quarantine" in line and "credential itself was rejected" in line for line in lines)
    # A 403 with the wrong code passes nothing — the list probe fails too.
    assert any("can read published (list)" in line for line in lines)


def test_an_unknown_403_code_is_not_a_refusal(script, capsys):
    stores, upload, serve = _correct_split(
        serve_rules={("get", QUARANTINE): _client_error("SomethingNew", 403)}
    )
    ck, out = _run(script, stores, upload, serve, capsys)
    [line] = _failed_labels(out)
    assert "REFUSED reading quarantine" in line
    assert "unclassified" in line


def test_assertion_3_is_not_meaningful_when_the_object_was_never_written(script, capsys):
    # A wrong quarantine bucket name: the PUT fails, and a refusal on an
    # object that does not exist must not read as the guarantee holding.
    stores, upload, serve = _correct_split()
    upload.raw.stores = {PUBLISHED: {}}  # quarantine "does not exist" for the upload side

    def http(method, url, headers, body):
        return 404 if method == "PUT" else 404

    ck, out = _run(script, stores, upload, serve, capsys, http=http)
    lines = _failed_labels(out)
    assert any("can PUT into quarantine" in line for line in lines)
    assert any("REFUSED reading quarantine" in line and "not meaningful" in line for line in lines)


# --- The other edges ----------------------------------------------------------


def test_upload_reading_published_is_a_fail(script, capsys):
    # A NoSuchKey instead of a refusal means the credential was allowed in.
    stores, upload, serve = _correct_split(upload_rules={("get", PUBLISHED): None})
    ck, out = _run(script, stores, upload, serve, capsys)
    [line] = _failed_labels(out)
    assert "upload credential is refused on published" in line
    assert "wider than" in line
    assert "let into published" in line


def test_serve_writing_published_is_a_fail_and_the_stray_object_is_removed(script, capsys):
    stores, upload, serve = _correct_split(
        serve_rules={("put", PUBLISHED): None, ("delete", PUBLISHED): None}
    )
    ck, out = _run(script, stores, upload, serve, capsys)
    [line] = _failed_labels(out)
    assert "refused WRITING to published" in line
    assert "WROTE to published" in line
    assert "deleted again with the serve credential" in out
    assert stores[PUBLISHED] == {}


def test_a_store_that_accepts_a_mismatched_body_is_a_fail(script, capsys):
    stores, upload, serve = _correct_split()

    def lax_http(method, url, headers, body):
        bucket, key = url.split("stub.invalid/", 1)[1].split("?", 1)[0].split("/", 1)
        if method == "PUT":
            stores[bucket][key] = body  # accepts any length: the signed size is not enforced
            return 200
        return 404

    ck, out = _run(script, stores, upload, serve, capsys, http=lax_http)
    lines = _failed_labels(out)
    assert any("length differs from the signed Content-Length" in line and "ACCEPTED" in line for line in lines)
    # And the read-back then disagrees with what was written, as it should.
    assert any("reads back exactly what it wrote" in line for line in lines)


def test_a_refused_presigned_get_is_a_fail(script, capsys):
    stores, upload, serve = _correct_split()

    def http(method, url, headers, body):
        if method == "GET":
            return 403
        return _http_honouring_signed_length(stores)(method, url, headers, body)

    ck, out = _run(script, stores, upload, serve, capsys, http=http)
    [line] = _failed_labels(out)
    assert "serve-presigned GET against published is not refused" in line
    assert "HTTP 403" in line


# --- Cleanup runs regardless -----------------------------------------------


def test_cleanup_runs_when_a_check_raises_unexpectedly(script, capsys, monkeypatch):
    stores, upload, serve = _correct_split()
    # Land the object first, then blow up mid-run.
    stores[QUARANTINE]["verify-r2-credentials/test.bin"] = b"x"

    def boom(*args, **kwargs):
        raise RuntimeError("script bug")

    monkeypatch.setattr(script, "run_checks", boom)
    ck = script.Checks()
    with pytest.raises(RuntimeError):
        script.verify(upload, serve, ck, key="verify-r2-credentials/test.bin")
    out = capsys.readouterr().out
    assert stores[QUARANTINE] == {}
    assert "test object deleted with the upload credential" in out
    assert "test object confirmed gone" in out


def test_a_failed_cleanup_names_the_key_and_the_backstop(script, capsys):
    stores, upload, serve = _correct_split(upload_rules={("delete", QUARANTINE): denied("DeleteObject")})
    ck, out = _run(script, stores, upload, serve, capsys)
    lines = _failed_labels(out)
    [line] = [line for line in lines if "deleted with the upload credential" in line]
    assert "verify-r2-credentials/test.bin" in line
    assert "24-hour lifecycle rule" in line


# --- classify() directly ----------------------------------------------------


@pytest.mark.parametrize(
    "exc, kind",
    [
        (_client_error("AccessDenied", 403), "refused"),
        (_client_error("Forbidden", 403), "refused"),
        (_client_error("NoSuchBucket", 404), "not_found"),
        (_client_error("NoSuchKey", 404), "not_found"),
        (_client_error("404", 404, "HeadObject"), "not_found"),
        (_client_error("SignatureDoesNotMatch", 403), "bad_credential"),
        (_client_error("InvalidAccessKeyId", 403), "bad_credential"),
        (_client_error("Unauthorized", 401), "bad_credential"),
        (_client_error("WeirdCode", 403), "other"),
        (_client_error("InternalError", 500), "other"),
        (EndpointConnectionError(endpoint_url="https://stub.invalid"), "network"),
        (RuntimeError("x"), "other"),
    ],
)
def test_classify(script, exc, kind):
    got, detail = script.classify(exc)
    assert got == kind
    assert "stub.invalid" not in detail
