"""CK-77.2 — two requests at once get one answer: the link, the invitations,
the tags and the sign-in.

CK-77.1's enumeration found five writes a duplicate request can make
conflict on a unique key with NO backstop at all, each answering 500 to the
second of two identical requests that really collide — and the planning
session found a sixth reading the sign-in handler: one link opened twice at
once was redeemed twice. Under READ COMMITTED a statement cannot see rows
another transaction has not committed when it starts, so two requests that
each "clear the old, then insert the new" each clear only what they can see
and then insert beside each other.

- `POST /groups/{id}/link`: both revoke, both insert; the second violates
  `uq_group_links_live` — fixed by an `INSERT … ON CONFLICT DO NOTHING
  RETURNING` and a read of the link that holds; both answer 201 with the
  SAME link, never a fresh one the other request revokes a moment later.
- `POST /gatherings/{id}/invitations` and `POST /groups/{id}/invitations` to
  one destination: the same on the live-destination partial uniques — the
  same fix, and the loser SENDS NOTHING (its token was never stored, so
  mailing it would send a dead link): one row, one email.
- `PATCH /media/{id}` with tags: two saves delete what each can see and
  insert beside each other — an identical list a unique violation, two
  different lists their union, `Tommy` beside `tommy` the case twin the
  verifier forbids. No `ON CONFLICT` makes a delete-then-insert atomic; only
  taking turns does, so the route locks the photograph's row
  (`_review_row`'s shape) and the second save waits, then saves its whole
  list over the first's.
- `GET /auth/verify`: two valid links for one NEW address each inserted the
  person; the second violated `people.email` at its flush — fixed by
  `INSERT … ON CONFLICT (email) DO NOTHING RETURNING`, the loser deleting the
  account row it had just inserted and signing in as the person who now
  exists; and ONE link opened twice at once was redeemed twice (the token's
  `consumed_at` assigned on a row read earlier, no guard) — fixed by a
  guarded `UPDATE … WHERE consumed_at IS NULL` with its rowcount checked,
  before the person is looked up or written: a link signs in once.

EVERY RACE HERE IS STAGED, NEVER TIMED (the CK-77.1 discipline,
`tests/test_race_backstops.py::_stage`): the competitor commits from a
SECOND session at one moment of the route's own transaction, hooked on the
route's own statements — after the supersession UPDATE for the three create
routes (the reaper's DELETE is the first DML on the same table, so the hook
is keyed on the UPDATE itself), after the token SELECT or the person SELECT
for the sign-in. The tag race needs a HELD competitor: it only happens while
the competitor's transaction is open across the route's delete, so the
competitor locks, deletes, inserts and flushes without committing, the route
runs as a task, and a third connection watches `pg_locks` for the route's
ungranted lock (or the route finishing, whichever comes first — bounded,
never a fixed sleep) before the competitor commits. Each test asserts its
staging fired, so none passes vacuously.

Red first against CK-77.1's code (2026-10-25): each test failed on exactly
its defect — the escaped `IntegrityError` (the 500) for the three creates
and the two-links sign-in, the union / the case twin for the tags, a second
session from one link for the sign-in opened twice (the report records
each).
"""

import asyncio
import secrets
import time
from datetime import datetime, timezone
from uuid import UUID

import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.sql import Insert, Update

from app.api.auth import TOKEN_TTL, TOS_VERSION
from app.api.deps import SESSION_TTL
from app.api.group_links import _link_url
from app.api.invitations import INVITATION_TTL, WITHDRAWN_MEANWHILE
from app.models import (
    Account,
    AccountKind,
    GatheringInvitationPending,
    GroupInvitationPending,
    GroupLink,
    InvitationChannel,
    MagicLinkToken,
    Media,
    MediaTag,
    Person,
    Session,
    TosAcceptance,
)
from app.security import hash_token
from tests.test_auth import ERROR_REDIRECT, TOKEN_REDIRECT_RE, _capture_link, _sign_in, _verify
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_group_invitations import _invite as _invite_to_group
from tests.test_group_links import _link_rows, _read
from tests.test_group_membership import ADMIN, _cast as _group_cast, _person_id
from tests.test_invitations import _invite
from tests.test_media_reads import _cast as _media_cast, _photograph
from tests.test_media_words import _patch, _stored_tags
from tests.test_race_backstops import _select_from, _stage

