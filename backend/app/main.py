from fastapi import FastAPI

app = FastAPI(title="Covey Keep")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
