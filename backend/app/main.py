from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.passkeys import me_router as passkeys_me_router
from app.api.passkeys import signin_router as passkeys_signin_router
from app.api.profile import router as profile_router
from app.config import settings

app = FastAPI(title="Covey Keep")

app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(passkeys_me_router)
app.include_router(passkeys_signin_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
