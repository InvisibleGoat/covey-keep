from fastapi import FastAPI

# Imported for its side effect: startup fails fast if configuration is unreadable.
from app.config import settings  # noqa: F401

app = FastAPI(title="Covey Keep")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
