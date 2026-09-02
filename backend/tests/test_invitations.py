"""CK-25 — person-targeted invitations: pending invites, acceptance, and the
first widening of the read audience.

The load-bearing pins: acceptance routes through the SESSION — a brand-new
invitee signs in through the unmodified magic-link path first, so the person,
their accounts row, AND their tos_acceptances row all exist after acceptance
(the regression test for the create-a-person-outside-/auth/verify trap);
admin-only management is 404-not-403, byte-identical to a missing id; the
rate limit survives supersession and revocation (pending rows are stamped,
never deleted — the CK-24 lesson applied forward); acceptance is idempotent
and every dead-token state is distinguished; and the reaper is wired as
purge_stale's fourth customer.
"""

import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.api.auth import RATE_WINDOW
from app.api.invitations import (
    INVITATION_TTL,
    MAX_INVITATIONS_PER_GATHERING,
    MAX_INVITATIONS_PER_INVITER,
)
from app.models import (
    Account,
    Gathering,
    GatheringInvitation,
    GatheringInvitationPending,
    Person,
    TosAcceptance,
)
from app.security import hash_token
from app.services.retention import PURGE_GRACE
from tests.test_auth import _sign_in
from tests.test_gatherings import _create, _field_errors, _signed_in_headers

MISSING_ID = "00000000-0000-0000-0000-000000000000"

# The invitation link targets the FRONTEND acceptance screen with the token in
# the URL fragment (never the query string — it must not reach access logs).
INVITE_LINK_RE = re.compile(
    r"http://localhost:5173/invitations/accept#token=([A-Za-z0-9_\-]+)"
)


async def _invite(client, headers, gathering_id: str, destination: str):
    return await client.post(
        f"/gatherings/{gathering_id}/invitations",
        json={"channel": "EMAIL", "destination": destination},
        headers=headers,
    )


async def _invite_token(client, capsys, headers, gathering_id: str, destination: str) -> str:
    # Drop anything already buffered (an earlier, uncaptured invitation email
    # would match the regex first) — the link captured is THIS invite's.
    capsys.readouterr()
    response = await _invite(client, headers, gathering_id, destination)
    assert response.status_code == 201, response.text
    out = capsys.readouterr().out
    match = INVITE_LINK_RE.search(out)
    assert match, f"no invitation link in console output: {out!r}"
    return match.group(1)


