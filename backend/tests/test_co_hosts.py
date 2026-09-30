"""CK-68 — co-hosts: the relation, the two helpers, and every check
classified (decisions/2026-09-03-co-hosts.md §1, §4, §5, §7, as amended by
decisions/2026-09-27-two-bins.md §4; migration 0027).

The cast is test_media_reads' — host, uploader (an accepted invitee),
keeper, bystander (a second accepted invitee), stranger — and THE BYSTANDER
IS MADE A CO-HOST through the API, so every seat the classification
distinguishes is signed in: a co-host who uploaded nothing, an invitee who
is not a co-host, a keeper who is neither, and a stranger. No network
anywhere.

The load-bearing pins, one per line of the kickoff's classification:
- FOR EVERY DELEGABLE ROUTE: host yes, co-host yes, invitee no, stranger 404
  — the gathering's PATCH (every field but the review switch), occurrences
  (add, move, remove), invitations (create, list, revoke), the full RSVP
  list in every visibility mode, taking a published photograph down, and
  reading the gathering's bin and restoring from it;
- FOR EVERY RESERVED ROUTE: host yes, co-host no, with the route's own
  refusal — a `pending` photograph invisible (the list, `/url`), the queue,
  publish, decline, the batch publish (the media 404), the review switch
  (a field-level 422 on `requires_approval_override`), destroying someone
  else's photograph (the media 404), and adding or removing co-hosts (the
  gathering 404);
- THE PATCH IS FIELD-LEVEL: a co-host's title applies; a co-host's switch
  draws the 422 and nothing in that body applies;
- A CO-HOST'S RESTORE PASSES THROUGH THE GATE: `pending` where gated (both
  stamps cleared, back in the host's queue — and out of the co-host's own
  sight), `live` where open; the host's restore in the same gated
  gathering still goes `live`;
- A CO-HOST'S TAKEDOWN lands in the gathering's bin with the co-host as
  remover — the uploader sees nothing, the host and the co-host both read
  it;
- MANAGEMENT: who may be made one (an accepted invitee who is not the host
  and not already a co-host, whose account is not deleted — each refusal a
  422 with its stable code and no row), the host removes, a co-host steps
  down, a co-host removing another → hidden;
- `caller_role` on the detail, the list and the patch body — `host`,
  `co_host`, or null;
- a co-host row on a HOSTLESS gathering still organises, and nobody is host;
- account deletion drops the deleted account's co-host rows and keeps the
  rows it added, as provenance;
- the keeper and the upload are unaffected: a co-host uploads as an invitee,
  against the keeper's allowance; the keeper gains nothing;
- the verifier's new invariant fires on a planted row and on nothing else.
"""

import dataclasses
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select, text

from app.api.co_hosts import ACCOUNT_DELETED, ALREADY_CO_HOST, IS_HOST, NOT_INVITED
from app.models import (
    Gathering,
    GatheringCoHost,
    GatheringInvitation,
    Media,
    MediaStatus,
    Person,
    PublicationState,
)
from app.services import keeping
from tests.test_destruction import (
    _counts,
    _destroy,
    _invariants_hold,
    _remove,
    _resync_counts,
    _row,
    _verifier,
)
from tests.test_gathering_bin import _bin_view, _stamp_invariants_hold
from tests.test_gatherings import (
    DELETE_BODY,
    _account_for,
    _create,
    _field_errors,
    _signed_in_headers,
)
from tests.test_invitations import _accept, _invite, _invite_token
from tests.test_media_intents import _intents, _item
from tests.test_media_reads import (
    BYSTANDER,
    HOST,
    KEEPER,
    MISSING_ID,
    UPLOADER,
    Cast,
    _cast,
    _ids,
    _list,
    _photograph,
    _url,
)
from tests.test_removal_attribution import _gate, _restore, _stamp_published, _state
from tests.test_review import _decline, _host_person_id, _publish, _queue
from tests.test_rsvps import _get_rsvps, _put_rsvp

RSVP_YES_WITH_TOMMY = {"response": "yes", "companions": ["Tommy"]}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- helpers ---------------------------------------------------------------------


async def _invitation_id(db_session_factory, gathering_id: str, address: str) -> str:
    """The accepted invitation's id for the person at `address` in this
    gathering — the handle the host reads in GET …/invitations, and the
    one the co-host routes take."""
    async with db_session_factory() as db:
        return str(
            (
                await db.execute(
                    select(GatheringInvitation.id)
                    .join(Person, Person.id == GatheringInvitation.person_id)
                    .where(
                        GatheringInvitation.gathering_id == UUID(gathering_id),
                        Person.email == address,
                    )
                )
            ).scalar_one()
        )


async def _person_id(db_session_factory, address: str) -> UUID:
    async with db_session_factory() as db:
        return (await db.execute(select(Person.id).where(Person.email == address))).scalar_one()


async def _add(client, headers, gathering_id: str, invitation_id: str):
    return await client.post(
        f"/gatherings/{gathering_id}/co-hosts",
        json={"invitation_id": invitation_id},
        headers=headers,
    )


async def _co_hosts(client, headers, gathering_id: str):
    return await client.get(f"/gatherings/{gathering_id}/co-hosts", headers=headers)


async def _drop(client, headers, gathering_id: str, invitation_id: str):
    return await client.delete(
        f"/gatherings/{gathering_id}/co-hosts/{invitation_id}", headers=headers
    )


async def _detail(client, headers, gathering_id: str):
    return await client.get(f"/gatherings/{gathering_id}", headers=headers)


async def _rows(db_session_factory, gathering_id: str) -> list[tuple[UUID, UUID]]:
    """(account_id, added_by_account_id) per co-host row of the gathering."""
    async with db_session_factory() as db:
        return [
            (row.account_id, row.added_by_account_id)
            for row in (
                await db.scalars(
                    select(GatheringCoHost)
                    .where(GatheringCoHost.gathering_id == UUID(gathering_id))
                    .order_by(GatheringCoHost.created_at)
                )
            ).all()
        ]


