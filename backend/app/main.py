from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.billing import router as billing_router
from app.api.co_hosts import router as co_hosts_router
from app.api.gatherings import router as gatherings_router
from app.api.group_invitations import router as group_invitations_router
from app.api.group_links import router as group_links_router
from app.api.groups import router as groups_router
from app.api.invitations import router as invitations_router
from app.api.media import router as media_router
from app.api.passkeys import me_router as passkeys_me_router
from app.api.passkeys import signin_router as passkeys_signin_router
from app.api.profile import router as profile_router
from app.api.rsvps import router as rsvps_router
from app.brand import PRODUCT_NAME
from app.config import settings
from app.logging_setup import configure_logging

# The API's own log lines reach stdout from here (CK-73.1): the `covey-keep`
# namespace at INFO with one handler in the worker's format, the ROOT
# untouched and `propagate` kept (app/logging_setup.py says why each).
# Idempotent, so a reimport adds no second handler. Before this call the
# web process never configured logging, and every INFO line an app module
# wrote was dropped at a root logger with no handler — CK-73's check (iq).
configure_logging()

app = FastAPI(title=PRODUCT_NAME)

app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(passkeys_me_router)
app.include_router(passkeys_signin_router)
app.include_router(gatherings_router)
app.include_router(invitations_router)
app.include_router(rsvps_router)
app.include_router(media_router)
app.include_router(groups_router)
app.include_router(group_links_router)
app.include_router(group_invitations_router)
app.include_router(co_hosts_router)
app.include_router(billing_router)

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