async def _accept(client, headers, token: str) -> dict:
    response = await client.post(
        "/invitations/accept", json={"token": token}, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_invitation_ttl_exceeds_rate_window():
    # The reap-vs-tally arithmetic (services/retention.py): every pending row
    # must outlive the rate window it was created in, or the counts stop
    # accumulating. With a 7-day TTL this is comfortable — the assert is the
    # tripwire for anyone shortening the TTL toward the window.
    assert INVITATION_TTL > RATE_WINDOW


async def test_invitation_endpoints_require_auth(client):
    body = {"channel": "EMAIL", "destination": "a@example.com"}
    assert (
        await client.post(f"/gatherings/{MISSING_ID}/invitations", json=body)
    ).status_code == 401
    assert (await client.get(f"/gatherings/{MISSING_ID}/invitations")).status_code == 401
    assert (await client.delete(f"/invitations/pending/{MISSING_ID}")).status_code == 401
    assert (
        await client.post("/invitations/accept", json={"token": "x"})
    ).status_code == 401
    # Preview is unauthenticated, deliberately: the acceptance screen renders
    # its distinguished states before pushing anyone through sign-in.
    response = await client.post("/invitations/preview", json={"token": "x"})
    assert response.status_code == 200
    assert response.json() == {"status": "invalid", "gathering_title": None}


async def test_invitation_management_is_admin_only_404_not_403(client, capsys):
    headers_admin = await _signed_in_headers(client, capsys, "host@example.com")
    headers_other = await _signed_in_headers(client, capsys, "bystander@example.com")
    created = await _create(client, headers_admin)
    gathering_id = created["id"]
    pending_id = (
        await _invite(client, headers_admin, gathering_id, "guest@example.com")
    ).json()["id"]

    # Every management route, same answer for a non-admin: 404, never 403,
    # byte-identical to a genuinely missing id.
    foreign = await _invite(client, headers_other, gathering_id, "spam@example.com")
    missing = await _invite(client, headers_other, MISSING_ID, "spam@example.com")
    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.content == missing.content

    foreign = await client.get(f"/gatherings/{gathering_id}/invitations", headers=headers_other)
    missing = await client.get(f"/gatherings/{MISSING_ID}/invitations", headers=headers_other)
    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.content == missing.content

    foreign = await client.delete(f"/invitations/pending/{pending_id}", headers=headers_other)
    missing = await client.delete(f"/invitations/pending/{MISSING_ID}", headers=headers_other)
    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.content == missing.content


async def test_sms_is_refused_with_a_usable_422(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "texter@example.com")
    created = await _create(client, headers)
    capsys.readouterr()  # clear the sign-in/creation output

    response = await client.post(
        f"/gatherings/{created['id']}/invitations",
        json={"channel": "SMS", "destination": "+15555550123"},
        headers=headers,
    )
    # Accepted by the schema, refused by the endpoint: a field-level 422 that
    # says the channel isn't available — never a 500, and never silently
    # treated as email.
    assert response.status_code == 422
    assert "channel" in _field_errors(response)
    assert "available" in response.text

    # Nothing was written and nothing was sent.
    assert "console-mode send" not in capsys.readouterr().out
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(GatheringInvitationPending))
        ) == 0

    # An unknown channel is the schema's own 422.
    response = await client.post(
        f"/gatherings/{created['id']}/invitations",
        json={"channel": "CARRIER_PIGEON", "destination": "x"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "channel" in _field_errors(response)


async def test_invite_stores_hash_normalizes_destination_and_sends_link(
    client, capsys, db_session_factory
):
    headers = await _signed_in_headers(client, capsys, "inviter@example.com")
    created = await _create(client, headers)
    capsys.readouterr()

    response = await _invite(client, headers, created["id"], "  Guest@Example.COM ")
    assert response.status_code == 201
    body = response.json()
    assert body["destination"] == "guest@example.com"

    out = capsys.readouterr().out
    assert "to=guest@example.com" in out
    match = INVITE_LINK_RE.search(out)
    assert match, f"no invitation link in console output: {out!r}"
    raw_token = match.group(1)

    async with db_session_factory() as db:
        row = (
            await db.execute(select(GatheringInvitationPending))
        ).scalars().one()
        inviter = (
            await db.execute(select(Person).where(Person.email == "inviter@example.com"))
        ).scalars().one()
        # Only the SHA-256 hash is stored — the raw token exists solely in
        # the sent link (the magic_link_tokens convention).
        assert row.token_hash == hash_token(raw_token)
        assert raw_token not in row.token_hash
        assert row.destination == "guest@example.com"
        assert row.invited_by_person_id == inviter.id
        assert row.consumed_at is None and row.revoked_at is None
        lifetime = row.expires_at - row.created_at
        assert (
            INVITATION_TTL - timedelta(minutes=5)
            <= lifetime
            <= INVITATION_TTL + timedelta(minutes=5)
        )


async def test_reinvite_supersedes_and_never_deletes(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "resender@example.com")
    created = await _create(client, headers)
    token_1 = await _invite_token(client, capsys, headers, created["id"], "guest@example.com")
    token_2 = await _invite_token(client, capsys, headers, created["id"], "guest@example.com")
    assert token_1 != token_2

    # Both rows remain (the rate tally must keep counting them); the first is
    # stamped revoked with its expiry forced, so the reaper takes it later
    # and the old link stops working now.
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(GatheringInvitationPending).order_by(
                    GatheringInvitationPending.created_at
                )
            )
        ).scalars().all()
        assert len(rows) == 2
        assert rows[0].revoked_at is not None
        assert rows[0].expires_at <= datetime.now(timezone.utc)
        assert rows[1].revoked_at is None

    guest_headers = await _signed_in_headers(client, capsys, "guest@example.com")
    assert (await _accept(client, guest_headers, token_1))["status"] == "revoked"
    result = await _accept(client, guest_headers, token_2)
    assert result["status"] == "accepted"
    assert result["gathering_id"] == created["id"]


async def test_rate_limit_per_gathering_counts_superseded_rows(client, capsys):
    # Every re-invite supersedes the last, so at most ONE row is ever live —
    # but the tally counts rows by created_at regardless, which is exactly
    # what makes the limit hold (the CK-24 lesson: a purge or delete keyed to
    # consumption/supersession would erase the tally).
    headers = await _signed_in_headers(client, capsys, "spammer@example.com")
    created = await _create(client, headers)
    for _ in range(MAX_INVITATIONS_PER_GATHERING):
        assert (
            await _invite(client, headers, created["id"], "victim@example.com")
        ).status_code == 201
    response = await _invite(client, headers, created["id"], "victim@example.com")
    assert response.status_code == 429


