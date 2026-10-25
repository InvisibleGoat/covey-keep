"""CK-77.1 — the race backstops survive their own rollback.

Several routes guard one race the same way: check whether the row exists,
write it, and if the commit hits an IntegrityError because a concurrent
request committed the same row first, roll back and answer the idempotent
outcome. Two things made every one of them answer 500 instead:

- AFTER `db.rollback()` EVERY OBJECT THE SESSION HOLDS IS EXPIRED, and
  reading any attribute of an expired object on an async session raises
  `MissingGreenlet` — its id included, and `expire_on_commit=False`
  notwithstanding (that setting governs commits; a rollback always
  expires). `ctx.person` lives in the request's session (FastAPI caches
  `get_db` per request), so it expires too.
- AUTOFLUSH RAISES THE CONFLICT AT THE NEXT `execute`, wherever the `try`
  sits: a route that adds its row and then runs a `delete` or an `INSERT …
  SELECT` before its commit meets the unique violation at that statement,
  outside a `try` that wraps only `db.commit()` — the 500 the deploy showed
  on 2026-10-25 (`pk_gathering_member_places`, `put_place`).

EVERY RACE HERE IS STAGED, NEVER TIMED: the competing write is committed
from a SECOND session at one moment of the route's own transaction — right
after the route's existence check has read the state (so its check reads
nothing), and before the route's own write is flushed (so the competitor's
insert never waits on the route's uncommitted row — staged at the commit
the two would deadlock, and the autoflush defect would never show). The
moment is hooked on the route's own statements (`_stage`): AFTER the
existence check's SELECT returns, or BEFORE the first DML statement whose
autoflush would carry the route's write. Each test asserts the hook fired,
so none passes vacuously.

Red first against CK-77's code (2026-10-25): each test failed on exactly
its defect — the escaped `IntegrityError` (`UniqueViolationError`) for the
three autoflush sites, `MissingGreenlet` after the rollback for the other
three (the report records each).
"""

import logging
import re
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Delete, Insert, Select, Update

from app.models import (
    RSVP,
    Gathering,
    GatheringInvitation,
    GatheringInvitationPending,
    GatheringMemberPlace,
    GroupInvitationPending,
    GroupJoinRequest,
    MemberPlace,
    Membership,
    RSVPCompanion,
    RSVPResponse,
)
from app.services.groups import invite_newcomer_to_upcoming_gatherings
from tests.test_billing import (
    _account,
    _plant_customer,
    _plant_subscription,
    _post_event,
    _records,
    _stub_fetch,
    _subscription_object,
    _subscription_rows,
)
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_links import _approve, _join, _make, _request_rows, _requests, _token_of
from tests.test_group_membership import ADMIN, CO_ADMIN, MEMBER, _add_member, _cast, _person_id
from tests.test_invitations import _invite_token
from tests.test_rsvps import RSVP_YES, _gathering_with_invitee, _put_rsvp

PLACE_TABLES = ("gathering_member_places", "gathering_invitations")


# --- staging a race ---------------------------------------------------------------


def _sql(statement) -> str:
    return str(statement.compile(dialect=postgresql.dialect()))


def _dml_on(*tables: str):
    """The first INSERT, UPDATE or DELETE the route issues against one of
    `tables` — the statement whose autoflush carries the route's own
    pending write (the hook runs BEFORE it)."""

    def when(statement) -> bool:
        table = getattr(statement, "table", None)
        return isinstance(statement, (Insert, Update, Delete)) and getattr(table, "name", None) in tables

    return when


def _select_from(table: str, *, containing: str = ""):
    """A SELECT whose FROM names `table` exactly (`gathering_invitations`
    never matches `gathering_invitations_pending`), optionally carrying
    `containing` — the route's existence check (the hook runs AFTER it)."""
    pattern = re.compile(r"\bFROM " + re.escape(table) + r"\b")

    def when(statement) -> bool:
        if not isinstance(statement, Select):
            return False
        sql = _sql(statement)
        return bool(pattern.search(sql)) and containing in sql

    return when