async def _co_hosted(client, capsys, db_session_factory) -> tuple[Cast, str]:
    """The cast, with THE BYSTANDER made a co-host through the API. Returns
    the cast and the bystander's invitation id — the handle every
    management call takes. `cast.bystander` is the co-host from here on."""
    cast = await _cast(client, capsys, db_session_factory)
    invitation_id = await _invitation_id(db_session_factory, cast.gathering_id, BYSTANDER)
    response = await _add(client, cast.host, cast.gathering_id, invitation_id)
    assert response.status_code == 201, response.text
    return cast, invitation_id


async def _gathering_404(client, headers) -> dict:
    """The gathering's 404 body — what every non-organiser must draw on the
    co-host routes, byte-identical."""
    response = await _detail(client, headers, MISSING_ID)
    assert response.status_code == 404
    return response.json()


def _by_uploader(cast: Cast, person_id: UUID) -> Cast:
    """The cast with a different uploader — so `_photograph` plants a row
    the CO-HOST (or the host) uploaded."""
    return dataclasses.replace(cast, uploader_person_id=person_id)


async def _patch_title(client, headers, gathering_id: str, title: str):
    return await client.patch(f"/gatherings/{gathering_id}", json={"title": title}, headers=headers)


# --- auth ------------------------------------------------------------------------


async def test_co_host_endpoints_require_auth(client):
    body = {"invitation_id": MISSING_ID}
    assert (await client.post(f"/gatherings/{MISSING_ID}/co-hosts", json=body)).status_code == 401
    assert (await client.get(f"/gatherings/{MISSING_ID}/co-hosts")).status_code == 401
    assert (
        await client.delete(f"/gatherings/{MISSING_ID}/co-hosts/{MISSING_ID}")
    ).status_code == 401


# --- management: the host makes, removes; a co-host steps down --------------------


