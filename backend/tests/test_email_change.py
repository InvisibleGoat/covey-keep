import re
from datetime import datetime, timedelta, timezone

from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.main import app
from app.models import EmailChangeRequest, Person, Session
from tests.test_auth import _sign_in

CHANGE_LINK_RE = re.compile(r"http://testserver/auth/email-change/verify\?token=[A-Za-z0-9_\-]+")

# Verify answers with a 302 into the frontend result screen; the status rides
# the URL fragment (CK-6 discipline). Unlike sign-in verify, the failure
# states are deliberately DISTINGUISHED — the reader is the inbox's owner.
RESULT = "http://localhost:5173/email-change#status="


async def _signed_in_headers(client, capsys, address: str) -> dict:
    jwt = await _sign_in(client, capsys, address)
    return {"Authorization": f"Bearer {jwt}"}


async def _request_change(client, headers, new_email: str):
    return await client.post(
        "/me/email-change", json={"new_email": new_email}, headers=headers
    )


async def _capture_change_link(client, capsys, headers, new_email: str) -> str:
    response = await _request_change(client, headers, new_email)
    assert response.status_code == 202
    out = capsys.readouterr().out
    match = CHANGE_LINK_RE.search(out)
    assert match, f"no email-change link in console output: {out!r}"
    return match.group(0)


async def _verify(client, link: str) -> str:
    response = await client.get(link)
    assert response.status_code == 302, response.text
    return response.headers["location"]


def _console_sends(out: str) -> dict[str, str]:
    """Map recipient address -> full console-mode message for each send."""
    sends = {}
    for chunk in out.split("[email] console-mode send ok to=")[1:]:
        sends[chunk.split(" ", 1)[0]] = chunk
    return sends


async def test_request_requires_auth(client):
    response = await client.post("/me/email-change", json={"new_email": "x@example.com"})
    assert response.status_code == 401


async def test_happy_path_change(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "before@example.com")
    response = await _request_change(client, headers, " After.Move@Example.com ")
    assert response.status_code == 202
    out = capsys.readouterr().out
    sends = _console_sends(out)

    # The verification link goes to the NEW (normalized) address — controlling
    # that inbox is the entire proof.
    assert "after.move@example.com" in sends
    link = CHANGE_LINK_RE.search(sends["after.move@example.com"]).group(0)

    # The old address gets a plain notice: it exists so a session hijack is
    # visible — and it may reach a party who no longer controls the account,
    # so it must carry NO link, NO token, and NO new address.
    assert "before@example.com" in sends
    notice = sends["before@example.com"]
    assert "http" not in notice
    assert "after.move" not in notice

    # Verify in a browser with NO session — the person often opens the link on
    # another device, which is exactly why the endpoint is unauthenticated.
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as fresh_browser:
        location = await _verify(fresh_browser, link)
    assert location == RESULT + "success"

    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.email == "after.move@example.com"
        assert person.updated_at is not None
        row = (await db.execute(select(EmailChangeRequest))).scalars().one()
        assert row.consumed_at is not None

    # The requesting session survived and sees the new address immediately.
    me = await client.get("/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == "after.move@example.com"

    # Signing in with the NEW address reaches the same account.
    await _sign_in(client, capsys, "after.move@example.com")
    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(Person))) == 1


async def test_response_byte_identical_free_vs_taken(client, capsys):
    headers = await _signed_in_headers(client, capsys, "prober@example.com")
    await _sign_in(client, capsys, "occupied@example.com")
    capsys.readouterr()

    free = await _request_change(client, headers, "unclaimed@example.com")
    free_out = capsys.readouterr().out
    taken = await _request_change(client, headers, "occupied@example.com")
    taken_out = capsys.readouterr().out

    # Byte-identical, not merely equivalent — a signed-in prober is still a
    # prober, and this is the same oracle CK-5 closed on /auth/request-link.
    assert free.status_code == taken.status_code == 202
    assert free.content == taken.content

    # The free request sent a verification link; the taken one sent NOTHING to
    # the target address (the old-address notice still goes out in both).
    assert CHANGE_LINK_RE.search(free_out)
    assert not CHANGE_LINK_RE.search(taken_out)
    assert "occupied@example.com" not in _console_sends(taken_out)
    assert "prober@example.com" in _console_sends(taken_out)


async def test_rate_limit_counts_taken_requests_identically(client, capsys):
    # A request for a taken address must tally against the rate limit exactly
    # like one for a free address — otherwise "does the 6th request 429?"
    # answers "is this address taken?" (the oracle wearing a rate limit).
    headers = await _signed_in_headers(client, capsys, "counter@example.com")
    await _sign_in(client, capsys, "someone-else@example.com")
    for _ in range(5):
        assert (
            await _request_change(client, headers, "someone-else@example.com")
        ).status_code == 202
    assert (await _request_change(client, headers, "fresh@example.com")).status_code == 429


async def test_tokens_stored_hashed_only(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "hasher@example.com")
    link = await _capture_change_link(client, capsys, headers, "hashed-to@example.com")
    raw_token = link.split("token=", 1)[1]
    async with db_session_factory() as db:
        row = (await db.execute(select(EmailChangeRequest))).scalars().one()
        assert row.token_hash != raw_token
        assert raw_token not in row.token_hash
        assert re.fullmatch(r"[0-9a-f]{64}", row.token_hash)


