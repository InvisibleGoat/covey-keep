"""Passkey enrolment and usernameless sign-in (CK-10).

The SoftPasskey below is a minimal software authenticator: one ES256 key pair
that answers registration and authentication ceremonies the way a real
platform authenticator would, with full control over the sign counter — which
is exactly what the counter-rule tests need. It builds real CBOR attestation
objects and real ECDSA signatures; py_webauthn verifies them for real.
"""

import base64
import hashlib
import json
import os
import struct
from datetime import datetime, timedelta, timezone
from uuid import UUID

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import func, select

from app.api.deps import SESSION_ABSOLUTE_CAP, SESSION_TTL
from app.models import Person, Session, WebauthnChallenge, WebauthnCredential
from tests.test_auth import _sign_in

RP_ID = "localhost"
ORIGIN = "http://localhost:5173"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _jwt_payload(jwt: str) -> dict:
    segment = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


class SoftPasskey:
    def __init__(self, sign_count: int = 0):
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        # What the AUTHENTICATOR will report next. Synced platform passkeys
        # report 0 forever; hardware keys increment.
        self.sign_count = sign_count

    @property
    def credential_id_b64(self) -> str:
        return _b64url(self.credential_id)

    def _cose_public_key(self) -> bytes:
        numbers = self.private_key.public_key().public_numbers()
        return cbor2.dumps(
            {
                1: 2,  # kty: EC2
                3: -7,  # alg: ES256
                -1: 1,  # crv: P-256
                -2: numbers.x.to_bytes(32, "big"),
                -3: numbers.y.to_bytes(32, "big"),
            }
        )

    def register(self, options: dict) -> dict:
        client_data = json.dumps(
            {
                "type": "webauthn.create",
                "challenge": options["challenge"],
                "origin": ORIGIN,
                "crossOrigin": False,
            }
        ).encode()
        attested = (
            bytes(16)  # zero AAGUID, as attestation 'none' implies
            + struct.pack(">H", len(self.credential_id))
            + self.credential_id
            + self._cose_public_key()
        )
        auth_data = (
            hashlib.sha256(RP_ID.encode()).digest()
            + bytes([0x45])  # UP | UV | AT
            + struct.pack(">I", self.sign_count)
            + attested
        )
        attestation_object = cbor2.dumps(
            {"fmt": "none", "attStmt": {}, "authData": auth_data}
        )
        return {
            "id": self.credential_id_b64,
            "rawId": self.credential_id_b64,
            "response": {
                "clientDataJSON": _b64url(client_data),
                "attestationObject": _b64url(attestation_object),
                "transports": ["internal"],
            },
            "type": "public-key",
            "clientExtensionResults": {},
        }

    def sign(self, options: dict, sign_count: int | None = None) -> dict:
        """Answer an authentication ceremony. sign_count overrides what the
        authenticator reports — the cloned-credential tests depend on that."""
        count = self.sign_count if sign_count is None else sign_count
        client_data = json.dumps(
            {
                "type": "webauthn.get",
                "challenge": options["challenge"],
                "origin": ORIGIN,
                "crossOrigin": False,
            }
        ).encode()
        auth_data = (
            hashlib.sha256(RP_ID.encode()).digest()
            + bytes([0x05])  # UP | UV
            + struct.pack(">I", count)
        )
        signature = self.private_key.sign(
            auth_data + hashlib.sha256(client_data).digest(),
            ec.ECDSA(hashes.SHA256()),
        )
        return {
            "id": self.credential_id_b64,
            "rawId": self.credential_id_b64,
            "response": {
                "clientDataJSON": _b64url(client_data),
                "authenticatorData": _b64url(auth_data),
                "signature": _b64url(signature),
            },
            "type": "public-key",
            "clientExtensionResults": {},
        }


async def _enrol(
    client, headers: dict, passkey: SoftPasskey, nickname: str | None = None
) -> dict:
    begin = await client.post("/me/passkeys/register/begin", headers=headers)
    assert begin.status_code == 200, begin.text
    body: dict = {"credential": passkey.register(begin.json())}
    if nickname is not None:
        body["nickname"] = nickname
    complete = await client.post(
        "/me/passkeys/register/complete", json=body, headers=headers
    )
    assert complete.status_code == 201, complete.text
    return complete.json()


async def _signin(client, passkey: SoftPasskey, sign_count: int | None = None):
    begin = await client.post("/auth/passkey/begin")
    assert begin.status_code == 200, begin.text
    return await client.post(
        "/auth/passkey/complete",
        json={"credential": passkey.sign(begin.json(), sign_count=sign_count)},
    )


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


