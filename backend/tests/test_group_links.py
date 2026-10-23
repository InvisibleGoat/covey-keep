"""CK-75 — the group's link, and joining through it
(decisions/2026-10-23-joining-a-group-and-co-admins.md §2–§3;
api/group_links.py; app/security.py's derived token).

The load-bearing pins:
- THE TOKEN IS DERIVED, NEVER STORED: `<link id>.<MAC>` under the session
  secret, verified in constant time; a tampered MAC, another id, another
  secret, garbage — every one `invalid`; no column of the row holds it;
- made by an organiser, shown to any member — recomputed, equal on every
  read — replaced (the old token `revoked`), revoked (idempotent), expired;
  a member cannot make or revoke; a stranger draws the group 404;
- the join flow: `requested` → `pending` → approved (the membership exists,
  the request stamped with the approver) or declined; `already_member`
  with the group id and NOTHING ELSE carrying it; dead tokens answer their
  status; two concurrent joins make ONE open request; a declined person
  simply asks again;
- decisions are the organisers' (a co-admin approves; a member and a
  stranger draw the group 404); a decided request is `already_decided`;
  a request of another group is the request 404;
- the per-group rate limit, counting decided rows; the reaper taking
  decided requests and expired links and sparing open ones;
- NEVER LOGGED: with the root at DEBUG across every path, the success paths
  included, no token and no URL carrying one reaches any record.
"""

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.api import group_links as links_api
from app.api.group_links import ALREADY_DECIDED, MAX_JOIN_REQUESTS_PER_GROUP
from app.config import settings
from app.models import GroupJoinRequest, GroupLink, Membership, Person
from app.security import group_link_token, parse_group_link_token
from app.services.retention import PURGE_GRACE
from tests.test_gatherings import _signed_in_headers
from tests.test_group_membership import (
    ADMIN,
    CO_ADMIN,
    MEMBER,
    STRANGER,
    _cast,
    _group_404,
    _members,
    _person_id,
)
from tests.test_groups import MISSING, _create

