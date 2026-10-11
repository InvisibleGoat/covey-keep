"""Settings — two classes, two services, and they diverge on purpose (CK-35).

`Settings` is the WEB service's: what uvicorn, every router, alembic's
env.py and the two scripts read. `WorkerSettings` is the INGEST WORKER's:
DATABASE_URL, the R2 endpoint, the two bucket names, and the worker
credential — six values, and exactly six, plus since CK-59 one optional
boolean, the bin sweep's switch (media pipeline record §8, §11.1).
Neither class has a field for the other's credential. That is the structural
half of "neither service holds the other's powers": the worker cannot reach
R2_UPLOAD_* or R2_SERVE_* even if they sit in its environment, because
nothing in its process reads them; the web service cannot reach R2_WORKER_*
for the same reason. A credential with read-write on both buckets can read
quarantine AND serve published — the exact combination the two-bucket split
exists to prevent — and the verifier script would not catch it landing in
the wrong service, because it tests the credentials it is given, not which
service holds them. Pinned by test on the field lists themselves.

The web settings singleton is constructed LAZILY (a module-level
__getattr__, PEP 562), and that is the one thing CK-35 changed in the web
path. The worker imports this module for WorkerSettings; an eager
`settings = Settings()` at module level would have required the worker to
carry SESSION_SECRET and both web credentials just to import the class it
actually uses — the split would have been decorative. Nothing about WHEN the
web service fails has changed: every web consumer does
`from app.config import settings` at its own import, so the construction
still happens at boot, and a missing required value still crashes uvicorn
and alembic before anything serves (the session_secret precedent; CK-33's
RE_ENDPOINT_URL catch ran through exactly this path). Only the worker no
longer fails with it.

THE STRIPE FOUR (CK-73; paid-tiers record §10) are the WEB service's and the
web service's alone: `WorkerSettings` gains no field for any of them — billing
is the API's, the worker processes photographs — and the field-list pin that
keeps the two classes apart holds over them too. `stripe_api_key` is
shape-checked at boot to be a TEST-mode RESTRICTED key (`rk_test_`): a
full-access `sk_` key is refused so that least privilege is structural rather
than a habit, and a live key is refused until the live cutover relaxes the
check on the production service alone (record §13). Nothing gates billing,
so the four are required with no default — the CK-33 rule.
"""

import re
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchor the env file to backend/.env so imports work regardless of cwd
# (uvicorn and alembic are both documented to run from backend/, but don't rely on it).
BACKEND_DIR = Path(__file__).resolve().parent.parent

# An R2 access key id is exactly 32 hexadecimal characters (CK-61). The rule
# is the SHAPE and nothing more: no stripping (a stray space from a dashboard
# paste IS a mistyped value, and saying so at boot is the point), and either
# case (nothing has measured that R2 mints lowercase only, and a rule that
# rejected a valid credential would be worse than the defect it exists for).
_R2_ACCESS_KEY_ID = re.compile(r"[0-9a-fA-F]{32}")


def _r2_access_key_id_shape(value: str) -> str:
    """32 hexadecimal characters, or a ValueError that names the shape and
    the length — never the characters. CK-61's other half; one function for
    all three access key ids (both classes' validators call it).

    WHY AT BOOT. This module's own rule: a value fails in front of whoever
    deployed rather than at the first claim. Check (gv)'s first run
    (2026-09-25) is what a wrong-LENGTH key id does otherwise. R2
    length-validates before it authenticates, so the request is refused as
    MALFORMED — `InvalidArgument` / 400 — which is correctly NOT a
    credential-rejection code; the worker classifies it transient, and
    every queued photograph dead-letters at attempt 3, verbatim the outcome
    CK-35's third class was written to prevent. Two halves, and neither
    substitutes for the other: `ingest._is_credential_rejected` catches a
    well-formed WRONG credential (401/403 — the store answered the
    credential), this catches a MALFORMED one before the worker ever asks,
    and '400' must never be admitted to the classifier to cover this case
    — a 400 is a bad request, not a credential fact, and a classifier that
    read it as the worker's configuration would release genuinely bad
    requests forever.

    ALL THREE IDS, not the worker's alone: the upload and serve credentials
    mint presigned URLs, so a malformed one there fails a person's upload
    rather than the queue — a different blast radius, and no less worth
    catching at boot.

    THE SECRET ACCESS KEYS ARE DELIBERATELY NOT SHAPE-CHECKED. Nothing here
    has measured their format, and a guessed constraint that rejected a
    valid credential would be worse than the defect. (gv)'s fingerprint
    measured the worker's KEY ID at length 32, and R2's documented shape
    for the id is 32 hex; the secret is a different object with no
    measurement behind it. Pinned by test: a secret of any shape constructs.

    The message says the length and never the value: hide_input_in_errors
    keeps the input dict out of the rendered error, and this keeps the
    characters out of the message that renders beside it."""
    if _R2_ACCESS_KEY_ID.fullmatch(value) is not None:
        return value
    if len(value) != 32:
        raise ValueError(
            "an R2 access key id is exactly 32 hexadecimal characters; "
            f"this value has {len(value)}"
        )
    raise ValueError(
        "an R2 access key id is exactly 32 hexadecimal characters; "
        "this value has 32, but not all of them are hexadecimal"
    )