async def test_expired_token_rejected(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "slowpoke@example.com")
    link = await _capture_change_link(client, capsys, headers, "too-late@example.com")
    async with db_session_factory() as db:
        row = (await db.execute(select(EmailChangeRequest))).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    assert (await _verify(client, link)) == RESULT + "expired"
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        assert person.email == "slowpoke@example.com"


async def test_reused_token_rejected(client, capsys):
    headers = await _signed_in_headers(client, capsys, "replayer@example.com")
    link = await _capture_change_link(client, capsys, headers, "replayed@example.com")
    assert (await _verify(client, link)) == RESULT + "success"
    assert (await _verify(client, link)) == RESULT + "used"


async def test_garbage_token_rejected(client):
    assert (
        await _verify(client, "/auth/email-change/verify?token=not-a-token")
    ) == RESULT + "invalid"
    assert (await _verify(client, "/auth/email-change/verify")) == RESULT + "invalid"


async def test_new_request_supersedes_outstanding(client, capsys):
    headers = await _signed_in_headers(client, capsys, "restless@example.com")
    first = await _capture_change_link(client, capsys, headers, "first@example.com")
    second = await _capture_change_link(client, capsys, headers, "second@example.com")
    assert (await _verify(client, first)) == RESULT + "expired"
    assert (await _verify(client, second)) == RESULT + "success"


async def test_cancel_supersedes_outstanding(client, capsys):
    headers = await _signed_in_headers(client, capsys, "wavering@example.com")
    link = await _capture_change_link(client, capsys, headers, "regretted@example.com")
    assert (await client.delete("/me/email-change", headers=headers)).status_code == 204
    assert (await _verify(client, link)) == RESULT + "expired"
    # Idempotent: nothing outstanding is still a 204.
    assert (await client.delete("/me/email-change", headers=headers)).status_code == 204


async def test_other_sessions_revoked_current_survives(client, capsys, db_session_factory):
    address = "multidevice@example.com"
    requesting = await _signed_in_headers(client, capsys, address)
    other = await _signed_in_headers(client, capsys, address)
    link = await _capture_change_link(client, capsys, requesting, "moved@example.com")
    assert (await _verify(client, link)) == RESULT + "success"

    # Email is the credential: the change killed every session except the one
    # that asked for it.
    assert (await client.get("/auth/me", headers=requesting)).status_code == 200
    assert (await client.get("/auth/me", headers=other)).status_code == 401
    async with db_session_factory() as db:
        sessions = (await db.execute(select(Session))).scalars().all()
        assert len(sessions) == 2
        assert sorted(s.revoked_at is None for s in sessions) == [False, True]


async def test_race_second_verifier_fails_cleanly(client, capsys, db_session_factory):
    # Two people request the SAME new address inside the window — the race the
    # verify-time re-check exists for. Whoever verifies second must fail.
    first_headers = await _signed_in_headers(client, capsys, "first-mover@example.com")
    second_headers = await _signed_in_headers(client, capsys, "second-mover@example.com")
    first_link = await _capture_change_link(client, capsys, first_headers, "contested@example.com")
    second_link = await _capture_change_link(
        client, capsys, second_headers, "contested@example.com"
    )
    assert (await _verify(client, second_link)) == RESULT + "success"
    assert (await _verify(client, first_link)) == RESULT + "taken"

    async with db_session_factory() as db:
        people = (await db.execute(select(Person))).scalars().all()
        emails = {p.email for p in people}
        assert emails == {"first-mover@example.com", "contested@example.com"}


async def test_deletion_purges_email_change_rows(client, capsys, db_session_factory):
    # An erased account that still holds an unverified address is retained PII
    # after a promised erasure — deletion must leave ZERO rows (kickoff STEP 5).
    headers = await _signed_in_headers(client, capsys, "leaver@example.com")
    await _capture_change_link(client, capsys, headers, "never-verified@example.com")
    response = await client.post("/me/delete", json={"confirm": "DELETE"}, headers=headers)
    assert response.status_code == 204
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(EmailChangeRequest))
        ) == 0


async def test_old_address_after_change_is_a_fresh_start(client, capsys, db_session_factory):
    # No history is kept: once the address moves, signing in with the OLD one
    # creates a different, unrelated account — exactly like re-signup after
    # deletion.
    headers = await _signed_in_headers(client, capsys, "formerly@example.com")
    link = await _capture_change_link(client, capsys, headers, "currently@example.com")
    assert (await _verify(client, link)) == RESULT + "success"

    jwt = await _sign_in(client, capsys, "formerly@example.com")
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert me.status_code == 200
    assert me.json()["display_name"] == "formerly"
    async with db_session_factory() as db:
        assert (await db.scalar(select(func.count()).select_from(Person))) == 2


async def test_bad_request_bodies_rejected(client, capsys):
    headers = await _signed_in_headers(client, capsys, "strict@example.com")
    for bad_body in (
        {"new_email": "not-an-address"},
        {"new_email": ""},
        {},
        {"new_email": "ok@example.com", "extra": True},
        {"email": "ok@example.com"},
    ):
        response = await client.post("/me/email-change", json=bad_body, headers=headers)
        assert response.status_code == 422, bad_body