async def test_rate_limit_per_inviter_spans_gatherings_and_survives_revocation(
    client, capsys
):
    headers = await _signed_in_headers(client, capsys, "prolific@example.com")
    first = await _create(client, headers, title="First")
    second = await _create(client, headers, title="Second")
    third = await _create(client, headers, title="Third")

    pending_ids = []
    per_gathering = MAX_INVITATIONS_PER_INVITER // 2
    assert per_gathering <= MAX_INVITATIONS_PER_GATHERING
    for gathering in (first, second):
        for n in range(per_gathering):
            response = await _invite(
                client, headers, gathering["id"], f"guest{n}@example.com"
            )
            assert response.status_code == 201, response.text
            pending_ids.append(response.json()["id"])

    # The inviter cap spans gatherings: a fresh gathering doesn't reset it.
    response = await _invite(client, headers, third["id"], "one-more@example.com")
    assert response.status_code == 429

    # Revoking stamps the row, never deletes it — so revocation cannot be
    # used to walk back the tally and mail on.
    assert (
        await client.delete(f"/invitations/pending/{pending_ids[0]}", headers=headers)
    ).status_code == 204
    response = await _invite(client, headers, third["id"], "one-more@example.com")
    assert response.status_code == 429


async def test_accept_as_new_person_creates_person_account_and_tos(
    client, capsys, db_session_factory
):
    """THE regression test for the STEP-5 trap: the invitee did not exist, and
    after acceptance they must have a person row, an accounts row, AND a
    tos_acceptances row — because sign-in went through /auth/verify, the one
    place all three are born together. An accept flow that created the person
    itself would fail this silently on the ToS row."""
    headers = await _signed_in_headers(client, capsys, "host@example.com")
    created = await _create(client, headers)
    token = await _invite_token(client, capsys, headers, created["id"], "newcomer@example.com")

    # The invitation alone authenticates nothing and creates nobody.
    async with db_session_factory() as db:
        assert (
            await db.scalar(
                select(func.count()).select_from(Person).where(Person.email == "newcomer@example.com")
            )
        ) == 0

    # The invitee signs in through the NORMAL magic-link path (ToS consent
    # collected on the sign-in form, recorded at account creation)...
    invitee_headers = await _signed_in_headers(client, capsys, "newcomer@example.com")
    # ...and then the token is redeemed against the session.
    result = await _accept(client, invitee_headers, token)
    assert result == {"status": "accepted", "gathering_id": created["id"]}

    async with db_session_factory() as db:
        invitee = (
            await db.execute(select(Person).where(Person.email == "newcomer@example.com"))
        ).scalars().one()
        host = (
            await db.execute(select(Person).where(Person.email == "host@example.com"))
        ).scalars().one()
        # All three rows of a properly-born account:
        account = (
            await db.execute(select(Account).where(Account.id == invitee.account_id))
        ).scalars().one()
        assert account.kind.value == "PERSON"
        tos = (
            await db.execute(
                select(TosAcceptance).where(TosAcceptance.person_id == invitee.id)
            )
        ).scalars().all()
        assert len(tos) == 1
        # The invitation landed on the person, with provenance carried over,
        # and the pending row is consumed.
        invitation = (
            await db.execute(select(GatheringInvitation))
        ).scalars().one()
        assert invitation.person_id == invitee.id
        assert str(invitation.gathering_id) == created["id"]
        assert invitation.invited_by_person_id == host.id
        pending = (
            await db.execute(select(GatheringInvitationPending))
        ).scalars().one()
        assert pending.consumed_at is not None

    # The invitee is signed in and looking at the gathering.
    detail = await client.get(f"/gatherings/{created['id']}", headers=invitee_headers)
    assert detail.status_code == 200
    assert detail.json()["title"] == created["title"]