def _stage(monkeypatch, *, when, competitor, before: bool = False) -> dict:
    """Arm `competitor` — a coroutine function that commits from a SECOND
    session — to run exactly once, at the first statement of the route's
    session for which `when(statement)` holds: AFTER that statement returns
    (default — the route's existence check has read the state before the
    competitor existed), or BEFORE it runs (`before=True` — the statement
    whose autoflush would carry the route's write). `AsyncSession.scalar`
    does not go through `AsyncSession.execute`, so both are wrapped. The
    state is disarmed before the competitor runs, so the competitor's own
    statements never re-enter the hook."""
    state = {"fired": False}
    real_execute = AsyncSession.execute
    real_scalar = AsyncSession.scalar

    def wrap(real):
        async def wrapped(self, statement, *args, **kwargs):
            armed = not state["fired"] and when(statement)
            if armed and before:
                state["fired"] = True
                await competitor()
            result = await real(self, statement, *args, **kwargs)
            if armed and not before:
                state["fired"] = True
                await competitor()
            return result

        return wrapped

    monkeypatch.setattr(AsyncSession, "execute", wrap(real_execute))
    monkeypatch.setattr(AsyncSession, "scalar", wrap(real_scalar))
    return state


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _place_row(db_session_factory, gathering_id: str, person_id: UUID):
    async with db_session_factory() as db:
        return (
            await db.execute(
                select(GatheringMemberPlace.place, GatheringMemberPlace.set_by_person_id).where(
                    GatheringMemberPlace.gathering_id == UUID(gathering_id),
                    GatheringMemberPlace.person_id == person_id,
                )
            )
        ).all()


async def _invitation_row(db_session_factory, gathering_id: str, person_id: UUID):
    async with db_session_factory() as db:
        return (
            await db.execute(
                select(GatheringInvitation.invited_by_person_id).where(
                    GatheringInvitation.gathering_id == UUID(gathering_id),
                    GatheringInvitation.person_id == person_id,
                )
            )
        ).all()


async def _chosen(db_session_factory, gathering_id: str) -> bool:
    async with db_session_factory() as db:
        return await db.scalar(select(Gathering.invitees_chosen).where(Gathering.id == UUID(gathering_id)))


async def _membership_count(db_session_factory, group_id: str, person_id: UUID) -> int:
    async with db_session_factory() as db:
        return await db.scalar(
            select(func.count())
            .select_from(Membership)
            .where(Membership.group_id == UUID(group_id), Membership.person_id == person_id)
        )


async def _group_pending_consumed(db_session_factory) -> list[bool]:
    async with db_session_factory() as db:
        return [c is not None for c in (await db.scalars(select(GroupInvitationPending.consumed_at))).all()]


async def _gathering_pending_consumed(db_session_factory) -> list[bool]:
    async with db_session_factory() as db:
        return [c is not None for c in (await db.scalars(select(GatheringInvitationPending.consumed_at))).all()]


# --- PUT /gatherings/{id}/places/{membership_id} — broken twice ----------------------


async def test_two_organisers_placing_a_member_at_once_both_read_the_place_that_holds(
    client, capsys, db_session_factory, monkeypatch
):
    """The deploy's reproduction (2026-10-25): two identical first-time
    moves to `shared_with` for a member with NO place row answered 200 and
    500 — the primary key violation raised at the `delete` that autoflushed
    the add, outside the `try`. Staged: the co-admin's move commits from a
    second session after the member's route has checked and before its
    first write lands; the member's route answers 200 with the place that
    holds, one place row, no invitation row, `invitees_chosen` true."""
    cast = await _cast(client, capsys, db_session_factory)
    await _signed_in_headers(client, capsys, "e@example.com")
    e_membership = await _add_member(db_session_factory, cast.group_id, "e@example.com")
    e_person = await _person_id(db_session_factory, "e@example.com")
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    created = await _create_in_group(client, cast.member, cast.group_id)
    gathering_id = created["id"]
    assert await _invitation_row(db_session_factory, gathering_id, e_person)  # invited by the rule

    async def competitor() -> None:
        # Another organiser's identical move, committed first.
        async with db_session_factory() as db:
            await db.execute(
                pg_insert(GatheringMemberPlace).values(
                    gathering_id=UUID(gathering_id),
                    person_id=e_person,
                    place=MemberPlace.SHARED_WITH,
                    set_by_person_id=co_admin_person,
                )
            )
            await db.execute(
                delete(GatheringInvitation).where(
                    GatheringInvitation.gathering_id == UUID(gathering_id),
                    GatheringInvitation.person_id == e_person,
                )
            )
            await db.execute(
                update(Gathering).where(Gathering.id == UUID(gathering_id)).values(invitees_chosen=True)
            )
            await db.commit()

    staged = _stage(monkeypatch, when=_dml_on(*PLACE_TABLES), competitor=competitor, before=True)
    response = await client.put(
        f"/gatherings/{gathering_id}/places/{e_membership}", json={"place": "shared_with"}, headers=cast.member
    )
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    assert response.json()["membership_id"] == e_membership
    assert response.json()["place"] == "shared_with"
    # The state that holds: one place row — the competitor's — and no invitation row.
    assert await _place_row(db_session_factory, gathering_id, e_person) == [(MemberPlace.SHARED_WITH, co_admin_person)]
    assert await _invitation_row(db_session_factory, gathering_id, e_person) == []
    assert await _chosen(db_session_factory, gathering_id) is True
    # And the list agrees.
    listed = await client.get(f"/gatherings/{gathering_id}/places", headers=cast.member)
    assert {e["membership_id"]: e["place"] for e in listed.json()["members"]}[e_membership] == "shared_with"