SEND_LINE = "[email] console-mode send ok to="


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dml(kind, table: str):
    """The route's first INSERT (or UPDATE) against `table` — keyed on the
    KIND, because the reaper's DELETE is the first DML on each of the three
    create routes' tables and a kind-blind predicate would fire there."""

    def when(statement) -> bool:
        return isinstance(statement, kind) and getattr(getattr(statement, "table", None), "name", None) == table

    return when


async def _count(db_session_factory, model, *criteria) -> int:
    async with db_session_factory() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*criteria))


async def _withdrawn(response) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == WITHDRAWN_MEANWHILE


# --- POST /groups/{id}/link ---------------------------------------------------------


async def test_two_links_made_at_once_both_answer_the_link_that_holds(
    client, capsys, db_session_factory, monkeypatch
):
    """Both revoke what they can see (nothing), both insert; the second
    insert used to violate `uq_group_links_live` at its commit: 500. Staged:
    the co-admin's link commits after the admin's route has revoked and
    before it inserts. The route answers 201 with the SAME link — never a
    fresh one the other request revokes a moment later — the read agrees,
    and exactly one unrevoked row stands: the competitor's."""
    cast = await _group_cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    made: dict = {}

    async def competitor() -> None:
        async with db_session_factory() as db:
            row = GroupLink(
                group_id=UUID(cast.group_id), created_by_person_id=admin_person, expires_at=_now() + INVITATION_TTL
            )
            db.add(row)
            await db.commit()
            made["id"] = row.id

    staged = _stage(monkeypatch, when=_dml(Update, "group_links"), competitor=competitor)
    response = await client.post(f"/groups/{cast.group_id}/link", headers=cast.co_admin)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 201, response.text
    assert response.json()["url"] == _link_url(made["id"])
    read = await _read(client, cast.member, cast.group_id)
    assert read.json() == response.json()
    live = [row.id for row in await _link_rows(db_session_factory, cast.group_id) if row.revoked_at is None]
    assert live == [made["id"]]


async def test_a_link_made_as_the_one_that_held_is_withdrawn_is_refused_and_never_a_500(
    client, capsys, db_session_factory, monkeypatch
):
    """The vanishingly rare window: the competitor's link lands after the
    route's revoke, and a revoke of THAT link lands after the route's
    insert returned nothing — the route's read finds no live link. It
    answers 409 `withdrawn_meanwhile` (another try makes a link), never a
    500; nothing of its own is written, and the read shows no link."""
    cast = await _group_cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)

    async def lands() -> None:
        async with db_session_factory() as db:
            db.add(
                GroupLink(
                    group_id=UUID(cast.group_id), created_by_person_id=admin_person, expires_at=_now() + INVITATION_TTL
                )
            )
            await db.commit()

    async def withdrawn() -> None:
        async with db_session_factory() as db:
            await db.execute(
                update(GroupLink)
                .where(GroupLink.group_id == UUID(cast.group_id), GroupLink.revoked_at.is_(None))
                .values(revoked_at=_now(), expires_at=_now())
            )
            await db.commit()

    first = _stage(monkeypatch, when=_dml(Update, "group_links"), competitor=lands)
    second = _stage(monkeypatch, when=_dml(Insert, "group_links"), competitor=withdrawn)
    response = await client.post(f"/groups/{cast.group_id}/link", headers=cast.admin)
    assert first["fired"] and second["fired"], "the race was not staged — a hook never fired"
    await _withdrawn(response)
    assert [row for row in await _link_rows(db_session_factory, cast.group_id) if row.revoked_at is None] == []
    assert (await _read(client, cast.member, cast.group_id)).json() == {"url": None, "expires_at": None}


