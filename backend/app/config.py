"""Settings — two classes, two services, and they diverge on purpose (CK-35).

`Settings` is the WEB service's: what uvicorn, every router, alembic's
env.py and the two scripts read. `WorkerSettings` is the INGEST WORKER's:
DATABASE_URL, the R2 endpoint, the two bucket names, and the worker
credential — six values, and exactly six (media pipeline record §8, §11.1).
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
"""

from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchor the env file to backend/.env so imports work regardless of cwd
# (uvicorn and alembic are both documented to run from backend/, but don't rely on it).
BACKEND_DIR = Path(__file__).resolve().parent.parent


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
    r2_upload_access_key_id: str
    r2_upload_secret_access_key: str
    r2_serve_access_key_id: str
    r2_serve_secret_access_key: str

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

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


class WorkerSettings(BaseSettings):
    """The ingest worker's environment (CK-35) — six values, and exactly six.

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
    r2_worker_access_key_id: str
    r2_worker_secret_access_key: str

    @field_validator("database_url")
    @classmethod
    def _force_asyncpg_scheme(cls, value: str) -> str:
        # The one normalisation, reused rather than copied.
        return Settings._force_asyncpg_scheme(value)


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