async def test_accept_as_existing_person_widens_reads_and_nothing_else(
    client, capsys, db_session_factory
):
    headers_admin = await _signed_in_headers(client, capsys, "admin@example.com")
    headers_guest = await _signed_in_headers(client, capsys, "regular@example.com")
    headers_stranger = await _signed_in_headers(client, capsys, "stranger@example.com")
    created = await _create(
        client,
        headers_admin,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00", "location": "the park"}
        ],
    )
    gathering_id = created["id"]
    occurrence_id = created["occurrences"][0]["id"]

    # Before acceptance the invitee is any other stranger: 404.
    assert (
        await client.get(f"/gatherings/{gathering_id}", headers=headers_guest)
    ).status_code == 404

    token = await _invite_token(client, capsys, headers_admin, gathering_id, "regular@example.com")
    result = await _accept(client, headers_guest, token)
    assert result["status"] == "accepted"

    # The invitee reads the SAME detail body the admin reads — occurrences,
    # times, places: the point of inviting them.
    admin_view = await client.get(f"/gatherings/{gathering_id}", headers=headers_admin)
    guest_view = await client.get(f"/gatherings/{gathering_id}", headers=headers_guest)
    assert guest_view.status_code == 200
    assert guest_view.json() == admin_view.json()

    # The gathering appears on the invitee's list (without it, the emailed
    # link would be their only way back, forever).
    listed = await client.get("/gatherings", headers=headers_guest)
    assert [g["id"] for g in listed.json()["gatherings"]] == [gathering_id]

    # Visibility, nothing more: no mutation, no invitation roster.
    assert (
        await client.patch(
            f"/gatherings/{gathering_id}", json={"title": "hijacked"}, headers=headers_guest
        )
    ).status_code == 404
    assert (
        await client.post(
            f"/gatherings/{gathering_id}/occurrences",
            json={"starts_at": "2026-10-01T18:00:00+00:00"},
            headers=headers_guest,
        )
    ).status_code == 404
    assert (
        await client.patch(
            f"/occurrences/{occurrence_id}", json={"location": "moved"}, headers=headers_guest
        )
    ).status_code == 404
    assert (
        await client.delete(f"/occurrences/{occurrence_id}", headers=headers_guest)
    ).status_code == 404
    assert (
        await client.get(f"/gatherings/{gathering_id}/invitations", headers=headers_guest)
    ).status_code == 404
    assert (
        await _invite(client, headers_guest, gathering_id, "friend@example.com")
    ).status_code == 404

    # A non-invited account still gets the not-found posture.
    assert (
        await client.get(f"/gatherings/{gathering_id}", headers=headers_stranger)
    ).status_code == 404

    # And the moderation default was left alone: still hard-coded True.
    async with db_session_factory() as db:
        gathering = (await db.execute(select(Gathering))).scalars().one()
        assert gathering.requires_approval is True


async def test_token_is_the_credential_not_the_address(client, capsys):
    # The CK-9 email-change precedent: whoever holds the link may accept under
    # whatever account they sign in with — acceptance is deliberately not
    # bound to the invited address (the invitee may own several, and an SMS
    # destination has no address at all). Control of the destination inbox is
    # how they got the token; the token is the proof.
    headers_admin = await _signed_in_headers(client, capsys, "sender@example.com")
    created = await _create(client, headers_admin)
    token = await _invite_token(client, capsys, headers_admin, created["id"], "personal@example.com")

    other_headers = await _signed_in_headers(client, capsys, "work@example.com")
    result = await _accept(client, other_headers, token)
    assert result["status"] == "accepted"
    assert (
        await client.get(f"/gatherings/{created['id']}", headers=other_headers)
    ).status_code == 200


async def test_accept_is_idempotent_and_dead_tokens_are_distinguished(
    client, capsys, db_session_factory
):
    headers_admin = await _signed_in_headers(client, capsys, "organizer@example.com")
    created = await _create(client, headers_admin)
    gathering_id = created["id"]
    headers_guest = await _signed_in_headers(client, capsys, "guest@example.com")

    # Idempotent: a re-click lands on already_accepted with the gathering id
    # — never a 500 — and no second invitation row appears.
    token = await _invite_token(client, capsys, headers_admin, gathering_id, "guest@example.com")
    assert (await _accept(client, headers_guest, token))["status"] == "accepted"
    result = await _accept(client, headers_guest, token)
    assert result == {"status": "already_accepted", "gathering_id": gathering_id}
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(GatheringInvitation))
        ) == 1

    # Consumed by someone ELSE: the token is spent, and it points nowhere.
    headers_other = await _signed_in_headers(client, capsys, "other@example.com")
    assert (await _accept(client, headers_other, token)) == {
        "status": "used",
        "gathering_id": None,
    }

    # Expired: distinguished from invalid and from used.
    expired_token = await _invite_token(
        client, capsys, headers_admin, gathering_id, "late@example.com"
    )
    async with db_session_factory() as db:
        row = (
            await db.execute(
                select(GatheringInvitationPending).where(
                    GatheringInvitationPending.token_hash == hash_token(expired_token)
                )
            )
        ).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    assert (await _accept(client, headers_other, expired_token))["status"] == "expired"

    # Revoked via the admin's DELETE: distinguished too.
    revoked = await _invite(client, headers_admin, gathering_id, "withdrawn@example.com")
    revoked_token = INVITE_LINK_RE.search(capsys.readouterr().out).group(1)
    assert (
        await client.delete(
            f"/invitations/pending/{revoked.json()['id']}", headers=headers_admin
        )
    ).status_code == 204
    assert (await _accept(client, headers_other, revoked_token))["status"] == "revoked"

    # Garbage: invalid.
    assert (await _accept(client, headers_other, "not-a-token"))["status"] == "invalid"