# --- POST /gatherings/{id}/invitations ----------------------------------------------


def _pending(gathering_id: str, destination: str, inviter: UUID) -> GatheringInvitationPending:
    return GatheringInvitationPending(
        gathering_id=UUID(gathering_id),
        channel=InvitationChannel.EMAIL,
        destination=destination,
        token_hash=hash_token(secrets.token_urlsafe(32)),
        expires_at=_now() + INVITATION_TTL,
        invited_by_person_id=inviter,
    )


async def _live_gathering_rows(db_session_factory, gathering_id: str, destination: str) -> list[UUID]:
    async with db_session_factory() as db:
        return list(
            await db.scalars(
                select(GatheringInvitationPending.id).where(
                    GatheringInvitationPending.gathering_id == UUID(gathering_id),
                    GatheringInvitationPending.destination == destination,
                    GatheringInvitationPending.consumed_at.is_(None),
                    GatheringInvitationPending.revoked_at.is_(None),
                )
            )
        )


async def test_two_invitations_to_one_address_at_once_make_one_row_and_send_one_email(
    client, capsys, db_session_factory, monkeypatch
):
    """Both supersede what they can see (nothing), both insert; the second
    used to violate the live-destination partial unique at its commit: 500
    — before its send. Staged: the other organiser's pending row commits
    after the route's supersession UPDATE. The route answers 201 with the
    row that holds — the competitor's id — and SENDS NOTHING: its token was
    never stored, and mailing it would send a dead link. One live row; the
    organiser's list shows one."""
    host = await _signed_in_headers(client, capsys, "host@example.com")
    host_person = await _person_id(db_session_factory, "host@example.com")
    gathering_id = (await _create(client, host))["id"]
    destination = "twice@example.com"
    made: dict = {}

    async def competitor() -> None:
        async with db_session_factory() as db:
            row = _pending(gathering_id, destination, host_person)
            db.add(row)
            await db.commit()
            made["id"] = row.id

    staged = _stage(monkeypatch, when=_dml(Update, "gathering_invitations_pending"), competitor=competitor)
    capsys.readouterr()  # drop everything buffered: what follows is this request's output alone
    response = await _invite(client, host, gathering_id, destination)
    out = capsys.readouterr().out
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 201, response.text
    assert response.json()["id"] == str(made["id"])
    assert SEND_LINE not in out, "the losing request sent an email for a token it never stored"
    assert await _live_gathering_rows(db_session_factory, gathering_id, destination) == [made["id"]]
    listed = (await client.get(f"/gatherings/{gathering_id}/invitations", headers=host)).json()
    assert [entry["id"] for entry in listed["pending"]] == [str(made["id"])]


async def test_an_invitation_made_as_the_one_that_held_is_withdrawn_is_refused_and_sends_nothing(
    client, capsys, db_session_factory, monkeypatch
):
    """The vanishingly rare window on the invitation: the competitor's row
    lands after the route's supersession and is revoked after the route's
    insert returned nothing. 409 `withdrawn_meanwhile`, no email, no live
    row, never a 500."""
    host = await _signed_in_headers(client, capsys, "host@example.com")
    host_person = await _person_id(db_session_factory, "host@example.com")
    gathering_id = (await _create(client, host))["id"]
    destination = "twice@example.com"

    async def lands() -> None:
        async with db_session_factory() as db:
            db.add(_pending(gathering_id, destination, host_person))
            await db.commit()

    async def withdrawn() -> None:
        async with db_session_factory() as db:
            await db.execute(
                update(GatheringInvitationPending)
                .where(
                    GatheringInvitationPending.gathering_id == UUID(gathering_id),
                    GatheringInvitationPending.revoked_at.is_(None),
                )
                .values(revoked_at=_now(), expires_at=_now())
            )
            await db.commit()

    first = _stage(monkeypatch, when=_dml(Update, "gathering_invitations_pending"), competitor=lands)
    second = _stage(monkeypatch, when=_dml(Insert, "gathering_invitations_pending"), competitor=withdrawn)
    capsys.readouterr()
    response = await _invite(client, host, gathering_id, destination)
    out = capsys.readouterr().out
    assert first["fired"] and second["fired"], "the race was not staged — a hook never fired"
    await _withdrawn(response)
    assert SEND_LINE not in out
    assert await _live_gathering_rows(db_session_factory, gathering_id, destination) == []