async def test_the_host_makes_an_accepted_invitee_a_co_host_and_every_body_says_who_the_caller_is(
    client, capsys, db_session_factory
):
    """One row — (gathering, the invitee's account), added by the host —
    and `caller_role` on the detail, the list and (below) the patch body:
    `host` for the host, `co_host` for the co-host, null for an invitee
    who is not one and for the keeper. The list's role rides the one
    statement (the CK-20 statement-count pin passes unedited)."""
    cast, invitation_id = await _co_hosted(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        host_account = (await _account_for(db, HOST)).id
        co_host_account = (await _account_for(db, BYSTANDER)).id
    assert await _rows(db_session_factory, cast.gathering_id) == [(co_host_account, host_account)]

    for headers, role in (
        (cast.host, "host"),
        (cast.bystander, "co_host"),
        (cast.uploader, None),
        (cast.keeper, None),
    ):
        detail = await _detail(client, headers, cast.gathering_id)
        assert detail.status_code == 200
        assert detail.json()["caller_role"] == role, role
        if headers is cast.host:
            # The list is kept-or-invited (CK-49b) and the cast's host is
            # neither — the sponsorship shape moves the keeper column — so
            # the host's own gathering is absent from THEIR list. A
            # pre-existing gap of the list rule, not this phase's;
            # recorded in the report.
            continue
        listed = await client.get("/gatherings", headers=headers)
        (item,) = [g for g in listed.json()["gatherings"] if g["id"] == cast.gathering_id]
        assert item["caller_role"] == role, role
    # The co-host list itself is NOT on the body, for anyone.
    assert "co_hosts" not in (await _detail(client, cast.host, cast.gathering_id)).json()


async def test_the_add_body_and_the_list_carry_display_names_and_the_handle_and_nothing_else(
    client, capsys, db_session_factory
):
    """Display names only: the handle is the accepted invitation's id the
    host already reads, `is_self` is the one caller-relative fact, and no
    body carries an email, a person id or an account id — the adder
    included (provenance rides no body)."""
    cast = await _cast(client, capsys, db_session_factory)
    invitation_id = await _invitation_id(db_session_factory, cast.gathering_id, BYSTANDER)
    display_name = (await client.get("/auth/me", headers=cast.bystander)).json()["display_name"]

    added = await _add(client, cast.host, cast.gathering_id, invitation_id)
    assert added.status_code == 201, added.text
    assert set(added.json()) == {"invitation_id", "display_name", "added_at", "is_self"}
    assert added.json()["invitation_id"] == invitation_id
    assert added.json()["display_name"] == display_name
    assert added.json()["is_self"] is False

    for headers, is_self in ((cast.host, False), (cast.bystander, True)):
        listed = await _co_hosts(client, headers, cast.gathering_id)
        assert listed.status_code == 200, listed.text
        (entry,) = listed.json()["co_hosts"]
        assert set(entry) == {"invitation_id", "display_name", "added_at", "is_self"}
        assert (entry["invitation_id"], entry["display_name"], entry["is_self"]) == (
            invitation_id,
            display_name,
            is_self,
        )
        text_body = listed.text
        assert BYSTANDER not in text_body and HOST not in text_body
        async with db_session_factory() as db:
            for address in (HOST, BYSTANDER):
                account = await _account_for(db, address)
                assert str(account.id) not in text_body
                assert str(await _person_id(db_session_factory, address)) not in text_body


async def test_making_a_co_host_is_refused_with_a_stable_code_and_writes_nothing(
    client, capsys, db_session_factory
):
    """Four refusals, each a 422 on `invitation_id` with its code and no
    row: the host themselves (they can hold an accepted invitation to
    their own gathering — nothing stops them inviting and accepting);
    someone already a co-host; a handle that names no accepted invitee of
    THIS gathering (a pending row's id, a missing id, and another
    gathering's accepted invitation — one code, `not_invited`, so the
    refusal confirms nothing about other gatherings); and an invitee whose
    account has been deleted."""
    cast, bystander_invitation = await _co_hosted(client, capsys, db_session_factory)
    before = await _rows(db_session_factory, cast.gathering_id)
    assert len(before) == 1

    def code_of(response) -> str:
        assert response.status_code == 422, response.text
        (error,) = response.json()["detail"]
        assert error["loc"] == ["body", "invitation_id"]
        return error["code"]

    # The host, holding an accepted invitation to their own gathering.
    own_token = await _invite_token(client, capsys, cast.host, cast.gathering_id, HOST)
    await _accept(client, cast.host, own_token)
    host_invitation = await _invitation_id(db_session_factory, cast.gathering_id, HOST)
    assert code_of(await _add(client, cast.host, cast.gathering_id, host_invitation)) == IS_HOST
    # Already a co-host.
    assert (
        code_of(await _add(client, cast.host, cast.gathering_id, bystander_invitation))
        == ALREADY_CO_HOST
    )
    # Not an accepted invitee here: a PENDING row's id, a missing id, and
    # another gathering's accepted invitation — the same code for all three.
    pending_id = (await _invite(client, cast.host, cast.gathering_id, "waiting@example.com")).json()["id"]
    assert code_of(await _add(client, cast.host, cast.gathering_id, pending_id)) == NOT_INVITED
    assert code_of(await _add(client, cast.host, cast.gathering_id, MISSING_ID)) == NOT_INVITED
    other = await _create(client, cast.host, title="The other one")
    token = await _invite_token(client, capsys, cast.host, other["id"], UPLOADER)
    await _accept(client, cast.uploader, token)
    elsewhere = await _invitation_id(db_session_factory, other["id"], UPLOADER)
    assert code_of(await _add(client, cast.host, cast.gathering_id, elsewhere)) == NOT_INVITED
    # A deleted account: invited, accepted, then gone.
    leaver = "leaver@example.com"
    token = await _invite_token(client, capsys, cast.host, cast.gathering_id, leaver)
    leaver_headers = await _signed_in_headers(client, capsys, leaver)
    await _accept(client, leaver_headers, token)
    leaver_invitation = await _invitation_id(db_session_factory, cast.gathering_id, leaver)
    assert (await client.post("/me/delete", json=DELETE_BODY, headers=leaver_headers)).status_code == 204
    assert (
        code_of(await _add(client, cast.host, cast.gathering_id, leaver_invitation))
        == ACCOUNT_DELETED
    )

    assert await _rows(db_session_factory, cast.gathering_id) == before


async def test_adding_a_co_host_is_the_hosts_alone_and_reading_the_list_is_the_organisers(
    client, capsys, db_session_factory
):
    """Reserved (co-hosts §4): a co-host, an invitee, the keeper and a
    stranger each draw the gathering 404 byte-identical to a missing
    gathering on the add — the route hides. The list is the organisers':
    the host and the co-host read it; an invitee, the keeper and a
    stranger draw the same 404."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    uploader_invitation = await _invitation_id(db_session_factory, cast.gathering_id, UPLOADER)
    before = await _rows(db_session_factory, cast.gathering_id)

    for headers in (cast.bystander, cast.uploader, cast.keeper, cast.stranger):
        refused = await _add(client, headers, cast.gathering_id, uploader_invitation)
        assert (refused.status_code, refused.json()) == (404, await _gathering_404(client, headers))
    assert await _rows(db_session_factory, cast.gathering_id) == before

    for headers in (cast.host, cast.bystander):
        assert (await _co_hosts(client, headers, cast.gathering_id)).status_code == 200
    for headers in (cast.uploader, cast.keeper, cast.stranger):
        refused = await _co_hosts(client, headers, cast.gathering_id)
        assert (refused.status_code, refused.json()) == (404, await _gathering_404(client, headers))


async def test_the_host_removes_a_co_host_and_the_role_ends_at_once(
    client, capsys, db_session_factory
):
    """204, the row gone, `caller_role` back to null, and the next
    delegable act — a title patch — draws the gathering 404 (hz's shape).
    Idempotent: a second remove is a 204, and so is removing an invitee
    who never was a co-host; a handle naming no accepted invitee of this
    gathering is the co-host 404."""
    cast, invitation_id = await _co_hosted(client, capsys, db_session_factory)
    assert (await _patch_title(client, cast.bystander, cast.gathering_id, "By the co-host")).status_code == 200

    assert (await _drop(client, cast.host, cast.gathering_id, invitation_id)).status_code == 204
    assert await _rows(db_session_factory, cast.gathering_id) == []
    assert (await _detail(client, cast.bystander, cast.gathering_id)).json()["caller_role"] is None
    refused = await _patch_title(client, cast.bystander, cast.gathering_id, "Hijacked")
    assert (refused.status_code, refused.json()) == (404, await _gathering_404(client, cast.bystander))
    assert (await _co_hosts(client, cast.host, cast.gathering_id)).json() == {"co_hosts": []}
    # Idempotent for the host; a foreign handle is the co-host 404.
    assert (await _drop(client, cast.host, cast.gathering_id, invitation_id)).status_code == 204
    uploader_invitation = await _invitation_id(db_session_factory, cast.gathering_id, UPLOADER)
    assert (await _drop(client, cast.host, cast.gathering_id, uploader_invitation)).status_code == 204
    assert (await _drop(client, cast.host, cast.gathering_id, MISSING_ID)).status_code == 404
    # The title the co-host set stands: an act done while they organised
    # is a fact, not a permission.
    assert (await _detail(client, cast.host, cast.gathering_id)).json()["title"] == "By the co-host"


async def test_a_co_host_may_step_down_and_may_not_remove_another_co_host(
    client, capsys, db_session_factory
):
    """Two co-hosts. One removing the OTHER draws the co-host 404 and
    changes nothing (§4 reserves it; §7's second item stays open — the
    answer built is no); one removing THEMSELVES steps down (204, their
    row gone, the other's intact). Everyone who is not an organiser draws
    the gathering 404 on the remove."""
    cast, bystander_invitation = await _co_hosted(client, capsys, db_session_factory)
    uploader_invitation = await _invitation_id(db_session_factory, cast.gathering_id, UPLOADER)
    assert (await _add(client, cast.host, cast.gathering_id, uploader_invitation)).status_code == 201
    before = await _rows(db_session_factory, cast.gathering_id)
    assert len(before) == 2

    hidden = await _drop(client, cast.uploader, cast.gathering_id, bystander_invitation)
    assert hidden.status_code == 404
    assert hidden.json() == (await _drop(client, cast.host, cast.gathering_id, MISSING_ID)).json()
    assert await _rows(db_session_factory, cast.gathering_id) == before
    for headers in (cast.keeper, cast.stranger):
        refused = await _drop(client, headers, cast.gathering_id, bystander_invitation)
        assert (refused.status_code, refused.json()) == (404, await _gathering_404(client, headers))

    assert (await _drop(client, cast.bystander, cast.gathering_id, bystander_invitation)).status_code == 204
    remaining = await _rows(db_session_factory, cast.gathering_id)
    assert [account for account, _ in remaining] == [before[1][0]]
    assert (await _detail(client, cast.bystander, cast.gathering_id)).json()["caller_role"] is None
    assert (await _detail(client, cast.uploader, cast.gathering_id)).json()["caller_role"] == "co_host"


# --- the delegable set ------------------------------------------------------------


async def test_the_delegable_routes_admit_the_host_and_a_co_host_and_refuse_everyone_else(
    client, capsys, db_session_factory
):
    """FOR EVERY DELEGABLE ROUTE: host yes, co-host yes, invitee no, stranger
    404 — the invitee's and the stranger's refusals byte-identical to a
    missing id. The gathering's PATCH (title), an occurrence added, moved
    and removed, and an invitation created, listed and revoked."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    gid = cast.gathering_id
    missing = await _gathering_404(client, cast.uploader)

    async def refused(response) -> None:
        assert (response.status_code, response.json()) == (404, missing), response.text

    # PATCH /gatherings/{id} — the title.
    for headers in (cast.uploader, cast.stranger):
        await refused(await _patch_title(client, headers, gid, "Hijacked"))
    for headers, title in ((cast.host, "By the host"), (cast.bystander, "By the co-host")):
        response = await _patch_title(client, headers, gid, title)
        assert response.status_code == 200, response.text
        assert response.json()["title"] == title
        assert response.json()["updated_at"] is not None
    assert (await _detail(client, cast.host, gid)).json()["title"] == "By the co-host"

    # POST /gatherings/{id}/occurrences — one date each; the cast has two.
    body = {"starts_at": "2026-09-15T18:00:00+00:00"}
    for headers in (cast.uploader, cast.stranger):
        await refused(await client.post(f"/gatherings/{gid}/occurrences", json=body, headers=headers))
    added = {}
    for name, headers in (("host", cast.host), ("co_host", cast.bystander)):
        response = await client.post(f"/gatherings/{gid}/occurrences", json=body, headers=headers)
        assert response.status_code == 201, response.text
        added[name] = response.json()["id"]
    # PATCH /occurrences/{id} — move the co-host's date.
    move = {"location": "the hall"}
    for headers in (cast.uploader, cast.stranger):
        await refused(await client.patch(f"/occurrences/{added['co_host']}", json=move, headers=headers))
    for headers in (cast.host, cast.bystander):
        response = await client.patch(f"/occurrences/{added['co_host']}", json=move, headers=headers)
        assert response.status_code == 200, response.text
    # DELETE /occurrences/{id} — four dates now; each organiser removes one.
    for headers in (cast.uploader, cast.stranger):
        await refused(await client.delete(f"/occurrences/{added['host']}", headers=headers))
    assert (await client.delete(f"/occurrences/{added['host']}", headers=cast.host)).status_code == 204
    assert (await client.delete(f"/occurrences/{added['co_host']}", headers=cast.bystander)).status_code == 204
    assert len((await _detail(client, cast.host, gid)).json()["occurrences"]) == 2

    # Invitations: create, list, revoke.
    for headers in (cast.uploader, cast.stranger):
        await refused(await _invite(client, headers, gid, "spam@example.com"))
        await refused(await client.get(f"/gatherings/{gid}/invitations", headers=headers))
    pending = {}
    for name, headers, destination in (
        ("host", cast.host, "by-host@example.com"),
        ("co_host", cast.bystander, "by-co-host@example.com"),
    ):
        response = await _invite(client, headers, gid, destination)
        assert response.status_code == 201, response.text
        pending[name] = response.json()["id"]
    for headers in (cast.host, cast.bystander):
        listed = await client.get(f"/gatherings/{gid}/invitations", headers=headers)
        assert listed.status_code == 200
        assert {p["destination"] for p in listed.json()["pending"]} == {
            "by-host@example.com",
            "by-co-host@example.com",
        }
    for headers in (cast.uploader, cast.stranger):
        response = await client.delete(f"/invitations/pending/{pending['host']}", headers=headers)
        assert response.status_code == 404
        assert response.json() == (
            await client.delete(f"/invitations/pending/{MISSING_ID}", headers=headers)
        ).json()
    assert (await client.delete(f"/invitations/pending/{pending['host']}", headers=cast.bystander)).status_code == 204
    assert (await client.delete(f"/invitations/pending/{pending['co_host']}", headers=cast.host)).status_code == 204
    assert (await client.get(f"/gatherings/{gid}/invitations", headers=cast.host)).json()["pending"] == []


async def test_the_full_rsvp_list_is_the_organisers_view_in_every_mode(
    client, capsys, db_session_factory
):
    """The host's floor is the organisers' (co-hosts §4: "see the RSVP
    list; set its visibility"): under HOST_ONLY — set by the co-host,
    through the delegable PATCH — the host and the co-host read the
    roster and an invitee reads only their own; under ATTENDEES the
    co-host, who has not answered, reads the roster WITH companion names,
    where an attendee who is not an organiser reads them withheld."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    occurrence_id = cast.date_id
    assert (
        await client.patch(
            f"/gatherings/{cast.gathering_id}",
            json={"rsvp_list_visibility": "HOST_ONLY"},
            headers=cast.bystander,
        )
    ).status_code == 200
    assert (await _put_rsvp(client, cast.uploader, occurrence_id, RSVP_YES_WITH_TOMMY)).status_code == 200
    assert (await _put_rsvp(client, cast.host, occurrence_id, {"response": "yes"})).status_code == 200

    for headers in (cast.host, cast.bystander):
        view = (await _get_rsvps(client, headers, occurrence_id)).json()
        assert view["visibility"] == "HOST_ONLY"
        assert len(view["rsvps"]) == 2
        (uploader_row,) = [r for r in view["rsvps"] if r["companions"] == ["Tommy"]]
        assert uploader_row["total"] == 2
    invitee_view = (await _get_rsvps(client, cast.uploader, occurrence_id)).json()
    assert invitee_view["rsvps"] == []
    assert invitee_view["own"]["companions"] == ["Tommy"]

    assert (
        await client.patch(
            f"/gatherings/{cast.gathering_id}",
            json={"rsvp_list_visibility": "ATTENDEES"},
            headers=cast.host,
        )
    ).status_code == 200
    # A second attendee who is not an organiser: names withheld.
    keeper_view = (await _get_rsvps(client, cast.keeper, occurrence_id)).json()
    assert keeper_view["rsvps"] == []  # has not answered yes
    assert (await _put_rsvp(client, cast.keeper, occurrence_id, {"response": "yes"})).status_code == 200
    keeper_view = (await _get_rsvps(client, cast.keeper, occurrence_id)).json()
    assert {r["companions"] for r in keeper_view["rsvps"] if r["companions"] is not None} == set()
    assert [r["total"] for r in keeper_view["rsvps"] if r["total"] == 2] == [2]
    co_host_view = (await _get_rsvps(client, cast.bystander, occurrence_id)).json()
    assert co_host_view["own"] is None
    assert [r["companions"] for r in co_host_view["rsvps"] if r["companions"]] == [["Tommy"]]


async def test_the_patch_is_field_level_and_the_review_switch_stays_the_hosts(
    client, capsys, db_session_factory
):
    """A co-host's title applies; a co-host's `requires_approval_override`
    draws a 422 ON THAT FIELD — and with a title beside it, the whole
    request is refused and the title does not apply either (a partial
    apply the caller cannot see is worse than a refusal). The host's
    switch is untouched: they flip it, and the co-host's title patch keeps
    the flipped value. `caller_role` on the patch body reads `co_host`."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    gid = cast.gathering_id

    for body in ({"requires_approval_override": True}, {"requires_approval_override": None}):
        refused = await client.patch(f"/gatherings/{gid}", json=body, headers=cast.bystander)
        assert refused.status_code == 422, refused.text
        assert _field_errors(refused) == {"requires_approval_override"}
    mixed = await client.patch(
        f"/gatherings/{gid}",
        json={"title": "Smuggled", "requires_approval_override": True},
        headers=cast.bystander,
    )
    assert mixed.status_code == 422
    assert _field_errors(mixed) == {"requires_approval_override"}
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(gid))
        assert gathering.requires_approval is None
        assert gathering.title == "August potluck"
        assert gathering.updated_at is None

    applied = await client.patch(f"/gatherings/{gid}", json={"title": "Applied"}, headers=cast.bystander)
    assert applied.status_code == 200, applied.text
    assert (applied.json()["title"], applied.json()["caller_role"]) == ("Applied", "co_host")
    assert applied.json()["requires_approval"] is False

    flipped = await client.patch(
        f"/gatherings/{gid}", json={"requires_approval_override": True}, headers=cast.host
    )
    assert flipped.status_code == 200, flipped.text
    assert (flipped.json()["requires_approval"], flipped.json()["caller_role"]) == (True, "host")
    again = await client.patch(f"/gatherings/{gid}", json={"title": "Still gated"}, headers=cast.bystander)
    assert again.status_code == 200
    assert again.json()["requires_approval_override"] is True


# --- the reserved set --------------------------------------------------------------


async def test_a_co_host_sees_no_pending_photograph_and_has_no_queue_publish_or_decline(
    client, capsys, db_session_factory
):
    """Everything about an unapproved photograph is the host's (co-hosts
    §4; who-may-see §2): a `ready`+`pending` row is absent from the
    co-host's list and its `/url` is the media 404 byte-identical to a
    missing id; the queue, publish, decline and the batch each draw the
    media 404 — and nothing moves. The co-host's OWN pending upload is
    visible to them as its uploader and still not theirs to publish. The
    host, meanwhile, sees and decides."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    waiting = await _photograph(db_session_factory, cast)  # ready + pending, the uploader's
    own = await _photograph(
        db_session_factory, _by_uploader(cast, await _person_id(db_session_factory, BYSTANDER))
    )
    missing_url = await _url(client, co_host, MISSING_ID)

    assert _ids(await _list(client, co_host, cast.gathering_id)) == [own]
    refused = await _url(client, co_host, waiting)
    assert (refused.status_code, refused.json()) == (404, missing_url.json())
    assert (await _url(client, co_host, own)).status_code == 200
    queue = await _queue(client, co_host, cast.gathering_id)
    assert queue.status_code == 404
    for media_id in (waiting, own):
        for act in (_publish, _decline):
            refused = await act(client, co_host, media_id)
            missing = await act(client, co_host, MISSING_ID)
            assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__
    batch = await client.post(
        f"/gatherings/{cast.gathering_id}/media/publish",
        json={"media_ids": [waiting, own]},
        headers=co_host,
    )
    assert batch.status_code == 404
    for media_id in (waiting, own):
        status, state, *_ = await _state(db_session_factory, media_id)
        assert (status, state) == (MediaStatus.READY, PublicationState.PENDING)
    # The host: sees both, and the queue holds both.
    assert set(_ids(await _queue(client, cast.host, cast.gathering_id))) == {waiting, own}
    assert (await _publish(client, cast.host, waiting)).status_code == 200


async def test_a_co_host_takes_a_published_photograph_down_into_the_gatherings_bin(
    client, capsys, db_session_factory
):
    """Moderation is delegable (two-bins §4): the co-host's `remove` on
    someone else's `live` photograph lands it in the GATHERING's bin with
    the co-host as remover — the host and the co-host both read it there
    (the bin view, `/url`), the uploader sees nothing and draws the 404 on
    every act; nothing is destroyed and no count moves. A `pending` row is
    not the co-host's to remove (they cannot see it — the 404); the
    co-host's own upload goes to their personal bin, as anyone's does."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    co_host_person = await _person_id(db_session_factory, BYSTANDER)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    waiting = await _photograph(db_session_factory, cast)
    own = await _photograph(
        db_session_factory, _by_uploader(cast, co_host_person), publication_state=PublicationState.LIVE
    )
    before = await _resync_counts(db_session_factory, cast.gathering_id)

    taken = await _remove(client, co_host, live)
    assert taken.status_code == 200, taken.text
    status, state, removed_at, removed_by, *_ = await _state(db_session_factory, live)
    assert (status, state) == (MediaStatus.READY, PublicationState.REMOVED)
    assert removed_at is not None and removed_by == co_host_person
    for headers in (cast.host, co_host):
        assert _ids(await _bin_view(client, headers, cast.gathering_id)) == [live]
        assert live not in _ids(await _list(client, headers, cast.gathering_id))
        assert (await _url(client, headers, live)).status_code == 200
    assert live not in _ids(await _list(client, cast.uploader, cast.gathering_id))
    for act in (_url, _restore, _destroy):
        refused = await act(client, cast.uploader, live)
        missing = await act(client, cast.uploader, MISSING_ID)
        assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)

    # A pending row: not visible, so not removable — the 404, not a 409.
    refused = await _remove(client, co_host, waiting)
    assert (refused.status_code, refused.json()) == (404, (await _remove(client, co_host, MISSING_ID)).json())
    # Their own: the personal bin (in their default list, `is_own`; not the
    # gathering's bin view).
    assert (await _remove(client, co_host, own)).status_code == 200
    items = {m["id"]: m for m in (await _list(client, co_host, cast.gathering_id)).json()["media"]}
    assert items[own]["is_own"] is True and items[own]["publication_state"] == "removed"
    assert _ids(await _bin_view(client, co_host, cast.gathering_id)) == [live]
    assert await _counts(db_session_factory, cast.gathering_id) == before


async def test_a_co_host_may_not_destroy_anyones_photograph_but_their_own(
    client, capsys, db_session_factory
):
    """Emptying and permanent delete stay the host's (two-bins §4; co-hosts
    §4 as amended): the co-host's `destroy` on a live photograph, on a
    gathering-bin row they can read — one they removed themselves — and
    on a host-removed row each draws the media 404 byte-identical to a
    missing id; nothing is marked and no count moves. Their own upload
    they destroy as any uploader does. The host still empties."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    by_co_host = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    by_host = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    own = await _photograph(
        db_session_factory,
        _by_uploader(cast, await _person_id(db_session_factory, BYSTANDER)),
        publication_state=PublicationState.LIVE,
    )
    assert (await _remove(client, co_host, by_co_host)).status_code == 200
    assert (await _remove(client, cast.host, by_host)).status_code == 200
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    missing = await _destroy(client, co_host, MISSING_ID)
    assert set(_ids(await _bin_view(client, co_host, cast.gathering_id))) == {by_co_host, by_host}

    for media_id in (live, by_co_host, by_host):
        refused = await _destroy(client, co_host, media_id)
        assert (refused.status_code, refused.json()) == (404, missing.json()), media_id
        assert (await _row(db_session_factory, media_id)).status is MediaStatus.READY
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)

    assert (await _destroy(client, co_host, own)).status_code == 200
    assert (await _row(db_session_factory, own)).status is MediaStatus.DESTROYING
    assert (await _destroy(client, cast.host, by_co_host)).status_code == 200
    assert (await _row(db_session_factory, by_co_host)).status is MediaStatus.DESTROYING
    assert await _counts(db_session_factory, cast.gathering_id) == (before[0] - 2, before[1] - 2 * (
        before[1] // before[0]
    ))
    await _invariants_hold(db_session_factory, cast.gathering_id)


async def test_a_co_hosts_restore_passes_through_the_gate(client, capsys, db_session_factory):
    """Only the host's restore is the host's approval (two-bins §4). OPEN:
    the co-host's restore of a gathering-bin row goes `live` — an existing
    publication stamp kept whole, a never-published row stamped now with a
    NULL publisher (the rule published it, not a person). GATED: `pending`,
    both stamps cleared, back in the HOST's queue — and out of the
    co-host's own sight, because `pending` is reserved; the host's restore
    of another row in the same gated gathering still goes `live`. No count
    moves on any of it; the four stamp invariants hold after every act."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    host_person = await _host_person_id(db_session_factory)
    published = _now() - timedelta(days=3)
    stamped = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _stamp_published(db_session_factory, stamped, published, host_person)
    unstamped = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    for media_id in (stamped, unstamped):
        assert (await _remove(client, cast.host, media_id)).status_code == 200

    # OPEN (every gathering inherits open).
    t0 = _now()
    for media_id in (stamped, unstamped):
        response = await _restore(client, co_host, media_id)
        assert response.status_code == 200, response.text
        assert response.json()["publication_state"] == "live"
    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, stamped)
    assert (status, state, removed_at, removed_by) == (MediaStatus.READY, PublicationState.LIVE, None, None)
    assert (published_at, publisher) == (published, host_person)  # kept whole
    *_, published_at, publisher = await _state(db_session_factory, unstamped)
    assert published_at is not None and abs((published_at - t0).total_seconds()) < 60
    assert publisher is None  # the rule published it — never the co-host
    for headers in (cast.uploader, cast.keeper, co_host, cast.host):
        assert set(_ids(await _list(client, headers, cast.gathering_id))) == {stamped, unstamped}
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _stamp_invariants_hold(db_session_factory)

    # GATED: review turned on after the removal.
    for media_id in (stamped, unstamped):
        assert (await _remove(client, co_host, media_id)).status_code == 200
    await _gate(db_session_factory, cast, True)
    response = await _restore(client, co_host, stamped)
    assert response.status_code == 200, response.text
    assert response.json()["publication_state"] == "pending"
    status, state, removed_at, removed_by, published_at, publisher = await _state(db_session_factory, stamped)
    assert (status, state, removed_at, removed_by) == (MediaStatus.READY, PublicationState.PENDING, None, None)
    assert (published_at, publisher) == (None, None)  # both cleared
    assert _ids(await _queue(client, cast.host, cast.gathering_id)) == [stamped]
    # Reserved: the co-host who put it back cannot see it now.
    assert stamped not in _ids(await _list(client, co_host, cast.gathering_id))
    assert (await _url(client, co_host, stamped)).status_code == 404
    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [stamped]  # the uploader can
    # The host's restore in the same gated gathering: live, unchanged rule
    # — and the pair KEPT WHOLE: the co-host's open restore above stamped
    # this row with a NULL publisher (the rule published it), and the
    # host's restore re-dates nothing and fills in no blank.
    response = await _restore(client, cast.host, unstamped)
    assert response.status_code == 200, response.text
    assert response.json()["publication_state"] == "live"
    *_, published_at, publisher = await _state(db_session_factory, unstamped)
    assert published_at is not None and publisher is None
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)
    await _stamp_invariants_hold(db_session_factory)