async def test_second_invitation_for_the_same_person_does_not_500(
    client, capsys, db_session_factory
):
    # The partial unique index allows one person-targeted invitation per
    # (gathering, person). Someone invited twice — two addresses they own —
    # accepts both links; the second lands on already_accepted, never an
    # IntegrityError-turned-500.
    headers_admin = await _signed_in_headers(client, capsys, "planner@example.com")
    created = await _create(client, headers_admin)
    token_home = await _invite_token(client, capsys, headers_admin, created["id"], "home@example.com")
    token_work = await _invite_token(client, capsys, headers_admin, created["id"], "work@example.com")

    headers_guest = await _signed_in_headers(client, capsys, "home@example.com")
    assert (await _accept(client, headers_guest, token_home))["status"] == "accepted"
    result = await _accept(client, headers_guest, token_work)
    assert result == {"status": "already_accepted", "gathering_id": created["id"]}
    async with db_session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(GatheringInvitation))
        ) == 1
        # Both tokens are spent: the second acceptance still consumed its row.
        consumed = (
            await db.scalars(
                select(GatheringInvitationPending.consumed_at)
            )
        ).all()
        assert all(stamp is not None for stamp in consumed)


async def test_admin_list_shows_pending_and_accepted_without_addresses(
    client, capsys, db_session_factory
):
    headers_admin = await _signed_in_headers(client, capsys, "lister@example.com")
    created = await _create(client, headers_admin)
    await _invite(client, headers_admin, created["id"], "waiting@example.com")
    token = await _invite_token(client, capsys, headers_admin, created["id"], "joiner@example.com")

    headers_guest = await _signed_in_headers(client, capsys, "joiner@example.com")
    await _accept(client, headers_guest, token)
    # The accepted person's display name is what the admin sees.
    display = await client.get("/auth/me", headers=headers_guest)
    display_name = display.json()["display_name"]

    response = await client.get(f"/gatherings/{created['id']}/invitations", headers=headers_admin)
    assert response.status_code == 200
    body = response.json()
    assert [p["destination"] for p in body["pending"]] == ["waiting@example.com"]
    assert set(body["pending"][0]) == {"id", "channel", "destination", "created_at", "expires_at"}
    assert [a["display_name"] for a in body["accepted"]] == [display_name]
    # An account email is a credential: the accepted entry carries the display
    # name and nothing else identifying (the no-auto-exposure rule).
    assert set(body["accepted"][0]) == {"id", "display_name", "accepted_at"}


async def test_revoke_is_idempotent_and_a_consumed_invite_is_not_pending(
    client, capsys, db_session_factory
):
    headers_admin = await _signed_in_headers(client, capsys, "revoker@example.com")
    created = await _create(client, headers_admin)
    pending = (await _invite(client, headers_admin, created["id"], "outcast@example.com")).json()

    assert (
        await client.delete(f"/invitations/pending/{pending['id']}", headers=headers_admin)
    ).status_code == 204
    # Stamped, never deleted — the row keeps feeding the rate tally until the
    # reaper takes it an hour past the forced expiry.
    async with db_session_factory() as db:
        row = (
            await db.execute(select(GatheringInvitationPending))
        ).scalars().one()
        assert row.revoked_at is not None
        assert row.expires_at <= datetime.now(timezone.utc)
    # Revoking again: still a 204 (idempotent), still one row.
    assert (
        await client.delete(f"/invitations/pending/{pending['id']}", headers=headers_admin)
    ).status_code == 204

    # A consumed invitation is not pending: its DELETE is the uniform 404.
    token = await _invite_token(client, capsys, headers_admin, created["id"], "settled@example.com")
    headers_guest = await _signed_in_headers(client, capsys, "settled@example.com")
    accepted_pending_id = None
    async with db_session_factory() as db:
        accepted_pending_id = str(
            (
                await db.execute(
                    select(GatheringInvitationPending.id).where(
                        GatheringInvitationPending.token_hash == hash_token(token)
                    )
                )
            ).scalars().one()
        )
    await _accept(client, headers_guest, token)
    assert (
        await client.delete(
            f"/invitations/pending/{accepted_pending_id}", headers=headers_admin
        )
    ).status_code == 404


