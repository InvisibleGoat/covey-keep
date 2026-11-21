"""CK-100 — sign-up by invitation (THE DESIGN §1; Steven's Q1, 2026-11-19).

A new account is made only for an address holding a LIVE emailed invitation —
a row in `gathering_invitations_pending` or `group_invitations_pending` with
channel EMAIL, matched on the normalized address, neither consumed nor revoked
nor past `expires_at` — or for a reserved test address (§2, the one
exemption). An address that already belongs to a person signs in as before.
Decided twice: at `request-link`, which sends a sign-in link only to such an
address and the invite-only note to anyone else, and at `verify`, the one
place a person is made, which refuses with its uniform error if the
invitation has since gone.

Every address here that must NOT be exempt is at `kinmail.net`, a domain
outside the reserved set. Nothing leaves: the suite runs in console mode,
and the provider-mode tests (test_email_mode.py) stub the send. The host is
on `example.com`, reserved, so it signs up freely as every other test's
throwaway does.
"""

from datetime import datetime, timedelta, timezone

from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update

from app.api.auth import MAX_REQUESTS_PER_EMAIL, MAX_REQUESTS_PER_IP
from app.brand import PRODUCT_NAME
from app.main import app
from app.models import (
    Account,
    GatheringInvitationPending,
    GroupInvitationPending,
    MagicLinkToken,
    Person,
    TosAcceptance,
)
from tests.test_auth import (
    ERROR_REDIRECT,
    LINK_RE,
    TOKEN_REDIRECT_RE,
    _request_link,
    _verify,
)
from tests.test_email_change import CHANGE_LINK_RE, _capture_change_link
from tests.test_gatherings import _create as _create_gathering
from tests.test_gatherings import _signed_in_headers
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _invite_to_group
from tests.test_groups import _create as _create_group
from tests.test_invitations import _accept as _accept_gathering_invitation
from tests.test_invitations import _invite_token as _invite_to_gathering

HOST = "host@example.com"
AUNT = "aunt.may@kinmail.net"
COUSIN = "cousin.ray@kinmail.net"
STRANGER = "stranger@kinmail.net"

# THE WORDS (approved by Steven 2026-11-19), the product's name from the brand
# module — word for word, as the console line carries them.
INVITE_ONLY_SUBJECT = f"{PRODUCT_NAME} is open by invitation"
INVITE_ONLY_BODY = (
    f"Someone asked for a {PRODUCT_NAME} sign-in link for this address. "
    f"{PRODUCT_NAME} is a small private test, open only to people who've been "
    "invited, and there's no invitation for this address.\n\n"
    "If you were expecting to join, ask the person who invited you to send the "
    "invitation to this address. If you didn't ask for this, you can ignore this email."
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _ask(client, capsys, address: str):
    """One sign-in request; returns the response and what it printed."""
    capsys.readouterr()
    response = await _request_link(client, address)
    return response, capsys.readouterr().out


async def _link(client, capsys, address: str) -> str:
    response, out = await _ask(client, capsys, address)
    assert response.status_code == 202
    match = LINK_RE.search(out)
    assert match, f"no sign-in link in console output: {out!r}"
    return match.group(0)


async def _jwt(client, capsys, address: str) -> str:
    location = await _verify(client, await _link(client, capsys, address))
    assert TOKEN_REDIRECT_RE.match(location), location
    return location.split("#token=", 1)[1]


async def _host_and_gathering(client, capsys) -> tuple[dict, str]:
    headers = await _signed_in_headers(client, capsys, HOST)
    gathering = await _create_gathering(client, headers)
    return headers, gathering["id"]


async def _counts(db_session_factory) -> tuple[int, int, int]:
    async with db_session_factory() as db:
        return (
            await db.scalar(select(func.count()).select_from(Person)),
            await db.scalar(select(func.count()).select_from(Account)),
            await db.scalar(select(func.count()).select_from(TosAcceptance)),
        )


def _same_headers(response) -> dict:
    # Everything the answer carries but a clock.
    return {k: v for k, v in response.headers.items() if k.lower() != "date"}


# --- request-link ------------------------------------------------------------


async def test_the_three_cases_answer_byte_for_byte_alike(client, capsys):
    """An account, an invitation, neither — and a reserved address beside them:
    the same 202, the same bytes, the same headers. The answer must never let
    a caller tell them apart (the no-enumeration rule)."""
    headers, gathering_id = await _host_and_gathering(client, capsys)
    # An account at an address outside the reserved set: invited, signed up,
    # and the invitation accepted — consumed — so only the account stands.
    token = await _invite_to_gathering(client, capsys, headers, gathering_id, COUSIN)
    cousin = {"Authorization": f"Bearer {await _jwt(client, capsys, COUSIN)}"}
    await _accept_gathering_invitation(client, cousin, token)
    # An invitation, and no account.
    await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)

    account, _ = await _ask(client, capsys, COUSIN)
    invited, _ = await _ask(client, capsys, AUNT)
    neither, _ = await _ask(client, capsys, STRANGER)
    reserved, _ = await _ask(client, capsys, "throwaway@example.com")

    answers = (account, invited, neither, reserved)
    assert {a.status_code for a in answers} == {202}
    assert account.content == invited.content == neither.content == reserved.content
    assert (
        _same_headers(account)
        == _same_headers(invited)
        == _same_headers(neither)
        == _same_headers(reserved)
    )
    # And it carries no send-status field — one key, the fixed sentence.
    assert set(neither.json()) == {"detail"}