async def test_two_organisers_inviting_a_placed_member_at_once_both_read_invited(
    client, capsys, db_session_factory, monkeypatch
):
    """The other branch: a member holding a `shared_with` row is moved back
    to `invited` by two organisers at once — the partial unique on the
    person target held for the competitor, and the route's add was
    autoflushed by its `delete` of the place row. Staged the same way; the
    route answers 200 `invited`, one invitation row (the competitor's), no
    place row, `invitees_chosen` still true (once chosen, chosen)."""
    cast = await _cast(client, capsys, db_session_factory)
    await _signed_in_headers(client, capsys, "e@example.com")
    e_membership = await _add_member(db_session_factory, cast.group_id, "e@example.com")
    e_person = await _person_id(db_session_factory, "e@example.com")
    co_admin_person = await _person_id(db_session_factory, CO_ADMIN)
    created = await _create_in_group(client, cast.member, cast.group_id)
    gathering_id = created["id"]
    moved = await client.put(
        f"/gatherings/{gathering_id}/places/{e_membership}", json={"place": "shared_with"}, headers=cast.member
    )
    assert moved.status_code == 200, moved.text
    assert await _place_row(db_session_factory, gathering_id, e_person)

    async def competitor() -> None:
        async with db_session_factory() as db:
            await db.execute(
                pg_insert(GatheringInvitation).values(
                    gathering_id=UUID(gathering_id), person_id=e_person, invited_by_person_id=co_admin_person
                )
            )
            await db.execute(
                delete(GatheringMemberPlace).where(
                    GatheringMemberPlace.gathering_id == UUID(gathering_id),
                    GatheringMemberPlace.person_id == e_person,
                )
            )
            await db.commit()

    staged = _stage(monkeypatch, when=_dml_on(*PLACE_TABLES), competitor=competitor, before=True)
    response = await client.put(
        f"/gatherings/{gathering_id}/places/{e_membership}", json={"place": "invited"}, headers=cast.member
    )
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    assert response.json()["place"] == "invited"
    assert await _invitation_row(db_session_factory, gathering_id, e_person) == [(co_admin_person,)]
    assert await _place_row(db_session_factory, gathering_id, e_person) == []
    assert await _chosen(db_session_factory, gathering_id) is True


# --- POST /invitations/accept — MissingGreenlet after the rollback -------------------


