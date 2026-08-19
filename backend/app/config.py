from pathlib import Path

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
    )

    database_url: str

    # Comma-separated origin list; kept as a plain string so the env var needs
    # no JSON quoting. Default covers the Vite dev server; render.yaml overrides.
    allowed_origins: str = "http://localhost:5173"

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


settings = Settings()
