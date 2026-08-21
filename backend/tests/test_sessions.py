"""Sliding trusted-device sessions (CK-9, sign-in-ergonomics decision §2).

The window slides on use so a device that visits a few times a year stays
signed in, but: refreshes at most ~daily (no write-per-request), never past
the 365-day absolute cap, and never for a revoked or expired session —
resurrecting one would break the revocation guarantee that account deletion
and email change both depend on.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.api.deps import SESSION_ABSOLUTE_CAP, SESSION_REFRESH_THRESHOLD, SESSION_TTL
from app.models import Session
from tests.test_auth import _sign_in


async def _session_row(db_session_factory) -> Session:
    async with db_session_factory() as db:
        return (await db.execute(select(Session))).scalars().one()


async def _set_session(db_session_factory, **values) -> None:
    async with db_session_factory() as db:
        row = (await db.execute(select(Session))).scalars().one()
        for key, value in values.items():
            setattr(row, key, value)
        await db.commit()


async def test_stale_last_seen_slides_expiry(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "returning@example.com")
    now = datetime.now(timezone.utc)
    stale = now - SESSION_REFRESH_THRESHOLD - timedelta(hours=1)
    await _set_session(db_session_factory, last_seen_at=stale)
    before = await _session_row(db_session_factory)

    response = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert response.status_code == 200

    after = await _session_row(db_session_factory)
    assert after.last_seen_at > stale
    assert after.expires_at > before.expires_at
    # Slid to ~now + TTL (well short of the cap for a fresh session).
    assert abs(after.expires_at - (now + SESSION_TTL)) < timedelta(minutes=5)


async def test_recent_last_seen_writes_nothing(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "frequent@example.com")
    recent = datetime.now(timezone.utc) - timedelta(hours=1)
    await _set_session(db_session_factory, last_seen_at=recent)
    before = await _session_row(db_session_factory)

    response = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert response.status_code == 200

    # Within the refresh threshold: no write at all — otherwise every
    # authenticated call becomes a database write for no benefit.
    after = await _session_row(db_session_factory)
    assert after.last_seen_at == recent
    assert after.expires_at == before.expires_at


async def test_revoked_session_never_extended(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "loggedout@example.com")
    headers = {"Authorization": f"Bearer {jwt}"}
    assert (await client.post("/auth/logout", headers=headers)).status_code == 204
    stale = datetime.now(timezone.utc) - timedelta(days=2)
    await _set_session(db_session_factory, last_seen_at=stale)
    before = await _session_row(db_session_factory)

    assert (await client.get("/auth/me", headers=headers)).status_code == 401

    after = await _session_row(db_session_factory)
    assert after.revoked_at is not None
    assert after.expires_at == before.expires_at
    assert after.last_seen_at == stale


async def test_expired_session_never_resurrected(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "dormant@example.com")
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    stale = datetime.now(timezone.utc) - timedelta(days=200)
    await _set_session(db_session_factory, expires_at=past, last_seen_at=stale)

    assert (
        await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    ).status_code == 401

    after = await _session_row(db_session_factory)
    assert after.expires_at == past
    assert after.last_seen_at == stale


async def test_cap_is_never_slid_past(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "veteran@example.com")
    now = datetime.now(timezone.utc)
    issued = now - SESSION_ABSOLUTE_CAP + timedelta(days=1)  # day 364 of 365
    cap = issued + SESSION_ABSOLUTE_CAP
    await _set_session(
        db_session_factory,
        issued_at=issued,
        expires_at=cap,
        last_seen_at=now - timedelta(days=2),
    )

    response = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert response.status_code == 200

    # The refresh ran (last_seen moved) but expiry pinned to the cap: a purely
    # sliding session would never expire on an active device, and the cap is
    # what "trusted device" actually means — one re-authentication a year.
    after = await _session_row(db_session_factory)
    assert after.last_seen_at > now - timedelta(minutes=5)
    assert after.expires_at == cap


async def test_jwt_outlives_the_first_window(client, capsys, db_session_factory):
    # The JWT's exp is minted at the absolute cap, NOT at the row's 90-day
    # expiry — otherwise the bearer token would die at day 90 and silently
    # undo the slide. A session slid past its first window must still work.
    jwt = await _sign_in(client, capsys, "longhaul@example.com")
    now = datetime.now(timezone.utc)
    await _set_session(
        db_session_factory,
        issued_at=now - timedelta(days=100),
        expires_at=now + timedelta(days=80),  # as a slide would have left it
        last_seen_at=now - timedelta(hours=1),
    )
    assert (
        await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    ).status_code == 200