# The Stripe key shapes (CK-73; paid-tiers record §10, §13). The API's key is
# a RESTRICTED key — Checkout Sessions, Customers, Subscriptions and portal
# sessions write, Prices and Products read, and nothing else — minted in
# the SANDBOX, so it starts `rk_test_`. The prefix is the shape checked at
# boot; the rest of a key is unmeasured and deliberately unchecked.
STRIPE_API_KEY_PREFIX = "rk_test_"
STRIPE_WEBHOOK_SECRET_PREFIX = "whsec_"


def _stripe_api_key_shape(value: str) -> str:
    """A test-mode restricted key, or a ValueError that names the shape and
    never the value (the CK-61 rule, kept by the message itself as well as
    by hide_input_in_errors).

    WHY TWO REFUSALS ARE SPELLED OUT. A full-access secret key (`sk_`) is
    refused BY SHAPE so that least privilege is structural: the full key
    stays in the password manager and never reaches a server, and the day
    someone pastes it into the dashboard because "it also works" the
    service refuses to boot in front of them (record §10). A LIVE key
    (`rk_live_`) is refused until the live-mode gate is discharged — ToS
    v2, the privacy policy, the prod cutover, activation, tax (record
    §13) — and relaxing this to accept it is a deliberate code change on
    the production service alone, never a dashboard edit; a live key
    against the dev database would be live money with no terms behind it.
    The restricted key can still bill a saved card through a subscription,
    which is why it lives in the API's dashboard alone and is checked here."""
    if value.startswith(STRIPE_API_KEY_PREFIX):
        return value
    if value.startswith("sk_"):
        raise ValueError(
            "the Stripe API key must be a RESTRICTED test-mode key (rk_test_...); "
            "a full-access secret key (sk_...) is refused"
        )
    if value.startswith("rk_live_"):
        raise ValueError(
            "the Stripe API key must be a TEST-mode restricted key (rk_test_...); "
            "a live key is refused until the live cutover"
        )
    raise ValueError("the Stripe API key must start with rk_test_")