async def test_an_invitation_accepted_twice_at_once_answers_already_accepted_and_consumes_the_token(
    client, capsys, db_session_factory, monkeypatch
):
    """A double tap on a slow phone: the second accept's existence check
    reads no invitation row, the first's lands (staged from a second
    session), the second's commit meets the partial unique and rolls
    back — and must answer `already_accepted` with the gathering id, the
    token consumed, from values captured before the write, never from the
    expired pending row."""
    host = await _signed_in_headers(client, capsys, "host@example.com")
    created = await _create(client, host)
    gathering_id = created["id"]
    token = await _invite_token(client, capsys, host, gathering_id, "guest@example.com")
    guest = await _signed_in_headers(client, capsys, "guest@example.com")
    guest_person = await _person_id(db_session_factory, "guest@example.com")
    host_person = await _person_id(db_session_factory, "host@example.com")

    async def competitor() -> None:
        async with db_session_factory() as db:
            db.add(
                GatheringInvitation(
                    gathering_id=UUID(gathering_id), person_id=guest_person, invited_by_person_id=host_person
                )
            )
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("gathering_invitations"), competitor=competitor)
    response = await client.post("/invitations/accept", json={"token": token}, headers=guest)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "already_accepted", "gathering_id": gathering_id}
    assert await _invitation_row(db_session_factory, gathering_id, guest_person) == [(host_person,)]
    assert await _gathering_pending_consumed(db_session_factory) == [True]


# --- POST /group-invitations/accept — broken twice ---------------------------------


async def test_a_group_invitation_accepted_twice_at_once_answers_already_accepted_and_consumes_the_token(
    client, capsys, db_session_factory, monkeypatch
):
    """The second accept's `_is_member` check reads no membership; the
    first's lands — the membership AND the newcomer's places, exactly as
    the route writes them — from a second session; the second's membership
    add is autoflushed by the newcomer helper's first INSERT … SELECT and
    meets the memberships UNIQUE there, outside a `try` that wrapped only
    the commit. Fixed: caught, rolled back, the token consumed by its
    captured id, `already_accepted` with the group id; one membership; the
    newcomer's one invitation row on the upcoming gathering."""
    cast = await _cast(client, capsys, db_session_factory)
    upcoming = await _create_in_group(client, cast.admin, cast.group_id)
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, "newcomer@example.com")
    newcomer = await _signed_in_headers(client, capsys, "newcomer@example.com")
    newcomer_person = await _person_id(db_session_factory, "newcomer@example.com")

    async def competitor() -> None:
        async with db_session_factory() as db:
            db.add(Membership(group_id=UUID(cast.group_id), person_id=newcomer_person))
            await invite_newcomer_to_upcoming_gatherings(
                db, group_id=UUID(cast.group_id), person_id=newcomer_person, now=_now()
            )
            await db.commit()

    staged = _stage(
        monkeypatch,
        when=_select_from("memberships", containing="memberships.person_id ="),
        competitor=competitor,
    )
    response = await client.post("/group-invitations/accept", json={"token": token}, headers=newcomer)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "already_accepted", "group_id": cast.group_id}
    assert await _membership_count(db_session_factory, cast.group_id, newcomer_person) == 1
    assert await _invitation_row(db_session_factory, upcoming["id"], newcomer_person) == [(None,)]
    assert await _group_pending_consumed(db_session_factory) == [True]


# --- the join approve racing an acceptance — broken twice --------------------------


async def test_an_approval_racing_an_acceptance_lets_the_decision_stand(
    client, capsys, db_session_factory, monkeypatch
):
    """The admin approves A's request while A's emailed acceptance lands
    (staged after the approve's membership check): the approve's membership
    add is autoflushed by the newcomer helper and meets the UNIQUE outside
    the `try`. Fixed: caught, rolled back, the decision re-applied with the
    approver's id captured before the write — 200 with the decision's body,
    the request decided by the admin, one membership."""
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    a_person = await _person_id(db_session_factory, "a@example.com")
    admin_person = await _person_id(db_session_factory, ADMIN)
    assert (await _join(client, a, token)).json()["status"] == "requested"
    (entry,) = (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]
    request_id = entry["id"]

    async def competitor() -> None:
        async with db_session_factory() as db:
            db.add(Membership(group_id=UUID(cast.group_id), person_id=a_person))
            await invite_newcomer_to_upcoming_gatherings(
                db, group_id=UUID(cast.group_id), person_id=a_person, now=_now()
            )
            await db.commit()

    staged = _stage(
        monkeypatch,
        when=_select_from("memberships", containing="memberships.person_id ="),
        competitor=competitor,
    )
    response = await _approve(client, cast.admin, cast.group_id, request_id)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    assert response.json()["id"] == request_id and response.json()["outcome"] == "approved"
    assert set(response.json()) == {"id", "display_name", "created_at", "outcome", "decided_at"}
    (request,) = await _request_rows(db_session_factory, cast.group_id)
    assert request.decided_at is not None and request.outcome.value == "approved"
    assert request.decided_by_person_id == admin_person
    assert await _membership_count(db_session_factory, cast.group_id, a_person) == 1
    async with db_session_factory() as db:
        assert (await db.get(GroupJoinRequest, UUID(request_id))).decided_at is not None