async def test_enrol_and_usernameless_signin_end_to_end(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "keyed@example.com")
    passkey = SoftPasskey()
    enrolled = await _enrol(client, headers, passkey, nickname="My phone")
    assert enrolled["nickname"] == "My phone"
    assert enrolled["last_used_at"] is None

    # Usernameless: begin takes no identity and offers no credential list.
    begin = await client.post("/auth/passkey/begin")
    assert begin.status_code == 200
    assert begin.json().get("allowCredentials", []) == []

    complete = await client.post(
        "/auth/passkey/complete", json={"credential": passkey.sign(begin.json())}
    )
    assert complete.status_code == 200, complete.text
    jwt = complete.json()["token"]

    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert me.status_code == 200
    assert me.json()["email"] == "keyed@example.com"

    async with db_session_factory() as db:
        row = (await db.execute(select(WebauthnCredential))).scalars().one()
        assert row.last_used_at is not None
        assert row.credential_id == passkey.credential_id_b64
        # Only the PUBLIC key is stored, as raw COSE bytes.
        assert row.public_key == passkey._cose_public_key()


async def test_passkey_session_has_magic_link_lifetime(
    client, capsys, db_session_factory
):
    # The kickoff's core reuse requirement: a passkey sign-in mints its session
    # through the same path as /auth/verify — same 90-day TTL, same 365-day
    # cap, same JWT exp minted at the cap.
    headers = await _signed_in_headers(client, capsys, "samettl@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)
    response = await _signin(client, passkey)
    assert response.status_code == 200
    payload = _jwt_payload(response.json()["token"])

    async with db_session_factory() as db:
        session = await db.get(Session, UUID(payload["sid"]))
        assert session is not None
        lifetime = session.expires_at - session.issued_at
        assert timedelta(0) <= lifetime - SESSION_TTL < timedelta(minutes=5)
        cap = session.issued_at + SESSION_ABSOLUTE_CAP
        jwt_exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        assert abs(jwt_exp - cap) < timedelta(minutes=5)


async def test_replayed_assertion_rejected(client, capsys):
    # The challenge is single-use: the identical (perfectly signed) assertion
    # must die the second time.
    headers = await _signed_in_headers(client, capsys, "replay@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)

    begin = await client.post("/auth/passkey/begin")
    assertion = passkey.sign(begin.json())
    first = await client.post("/auth/passkey/complete", json={"credential": assertion})
    assert first.status_code == 200
    second = await client.post("/auth/passkey/complete", json={"credential": assertion})
    assert second.status_code == 401


async def test_expired_challenge_rejected(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "slowpoke@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)

    begin = await client.post("/auth/passkey/begin")
    async with db_session_factory() as db:
        row = (
            await db.execute(
                select(WebauthnChallenge).where(WebauthnChallenge.purpose == "authenticate")
            )
        ).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    response = await client.post(
        "/auth/passkey/complete", json={"credential": passkey.sign(begin.json())}
    )
    assert response.status_code == 401

    # Same rule on the enrolment side.
    begin = await client.post("/me/passkeys/register/begin", headers=headers)
    async with db_session_factory() as db:
        row = (
            await db.execute(
                select(WebauthnChallenge).where(
                    WebauthnChallenge.purpose == "register",
                    WebauthnChallenge.consumed_at.is_(None),
                )
            )
        ).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    fresh_device = SoftPasskey()
    response = await client.post(
        "/me/passkeys/register/complete",
        json={"credential": fresh_device.register(begin.json())},
        headers=headers,
    )
    assert response.status_code == 400


async def test_unknown_credential_rejected(client, capsys):
    # A syntactically perfect assertion from a credential this server never
    # enrolled. (An account exists, so the failure is the lookup, not an
    # empty table.)
    await _signed_in_headers(client, capsys, "bystander@example.com")
    stranger = SoftPasskey()
    response = await _signin(client, stranger)
    assert response.status_code == 401


async def test_signin_never_accepts_an_email_field(client, capsys):
    # The usernameless rule, pinned: no address is accepted on either sign-in
    # endpoint, in any form — accepting one would let allowCredentials become
    # an enumeration oracle (the CK-5 / CK-9 shape, third appearance).
    headers = await _signed_in_headers(client, capsys, "oracleproof@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)

    assert (
        await client.post("/auth/passkey/begin", json={"email": "probe@example.com"})
    ).status_code == 422
    # An empty JSON object is fine — it carries nothing.
    assert (await client.post("/auth/passkey/begin", json={})).status_code == 200

    begin = await client.post("/auth/passkey/begin")
    response = await client.post(
        "/auth/passkey/complete",
        json={
            "credential": passkey.sign(begin.json()),
            "email": "probe@example.com",
        },
    )
    assert response.status_code == 422


async def test_decreasing_sign_count_rejected(client, capsys, db_session_factory):
    # A counter going backwards means a second copy of the credential may be
    # signing — reject, and leave the stored counter untouched.
    headers = await _signed_in_headers(client, capsys, "cloned@example.com")
    passkey = SoftPasskey(sign_count=5)
    await _enrol(client, headers, passkey)

    assert (await _signin(client, passkey, sign_count=6)).status_code == 200
    assert (await _signin(client, passkey, sign_count=4)).status_code == 401

    async with db_session_factory() as db:
        row = (await db.execute(select(WebauthnCredential))).scalars().one()
        assert row.sign_count == 6


async def test_zero_zero_sign_count_accepted(client, capsys, db_session_factory):
    # Synced platform passkeys (iCloud Keychain, Google Password Manager)
    # report 0 forever. 0 stored / 0 returned is the NORMAL case, not cloning
    # — getting this backwards locks ordinary users out on their second
    # sign-in (kickoff STEP 6).
    headers = await _signed_in_headers(client, capsys, "synced@example.com")
    passkey = SoftPasskey(sign_count=0)
    await _enrol(client, headers, passkey)

    assert (await _signin(client, passkey, sign_count=0)).status_code == 200
    assert (await _signin(client, passkey, sign_count=0)).status_code == 200

    async with db_session_factory() as db:
        row = (await db.execute(select(WebauthnCredential))).scalars().one()
        assert row.sign_count == 0


async def test_enrolment_requires_auth_signin_does_not(client):
    fake_uuid = "00000000-0000-0000-0000-000000000000"
    assert (await client.post("/me/passkeys/register/begin")).status_code == 401
    assert (
        await client.post("/me/passkeys/register/complete", json={"credential": {}})
    ).status_code == 401
    assert (await client.get("/me/passkeys")).status_code == 401
    assert (await client.delete(f"/me/passkeys/{fake_uuid}")).status_code == 401
    # Sign-in is unauthenticated by design — there is no one to authenticate yet.
    assert (await client.post("/auth/passkey/begin")).status_code == 200


async def test_register_complete_without_begin_rejected(client, capsys):
    headers = await _signed_in_headers(client, capsys, "eager@example.com")
    passkey = SoftPasskey()
    response = await client.post(
        "/me/passkeys/register/complete",
        json={"credential": passkey.register({"challenge": _b64url(os.urandom(32))})},
        headers=headers,
    )
    assert response.status_code == 400


async def test_register_excludes_existing_credentials(client, capsys):
    # The same device must not silently enrol twice: the second ceremony's
    # options carry the first credential's id in excludeCredentials, and a
    # client that ignores the list hits the 409 backstop.
    headers = await _signed_in_headers(client, capsys, "twice@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)

    begin = await client.post("/me/passkeys/register/begin", headers=headers)
    excluded = [c["id"] for c in begin.json().get("excludeCredentials", [])]
    assert passkey.credential_id_b64 in excluded

    response = await client.post(
        "/me/passkeys/register/complete",
        json={"credential": passkey.register(begin.json())},
        headers=headers,
    )
    assert response.status_code == 409


async def test_list_and_remove(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "curator@example.com")
    phone, laptop = SoftPasskey(), SoftPasskey()
    first = await _enrol(client, headers, phone, nickname="Phone")
    second = await _enrol(client, headers, laptop, nickname="Laptop")

    listing = await client.get("/me/passkeys", headers=headers)
    assert listing.status_code == 200
    names = [p["nickname"] for p in listing.json()["passkeys"]]
    assert names == ["Phone", "Laptop"]

    # A made-up id and (below) another person's id are both bare 404s.
    assert (
        await client.delete(
            "/me/passkeys/00000000-0000-0000-0000-000000000000", headers=headers
        )
    ).status_code == 404
    other_headers = await _signed_in_headers(client, capsys, "other@example.com")
    assert (
        await client.delete(f"/me/passkeys/{first['id']}", headers=other_headers)
    ).status_code == 404

    assert (
        await client.delete(f"/me/passkeys/{first['id']}", headers=headers)
    ).status_code == 204
    # Removing the LAST passkey is allowed without ceremony — email sign-in is
    # always available, so there is no lockout to protect against.
    assert (
        await client.delete(f"/me/passkeys/{second['id']}", headers=headers)
    ).status_code == 204
    listing = await client.get("/me/passkeys", headers=headers)
    assert listing.json()["passkeys"] == []

    # The removed credential no longer signs in; the magic link still does.
    assert (await _signin(client, phone)).status_code == 401
    await _sign_in(client, capsys, "curator@example.com")


async def test_deletion_purges_credentials_and_challenges(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "leaving@example.com")
    passkey = SoftPasskey()
    await _enrol(client, headers, passkey)
    # Leave a live enrolment challenge behind too — deletion must take both
    # tables, not just the credentials.
    assert (
        await client.post("/me/passkeys/register/begin", headers=headers)
    ).status_code == 200

    assert (
        await client.post("/me/delete", json={"confirm": "DELETE"}, headers=headers)
    ).status_code == 204

    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(WebauthnCredential))
        ) == 0
        assert (
            await db.scalar(select(func.count()).select_from(WebauthnChallenge))
        ) == 0
        person = (await db.execute(select(Person))).scalars().one()
        assert person.anonymized_at is not None

    # The credential is gone, so the passkey that authenticated this account
    # is dead — not a 401-on-anonymized fallback, an unknown credential.
    assert (await _signin(client, passkey)).status_code == 401