def _stripe_webhook_secret_shape(value: str) -> str:
    """A webhook signing secret starts `whsec_`; anything else is a pasted
    wrong value, named by field and never echoed."""
    if value.startswith(STRIPE_WEBHOOK_SECRET_PREFIX):
        return value
    raise ValueError("the Stripe webhook secret must start with whsec_")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # A missing required field fails at boot naming the field — and
        # WITHOUT echoing the input. Pydantic's default ValidationError
        # renders `input_value=<the raw dict>`, i.e. every variable that WAS
        # set, and a deploy log is where that error lands: CK-33's first
        # deploy printed 22 hex characters of a live credential's tail that
        # way (WORKING-ON-NOW 1.56.0; CK-36 rider). SecretStr would not
        # help — it masks a field's repr after validation, while input_value
        # is the dict before it. Pinned by test on both classes.
        hide_input_in_errors=True,
    )

    database_url: str

    # Comma-separated origin list; kept as a plain string so the env var needs
    # no JSON quoting. Default covers the Vite dev server; render.yaml overrides.
    allowed_origins: str = "http://localhost:5173"

    # Session-JWT signing key. Required with no default, deliberately — a signing
    # key with a fallback is worse than a crash. Render holds the value in the
    # dashboard (sync: false in render.yaml only declares the slot).
    session_secret: str

    # Link bases: the frontend origin (CK-6 redirects magic links into it) and
    # this API's own public origin (what /auth/request-link mints links against).
    app_base_url: str
    api_base_url: str

    # WebAuthn Relying Party identity (CK-10). rp_id is the BARE DOMAIN a
    # passkey is cryptographically bound to; origin is the full origin the
    # browser reports during the ceremony. A passkey does not survive an rp_id
    # change — every credential enrolled against *.netlify.app dies the day the
    # app moves to a custom domain, which is why the passkey UI stays
    # unpromoted until that domain is final (docs-root CLAUDE.md, Gotchas).
    # Defaults cover local dev; render.yaml overrides both.
    webauthn_rp_id: str = "localhost"
    webauthn_origin: str = "http://localhost:5173"

    # Email delivery mode: "console" prints the full message to the service logs;
    # "provider" does real sends. The flip to provider is its own later phase.
    email_mode: str = "console"
    # Provider-mode credentials; deliberately unset until the cutover phase.
    email_api_key: str = ""
    email_from: str = ""

    # Cloudflare R2 (CK-33): the endpoint, the two buckets, and the two
    # web-service credentials (media pipeline record §11). ALL SEVEN REQUIRED,
    # no defaults — decided, not accidental. email_api_key may default to ""
    # because email_mode gives the empty value a meaning (console mode);
    # nothing gates media, so an empty R2 value can only mean "misconfigured",
    # and the only choice is WHERE that surfaces: at boot, in front of whoever
    # deployed, or at the first upload intent, in front of a relative holding
    # a phone. The session_secret precedent — fail at boot — wins, and it buys
    # a check for free: a green deploy with these required proves the
    # dashboard values are actually present (render.yaml declares the slots;
    # it never populates them). The bucket names get no default either: a
    # default naming the dev buckets is exactly the value a prod service
    # would silently inherit. Local dev copies the seven from .env.example —
    # real values only when exercising presigning (reuse the dashboard's two
    # tokens; never mint a third); placeholders boot fine for everything else.
    # The worker credential (both buckets) is NOT here and must never be:
    # it belongs to the worker service's own environment (CK-35).
    r2_endpoint_url: str
    r2_bucket_quarantine: str
    r2_bucket_published: str
    # The two access key ids are shape-checked at boot since CK-61 (32 hex;
    # the validator below); the two secrets are not, deliberately.
    r2_upload_access_key_id: str
    r2_upload_secret_access_key: str
    r2_serve_access_key_id: str
    r2_serve_secret_access_key: str

    # Stripe (CK-73; paid-tiers record §10): the RESTRICTED sandbox key, the
    # webhook endpoint's signing secret, and the two prices' LOOKUP KEYS
    # (record §3 — a plan is found by its lookup key, never a price id,
    # because the id differs between the sandbox and live mode). ALL FOUR
    # REQUIRED, no defaults — the CK-33 rule: nothing gates billing, so an
    # empty value can only mean misconfigured, and it fails at boot in front
    # of whoever deployed rather than at a person's first Checkout click.
    # All four are `sync: false` slots in render.yaml, set in
    # covey-keep-api's dashboard BEFORE the push that declares them (the
    # SESSION_SECRET / R2 ordering), and NEVER on the worker, which has no
    # field for any of them. The key and the secret are shape-checked at
    # boot (the validators below); the lookup keys are plain strings.
    stripe_api_key: str
    stripe_webhook_secret: str
    stripe_price_lookup_100k: str
    stripe_price_lookup_300k: str

    @field_validator("database_url")
    @classmethod
    def _force_asyncpg_scheme(cls, value: str) -> str:
        # Render's fromDatabase connection strings use the bare postgresql://
        # scheme, which SQLAlchemy would resolve to psycopg2; this app only
        # ships asyncpg.
        for prefix in ("postgresql://", "postgres://"):
            if value.startswith(prefix):
                return "postgresql+asyncpg://" + value.removeprefix(prefix)
        return value

    @field_validator("r2_upload_access_key_id", "r2_serve_access_key_id")
    @classmethod
    def _r2_access_key_id_is_32_hex(cls, value: str) -> str:
        # CK-61's other half — the shape checked at boot, on both web ids.
        # See _r2_access_key_id_shape for why here, why all three, and why
        # the two secrets are left alone.
        return _r2_access_key_id_shape(value)

    @field_validator("stripe_api_key")
    @classmethod
    def _stripe_api_key_is_a_test_restricted_key(cls, value: str) -> str:
        # CK-73: `rk_test_` and nothing else — see _stripe_api_key_shape for
        # why a full-access key and a live key are each refused by name.
        return _stripe_api_key_shape(value)

    @field_validator("stripe_webhook_secret")
    @classmethod
    def _stripe_webhook_secret_is_a_signing_secret(cls, value: str) -> str:
        return _stripe_webhook_secret_shape(value)

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