# --- POST /groups/{id}/invitations --------------------------------------------------


def _group_pending(group_id: str, destination: str, inviter: UUID) -> GroupInvitationPending:
    return GroupInvitationPending(
        group_id=UUID(group_id),
        channel=InvitationChannel.EMAIL,
        destination=destination,
        token_hash=hash_token(secrets.token_urlsafe(32)),
        expires_at=_now() + INVITATION_TTL,
        invited_by_person_id=inviter,
    )


async def _live_group_rows(db_session_factory, group_id: str, destination: str) -> list[UUID]:
    async with db_session_factory() as db:
        return list(
            await db.scalars(
                select(GroupInvitationPending.id).where(
                    GroupInvitationPending.group_id == UUID(group_id),
                    GroupInvitationPending.destination == destination,
                    GroupInvitationPending.consumed_at.is_(None),
                    GroupInvitationPending.revoked_at.is_(None),
                )
            )
        )


async def test_two_group_invitations_to_one_address_at_once_make_one_row_and_send_one_email(
    client, capsys, db_session_factory, monkeypatch
):
    """The group's emailed invitation, the same shape and the same defect:
    the second insert violated `uq_group_invitations_pending_live_destination`
    at its commit. Staged after the route's supersession UPDATE; 201 with
    the competitor's row, nothing sent, one live row, the list showing it."""
    cast = await _group_cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    destination = "twice@example.com"
    made: dict = {}

    async def competitor() -> None:
        async with db_session_factory() as db:
            row = _group_pending(cast.group_id, destination, admin_person)
            db.add(row)
            await db.commit()
            made["id"] = row.id

    staged = _stage(monkeypatch, when=_dml(Update, "group_invitations_pending"), competitor=competitor)
    capsys.readouterr()
    response = await _invite_to_group(client, cast.co_admin, cast.group_id, destination)
    out = capsys.readouterr().out
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 201, response.text
    assert response.json()["id"] == str(made["id"])
    assert SEND_LINE not in out, "the losing request sent an email for a token it never stored"
    assert await _live_group_rows(db_session_factory, cast.group_id, destination) == [made["id"]]
    listed = (await client.get(f"/groups/{cast.group_id}/invitations", headers=cast.admin)).json()
    assert [entry["id"] for entry in listed["pending"]] == [str(made["id"])]


async def test_a_group_invitation_made_as_the_one_that_held_is_withdrawn_is_refused_and_sends_nothing(
    client, capsys, db_session_factory, monkeypatch
):
    """The vanishingly rare window on the group invitation: 409
    `withdrawn_meanwhile`, no email, no live row, never a 500."""
    cast = await _group_cast(client, capsys, db_session_factory)
    admin_person = await _person_id(db_session_factory, ADMIN)
    destination = "twice@example.com"

    async def lands() -> None:
        async with db_session_factory() as db:
            db.add(_group_pending(cast.group_id, destination, admin_person))
            await db.commit()

    async def withdrawn() -> None:
        async with db_session_factory() as db:
            await db.execute(
                update(GroupInvitationPending)
                .where(GroupInvitationPending.group_id == UUID(cast.group_id), GroupInvitationPending.revoked_at.is_(None))
                .values(revoked_at=_now(), expires_at=_now())
            )
            await db.commit()

    first = _stage(monkeypatch, when=_dml(Update, "group_invitations_pending"), competitor=lands)
    second = _stage(monkeypatch, when=_dml(Insert, "group_invitations_pending"), competitor=withdrawn)
    capsys.readouterr()
    response = await _invite_to_group(client, cast.admin, cast.group_id, destination)
    out = capsys.readouterr().out
    assert first["fired"] and second["fired"], "the race was not staged — a hook never fired"
    await _withdrawn(response)
    assert SEND_LINE not in out
    assert await _live_group_rows(db_session_factory, cast.group_id, destination) == []


