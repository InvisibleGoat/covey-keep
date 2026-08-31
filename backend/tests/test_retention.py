"""The ephemeral-data reaper (CK-24): services/retention.py and its three
live customers.

The whole phase turns on one constraint — the purge keys off expires_at,
never consumed_at, and PURGE_GRACE exceeds RATE_WINDOW. The rate limits on
/auth/request-link and /me/email-change count rows by created_at whether or
not a row was consumed or superseded, so a purge that ran any sooner would
erase the tally and silently disable the limits. The tests here pin the
constant, the mechanism, the limit surviving a purge, and (one per customer)
that each endpoint actually calls it.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import func, select

from app.api.auth import MAX_REQUESTS_PER_EMAIL, RATE_WINDOW
from app.api.profile import EMAIL_CHANGE_TOKEN_TTL
from app.models import EmailChangeRequest, MagicLinkToken, Person, Session, WebauthnChallenge
from app.services.retention import PURGE_GRACE, purge_stale
from tests.test_auth import _request_link, _sign_in
from tests.test_email_change import _capture_change_link, _request_change, _signed_in_headers


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _magic_link_row(*, expires_at: datetime, email: str = "reaped@example.com") -> MagicLinkToken:
    return MagicLinkToken(
        email=email,
        token_hash=f"hash-{uuid4().hex}",
        expires_at=expires_at,
        tos_version=1,
    )


async def _count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


# --- The invariant -----------------------------------------------------------


def test_purge_grace_exceeds_rate_window():
    # The property a future tuning change must not break: the rate limits
    # tally rows by created_at over RATE_WINDOW regardless of consumption, so
    # any row the purge removes must already be outside every window that
    # could still count it. Strictly greater — equal would race the edge.
    assert PURGE_GRACE > RATE_WINDOW


# --- The mechanism -----------------------------------------------------------


async def test_purge_keys_off_expiry_age(db_session_factory):
    now = _now()
    async with db_session_factory() as db:
        db.add_all(
            [
                # Expired more than the grace ago: gone.
                _magic_link_row(expires_at=now - PURGE_GRACE - timedelta(minutes=1)),
                # Expired, but inside the grace: survives — a rate-limit
                # window may still be counting it.
                _magic_link_row(expires_at=now - timedelta(minutes=5)),
                # Live: survives.
                _magic_link_row(expires_at=now + timedelta(minutes=10)),
            ]
        )
        await db.commit()

        removed = await purge_stale(db, MagicLinkToken, MagicLinkToken.expires_at, now)
        await db.commit()
        assert removed == 1
        remaining = (await db.execute(select(MagicLinkToken.expires_at))).scalars().all()
        assert len(remaining) == 2
        assert all(expires_at >= now - PURGE_GRACE for expires_at in remaining)


async def test_consumed_but_recent_row_survives(client, capsys, db_session_factory):
    # Consumption is NOT the trigger. A consumed row is still a tally against
    # the rate limit for the rest of its window.
    await _sign_in(client, capsys, "prompt@example.com")
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert row.consumed_at is not None
        removed = await purge_stale(db, MagicLinkToken, MagicLinkToken.expires_at, _now())
        await db.commit()
        assert removed == 0
        assert await _count(db, MagicLinkToken) == 1


async def test_rate_limit_survives_a_purge(client, capsys, db_session_factory):
    # THE regression this phase exists to prevent. Five requests leave five
    # rows inside RATE_WINDOW — four of them superseded (expires_at forced to
    # now by the request that followed) and none consumed. A purge keyed off
    # consumption, or one whose grace was shorter than the window, would
    # remove the superseded rows and the sixth request would sail through.
    address = "insistent@example.com"
    for _ in range(MAX_REQUESTS_PER_EMAIL):
        assert (await _request_link(client, address)).status_code == 202
    async with db_session_factory() as db:
        assert await _count(db, MagicLinkToken) == MAX_REQUESTS_PER_EMAIL
        superseded = await db.scalar(
            select(func.count())
            .select_from(MagicLinkToken)
            .where(MagicLinkToken.expires_at <= _now())
        )
        assert superseded == MAX_REQUESTS_PER_EMAIL - 1
        removed = await purge_stale(db, MagicLinkToken, MagicLinkToken.expires_at, _now())
        await db.commit()
        assert removed == 0
        assert await _count(db, MagicLinkToken) == MAX_REQUESTS_PER_EMAIL
    assert (await _request_link(client, address)).status_code == 429


async def test_a_grace_inside_the_rate_window_would_erase_the_tally(
    client, capsys, db_session_factory
):
    # The counter-example that shows the invariant is load-bearing: with no
    # grace ("delete expired rows immediately") the superseded rows vanish and
    # the limit never accumulates — and supersession needs no inbox access,
    # just another request. This is why PURGE_GRACE must exceed RATE_WINDOW.
    address = "evasive@example.com"
    for _ in range(MAX_REQUESTS_PER_EMAIL):
        assert (await _request_link(client, address)).status_code == 202
    async with db_session_factory() as db:
        removed = await purge_stale(
            db, MagicLinkToken, MagicLinkToken.expires_at, _now(), grace=timedelta(0)
        )
        await db.rollback()  # demonstrate the failure; never keep it
        assert removed == MAX_REQUESTS_PER_EMAIL - 1


# --- Email-change rows -------------------------------------------------------


async def test_superseded_email_change_request_purged_after_grace_not_before(
    client, capsys, db_session_factory
):
    # Supersede forces expires_at to now (CK-9). The row must survive the
    # grace — it is a rate-limit tally — and go once the grace has passed,
    # while the live request that superseded it stays.
    headers = await _signed_in_headers(client, capsys, "restless@example.com")
    await _capture_change_link(client, capsys, headers, "first@example.com")
    superseded_after = _now()
    await _capture_change_link(client, capsys, headers, "second@example.com")
    async with db_session_factory() as db:
        assert await _count(db, EmailChangeRequest) == 2
        removed = await purge_stale(db, EmailChangeRequest, EmailChangeRequest.expires_at, _now())
        assert removed == 0

        later = superseded_after + PURGE_GRACE + timedelta(minutes=5)
        removed = await purge_stale(db, EmailChangeRequest, EmailChangeRequest.expires_at, later)
        await db.commit()
        assert removed == 1
        survivor = (await db.execute(select(EmailChangeRequest))).scalars().one()
        assert survivor.expires_at > later - PURGE_GRACE


async def test_third_party_address_request_purged_on_the_same_schedule(
    client, capsys, db_session_factory
):
    # The case that made this a privacy defect rather than a tidy-up: a
    # request to change TO an address someone else holds writes a row (the
    # rate limit must not diverge between free and taken) carrying a third
    # party's address, supplied by someone who does not control it. It gets
    # no special path — purged exactly like any other request: after the
    # grace, never before.
    headers = await _signed_in_headers(client, capsys, "prober@example.com")
    await _sign_in(client, capsys, "holder@example.com")
    requested_after = _now()
    assert (await _request_change(client, headers, "holder@example.com")).status_code == 202
    async with db_session_factory() as db:
        assert await _count(db, EmailChangeRequest) == 1
        removed = await purge_stale(db, EmailChangeRequest, EmailChangeRequest.expires_at, _now())
        assert removed == 0

        later = requested_after + EMAIL_CHANGE_TOKEN_TTL + PURGE_GRACE + timedelta(minutes=5)
        removed = await purge_stale(db, EmailChangeRequest, EmailChangeRequest.expires_at, later)
        await db.commit()
        assert removed == 1
        assert await _count(db, EmailChangeRequest) == 0


# --- Wiring: each customer reaps on the request that writes its table --------


async def test_request_link_reaps_stale_magic_link_rows(client, db_session_factory):
    async with db_session_factory() as db:
        db.add(
            _magic_link_row(
                expires_at=_now() - PURGE_GRACE - timedelta(minutes=1), email="stale@example.com"
            )
        )
        await db.commit()
    assert (await _request_link(client, "fresh@example.com")).status_code == 202
    async with db_session_factory() as db:
        row = (await db.execute(select(MagicLinkToken))).scalars().one()
        assert row.expires_at > _now()


async def test_email_change_request_reaps_stale_rows(client, capsys, db_session_factory):
    headers = await _signed_in_headers(client, capsys, "tidy@example.com")
    async with db_session_factory() as db:
        person = (await db.execute(select(Person))).scalars().one()
        session = (await db.execute(select(Session))).scalars().one()
        db.add(
            EmailChangeRequest(
                person_id=person.id,
                requested_session_id=session.id,
                new_email="old-request@example.com",
                token_hash=f"hash-{uuid4().hex}",
                expires_at=_now() - PURGE_GRACE - timedelta(minutes=1),
            )
        )
        await db.commit()
    assert (await _request_change(client, headers, "new-request@example.com")).status_code == 202
    async with db_session_factory() as db:
        row = (await db.execute(select(EmailChangeRequest))).scalars().one()
        assert row.expires_at > _now()


async def test_passkey_begin_reaps_stale_challenges(client, db_session_factory):
    # The pre-existing purge, now on the shared mechanism — same semantics.
    async with db_session_factory() as db:
        db.add(
            WebauthnChallenge(
                challenge="stale-challenge",
                purpose="authenticate",
                expires_at=_now() - PURGE_GRACE - timedelta(minutes=1),
            )
        )
        await db.commit()
    assert (await client.post("/auth/passkey/begin", json={})).status_code == 200
    async with db_session_factory() as db:
        row = (await db.execute(select(WebauthnChallenge))).scalars().one()
        assert row.expires_at > _now()