# --- what co-hosting does not touch -------------------------------------------------


async def test_the_keeper_and_the_upload_are_unaffected(client, capsys, db_session_factory):
    """A co-host uploads as any invitee does (co-hosts §8: "media upload
    is not affected and was never admin-gated"), and the reservation lands
    on the KEEPER's allowance, never the co-host's; the keeper gains
    nothing from co-hosts existing — no bin, no takedown, no list, no
    patch — and keeps everything they had (the read, the upload)."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    async with db_session_factory() as db:
        keeper = await _account_for(db, KEEPER)
        co_host_account = await _account_for(db, BYSTANDER)
        keeper_before = await keeping.account_usage(db, keeper)
        assert await keeping.account_usage(db, co_host_account) == 0

    intents = await _intents(client, co_host, cast.gathering_id, [_item(), _item()])
    assert intents.status_code == 201, intents.text
    async with db_session_factory() as db:
        keeper = await _account_for(db, KEEPER)
        co_host_account = await _account_for(db, BYSTANDER)
        assert await keeping.account_usage(db, keeper) == keeper_before + 2
        assert await keeping.account_usage(db, co_host_account) == 0

    missing_404 = await _gathering_404(client, cast.keeper)
    for response in (
        await _patch_title(client, cast.keeper, cast.gathering_id, "Hijacked"),
        await _co_hosts(client, cast.keeper, cast.gathering_id),
    ):
        assert (response.status_code, response.json()) == (404, missing_404)
    refused = await _remove(client, cast.keeper, live)
    assert (refused.status_code, refused.json()) == (404, (await _remove(client, cast.keeper, MISSING_ID)).json())
    assert (await _remove(client, co_host, live)).status_code == 200
    view = await _bin_view(client, cast.keeper, cast.gathering_id)
    assert (view.status_code, _ids(view)) == (200, [])
    assert (await _detail(client, cast.keeper, cast.gathering_id)).status_code == 200
    assert (await _intents(client, cast.keeper, cast.gathering_id, [_item()])).status_code == 201


async def test_account_deletion_drops_the_deleted_accounts_co_host_rows_and_keeps_the_rows_it_added(
    client, capsys, db_session_factory
):
    """Co-hosting ends with the account (co-hosts §8): the co-host deletes
    theirs and their row is gone in the same transaction, on every
    gathering they co-hosted. The HOST deleting theirs relinquishes host
    (the claimable state) and leaves the co-host row standing, its
    `added_by_account_id` still the anonymized host's account — provenance
    is retained, and a co-host persists when the host relinquishes
    (co-hosts §7, provisionally)."""
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        host_account = (await _account_for(db, HOST)).id
        co_host_account = (await _account_for(db, BYSTANDER)).id
    # A second gathering the co-host also co-hosts.
    other = await _create(client, cast.host, title="The other one")
    token = await _invite_token(client, capsys, cast.host, other["id"], BYSTANDER)
    await _accept(client, cast.bystander, token)
    other_invitation = await _invitation_id(db_session_factory, other["id"], BYSTANDER)
    assert (await _add(client, cast.host, other["id"], other_invitation)).status_code == 201
    # And a co-host of the first gathering who stays: the uploader.
    uploader_invitation = await _invitation_id(db_session_factory, cast.gathering_id, UPLOADER)
    assert (await _add(client, cast.host, cast.gathering_id, uploader_invitation)).status_code == 201
    async with db_session_factory() as db:
        uploader_account = (await _account_for(db, UPLOADER)).id

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=cast.bystander)).status_code == 204
    assert await _rows(db_session_factory, cast.gathering_id) == [(uploader_account, host_account)]
    assert await _rows(db_session_factory, other["id"]) == []
    listed = await _co_hosts(client, cast.host, cast.gathering_id)
    assert [c["invitation_id"] for c in listed.json()["co_hosts"]] == [uploader_invitation]

    assert (await client.post("/me/delete", json=DELETE_BODY, headers=cast.host)).status_code == 204
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(cast.gathering_id))
        assert gathering.host_account_id is None
    assert await _rows(db_session_factory, cast.gathering_id) == [(uploader_account, host_account)]
    # The surviving co-host still organises the now-hostless gathering.
    assert (await _patch_title(client, cast.uploader, cast.gathering_id, "Carried on")).status_code == 200


async def test_a_co_host_row_on_a_hostless_gathering_still_organises_and_nobody_is_host(
    client, capsys, db_session_factory
):
    """co-hosts §7's first item, provisionally: the host relinquished (the
    claimable state — NULL), the co-host still edits, invites and reads the
    list, while the FORMER host draws the gathering 404 on every organiser
    route and `caller_role` reads null for them; and nobody is host — the
    switch is nobody's (the co-host's 422 stands), the co-host cannot add
    or remove co-hosts (the gathering 404 — the add is the host's alone),
    and nothing reserved is reachable."""
    cast, invitation_id = await _co_hosted(client, capsys, db_session_factory)
    co_host = cast.bystander
    uploader_invitation = await _invitation_id(db_session_factory, cast.gathering_id, UPLOADER)
    async with db_session_factory() as db:
        gathering = await db.get(Gathering, UUID(cast.gathering_id))
        # The deploy's shape: the creator keeps the gathering and the host
        # is relinquished — so the former host still READS it (as its
        # keeper) and organises nothing. (The cast had moved the keeper
        # column to KEEPER; moved back for this test alone.)
        gathering.host_account_id = None
        gathering.keeper_account_id = (await _account_for(db, HOST)).id
        await db.commit()

    assert (await _detail(client, co_host, cast.gathering_id)).json()["caller_role"] == "co_host"
    assert (await _detail(client, cast.host, cast.gathering_id)).json()["caller_role"] is None
    assert (await _patch_title(client, co_host, cast.gathering_id, "Carried on")).status_code == 200
    assert (await _invite(client, co_host, cast.gathering_id, "new@example.com")).status_code == 201
    assert (await _co_hosts(client, co_host, cast.gathering_id)).status_code == 200
    former = await _gathering_404(client, cast.host)
    for response in (
        await _patch_title(client, cast.host, cast.gathering_id, "Reclaimed"),
        await _co_hosts(client, cast.host, cast.gathering_id),
        await _add(client, cast.host, cast.gathering_id, uploader_invitation),
    ):
        assert (response.status_code, response.json()) == (404, former)
    refused = await client.patch(
        f"/gatherings/{cast.gathering_id}",
        json={"requires_approval_override": True},
        headers=co_host,
    )
    assert refused.status_code == 422 and _field_errors(refused) == {"requires_approval_override"}
    refused = await _add(client, co_host, cast.gathering_id, uploader_invitation)
    assert (refused.status_code, refused.json()) == (404, await _gathering_404(client, co_host))
    # Stepping down still works without a host.
    assert (await _drop(client, co_host, cast.gathering_id, invitation_id)).status_code == 204
    assert await _rows(db_session_factory, cast.gathering_id) == []


# --- the verifier -------------------------------------------------------------------


async def test_the_verifier_asserts_the_relations_shape_and_that_no_co_host_is_the_host(
    client, capsys, db_session_factory
):
    """scripts/verify_schema.py's fourteen CK-68 lines, run as the operator
    runs it — a fresh interpreter against the test database — on a clean
    baseline holding one real co-host row, then on a planted row naming
    the gathering's own host (written around the endpoint, which refuses
    it), then clean again. The total is pinned as a number (the CK-57
    convention: 197 → 211). A PLANT IS NOT EVIDENCE UNTIL SOMETHING
    INDEPENDENT OF THE ASSERTION CONFIRMS THE ROW EXISTS (CK-56's lesson)."""
    exclusive = "no co-host row names its gathering's own host (host and co-host are exclusive)"
    cast, _ = await _co_hosted(client, capsys, db_session_factory)
    async with db_session_factory() as db:
        host_account = (await _account_for(db, HOST)).id

    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (211, 0, 0), out
    for line in (
        "table gathering_co_hosts exists",
        "gathering_co_hosts primary key is (gathering_id, account_id)",
        "gathering_co_hosts.added_by_account_id has no delete rule",
        "index ix_gathering_co_hosts_account_id exists on gathering_co_hosts.account_id",
        exclusive,
    ):
        assert f"PASS  {line}" in out, line
    assert "INFO  gathering_co_hosts rows: 1" in out

    async with db_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO gathering_co_hosts (gathering_id, account_id, added_by_account_id) "
                "VALUES (:g, :a, :a)"
            ),
            {"g": UUID(cast.gathering_id), "a": host_account},
        )
        await db.commit()
        planted = await db.scalar(
            text(
                "SELECT count(*) FROM gathering_co_hosts c JOIN gatherings g ON g.id = c.gathering_id "
                "WHERE g.host_account_id = c.account_id"
            )
        )
        assert planted == 1, "the plant did not land"
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (210, 1, 1), out
    assert f"FAIL  {exclusive}" in out and "1 co-host row(s) naming the gathering's host" in out

    async with db_session_factory() as db:
        await db.execute(
            text("DELETE FROM gathering_co_hosts WHERE gathering_id = :g AND account_id = :a"),
            {"g": UUID(cast.gathering_id), "a": host_account},
        )
        await db.commit()
    assert _verifier()[:3] == (211, 0, 0)


async def test_co_host_management_logs_nothing_at_debug(client, capsys, db_session_factory, caplog):
    """A co-host list is a roster: with the root logger at DEBUG, the add,
    the list and the remove put no display name, no address and no id into
    any application log record."""
    cast = await _cast(client, capsys, db_session_factory)
    invitation_id = await _invitation_id(db_session_factory, cast.gathering_id, BYSTANDER)
    display_name = (await client.get("/auth/me", headers=cast.bystander)).json()["display_name"]
    with caplog.at_level(logging.DEBUG):
        assert (await _add(client, cast.host, cast.gathering_id, invitation_id)).status_code == 201
        assert (await _co_hosts(client, cast.host, cast.gathering_id)).status_code == 200
        assert (await _drop(client, cast.host, cast.gathering_id, invitation_id)).status_code == 204
    # The invitation id rides the request LINE of the DELETE — the
    # transport's record (httpx here, the access log on Render), as every
    # path is (the api-reference's rule for `q`) — so it is not asserted
    # absent; no APPLICATION record exists at all, and no name or address
    # reaches any record.
    assert display_name not in caplog.text
    assert BYSTANDER not in caplog.text and HOST not in caplog.text
    assert not any(record.name.startswith(("app", "covey-keep")) for record in caplog.records)