# --- PUT /occurrences/{id}/rsvp — MissingGreenlet after the rollback --------------


async def test_two_first_time_rsvps_at_once_apply_the_second_as_the_update(
    client, capsys, db_session_factory, monkeypatch
):
    """The second submission's existence check reads no row; the first's
    lands from a second session; the second's flush meets the partial
    unique inside the `try` and rolls back — and must then re-read by the
    path's occurrence id and the caller's person id captured before the
    write, never through the expired occurrence or `ctx.person`. 200, the
    request applied as the update: one row carrying this request's answer,
    `updated_at` stamped."""
    _, invitee, created = await _gathering_with_invitee(client, capsys, "host@example.com", "cousin@example.com")
    occurrence_id = created["occurrences"][0]["id"]
    cousin_person = await _person_id(db_session_factory, "cousin@example.com")

    async def competitor() -> None:
        async with db_session_factory() as db:
            db.add(RSVP(occurrence_id=UUID(occurrence_id), person_id=cousin_person, response=RSVPResponse.NO))
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("rsvps"), competitor=competitor)
    response = await _put_rsvp(client, invitee, occurrence_id, RSVP_YES)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["response"] == "yes" and body["companions"] == RSVP_YES["companions"]
    assert body["updated_at"] is not None  # applied as the update it would have been
    async with db_session_factory() as db:
        rows = (
            await db.execute(
                select(RSVP).where(RSVP.occurrence_id == UUID(occurrence_id), RSVP.person_id == cousin_person)
            )
        ).scalars().all()
        assert len(rows) == 1 and rows[0].response is RSVPResponse.YES and rows[0].updated_at is not None
        companions = (
            await db.scalars(
                select(RSVPCompanion.name).where(RSVPCompanion.rsvp_id == rows[0].id).order_by(RSVPCompanion.position)
            )
        ).all()
        assert companions == RSVP_YES["companions"]


# --- the webhook's upsert — MissingGreenlet after the rollback ----------------------


async def test_two_paid_subscriptions_flushed_at_once_log_both_ids_and_write_nothing(
    client, capsys, db_session_factory, monkeypatch, caplog
):
    """The race the pre-check cannot see: a second paid subscription for
    the account commits (staged) after `_other_paid_subscription` found
    none and before this event's row is flushed; the flush meets the
    partial unique inside the `try` and rolls back — and the backstop must
    name both ids from the account id captured before the write, never
    through the expired customer row. One ERROR line naming both
    subscription ids and the event id, nothing written, the webhook 200."""
    address = "double@example.com"
    await _signed_in_headers(client, capsys, address)
    async with db_session_factory() as db:
        account = await _account(db, address)
    await _plant_customer(db_session_factory, account.id)
    _stub_fetch(monkeypatch, _subscription_object(subscription_id="sub_second", status="active"))

    async def competitor() -> None:
        await _plant_subscription(db_session_factory, account.id, subscription_id="sub_first")

    staged = _stage(
        monkeypatch,
        when=_select_from("subscriptions", containing="subscriptions.provider_subscription_id = "),
        competitor=competitor,
    )
    with caplog.at_level(logging.DEBUG):
        response = await _post_event(
            client, "customer.subscription.created", {"id": "sub_second", "object": "subscription"}, event_id="evt_race"
        )
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 200, response.text
    rows = await _subscription_rows(db_session_factory)
    assert [r.provider_subscription_id for r in rows] == ["sub_first"]
    errors = [r for r in _records(caplog) if r.levelno == logging.ERROR]
    assert len(errors) == 1
    message = errors[0].getMessage()
    assert "sub_first" in message and "sub_second" in message and "evt_race" in message