async def test_a_link_only_for_an_account_or_an_invitation(client, capsys):
    headers, gathering_id = await _host_and_gathering(client, capsys)
    await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    _, invited = await _ask(client, capsys, AUNT)
    _, account = await _ask(client, capsys, HOST)
    _, neither = await _ask(client, capsys, STRANGER)
    assert LINK_RE.search(invited)
    assert LINK_RE.search(account)
    assert not LINK_RE.search(neither)
    assert "/auth/verify" not in neither


async def test_an_address_with_neither_gets_the_invite_only_email_word_for_word(
    client, capsys, db_session_factory
):
    response, out = await _ask(client, capsys, STRANGER)
    assert response.status_code == 202
    assert out == (
        f"[email] console-mode send ok to={STRANGER} subject={INVITE_ONLY_SUBJECT!r}\n"
        f"{INVITE_ONLY_BODY}\n"
    )
    # No link and no token in it, in any form.
    assert "http" not in out and "token" not in out.lower()
    # The request is written as every other is — the row the limits count —
    # and its link is never sent anywhere.
    async with db_session_factory() as db:
        rows = (await db.execute(select(MagicLinkToken))).scalars().all()
    assert [row.email for row in rows] == [STRANGER]


async def test_the_rate_limits_count_refused_requests_per_address(client, capsys):
    for _ in range(MAX_REQUESTS_PER_EMAIL):
        assert (await _request_link(client, STRANGER)).status_code == 202
    assert (await _request_link(client, STRANGER)).status_code == 429


async def test_the_rate_limits_count_refused_requests_per_ip(capsys):
    # A peer of its own, so the default client's other requests count nothing
    # here: twenty addresses with neither an account nor an invitation, then
    # one more.
    transport = ASGITransport(app=app, client=("203.0.113.71", 40100))
    async with AsyncClient(transport=transport, base_url="http://testserver") as peer:
        for n in range(MAX_REQUESTS_PER_IP):
            assert (await _request_link(peer, f"stranger{n}@kinmail.net")).status_code == 202
        assert (await _request_link(peer, "one-more@kinmail.net")).status_code == 429
    assert not LINK_RE.search(capsys.readouterr().out)