# --- PATCH /media/{id} — the tags, with a HELD competitor ---------------------------


async def _until_the_route_waits_or_finishes(db_session_factory, route: asyncio.Task) -> str:
    """From a THIRD connection, watch `pg_locks` until the route's session
    is waiting on an ungranted lock, or the route has finished — whichever
    comes first — bounded by a deadline. Each poll is a round trip that
    yields to the loop (the route task runs between polls); there is no
    fixed sleep. Nothing else runs against the test database, so any
    ungranted lock is the route's."""
    deadline = time.monotonic() + 15
    async with db_session_factory() as watch:
        while time.monotonic() < deadline:
            if route.done():
                return "finished"
            if await watch.scalar(text("SELECT count(*) FROM pg_locks WHERE NOT granted")):
                return "waiting"
            await asyncio.sleep(0)
    raise AssertionError("the route neither waited on a lock nor finished within the bound")


async def _tag_race(client, capsys, db_session_factory, *, held: list[str], saved: list[str]) -> tuple:
    """A concurrent FIXED save holds the photograph's row and its own list
    uncommitted while the route's save runs as a task; the competitor
    commits as soon as the route waits on a lock or has finished. Returns
    (what the watcher saw, the route's response, the competitor's row ids)."""
    cast = await _media_cast(client, capsys, db_session_factory)
    media_id = await _photograph(db_session_factory, cast)
    async with db_session_factory() as competitor:
        await competitor.execute(select(Media).where(Media.id == UUID(media_id)).with_for_update())
        await competitor.execute(delete(MediaTag).where(MediaTag.media_id == UUID(media_id)))
        rows = [MediaTag(media_id=UUID(media_id), tag=tag, added_by_person_id=cast.uploader_person_id) for tag in held]
        competitor.add_all(rows)
        await competitor.flush()
        held_ids = {row.id for row in rows}
        route = asyncio.create_task(_patch(client, cast.uploader, media_id, {"tags": saved}))
        try:
            seen = await _until_the_route_waits_or_finishes(db_session_factory, route)
        finally:
            await competitor.commit()
        try:
            response = await route
        except Exception as exc:  # the escaped IntegrityError — the 500 — reaches the test under ASGITransport
            pytest.fail(f"the route raised {type(exc).__name__}: {exc}")
    return seen, response, held_ids, media_id


async def _stored_tag_ids(db_session_factory, media_id: str) -> set[UUID]:
    async with db_session_factory() as db:
        return set(await db.scalars(select(MediaTag.id).where(MediaTag.media_id == UUID(media_id))))


async def test_two_identical_tag_saves_at_once_take_turns_and_the_second_list_holds(
    client, capsys, db_session_factory
):
    """Today the route's SELECT takes no lock: its delete sees none of the
    competitor's uncommitted rows, its inserts then wait on the
    competitor's identical uncommitted keys, and when the competitor
    commits they raise: 500. Fixed, the route waits on the ROW LOCK
    instead, deletes what the competitor committed and saves its own list:
    200, the list it saved, the rows its own — the photograph ends with one
    whole list, the last writer's."""
    seen, response, held_ids, media_id = await _tag_race(
        client, capsys, db_session_factory, held=["ck772", "twice"], saved=["ck772", "twice"]
    )
    assert seen == "waiting", f"the route never took its turn behind the competitor ({seen})"
    assert response.status_code == 200, response.text
    assert response.json()["tags"] == ["ck772", "twice"]
    assert await _stored_tags(db_session_factory, media_id) == ["ck772", "twice"]
    assert (await _stored_tag_ids(db_session_factory, media_id)).isdisjoint(held_ids)


