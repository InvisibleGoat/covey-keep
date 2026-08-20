import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app import __version__
from app.api import auth as auth_api
from app.api.auth import MAX_REQUESTS_PER_EMAIL
from app.config import settings
from app.main import app
from app.models import MagicLinkToken, Person, Session, TosAcceptance
from app.services import email as email_service

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

LINK_RE = re.compile(r"http://testserver/auth/verify\?token=[A-Za-z0-9_\-]+")

# Verify answers with a 302 into the frontend callback; the payload rides the
# URL fragment (never the query string — fragments don't reach servers or logs).
TOKEN_REDIRECT_RE = re.compile(
    r"^http://localhost:5173/auth/callback"
    r"#token=[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$"
)
ERROR_REDIRECT = "http://localhost:5173/auth/callback#error=invalid_link"


async def _request_link(client, address: str):
    # The sign-in form always submits affirmative ToS consent (it cannot know
    # whether the address is new — that would be enumeration).
    return await client.post(
        "/auth/request-link",
        json={"email": address, "tos_accepted": True, "tos_version": 1},
    )


async def _capture_link(client, capsys, address: str) -> str:
    response = await _request_link(client, address)
    assert response.status_code == 202
    out = capsys.readouterr().out
    match = LINK_RE.search(out)
    assert match, f"no magic link in console output: {out!r}"
    return match.group(0)


async def _verify(client, link: str) -> str:
    """GET the magic link and return the redirect Location."""
    response = await client.get(link)
    assert response.status_code == 302, response.text
    return response.headers["location"]


async def _sign_in(client, capsys, address: str) -> str:
    link = await _capture_link(client, capsys, address)
    location = await _verify(client, link)
    match = TOKEN_REDIRECT_RE.match(location)
    assert match, f"expected a token-fragment redirect, got {location!r}"
    return location.split("#token=", 1)[1]


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
    assert (await _verify(client, link)) == ERROR_REDIRECT


async def test_reused_token_rejected(client, capsys):
    link = await _capture_link(client, capsys, "replay@example.com")
    assert TOKEN_REDIRECT_RE.match(await _verify(client, link))
    assert (await _verify(client, link)) == ERROR_REDIRECT


async def test_garbage_token_rejected(client):
    # Garbage and absent tokens both land on the same uniform error redirect —
    # a mangled copy-paste gets the expired-link screen, not a JSON error.
    assert (await _verify(client, "/auth/verify?token=not-a-real-token")) == ERROR_REDIRECT
    assert (await _verify(client, "/auth/verify")) == ERROR_REDIRECT


async def test_new_link_invalidates_outstanding_one(client, capsys):
    first = await _capture_link(client, capsys, "again@example.com")
    second = await _capture_link(client, capsys, "again@example.com")
    assert (await _verify(client, first)) == ERROR_REDIRECT
    assert TOKEN_REDIRECT_RE.match(await _verify(client, second))


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


async def test_request_link_requires_affirmative_tos(client, db_session_factory):
    # Absent and unchecked are both rejected before any token is minted — an
    # account must never be creatable from a request that carried no consent.
    absent = await client.post("/auth/request-link", json={"email": "keen@example.com"})
    unchecked = await client.post(
        "/auth/request-link",
        json={"email": "keen@example.com", "tos_accepted": False, "tos_version": 1},
    )
    assert absent.status_code == 422
    assert unchecked.status_code == 422
    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(MagicLinkToken))) == 0


async def test_unknown_tos_version_rejected(client):
    response = await client.post(
        "/auth/request-link",
        json={"email": "keen@example.com", "tos_accepted": True, "tos_version": 99},
    )
    assert response.status_code == 422


async def test_acceptance_records_the_version_the_client_sent(
    client, capsys, monkeypatch, db_session_factory
):
    # The acceptance row must carry what the person actually agreed to, not a
    # hardcoded 1: publish version 2, accept version 2, expect 2 recorded.
    monkeypatch.setattr(auth_api, "TOS_VERSION", 2)
    response = await client.post(
        "/auth/request-link",
        json={"email": "versioned@example.com", "tos_accepted": True, "tos_version": 2},
    )
    assert response.status_code == 202
    match = LINK_RE.search(capsys.readouterr().out)
    assert match, "no magic link in console output"
    assert TOKEN_REDIRECT_RE.match(await _verify(client, match.group(0)))
    async with db_session_factory() as db:
        acceptance = (await db.execute(select(TosAcceptance))).scalars().one()
        assert acceptance.version == 2


async def test_pre_ck6_token_cannot_create_account(client, capsys, db_session_factory):
    # A token minted before CK-6 (tos_version NULL) recorded no consent, so it
    # must never create an account — that would be the assumed-consent bug back.
    link = await _capture_link(client, capsys, "grandfathered@example.com")
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        row.tos_version = None
        await db.commit()
    assert (await _verify(client, link)) == ERROR_REDIRECT
    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(Person))) == 0


async def test_tokens_stored_hashed_only(client, capsys, db_session_factory):
    link = await _capture_link(client, capsys, "hashed@example.com")
    raw_token = link.split("token=", 1)[1]
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert row.token_hash != raw_token
        assert raw_token not in row.token_hash
        assert re.fullmatch(r"[0-9a-f]{64}", row.token_hash)


async def test_forwarded_client_ip_recorded_not_proxy_peer(capsys, db_session_factory):
    # On Render the socket peer is always the load balancer; the real client
    # arrives in X-Forwarded-For. This wraps the app in the exact middleware
    # uvicorn applies when render.yaml's start command passes
    # --proxy-headers --forwarded-allow-ips="*", and asserts the recorded IPs
    # are the forwarded client, not the immediate peer.
    forwarded_ip = "203.0.113.9"
    proxy_peer = "10.210.4.7"
    transport = ASGITransport(
        app=ProxyHeadersMiddleware(app, trusted_hosts="*"),
        client=(proxy_peer, 51234),
    )
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-Forwarded-For": forwarded_ip},
    ) as forwarded:
        response = await forwarded.post(
            "/auth/request-link",
            json={"email": "behind-proxy@example.com", "tos_accepted": True, "tos_version": 1},
        )
        assert response.status_code == 202
        match = LINK_RE.search(capsys.readouterr().out)
        assert match, "no magic link in console output"
        assert (await forwarded.get(match.group(0))).status_code == 302

    async with db_session_factory() as db:
        token_row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert str(token_row.requested_ip) == forwarded_ip
        tos_row = (await db.execute(select(TosAcceptance))).scalars().one()
        assert str(tos_row.accepted_ip) == forwarded_ip


def test_render_start_command_trusts_proxy_headers():
    # Config pin: the middleware test above proves the mechanism, but only
    # these flags in render.yaml make it real on the deployed service — and
    # they are exactly the kind of flag a future tidy-up deletes. Without
    # them uvicorn trusts only 127.0.0.1 and every deployed request records
    # Render's load balancer as the client.
    render_yaml = (REPO_ROOT / "render.yaml").read_text(encoding="utf-8")
    start_line = next(
        line for line in render_yaml.splitlines() if "startCommand:" in line
    )
    assert "--proxy-headers" in start_line
    assert '--forwarded-allow-ips="*"' in start_line


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
