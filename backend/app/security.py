"""Token hashing and the HS256 session JWT.

The JWT is composed from stdlib hmac/hashlib/base64 rather than a JWT library:
one less runtime dependency, and because verification recomputes HMAC-SHA256
unconditionally (the header is never consulted for algorithm dispatch),
alg-confusion attacks are structurally impossible.
"""

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone


def hash_token(raw: str) -> str:
    """SHA-256 hex digest — the only form of a magic-link token ever stored."""
    return hashlib.sha256(raw.encode()).hexdigest()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def encode_session_jwt(
    *, person_id: str, session_id: str, expires_at: datetime, secret: str
) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": person_id, "sid": session_id, "exp": int(expires_at.timestamp())}
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + "." + _b64url(signature)


def decode_session_jwt(token: str, secret: str) -> dict | None:
    """Return the payload, or None on ANY failure — malformed, bad signature,
    or expired. Callers must still check the sessions row (revocation)."""
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
        expected = hmac.new(
            secret.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(expected, _b64url_decode(signature_b64)):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
        if not isinstance(payload, dict):
            return None
        expires = payload.get("exp")
        if not isinstance(expires, int):
            return None
        if expires <= datetime.now(timezone.utc).timestamp():
            return None
        return payload
    except (ValueError, TypeError):
        return None