class WorkerSettings(BaseSettings):
    """The ingest worker's environment (CK-35) — six values, and exactly six,
    required; plus ONE optional boolean since CK-59 (`sweep_enabled`, below),
    an amendment made deliberately and for a stated reason.

    Required with no default, the web Settings' own rule: nothing gates the
    worker, so an empty value can only mean misconfigured, and it should fail
    at boot in front of whoever deployed rather than at the first claim.
    Render populates DATABASE_URL from the database and holds the rest in the
    worker service's own dashboard (render.yaml declares the slots; the
    SESSION_SECRET ordering applies — a `sync: false` slot is never populated
    after the fact, so a new service's first boot is expected to fail until
    the values are set, which breaks nothing: no request depends on a
    background worker).

    NO field here may ever name the upload or serve credential, and Settings
    must never grow a worker field. A test asserts both lists, so the worker
    cannot reach the web credentials even by mistake — the same spirit as the
    IAM guarantee the credential-split verifier proves against the buckets.

    THE SEVENTH (CK-59): `sweep_enabled`, a boolean defaulting to OFF, so the
    bin sweep — the first path in the product that destroys photographs
    without a person asking — ships dark and is turned on as a deliberate
    act in the worker service's dashboard, with no code deploy. This amends
    the COUNT and not the credential rule above: that rule exists so this
    process can never name the upload or serve credential ("adding one here
    would give one process the powers the split keeps apart"), and a
    boolean grants no powers. What it buys is an off-switch reachable from
    the dashboard. The test that pins the field list now pins seven, still
    asserts that no field names a credential or the session secret, and
    asserts the default is False; the six-variable boot test is unchanged,
    because a worker booted with exactly the six IS the dark sweep.
    """

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # Same rule as the web Settings: a missing field is named, the
        # values that were present are never echoed into the deploy log.
        hide_input_in_errors=True,
    )

    database_url: str
    r2_endpoint_url: str
    r2_bucket_quarantine: str
    r2_bucket_published: str
    # Object Read & Write on BOTH buckets (record §11.1): reads quarantine,
    # writes published, deletes originals. Held by this process and no other.
    # The id is shape-checked at boot since CK-61 (32 hex; the validator
    # below); the secret is not, deliberately.
    r2_worker_access_key_id: str
    r2_worker_secret_access_key: str
    # THE ONLY OPTIONAL FIELD, AND THE ONLY BOOLEAN (CK-59): the bin sweep's
    # switch. False — the default, and the whole point of a default here —
    # means the sweep never runs and the worker polls exactly as before;
    # an unset dashboard is a dark sweep, never a live one. Turned on by
    # SWEEP_ENABLED=true in the worker's dashboard, and nowhere else.
    sweep_enabled: bool = False

    @field_validator("database_url")
    @classmethod
    def _force_asyncpg_scheme(cls, value: str) -> str:
        # The one normalisation, reused rather than copied.
        return Settings._force_asyncpg_scheme(value)

    @field_validator("r2_worker_access_key_id")
    @classmethod
    def _r2_access_key_id_is_32_hex(cls, value: str) -> str:
        # The same shape check as the two web ids (CK-61), the same one
        # function — a wrong-length key id fails HERE, at boot, and never
        # reaches the worker's first claim as InvalidArgument / 400.
        return _r2_access_key_id_shape(value)


if TYPE_CHECKING:
    settings: Settings


def __getattr__(name: str):
    # The lazy web singleton (see the module docstring). Constructed on the
    # first `from app.config import settings` and cached in the module
    # namespace, so every later access — and every monkeypatch in the test
    # suite — sees the one instance.
    if name == "settings":
        instance = Settings()
        globals()["settings"] = instance
        return instance
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
