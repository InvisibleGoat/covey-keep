"""Passkey (WebAuthn) enrolment and usernameless sign-in (CK-10).

Passkeys are the SECURITY path, not the accessibility path
(decisions/2026-08-20-sign-in-ergonomics.md §4): a second credential so one
email-provider outage cannot lock out every user at once. Email magic-link
sign-in remains fully supported and is never gated behind a passkey.

Sign-in is USERNAMELESS, deliberately: the begin endpoint returns an empty
allowCredentials and no endpoint here accepts an email address, in any form.
Narrowing allowCredentials by address would return a credential list for known
accounts and an empty one for unknown ones — an enumeration oracle, the same
shape CK-5 closed on /auth/request-link and CK-9 closed on /me/email-change.
Discoverable credentials (residentKey: preferred at enrolment) are what make
the addressless flow work.

Verification is py_webauthn's, not ours — see requirements.txt for why that
dependency is the correct exception to the stdlib-only precedent. Its
verify_authentication_response also enforces the sign-counter rule this phase
needs (kickoff STEP 6): a non-increasing counter is rejected as possible
credential cloning EXCEPT when both stored and returned are 0 — the normal,
permanent state for synced platform passkeys (iCloud Keychain, Google
Password Manager). Both directions are pinned by test.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import (
    InvalidAuthenticationResponse,
    InvalidJSONStructure,
    InvalidRegistrationResponse,
)
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorSelectionCriteria,
    CredentialDeviceType,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.api.auth import mint_session
from app.api.deps import AuthContext, get_auth_context, get_db
from app.brand import PRODUCT_NAME
from app.config import settings
from app.models import Person, WebauthnChallenge, WebauthnCredential
from app.services.retention import purge_stale

me_router = APIRouter(prefix="/me/passkeys", tags=["passkeys"])
signin_router = APIRouter(prefix="/auth/passkey", tags=["auth"])

CHALLENGE_TTL = timedelta(minutes=5)
MAX_NICKNAME_LENGTH = 60

# Display-only, shown in the browser's passkey prompt. Safe to track the brand:
# a credential binds to WEBAUTHN_RP_ID (the domain), never to this string.
RP_NAME = PRODUCT_NAME


def _signin_failed() -> HTTPException:
    # ONE uniform failure for every sign-in arm — unknown credential, spent or
    # expired challenge, bad signature, counter regression. The caller sent an
    # assertion, not an identity, so there is nothing to enumerate — but a
    # distinguished error would still map the internals for no user benefit.
    return HTTPException(status_code=401, detail="Passkey sign-in failed.")


def _options_body(options) -> dict:
    # options_to_json produces the exact camelCase JSON the browser API (via
    # @simplewebauthn/browser) expects; round-trip it so FastAPI serializes it
    # as an object rather than a double-encoded string.
    return json.loads(options_to_json(options))


def _passkey_body(row: WebauthnCredential) -> dict:
    return {
        "id": str(row.id),
        "nickname": row.nickname,
        "backup_eligible": row.backup_eligible,
        "created_at": row.created_at.isoformat(),
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
    }


# --- Enrolment (authenticated) ----------------------------------------------


@me_router.post("/register/begin")
async def register_begin(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    person = ctx.person
    now = datetime.now(timezone.utc)
    # Challenges live 5 minutes; rows an hour past expiry are reaped through
    # the shared opportunistic mechanism (CK-24) — no scheduled job.
    await purge_stale(db, WebauthnChallenge, WebauthnChallenge.expires_at, now)

    # A new ceremony supersedes any outstanding one for the person — the same
    # rule every other token in this codebase follows.
    await db.execute(
        update(WebauthnChallenge)
        .where(
            WebauthnChallenge.person_id == person.id,
            WebauthnChallenge.purpose == "register",
            WebauthnChallenge.consumed_at.is_(None),
            WebauthnChallenge.expires_at > now,
        )
        .values(expires_at=now)
    )

    existing_ids = (
        await db.execute(
            select(WebauthnCredential.credential_id).where(
                WebauthnCredential.person_id == person.id
            )
        )
    ).scalars().all()

    options = generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=RP_NAME,
        # The user handle is the person's UUID, not their email: it is stored
        # on the authenticator and shown to no one, so it carries no PII.
        user_id=person.id.bytes,
        # name/displayName ARE shown — in the person's own passkey picker, on
        # their own devices, which is exactly where "which account is this"
        # needs answering.
        user_name=person.email or person.display_name,
        user_display_name=person.display_name,
        # 'none': conveyed attestation buys nothing for a family photo app and
        # carries privacy baggage (kickoff STEP 4). Never validate attestation
        # certificates, never build device allow/deny lists.
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            # Discoverable credentials are what make usernameless sign-in
            # possible; 'preferred' (not 'required') keeps older security keys
            # enrollable as second-device credentials.
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        # The same device must not silently enrol twice.
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(cid))
            for cid in existing_ids
        ],
    )

    db.add(
        WebauthnChallenge(
            person_id=person.id,
            challenge=bytes_to_base64url(options.challenge),
            purpose="register",
            expires_at=now + CHALLENGE_TTL,
        )
    )
    await db.commit()
    return _options_body(options)


class RegisterCompleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The authenticator's response, verbatim from @simplewebauthn/browser —
    # py_webauthn parses and verifies it; nothing in it is trusted until then.
    credential: dict
    nickname: Optional[str] = None

    @field_validator("nickname")
    @classmethod
    def _trimmed(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        if len(value) > MAX_NICKNAME_LENGTH:
            raise ValueError(f"nickname is limited to {MAX_NICKNAME_LENGTH} characters")
        return value


@me_router.post("/register/complete", status_code=201)
async def register_complete(
    body: RegisterCompleteBody,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    person = ctx.person
    now = datetime.now(timezone.utc)

    challenge_row = (
        await db.execute(
            select(WebauthnChallenge)
            .where(
                WebauthnChallenge.person_id == person.id,
                WebauthnChallenge.purpose == "register",
                WebauthnChallenge.consumed_at.is_(None),
                WebauthnChallenge.expires_at > now,
            )
            .order_by(WebauthnChallenge.created_at.desc())
        )
    ).scalars().first()
    if challenge_row is None:
        raise HTTPException(400, "No passkey setup in progress — start again.")

    # Single-use means single-ATTEMPT: the challenge is spent (and committed)
    # before verification, so a failed response cannot be retried against the
    # same challenge.
    challenge_row.consumed_at = now
    await db.commit()

    try:
        verification = verify_registration_response(
            credential=body.credential,
            expected_challenge=base64url_to_bytes(challenge_row.challenge),
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origin,
        )
    except (InvalidRegistrationResponse, InvalidJSONStructure):
        raise HTTPException(400, "That passkey couldn't be verified. Start again.")

    credential_id = bytes_to_base64url(verification.credential_id)
    already = (
        await db.execute(
            select(WebauthnCredential.id).where(
                WebauthnCredential.credential_id == credential_id
            )
        )
    ).first()
    if already is not None:
        # excludeCredentials stops this in the browser; the check (and the DB
        # UNIQUE constraint behind it) stops a client that ignored the list.
        raise HTTPException(409, "That passkey is already registered.")

    transports = body.credential.get("response", {}).get("transports")
    if isinstance(transports, list):
        transports = ",".join(t for t in transports if isinstance(t, str) and len(t) <= 32) or None
    else:
        transports = None

    row = WebauthnCredential(
        person_id=person.id,
        credential_id=credential_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        transports=transports,
        nickname=body.nickname,
        backup_eligible=(
            verification.credential_device_type == CredentialDeviceType.MULTI_DEVICE
        ),
    )
    db.add(row)
    await db.flush()
    await db.commit()
    return _passkey_body(row)


@me_router.get("")
async def list_passkeys(
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = (
        await db.execute(
            select(WebauthnCredential)
            .where(WebauthnCredential.person_id == ctx.person.id)
            .order_by(WebauthnCredential.created_at)
        )
    ).scalars().all()
    return {"passkeys": [_passkey_body(row) for row in rows]}


@me_router.delete("/{passkey_id}", status_code=204)
async def remove_passkey(
    passkey_id: UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove one enrolled passkey. Removing the LAST one is allowed without
    ceremony — email sign-in is always available, so there is no lockout to
    protect against (kickoff STEP 8)."""
    row = (
        await db.execute(
            select(WebauthnCredential).where(
                WebauthnCredential.id == passkey_id,
                # Scoped to the caller: someone else's id is indistinguishable
                # from one that never existed.
                WebauthnCredential.person_id == ctx.person.id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "No such passkey.")
    await db.delete(row)
    await db.commit()


# --- Sign-in (unauthenticated, usernameless) --------------------------------


class EmptyBody(BaseModel):
    # extra="forbid" is the point: ANY field — an email above all — is a 422.
    # Pinned by test; see the module docstring for why no address may ever be
    # accepted here.
    model_config = ConfigDict(extra="forbid")


@signin_router.post("/begin")
async def signin_begin(
    body: Optional[EmptyBody] = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    now = datetime.now(timezone.utc)
    # Challenges live 5 minutes; rows an hour past expiry are reaped through
    # the shared opportunistic mechanism (CK-24) — no scheduled job.
    await purge_stale(db, WebauthnChallenge, WebauthnChallenge.expires_at, now)

    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        # Empty allowCredentials, always: the browser offers whatever
        # discoverable credentials it holds for this RP ID. No caller input
        # can narrow it, because no caller input exists.
        allow_credentials=[],
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    db.add(
        WebauthnChallenge(
            # No known person yet — that is what usernameless means.
            person_id=None,
            challenge=bytes_to_base64url(options.challenge),
            purpose="authenticate",
            expires_at=now + CHALLENGE_TTL,
        )
    )
    await db.commit()
    return _options_body(options)


class SigninCompleteBody(BaseModel):
    # Only the assertion. extra="forbid" makes an email field (or anything
    # else) a 422 — the usernameless rule, enforced at the schema.
    model_config = ConfigDict(extra="forbid")

    credential: dict


@signin_router.post("/complete")
async def signin_complete(
    body: SigninCompleteBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    now = datetime.now(timezone.utc)

    raw_id = body.credential.get("rawId") or body.credential.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        raise _signin_failed()
    credential = (
        await db.execute(
            select(WebauthnCredential).where(WebauthnCredential.credential_id == raw_id)
        )
    ).scalar_one_or_none()
    if credential is None:
        raise _signin_failed()

    # The assertion says which challenge it signed (clientDataJSON.challenge);
    # look that row up and require it live. Challenges are not secrets — the
    # browser was handed this one in the clear — so a plain equality lookup is
    # correct; single use plus the signature binding is the security.
    try:
        client_data = json.loads(
            base64url_to_bytes(body.credential["response"]["clientDataJSON"])
        )
        signed_challenge = client_data["challenge"]
    except (KeyError, TypeError, ValueError):
        raise _signin_failed()
    if not isinstance(signed_challenge, str):
        raise _signin_failed()
    challenge_row = (
        await db.execute(
            select(WebauthnChallenge).where(
                WebauthnChallenge.challenge == signed_challenge,
                WebauthnChallenge.purpose == "authenticate",
            )
        )
    ).scalars().first()
    if (
        challenge_row is None
        or challenge_row.consumed_at is not None
        or challenge_row.expires_at <= now
    ):
        raise _signin_failed()

    # Spent before verification, committed immediately: a replayed assertion
    # dies here no matter what happens next.
    challenge_row.consumed_at = now
    await db.commit()

    try:
        verification = verify_authentication_response(
            credential=body.credential,
            expected_challenge=base64url_to_bytes(challenge_row.challenge),
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origin,
            credential_public_key=credential.public_key,
            # py_webauthn enforces the counter rule here: a non-increasing
            # count is rejected as possible cloning, EXCEPT when both stored
            # and returned are 0 — synced platform passkeys report 0 forever,
            # and treating that as an attack would lock ordinary users out on
            # their second sign-in. Both directions pinned by test.
            credential_current_sign_count=credential.sign_count,
        )
    except (InvalidAuthenticationResponse, InvalidJSONStructure):
        raise _signin_failed()

    person = await db.get(Person, credential.person_id)
    if person is None or person.anonymized_at is not None:
        # Deletion hard-deletes the person's credentials in the same
        # transaction that anonymizes, so this arm should be unreachable —
        # belt and braces, same as the auth gate's anonymized check.
        raise _signin_failed()

    credential.sign_count = verification.new_sign_count
    credential.last_used_at = now
    # The SAME session path as /auth/verify — same TTL, same absolute cap,
    # same JWT exp at the cap, same sessions row (kickoff STEP 5).
    jwt = await mint_session(db, person, request, now)
    await db.commit()
    return {"token": jwt}