# The link targets the FRONTEND join screen with the token in the URL
# fragment (never the query string); the token is `<uuid>.<base64url>`.
JOIN_LINK_RE = re.compile(
    r"^http://localhost:5173/groups/join#token=([0-9a-f\-]{36}\.[A-Za-z0-9_\-]+)$"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _make(client, headers, group_id: str):
    return await client.post(f"/groups/{group_id}/link", headers=headers)


async def _read(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/link", headers=headers)


async def _revoke(client, headers, group_id: str):
    return await client.delete(f"/groups/{group_id}/link", headers=headers)


def _token_of(body: dict) -> str:
    match = JOIN_LINK_RE.match(body["url"])
    assert match, body
    return match.group(1)


async def _preview(client, token: str):
    return await client.post("/group-links/preview", json={"token": token})


async def _join(client, headers, token: str):
    return await client.post("/group-links/join", json={"token": token}, headers=headers)


async def _requests(client, headers, group_id: str):
    return await client.get(f"/groups/{group_id}/join-requests", headers=headers)


async def _approve(client, headers, group_id: str, request_id: str):
    return await client.post(f"/groups/{group_id}/join-requests/{request_id}/approve", headers=headers)


async def _decline(client, headers, group_id: str, request_id: str):
    return await client.post(f"/groups/{group_id}/join-requests/{request_id}/decline", headers=headers)


async def _link_rows(db_session_factory, group_id: str) -> list[GroupLink]:
    async with db_session_factory() as db:
        return (
            await db.scalars(
                select(GroupLink).where(GroupLink.group_id == UUID(group_id)).order_by(GroupLink.created_at)
            )
        ).all()


async def _request_rows(db_session_factory, group_id: str) -> list[GroupJoinRequest]:
    async with db_session_factory() as db:
        return (
            await db.scalars(
                select(GroupJoinRequest)
                .where(GroupJoinRequest.group_id == UUID(group_id))
                .order_by(GroupJoinRequest.created_at)
            )
        ).all()


# --- the token (app/security.py) ------------------------------------------------------


def test_the_token_is_derived_from_the_id_and_the_secret_and_verifies_or_does_not():
    link_id = uuid4()
    token = group_link_token(link_id, "secret-one")
    id_part, mac_part = token.split(".")
    assert UUID(id_part) == link_id
    assert "=" not in mac_part and len(mac_part) == 43  # 32 bytes, base64url, unpadded
    assert parse_group_link_token(token, "secret-one") == link_id
    # Deterministic: the same id and secret make the same token — the
    # reason a member can be shown the link again with nothing stored.
    assert group_link_token(link_id, "secret-one") == token
    # Another secret, another id, a tampered MAC, a dropped MAC, garbage:
    # every one None — and none raises.
    assert parse_group_link_token(token, "secret-two") is None
    assert parse_group_link_token(f"{uuid4()}.{mac_part}", "secret-one") is None
    tampered = mac_part[:-1] + ("A" if mac_part[-1] != "A" else "B")
    assert parse_group_link_token(f"{id_part}.{tampered}", "secret-one") is None
    for garbage in ("", "x", f"{id_part}.", f"{id_part}", "not-a-uuid.abc", f"{id_part}.{mac_part}.extra", "..", "a.b.c"):
        assert parse_group_link_token(garbage, "secret-one") is None, garbage
    # A session JWT is not a link token, and vice versa, by construction.
    assert parse_group_link_token("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig", "secret-one") is None


# --- the link (record §3) ----------------------------------------------------------


async def test_link_endpoints_require_auth_but_the_preview_does_not(client):
    assert (await client.post(f"/groups/{MISSING}/link")).status_code == 401
    assert (await client.get(f"/groups/{MISSING}/link")).status_code == 401
    assert (await client.delete(f"/groups/{MISSING}/link")).status_code == 401
    assert (await client.post("/group-links/join", json={"token": "x"})).status_code == 401
    assert (await client.get(f"/groups/{MISSING}/join-requests")).status_code == 401
    assert (await client.post(f"/groups/{MISSING}/join-requests/{MISSING}/approve")).status_code == 401
    assert (await client.post(f"/groups/{MISSING}/join-requests/{MISSING}/decline")).status_code == 401
    response = await _preview(client, "x")
    assert response.status_code == 200
    assert response.json() == {"status": "invalid", "group_name": None}


async def test_the_link_is_made_shown_replaced_revoked_and_expires_and_is_never_stored(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    stranger_404 = await _group_404(client, cast.stranger)

    # Nothing yet: the same shape, nulls.
    assert (await _read(client, cast.member, cast.group_id)).json() == {"url": None, "expires_at": None}
    # A member can neither make nor revoke; a stranger reads nothing.
    for act in (_make, _revoke):
        refused = await act(client, cast.member, cast.group_id)
        assert (refused.status_code, refused.content) == await _group_404(client, cast.member)
    refused = await _read(client, cast.stranger, cast.group_id)
    assert (refused.status_code, refused.content) == stranger_404

    made = await _make(client, cast.admin, cast.group_id)
    assert made.status_code == 201, made.text
    assert set(made.json()) == {"url", "expires_at"}
    token = _token_of(made.json())
    lifetime = datetime.fromisoformat(made.json()["expires_at"]) - _now()
    assert timedelta(days=7) - timedelta(minutes=5) <= lifetime <= timedelta(days=7)
    # Shown again to any member — recomputed, equal — and to the organisers.
    for headers in (cast.member, cast.co_admin, cast.admin):
        assert (await _read(client, headers, cast.group_id)).json() == made.json()
    assert (await _preview(client, token)).json() == {"status": "valid", "group_name": "Finch family"}

    # NEVER STORED: one row, no token column, and the token in no column's value.
    (row,) = await _link_rows(db_session_factory, cast.group_id)
    assert row.revoked_at is None
    async with db_session_factory() as db:
        columns = set(
            (
                await db.scalars(
                    text("SELECT column_name FROM information_schema.columns WHERE table_name = 'group_links'")
                )
            ).all()
        )
        assert columns == {"id", "group_id", "created_by_person_id", "created_at", "expires_at", "revoked_at"}
        values = (await db.execute(text("SELECT * FROM group_links WHERE id = :id"), {"id": row.id})).one()
        assert token not in " ".join(str(v) for v in values)
        assert token.split(".")[1] not in " ".join(str(v) for v in values)
    assert token.startswith(str(row.id) + ".")

    # Replaced by a co-admin: the old token reads revoked, exactly one
    # unrevoked row, the new one valid and shown.
    replaced = await _make(client, cast.co_admin, cast.group_id)
    assert replaced.status_code == 201, replaced.text
    new_token = _token_of(replaced.json())
    assert new_token != token
    assert (await _preview(client, token)).json() == {"status": "revoked", "group_name": None}
    assert (await _preview(client, new_token)).json()["status"] == "valid"
    rows = await _link_rows(db_session_factory, cast.group_id)
    assert [r.revoked_at is None for r in rows] == [False, True]
    assert rows[0].expires_at <= _now()
    assert (await _read(client, cast.member, cast.group_id)).json() == replaced.json()
    # The partial unique beneath it: a second unrevoked row is refused, by name.
    admin_person = await _person_id(db_session_factory, ADMIN)
    async with db_session_factory() as db:
        with pytest.raises(IntegrityError) as excinfo:
            await db.execute(
                text(
                    "INSERT INTO group_links (group_id, created_by_person_id, expires_at) "
                    "VALUES (:g, :p, now() + interval '1 day')"
                ),
                {"g": UUID(cast.group_id), "p": admin_person},
            )
        assert "uq_group_links_live" in str(excinfo.value)
        await db.rollback()

    # Revoked by the admin: 204, nothing shown, the token reads revoked;
    # revoking again is a 204.
    assert (await _revoke(client, cast.admin, cast.group_id)).status_code == 204
    assert (await _read(client, cast.member, cast.group_id)).json() == {"url": None, "expires_at": None}
    assert (await _preview(client, new_token)).json() == {"status": "revoked", "group_name": None}
    assert (await _revoke(client, cast.admin, cast.group_id)).status_code == 204
    assert all(r.revoked_at is not None for r in await _link_rows(db_session_factory, cast.group_id))

    # Expired: distinguished from revoked, and shown to nobody.
    expired = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    async with db_session_factory() as db:
        await db.execute(
            text("UPDATE group_links SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL")
        )
        await db.commit()
    assert (await _preview(client, expired)).json() == {"status": "expired", "group_name": None}
    assert (await _read(client, cast.member, cast.group_id)).json() == {"url": None, "expires_at": None}
    # Invalid: an unknown id with a well-formed MAC, and a tampered MAC on
    # a real id, are the same answer.
    unknown = group_link_token(uuid4(), settings.session_secret)
    assert (await _preview(client, unknown)).json() == {"status": "invalid", "group_name": None}
    id_part, mac_part = expired.split(".")
    tampered = f"{id_part}.{mac_part[:-2]}{'AB' if not mac_part.endswith('AB') else 'CD'}"
    assert (await _preview(client, tampered)).json() == {"status": "invalid", "group_name": None}


# --- joining through the link (record §2) ------------------------------------------


async def test_a_join_is_requested_then_pending_then_approved_or_declined(
    client, capsys, db_session_factory
):
    """A, who holds the link: `requested` (group id withheld), then
    `pending`; the admin lists the request — a display name, no email —
    and approves: the membership exists, the request is stamped with the
    approver, A reads the member list, and A's next join is
    `already_member` WITH the group id. B is declined, is told nothing by
    any endpoint, and asks again: a new open request. Approving the
    decided request again is the 409 `already_decided` carrying the
    outcome. Dead tokens answer their status to the join too."""
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    b = await _signed_in_headers(client, capsys, "b@example.com")
    a_person = await _person_id(db_session_factory, "a@example.com")
    admin_person = await _person_id(db_session_factory, ADMIN)

    assert (await _join(client, a, token)).json() == {"status": "requested", "group_id": None}
    assert (await _join(client, a, token)).json() == {"status": "pending", "group_id": None}
    assert (await _join(client, b, token)).json() == {"status": "requested", "group_id": None}
    # Still outside: the group is a 404 to a requester.
    assert (await client.get(f"/groups/{cast.group_id}", headers=a)).status_code == 404
    # A member who follows the link is simply in — the admin included.
    for headers in (cast.member, cast.co_admin, cast.admin):
        assert (await _join(client, headers, token)).json() == {"status": "already_member", "group_id": cast.group_id}
    assert len(await _request_rows(db_session_factory, cast.group_id)) == 2

    listed = await _requests(client, cast.admin, cast.group_id)
    assert listed.status_code == 200, listed.text
    entries = listed.json()["join_requests"]
    assert [e["display_name"] for e in entries] == ["a", "b"]
    assert all(set(e) == {"id", "display_name", "created_at"} for e in entries)
    assert "a@example.com" not in listed.text and str(a_person) not in listed.text
    a_request, b_request = entries[0]["id"], entries[1]["id"]

    approved = await _approve(client, cast.admin, cast.group_id, a_request)
    assert approved.status_code == 200, approved.text
    assert approved.json()["outcome"] == "approved" and approved.json()["id"] == a_request
    assert set(approved.json()) == {"id", "display_name", "created_at", "outcome", "decided_at"}
    async with db_session_factory() as db:
        request = await db.get(GroupJoinRequest, UUID(a_request))
        assert request.decided_at is not None and request.outcome.value == "approved"
        assert request.decided_by_person_id == admin_person
        assert (
            await db.scalar(
                select(func.count()).select_from(Membership).where(
                    Membership.group_id == UUID(cast.group_id), Membership.person_id == a_person
                )
            )
        ) == 1
    assert [e["display_name"] for e in (await _members(client, a, cast.group_id)).json()["members"]][-1] == "a"
    assert (await _join(client, a, token)).json() == {"status": "already_member", "group_id": cast.group_id}
    # The approved request is out of the open list; a second decision is refused.
    assert [e["id"] for e in (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]] == [b_request]
    again = await _approve(client, cast.admin, cast.group_id, a_request)
    assert again.status_code == 409 and again.json()["detail"]["code"] == ALREADY_DECIDED
    assert again.json()["detail"]["outcome"] == "approved"
    declined_again = await _decline(client, cast.admin, cast.group_id, a_request)
    assert declined_again.status_code == 409

    declined = await _decline(client, cast.admin, cast.group_id, b_request)
    assert declined.status_code == 200 and declined.json()["outcome"] == "declined"
    assert (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"] == []
    assert (await client.get(f"/groups/{cast.group_id}", headers=b)).status_code == 404
    # B simply asks again — a new open request, the decided one kept.
    assert (await _join(client, b, token)).json() == {"status": "requested", "group_id": None}
    rows = await _request_rows(db_session_factory, cast.group_id)
    assert [(r.decided_at is not None, r.outcome.value if r.outcome else None) for r in rows] == [
        (True, "approved"),
        (True, "declined"),
        (False, None),
    ]

    # Dead tokens through the join.
    assert (await _revoke(client, cast.admin, cast.group_id)).status_code == 204
    assert (await _join(client, b, token)).json() == {"status": "revoked", "group_id": None}
    assert (await _join(client, b, "garbage")).json() == {"status": "invalid", "group_id": None}


async def test_two_concurrent_joins_make_one_open_request(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    first, second = await asyncio.gather(_join(client, a, token), _join(client, a, token))
    assert sorted(r.json()["status"] for r in (first, second)) == ["pending", "requested"]
    rows = await _request_rows(db_session_factory, cast.group_id)
    assert len(rows) == 1 and rows[0].decided_at is None


async def test_join_requests_are_rate_limited_per_group_and_decided_rows_count(
    client, capsys, db_session_factory
):
    """Fifty requests in the window — planted DECIDED, because decided rows
    are stamped, never deleted, and keep counting (the CK-24 lesson) — and
    the fifty-first is a 429 with nothing written; a request older than the
    window does not count."""
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    stranger_person = await _person_id(db_session_factory, STRANGER)
    async with db_session_factory() as db:
        for n in range(MAX_JOIN_REQUESTS_PER_GROUP):
            await db.execute(
                text(
                    "INSERT INTO group_join_requests (group_id, person_id, created_at, decided_at, outcome) "
                    "VALUES (:g, :p, now() - interval '1 minute', now(), 'declined')"
                ),
                {"g": UUID(cast.group_id), "p": stranger_person},
            )
        await db.commit()
    refused = await _join(client, a, token)
    assert refused.status_code == 429, refused.text
    assert len(await _request_rows(db_session_factory, cast.group_id)) == MAX_JOIN_REQUESTS_PER_GROUP
    # Age one of them out of the window: room for one.
    async with db_session_factory() as db:
        await db.execute(
            text(
                "UPDATE group_join_requests SET created_at = now() - interval '16 minutes' "
                "WHERE id = (SELECT id FROM group_join_requests WHERE group_id = :g LIMIT 1)"
            ),
            {"g": UUID(cast.group_id)},
        )
        await db.commit()
    assert (await _join(client, a, token)).json()["status"] == "requested"


async def test_decisions_are_the_organisers_and_a_request_belongs_to_its_group(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    assert (await _join(client, a, token)).json()["status"] == "requested"
    (request_id,) = [e["id"] for e in (await _requests(client, cast.co_admin, cast.group_id)).json()["join_requests"]]

    # A member and a stranger: the group 404 on the list and both acts.
    for headers in (cast.member, cast.stranger):
        expected = await _group_404(client, headers)
        for response in (
            await _requests(client, headers, cast.group_id),
            await _approve(client, headers, cast.group_id, request_id),
            await _decline(client, headers, cast.group_id, request_id),
        ):
            assert (response.status_code, response.content) == expected
    # Another group of the admin's: the request is not its — the request 404.
    other = await _create(client, cast.admin, name="Other")
    assert (await _approve(client, cast.admin, other["id"], request_id)).status_code == 404
    assert (await _approve(client, cast.admin, cast.group_id, MISSING)).status_code == 404
    assert (await _approve(client, cast.admin, cast.group_id, MISSING)).json() == {"detail": "No such join request."}
    (row,) = await _request_rows(db_session_factory, cast.group_id)
    assert row.decided_at is None

    # A co-admin approves.
    approved = await _approve(client, cast.co_admin, cast.group_id, request_id)
    assert approved.status_code == 200, approved.text
    (row,) = await _request_rows(db_session_factory, cast.group_id)
    assert row.decided_by_person_id == await _person_id(db_session_factory, CO_ADMIN)
    assert (await client.get(f"/groups/{cast.group_id}", headers=a)).json()["caller_role"] == "member"


async def test_the_reaper_takes_decided_requests_and_expired_links_and_spares_open_ones(
    client, capsys, db_session_factory
):
    """purge_stale's customers here: a request decided more than PURGE_GRACE
    ago goes when the next join arrives; an open request of any age stays
    (it is never reaped by age); a link more than PURGE_GRACE past expiry
    goes when the next link is made; a recent one stays."""
    cast = await _cast(client, capsys, db_session_factory)
    token = _token_of((await _make(client, cast.admin, cast.group_id)).json())
    a = await _signed_in_headers(client, capsys, "a@example.com")
    stranger_person = await _person_id(db_session_factory, STRANGER)
    long_ago = _now() - PURGE_GRACE - timedelta(days=30)
    async with db_session_factory() as db:
        for decided in (long_ago, None):
            await db.execute(
                text(
                    "INSERT INTO group_join_requests (group_id, person_id, created_at, decided_at, outcome) "
                    "VALUES (:g, :p, :c, :d, :o)"
                ),
                {
                    "g": UUID(cast.group_id),
                    "p": stranger_person,
                    "c": long_ago - timedelta(hours=1),
                    "d": decided,
                    "o": "approved" if decided else None,
                },
            )
        await db.execute(
            text(
                "INSERT INTO group_links (group_id, created_by_person_id, created_at, expires_at, revoked_at) "
                "VALUES (:g, :p, :c, :e, :c)"
            ),
            {"g": UUID(cast.group_id), "p": stranger_person, "c": long_ago, "e": long_ago},
        )
        await db.commit()
    assert len(await _request_rows(db_session_factory, cast.group_id)) == 2
    assert len(await _link_rows(db_session_factory, cast.group_id)) == 2

    assert (await _join(client, a, token)).json()["status"] == "requested"
    rows = await _request_rows(db_session_factory, cast.group_id)
    assert [(r.person_id, r.decided_at is None) for r in rows] == [
        (stranger_person, True),
        (await _person_id(db_session_factory, "a@example.com"), True),
    ]
    assert (await _make(client, cast.admin, cast.group_id)).status_code == 201
    rows = await _link_rows(db_session_factory, cast.group_id)
    assert len(rows) == 2 and all(r.created_at > long_ago for r in rows)


async def test_the_link_and_the_join_log_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """The token is a bearer credential and never reaches a record: with
    the root at DEBUG across make, read, preview, join, list, approve,
    revoke — the success paths included — no application record exists,
    and the token, the URL and the requester's display name appear in no
    record at all (httpx's own lines carry the path, never the token: it
    rides a POST body and a fragment)."""
    cast = await _cast(client, capsys, db_session_factory)
    a = await _signed_in_headers(client, capsys, "a@example.com")
    assert not hasattr(links_api, "logger")
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        made = await _make(client, cast.admin, cast.group_id)
        token = _token_of(made.json())
        assert (await _read(client, cast.member, cast.group_id)).status_code == 200
        assert (await _preview(client, token)).json()["status"] == "valid"
        assert (await _join(client, a, token)).json()["status"] == "requested"
        (request_id,) = [e["id"] for e in (await _requests(client, cast.admin, cast.group_id)).json()["join_requests"]]
        assert (await _approve(client, cast.admin, cast.group_id, request_id)).status_code == 200
        assert (await _revoke(client, cast.admin, cast.group_id)).status_code == 204
        assert (await _preview(client, token)).json()["status"] == "revoked"
    assert any(r.name.startswith("httpx") for r in caplog.records)
    assert not [r for r in caplog.records if r.name.startswith(("app", "covey-keep"))]
    everything = "\n".join(r.getMessage() for r in caplog.records)
    assert token not in everything
    assert token.split(".")[1] not in everything
    assert made.json()["url"] not in everything
    assert "#token=" not in everything
    assert "a@example.com" not in everything
