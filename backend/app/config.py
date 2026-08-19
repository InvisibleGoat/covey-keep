from pathlib import Path

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


settings = Settings()