async def test_an_invitation_already_expired_revoked_or_consumed_sends_no_link(
    client, capsys, db_session_factory
):
    headers, gathering_id = await _host_and_gathering(client, capsys)
    for address in (AUNT, COUSIN, STRANGER):
        await _invite_to_gathering(client, capsys, headers, gathering_id, address)
    async with db_session_factory() as db:
        # AUNT's ran out on its own; COUSIN's was revoked with its expiry left
        # ahead (every revoking path also forces the expiry, so the column the
        # check reads is planted alone); STRANGER's was consumed by someone.
        await db.execute(
            update(GatheringInvitationPending)
            .where(GatheringInvitationPending.destination == AUNT)
            .values(expires_at=_now() - timedelta(minutes=1))
        )
        await db.execute(
            update(GatheringInvitationPending)
            .where(GatheringInvitationPending.destination == COUSIN)
            .values(revoked_at=_now())
        )
        await db.execute(
            update(GatheringInvitationPending)
            .where(GatheringInvitationPending.destination == STRANGER)
            .values(consumed_at=_now())
        )
        await db.commit()
    for address in (AUNT, COUSIN, STRANGER):
        response, out = await _ask(client, capsys, address)
        assert response.status_code == 202
        assert not LINK_RE.search(out), address
        assert INVITE_ONLY_SUBJECT in out, address


# --- verify ------------------------------------------------------------------


async def test_an_invitation_to_a_gathering_admits(client, capsys, db_session_factory):
    headers, gathering_id = await _host_and_gathering(client, capsys)
    token = await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    aunt = {"Authorization": f"Bearer {await _jwt(client, capsys, AUNT)}"}
    async with db_session_factory() as db:
        person = (await db.execute(select(Person).where(Person.email == AUNT))).scalar_one()
        acceptance = (
            await db.execute(select(TosAcceptance).where(TosAcceptance.person_id == person.id))
        ).scalar_one()
    assert acceptance.version is not None
    # And the invitation is still hers to accept, where the landing sends her.
    accepted = await _accept_gathering_invitation(client, aunt, token)
    assert accepted["gathering_id"] == gathering_id


async def test_an_invitation_to_a_group_admits(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, HOST)
    group = await _create_group(client, headers)
    token = await _invite_to_group(client, capsys, headers, group["id"], AUNT)
    aunt = {"Authorization": f"Bearer {await _jwt(client, capsys, AUNT)}"}
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(Person).where(Person.email == AUNT))
        ) == 1
    accepted = await _accept_group_invitation(client, aunt, token)
    assert accepted["group_id"] == group["id"]


async def test_verify_refuses_an_invitation_revoked_since_the_request_and_makes_nobody(
    client, capsys, db_session_factory
):
    headers, gathering_id = await _host_and_gathering(client, capsys)
    await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    link = await _link(client, capsys, AUNT)
    async with db_session_factory() as db:
        invitation_id = (
            await db.execute(
                select(GatheringInvitationPending.id).where(
                    GatheringInvitationPending.destination == AUNT
                )
            )
        ).scalar_one()
    revoked = await client.delete(f"/invitations/pending/{invitation_id}", headers=headers)
    assert revoked.status_code == 204
    before = await _counts(db_session_factory)
    assert (await _verify(client, link)) == ERROR_REDIRECT
    assert await _counts(db_session_factory) == before


async def test_verify_reads_revoked_at_itself(client, capsys, db_session_factory):
    # Revoked with its expiry still ahead: no product path writes this today
    # (each revocation forces the expiry too), so this pins the column the
    # check reads rather than the expiry it usually brings.
    headers, gathering_id = await _host_and_gathering(client, capsys)
    await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    link = await _link(client, capsys, AUNT)
    async with db_session_factory() as db:
        await db.execute(
            update(GatheringInvitationPending)
            .where(GatheringInvitationPending.destination == AUNT)
            .values(revoked_at=_now())
        )
        await db.commit()
    before = await _counts(db_session_factory)
    assert (await _verify(client, link)) == ERROR_REDIRECT
    assert await _counts(db_session_factory) == before


async def test_verify_refuses_an_invitation_expired_since_the_request(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, HOST)
    group = await _create_group(client, headers)
    await _invite_to_group(client, capsys, headers, group["id"], AUNT)
    link = await _link(client, capsys, AUNT)
    async with db_session_factory() as db:
        await db.execute(
            update(GroupInvitationPending)
            .where(GroupInvitationPending.destination == AUNT)
            .values(expires_at=_now() - timedelta(seconds=1))
        )
        await db.commit()
    before = await _counts(db_session_factory)
    assert (await _verify(client, link)) == ERROR_REDIRECT
    assert await _counts(db_session_factory) == before
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(Person).where(Person.email == AUNT))
        ) == 0


