"""Token hashing, the HS256 session JWT, and the group link's derived token.

The JWT is composed from stdlib hmac/hashlib/base64 rather than a JWT library:
one less runtime dependency, and because verification recomputes HMAC-SHA256
unconditionally (the header is never consulted for algorithm dispatch),
alg-confusion attacks are structurally impossible.

THE GROUP LINK'S TOKEN IS NEVER STORED (CK-75; joining-a-group record §2).
It is derived from the link row's id with the session secret under a
context string of its own, so any member can be shown the link again and a
leaked database yields no working link; verification parses the id,
recomputes the MAC and compares in constant time, and an unknown id and a
wrong MAC are the same `invalid`. Rotating the session secret kills every
link, as it kills every session — accepted. A different context string
than the JWT's signing input, so a link token can never verify as a session
and a session can never verify as a link.
"""

import base64
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timezone

# The HMAC context for a group link token — distinct from the JWT's signing
# input by construction (a JWT's input is base64url text with a dot; this
# is a fixed prefix plus sixteen raw id bytes), and versioned so a later
# shape can be told apart from this one.
GROUP_LINK_CONTEXT = b"covey-keep group link v1\x00"


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


def _group_link_mac(link_id: uuid.UUID, secret: str) -> bytes:
    return hmac.new(secret.encode(), GROUP_LINK_CONTEXT + link_id.bytes, hashlib.sha256).digest()


def group_link_token(link_id: uuid.UUID, secret: str) -> str:
    """`<link id>.<MAC>` — the MAC an HMAC-SHA256 under `secret` over the
    context string plus the link id, base64url without padding. Nothing
    about it is stored: the row holds the id alone, and the secret is the
    server's. NEVER LOGGED, on any path (the presigned-URL discipline)."""
    return f"{link_id}.{_b64url(_group_link_mac(link_id, secret))}"


def parse_group_link_token(token: str, secret: str) -> uuid.UUID | None:
    """The link id a token names, or None on ANY failure — malformed, an id
    that is not a UUID, a MAC that does not verify (constant-time). The
    caller still looks the id up: a well-formed token for a row that does
    not exist is the same `invalid` as a tampered one."""
    try:
        id_part, mac_part = token.split(".")
        link_id = uuid.UUID(id_part)
        supplied = _b64url_decode(mac_part)
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(_group_link_mac(link_id, secret), supplied):
        return None
    return link_id