async def test_preview_is_unauthenticated_and_distinguishes_states(
    client, capsys, db_session_factory
):
    headers_admin = await _signed_in_headers(client, capsys, "previewer@example.com")
    created = await _create(client, headers_admin, title="Sunday potluck")
    token = await _invite_token(client, capsys, headers_admin, created["id"], "curious@example.com")

    # Valid: the title renders on the acceptance screen — the same context the
    # invitation email already carried, disclosed only to the token's holder.
    response = await client.post("/invitations/preview", json={"token": token})
    assert response.status_code == 200
    assert response.json() == {"status": "valid", "gathering_title": "Sunday potluck"}

    # Expired.
    async with db_session_factory() as db:
        row = (
            await db.execute(select(GatheringInvitationPending))
        ).scalars().one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
    response = await client.post("/invitations/preview", json={"token": token})
    assert response.json() == {"status": "expired", "gathering_title": None}

    # Used (accepted before expiry elsewhere): reset expiry, accept, preview.
    async with db_session_factory() as db:
        row = (
            await db.execute(select(GatheringInvitationPending))
        ).scalars().one()
        row.expires_at = datetime.now(timezone.utc) + timedelta(days=1)
        await db.commit()
    headers_guest = await _signed_in_headers(client, capsys, "curious@example.com")
    await _accept(client, headers_guest, token)
    response = await client.post("/invitations/preview", json={"token": token})
    assert response.json() == {"status": "used", "gathering_title": None}

    # Revoked and invalid.
    revoked = await _invite(client, headers_admin, created["id"], "second@example.com")
    revoked_token = INVITE_LINK_RE.search(capsys.readouterr().out).group(1)
    await client.delete(f"/invitations/pending/{revoked.json()['id']}", headers=headers_admin)
    response = await client.post("/invitations/preview", json={"token": revoked_token})
    assert response.json() == {"status": "revoked", "gathering_title": None}
    response = await client.post("/invitations/preview", json={"token": "garbage"})
    assert response.json() == {"status": "invalid", "gathering_title": None}


async def test_reaper_purges_stale_pending_rows_and_spares_recent_ones(
    client, capsys, db_session_factory
):
    # purge_stale's fourth customer: rows more than PURGE_GRACE past expiry go
    # when the next invitation is created; consumed-but-recent rows stay (the
    # purge keys off expires_at, never consumed_at — the CK-24 invariant).
    headers_admin = await _signed_in_headers(client, capsys, "curator@example.com")
    created = await _create(client, headers_admin)
    await _invite(client, headers_admin, created["id"], "stale@example.com")
    token = await _invite_token(client, capsys, headers_admin, created["id"], "fresh@example.com")

    headers_guest = await _signed_in_headers(client, capsys, "fresh@example.com")
    await _accept(client, headers_guest, token)

    async with db_session_factory() as db:
        stale = (
            await db.execute(
                select(GatheringInvitationPending).where(
                    GatheringInvitationPending.destination == "stale@example.com"
                )
            )
        ).scalars().one()
        stale.expires_at = datetime.now(timezone.utc) - PURGE_GRACE - timedelta(minutes=1)
        await db.commit()

    # The next create reaps: the aged row goes, the consumed-but-recent row
    # (its expires_at still days out) survives.
    assert (
        await _invite(client, headers_admin, created["id"], "another@example.com")
    ).status_code == 201
    async with db_session_factory() as db:
        destinations = set(
            (await db.scalars(select(GatheringInvitationPending.destination))).all()
        )
        assert "stale@example.com" not in destinations
        assert {"fresh@example.com", "another@example.com"} <= destinations