async def test_an_invitation_consumed_by_someone_else_does_not_admit(
    client, capsys, db_session_factory
):
    """The invitation went to AUNT; its link was opened by someone else, who
    accepted it — consumed. AUNT's sign-in link, asked for while it was live,
    makes nobody; and a request now gets the note.

    MOVED at CK-101: someone else accepting is now the CONFIRMED acceptance
    (`confirm_other_address`) — unconfirmed, the link only asks and spends
    nothing, which is not the case this test is about."""
    headers, gathering_id = await _host_and_gathering(client, capsys)
    token = await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    link = await _link(client, capsys, AUNT)
    other = await _signed_in_headers(client, capsys, "other@example.com")
    accepted = await _accept_gathering_invitation(client, other, token, confirm=True)
    assert accepted["status"] == "accepted"
    before = await _counts(db_session_factory)
    assert (await _verify(client, link)) == ERROR_REDIRECT
    assert await _counts(db_session_factory) == before
    _, out = await _ask(client, capsys, AUNT)
    assert not LINK_RE.search(out)
    assert INVITE_ONLY_SUBJECT in out


async def test_an_existing_account_is_unaffected(client, capsys, db_session_factory):
    """Invited, signed up, accepted — the invitation is consumed and nothing
    else holds the address. It signs in as before: a link, the same person,
    nothing new written."""
    headers, gathering_id = await _host_and_gathering(client, capsys)
    token = await _invite_to_gathering(client, capsys, headers, gathering_id, AUNT)
    aunt = {"Authorization": f"Bearer {await _jwt(client, capsys, AUNT)}"}
    await _accept_gathering_invitation(client, aunt, token)
    before = await _counts(db_session_factory)
    async with db_session_factory() as db:
        person_id = (await db.execute(select(Person.id).where(Person.email == AUNT))).scalar_one()
    jwt = await _jwt(client, capsys, AUNT)
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {jwt}"})
    assert me.json()["id"] == str(person_id)
    assert await _counts(db_session_factory) == before


async def test_case_and_whitespace_are_handled_as_normalize_email_does(
    client, capsys, db_session_factory
):
    headers, gathering_id = await _host_and_gathering(client, capsys)
    # The destination is stored normalized at the invitation's create; the
    # request is normalized at its own validator; the two meet.
    await _invite_to_gathering(client, capsys, headers, gathering_id, " Aunt.May@KinMail.NET")
    location = await _verify(client, await _link(client, capsys, "  AUNT.may@kinmail.net "))
    assert TOKEN_REDIRECT_RE.match(location)
    async with db_session_factory() as db:
        assert (await db.execute(select(Person.email).where(Person.email == AUNT))).scalar_one()


async def test_a_reserved_address_signs_up_with_no_invitation(client, capsys, db_session_factory):
    location = await _verify(client, await _link(client, capsys, "fresh@sub.example.org"))
    assert TOKEN_REDIRECT_RE.match(location)
    async with db_session_factory() as db:
        assert (
            await db.scalar(
                select(func.count()).select_from(Person).where(Person.email == "fresh@sub.example.org")
            )
        ) == 1


async def test_an_email_change_to_a_new_address_is_unchanged(client, capsys):
    """An email change is not an account creation: a person moves to an address
    nobody invited, the change goes through as before, and that address then
    signs in — it belongs to a person."""
    headers = await _signed_in_headers(client, capsys, "mover@example.com")
    link = await _capture_change_link(client, capsys, headers, AUNT)
    assert CHANGE_LINK_RE.match(link)
    response = await client.get(link)
    assert response.status_code == 302
    assert response.headers["location"].endswith("#status=success")
    _, out = await _ask(client, capsys, AUNT)
    assert LINK_RE.search(out)