async def test_tommy_and_tommy_saved_at_once_leave_one_of_them_never_a_case_twin(
    client, capsys, db_session_factory
):
    """Today the route never waits — `Tommy` and `tommy` are distinct to
    the exact-match UNIQUE — so it commits past the competitor's
    uncommitted row and the competitor commits after it: both stored, the
    case twin the verifier forbids. Fixed, the route waits on the row lock,
    deletes the committed `tommy` and saves `Tommy`: exactly one, the last
    writer's."""
    seen, response, held_ids, media_id = await _tag_race(
        client, capsys, db_session_factory, held=["tommy"], saved=["Tommy"]
    )
    assert seen == "waiting", f"the route never took its turn behind the competitor ({seen})"
    assert response.status_code == 200, response.text
    assert response.json()["tags"] == ["Tommy"]
    assert await _stored_tags(db_session_factory, media_id) == ["Tommy"]
    assert (await _stored_tag_ids(db_session_factory, media_id)).isdisjoint(held_ids)


# --- GET /auth/verify — two links, one new address ----------------------------------


async def _people(db_session_factory, address: str) -> list[Person]:
    async with db_session_factory() as db:
        return list(await db.scalars(select(Person).where(Person.email == address)))


async def _sessions_of(db_session_factory, person_id: UUID) -> int:
    return await _count(db_session_factory, Session, Session.person_id == person_id)


async def _consumed(db_session_factory, raw: str) -> bool:
    async with db_session_factory() as db:
        return (
            await db.scalar(select(MagicLinkToken.consumed_at).where(MagicLinkToken.token_hash == hash_token(raw)))
        ) is not None


async def test_two_links_for_one_new_address_at_once_sign_in_as_the_one_person(
    client, db_session_factory, monkeypatch
):
    """Two live links for an address with no person yet (planted: the
    request endpoint supersedes, so the API cannot mint two). Each verify
    finds no person and inserts one; the second insert violated
    `people.email` at its flush: 500. Staged: the other link's verify —
    the account, the person, the ToS acceptance, its token consumed, a
    session — commits after this route's person SELECT. The route answers
    302 signed in AS THAT PERSON: one person, one account for them (the
    account the route inserted is deleted again — the verifier's
    `accounts == people + organizations`), ONE ToS acceptance (the request
    that created the person recorded it), both tokens consumed, two
    sessions for the one person."""
    address = "newcomer@example.com"
    raw_one, raw_two = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    async with db_session_factory() as db:
        for raw in (raw_one, raw_two):
            db.add(
                MagicLinkToken(
                    email=address, token_hash=hash_token(raw), expires_at=_now() + TOKEN_TTL, tos_version=TOS_VERSION
                )
            )
        await db.commit()
    accounts_before = await _count(db_session_factory, Account)

    async def competitor() -> None:
        async with db_session_factory() as db:
            account = Account(kind=AccountKind.PERSON)
            db.add(account)
            await db.flush()
            person = Person(display_name="newcomer", email=address, account_id=account.id)
            db.add(person)
            await db.flush()
            db.add(TosAcceptance(person_id=person.id, version=TOS_VERSION, accepted_at=_now()))
            db.add(Session(person_id=person.id, issued_at=_now(), expires_at=_now() + SESSION_TTL))
            await db.execute(
                update(MagicLinkToken)
                .where(MagicLinkToken.token_hash == hash_token(raw_two))
                .values(consumed_at=_now())
            )
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("people", containing="people.email"), competitor=competitor)
    response = await client.get(f"/auth/verify?token={raw_one}")
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert TOKEN_REDIRECT_RE.match(location), location
    (person,) = await _people(db_session_factory, address)
    assert person.display_name == "newcomer"
    assert await _count(db_session_factory, Account) == accounts_before + 1
    assert await _count(db_session_factory, TosAcceptance, TosAcceptance.person_id == person.id) == 1
    assert await _consumed(db_session_factory, raw_one) and await _consumed(db_session_factory, raw_two)
    assert await _sessions_of(db_session_factory, person.id) == 2
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {location.split('#token=', 1)[1]}"})
    assert me.status_code == 200 and me.json()["id"] == str(person.id)


