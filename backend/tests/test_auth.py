import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app import __version__
from app.api.auth import MAX_REQUESTS_PER_EMAIL
from app.config import settings
from app.models import MagicLinkToken, Person, Session, TosAcceptance
from app.services import email as email_service

LINK_RE = re.compile(r"http://testserver/auth/verify\?token=[A-Za-z0-9_\-]+")


async def _request_link(client, address: str):
    return await client.post("/auth/request-link", json={"email": address})


async def _capture_link(client, capsys, address: str) -> str:
    response = await _request_link(client, address)
    assert response.status_code == 202
    out = capsys.readouterr().out
    match = LINK_RE.search(out)
    assert match, f"no magic link in console output: {out!r}"
    return match.group(0)


async def _sign_in(client, capsys, address: str) -> str:
    link = await _capture_link(client, capsys, address)
    response = await client.get(link)
    assert response.status_code == 200, response.text
    return response.json()["token"]


async def test_happy_path_end_to_end(client, capsys, db_session_factory):
    jwt = await _sign_in(client, capsys, "Maya.Finch@Example.com ")

    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert me.status_code == 200
    body = me.json()
    # Email normalized; display name defaults to the local part.
    assert body["email"] == "maya.finch@example.com"
    assert body["display_name"] == "maya.finch"

    async with db_session_factory() as db:
        people = (await db.execute(select(Person))).scalars().all()
        assert len(people) == 1
        tos = (await db.execute(select(TosAcceptance))).scalars().all()
        assert len(tos) == 1
        assert tos[0].version == 1
        assert tos[0].person_id == people[0].id
        token_row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert token_row.consumed_at is not None
        session_row = (await db.execute(select(Session))).scalars().one()
        assert session_row.revoked_at is None
        # ~30-day trusted-device session.
        assert session_row.expires_at - session_row.issued_at == timedelta(days=30)

    # A returning sign-in reuses the person — no duplicate account, no second ToS row.
    await _sign_in(client, capsys, "maya.finch@example.com")
    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(Person))) == 1
        assert (await db.scalar(select(func.count()).select_from(TosAcceptance))) == 1


async def test_expired_token_rejected(client, capsys, db_session_factory):
    link = await _capture_link(client, capsys, "late@example.com")
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    response = await client.get(link)
    assert response.status_code == 400


async def test_reused_token_rejected(client, capsys):
    link = await _capture_link(client, capsys, "replay@example.com")
    assert (await client.get(link)).status_code == 200
    assert (await client.get(link)).status_code == 400


async def test_garbage_token_rejected(client):
    response = await client.get("/auth/verify", params={"token": "not-a-real-token"})
    assert response.status_code == 400


async def test_new_link_invalidates_outstanding_one(client, capsys):
    first = await _capture_link(client, capsys, "again@example.com")
    second = await _capture_link(client, capsys, "again@example.com")
    assert (await client.get(first)).status_code == 400
    assert (await client.get(second)).status_code == 200


async def test_unknown_and_known_email_responses_byte_identical(client, capsys):
    # Establish a known account first.
    await _sign_in(client, capsys, "known@example.com")

    known = await _request_link(client, "known@example.com")
    unknown = await _request_link(client, "nobody-here@example.com")
    assert known.status_code == unknown.status_code == 202
    # Byte-identical, not merely equivalent — and no send-status field may ever
    # be added: failure would uniquely mean "this address exists" (enumeration
    # oracle, transactional-email standard v1.0.0).
    assert known.content == unknown.content


async def test_send_failure_degrades_and_body_unchanged(client, capsys, monkeypatch):
    # Provider mode with no key configured: every send fails, yet the endpoint
    # still answers the canonical 202 — a send failure degrades, never raises,
    # and never surfaces in the response.
    monkeypatch.setattr(settings, "email_mode", "provider")
    baseline = await _request_link(client, "console@example.com")
    monkeypatch.undo()
    reference = await _request_link(client, "console2@example.com")
    assert baseline.status_code == reference.status_code == 202
    assert baseline.content == reference.content
    assert "provider-mode send failed" in capsys.readouterr().out


async def test_revoked_session_rejected(client, capsys):
    jwt = await _sign_in(client, capsys, "leaver@example.com")
    headers = {"Authorization": f"Bearer {jwt}"}
    assert (await client.get("/auth/me", headers=headers)).status_code == 200
    assert (await client.post("/auth/logout", headers=headers)).status_code == 204
    # The JWT signature is still valid — the revoked sessions row must reject it.
    assert (await client.get("/auth/me", headers=headers)).status_code == 401


async def test_rate_limit_trips(client):
    for _ in range(MAX_REQUESTS_PER_EMAIL):
        assert (await _request_link(client, "eager@example.com")).status_code == 202
    assert (await _request_link(client, "eager@example.com")).status_code == 429


async def test_tokens_stored_hashed_only(client, capsys, db_session_factory):
    link = await _capture_link(client, capsys, "hashed@example.com")
    raw_token = link.split("token=", 1)[1]
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert row.token_hash != raw_token
        assert raw_token not in row.token_hash
        assert re.fullmatch(r"[0-9a-f]{64}", row.token_hash)


def test_provider_request_sends_real_user_agent(monkeypatch):
    # Cloudflare fronts the provider API and answers stdlib default agents with
    # 403 / error code 1010, silently — the header is load-bearing. urllib
    # capitalizes stored header names, so it reads back as "User-agent";
    # asserting on get_header("User-Agent") would return None and could pass a
    # badly written assertion vacuously.
    monkeypatch.setattr(settings, "email_api_key", "test-key")
    monkeypatch.setattr(settings, "email_from", "keep@example.com")
    request = email_service.build_provider_request(
        to="someone@example.com", subject="s", body="b"
    )
    user_agent = request.get_header("User-agent")
    assert user_agent is not None
    assert user_agent == f"covey-keep-api/{__version__}"
