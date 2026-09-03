from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.gatherings import router as gatherings_router
from app.api.invitations import router as invitations_router
from app.api.passkeys import me_router as passkeys_me_router
from app.api.passkeys import signin_router as passkeys_signin_router
from app.api.profile import router as profile_router
from app.api.rsvps import router as rsvps_router
from app.brand import PRODUCT_NAME
from app.config import settings

app = FastAPI(title=PRODUCT_NAME)

app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(passkeys_me_router)
app.include_router(passkeys_signin_router)
app.include_router(gatherings_router)
app.include_router(invitations_router)
app.include_router(rsvps_router)

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