# --- GET /auth/verify — one link opened twice at once -------------------------------


async def test_one_link_opened_twice_at_once_signs_an_existing_person_in_once(
    client, capsys, db_session_factory, monkeypatch
):
    """A double click on the email's link. Today both openings read the
    token unconsumed, both assign `consumed_at` and both mint a session —
    two sessions from a link whose email says it can be used once. Staged:
    the other opening consumes the token and mints its session after this
    route's token SELECT. The route answers the uniform `invalid_link`
    redirect, as for any used link; the person holds exactly the sessions
    they had plus the competitor's — one from this link."""
    address = "again@example.com"
    await _sign_in(client, capsys, address)
    person_id = await _person_id(db_session_factory, address)
    link = await _capture_link(client, capsys, address)
    raw = link.split("token=", 1)[1]

    async def competitor() -> None:
        async with db_session_factory() as db:
            await db.execute(
                update(MagicLinkToken).where(MagicLinkToken.token_hash == hash_token(raw)).values(consumed_at=_now())
            )
            db.add(Session(person_id=person_id, issued_at=_now(), expires_at=_now() + SESSION_TTL))
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("magic_link_tokens"), competitor=competitor)
    location = await _verify(client, link)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert location == ERROR_REDIRECT
    assert await _sessions_of(db_session_factory, person_id) == 2  # the first sign-in's and the competitor's
    assert await _consumed(db_session_factory, raw)


async def test_one_link_opened_twice_at_once_for_a_new_address_signs_in_once_and_creates_one_person(
    client, capsys, db_session_factory, monkeypatch
):
    """The same double click for an address with no person yet. The other
    opening consumes the token and creates the person (account, ToS
    acceptance, session) after this route's token SELECT; today this route
    then finds the person, assigns `consumed_at` over the competitor's and
    mints a second session. Fixed: the guarded consume finds the token
    spent — the uniform redirect, one person, one ToS acceptance, one
    session."""
    address = "fresh@example.com"
    link = await _capture_link(client, capsys, address)
    raw = link.split("token=", 1)[1]

    async def competitor() -> None:
        async with db_session_factory() as db:
            await db.execute(
                update(MagicLinkToken).where(MagicLinkToken.token_hash == hash_token(raw)).values(consumed_at=_now())
            )
            account = Account(kind=AccountKind.PERSON)
            db.add(account)
            await db.flush()
            person = Person(display_name="fresh", email=address, account_id=account.id)
            db.add(person)
            await db.flush()
            db.add(TosAcceptance(person_id=person.id, version=TOS_VERSION, accepted_at=_now()))
            db.add(Session(person_id=person.id, issued_at=_now(), expires_at=_now() + SESSION_TTL))
            await db.commit()

    staged = _stage(monkeypatch, when=_select_from("magic_link_tokens"), competitor=competitor)
    location = await _verify(client, link)
    assert staged["fired"], "the race was not staged — the hook never fired"
    assert location == ERROR_REDIRECT
    (person,) = await _people(db_session_factory, address)
    assert await _count(db_session_factory, TosAcceptance, TosAcceptance.person_id == person.id) == 1
    assert await _sessions_of(db_session_factory, person.id) == 1
    assert await _consumed(db_session_factory, raw)
