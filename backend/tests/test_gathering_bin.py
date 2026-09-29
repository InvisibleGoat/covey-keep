"""CK-66 — the gathering's bin: the host reads it, restores from it, and
empties it, one photograph at a time
(decisions/2026-09-27-two-bins.md §1 and §4; no migration — head 0026).

The cast and the row-planting are test_media_reads' (host, uploader,
keeper, bystander, stranger), the counts and invariants test_destruction's,
and the restore helpers test_removal_attribution's, because everything here
runs inside CK-37's audience rule, CK-54's counting rules and CK-63's
attribution — and then widens exactly one seat: the host's.

The load-bearing pins:
- the bin view (`removed=true` on the list) shows the HOST the rows
  someone other than the uploader removed — a removal of someone else's,
  and a decline — and nothing else: not the uploader's personal bin, not
  the host's own self-removed row, not a NULL-remover row, not a live row;
- the DEFAULT list excludes gathering-bin rows (the bin is a view, never a
  mixture), while the uploader's personal-bin rows keep appearing in their
  default list exactly as at CK-64;
- a NON-HOST passing `removed=true` gets an EMPTY LIST, never a refusal
  that confirms the bin exists — deliberately not the queue's 404;
- a guest upload (NULL uploader) the host removed IS in the bin — the
  `IS DISTINCT FROM` case, which `!=` would silently hide;
- the two flags together (`removed` + `awaiting_review`) are a 422;
- `q` composes with the bin view and never reaches past it;
- the uploader of a gathering-bin row still gets the media 404
  byte-identical to a missing id on `/url`, `/restore` and `/destroy`;
- HOST RESTORE goes `live` WHATEVER the gate says — review is the host's,
  so putting it back IS approving it (two-bins §4): the publication pair
  is kept whole where `published_at` is set (a rule-published row keeps
  its NULL publisher), and a declined, never-published row is stamped now
  with THE HOST's person id — a person published it, not the rule;
- no count moves on a host restore, and the verifier's four stamp
  invariants hold as SQL after every act;
- host destroy from the gathering's bin frees the row and it leaves both
  views — emptying, one photograph at a time;
- a host restore losing the race to the sweep is the lost-race 409 and
  changes nothing.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.api import media as media_api
from app.api.media import ALREADY_REMOVED, NOT_PENDING
from app.models import Gathering, Media, MediaDerivative, MediaStatus, PublicationState
from app.services import destruction
from app.services.retention import REMOVED_BIN
from app.services.storage import published_key
from tests.test_destruction import (
    LAYER_BYTES,
    _counts,
    _destroy,
    _invariants_hold,
    _remove,
    _resync_counts,
    _row,
)
from tests.test_media_reads import (
    LAYER_SPECS,
    MISSING_ID,
    Cast,
    _cast,
    _ids,
    _list,
    _photograph,
    _url,
)
from tests.test_removal_attribution import _gate, _restore, _stamp_published, _state
from tests.test_review import _decline, _host_person_id, _hosts_own_photograph, _queue


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _bin_view(client, headers, gathering_id: str, **params):
    return await client.get(
        f"/gatherings/{gathering_id}/media",
        params={"removed": "true", **params},
        headers=headers,
    )


async def _guest_photograph(
    db_session_factory, cast: Cast, *, removed_at: datetime, removed_by_person_id
) -> str:
    """A `ready` + `removed` row with NO uploader person — a guest upload
    (guest uploads have no surface yet, but the columns and the
    `identity_present` CHECK have been real since 0001, and the read rule
    must not lose one). The remover is the test's to say; the point of the
    shape is that `removed_by != uploader` is NULL against a NULL
    uploader, so only `IS DISTINCT FROM` keeps such a row in the bin."""
    async with db_session_factory() as db:
        row = Media(
            gathering_id=cast.gathering_id,
            uploader_person_id=None,
            guest_name="Cousin Ana",
            upload_content_type="image/jpeg",
            upload_size_bytes=900_000,
            status=MediaStatus.READY,
            publication_state=PublicationState.REMOVED,
            removed_at=removed_at,
            removed_by_person_id=removed_by_person_id,
            created_at=_now(),
            uploaded_at=_now(),
        )
        db.add(row)
        await db.flush()
        for layer, (content_type, size, storage_class) in LAYER_SPECS.items():
            db.add(
                MediaDerivative(
                    media_id=row.id,
                    layer=layer,
                    storage_key=published_key(row.id, layer),
                    content_type=content_type,
                    size_bytes=size,
                    storage_class=storage_class,
                )
            )
        await db.commit()
        return str(row.id)


# The verifier's four stamp invariants (scripts/verify_schema.py — the
# CK-43 publication pair and the CK-63 removal pair), as the SQL the
# verifier runs. A host restore writes the publication pair and clears the
# removal pair in one statement, and every one of these must survive every
# act below — the kickoff's requirement, checked rather than reasoned
# about (the _invariants_hold discipline).
_STAMP_INVARIANTS = {
    "every media row with a publisher carries a published_at": (
        "SELECT count(*) FROM media "
        "WHERE published_by_person_id IS NOT NULL AND published_at IS NULL"
    ),
    "no pending media row carries a published_at": (
        "SELECT count(*) FROM media "
        "WHERE published_at IS NOT NULL AND publication_state = 'pending'"
    ),
    "every media row with a remover carries a removed_at": (
        "SELECT count(*) FROM media "
        "WHERE removed_by_person_id IS NOT NULL AND removed_at IS NULL"
    ),
    "no live or pending media row carries a remover": (
        "SELECT count(*) FROM media "
        "WHERE removed_by_person_id IS NOT NULL "
        "AND publication_state IN ('live', 'pending')"
    ),
}


async def _stamp_invariants_hold(db_session_factory) -> None:
    async with db_session_factory() as db:
        for label, sql in _STAMP_INVARIANTS.items():
            assert await db.scalar(text(sql)) == 0, label


# --- the bin view ---------------------------------------------------------------


async def test_the_host_lists_the_gatherings_bin_and_only_its_rows(
    client, capsys, db_session_factory
):
    """`removed=true` is the gathering's bin: the row the host removed from
    someone else and the one they declined, each with its clock — and
    nothing else. The DEFAULT list excludes them in the same breath (the
    bin is a view, never a mixture), and `remove` on a bin row now draws
    `already_removed` rather than the 404 an invisible row drew."""
    cast = await _cast(client, capsys, db_session_factory)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    waiting = await _photograph(db_session_factory, cast)  # ready + pending
    assert (await _remove(client, cast.uploader, mine)).status_code == 200
    assert (await _remove(client, cast.host, theirs)).status_code == 200
    assert (await _decline(client, cast.host, waiting)).status_code == 200

    view = await _bin_view(client, cast.host, cast.gathering_id)
    assert set(_ids(view)) == {theirs, waiting}
    assert all(item["removed_at"] is not None for item in view.json()["media"])
    # The default list: the live row alone — no gathering-bin row mixed in,
    # and the uploader's personal bin was never the host's to see.
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == [live]
    # A bin row is already in the bin: the refusal, not a re-stamp — and
    # not the 404 the invisible row drew before CK-66.
    refused = await _remove(client, cast.host, theirs)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == ALREADY_REMOVED


async def test_the_uploader_gets_nothing_of_the_gatherings_bin(
    client, capsys, db_session_factory
):
    """Two-bins §2, unchanged by this phase: from the uploader's side a
    moderation removal is gone from the gathering. Their default list keeps
    their own personal bin (CK-64's surface depends on it); the bin view is
    a 200 and an EMPTY list — never a refusal that confirms the bin exists,
    and never their personal-bin row, which is not the gathering's; and the
    three acts on a host-removed row draw the media 404 byte-identical to
    a missing id, per act."""
    cast = await _cast(client, capsys, db_session_factory)
    mine = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    assert (await _remove(client, cast.uploader, mine)).status_code == 200
    assert (await _remove(client, cast.host, theirs)).status_code == 200

    assert _ids(await _list(client, cast.uploader, cast.gathering_id)) == [mine]
    view = await _bin_view(client, cast.uploader, cast.gathering_id)
    assert (view.status_code, _ids(view)) == (200, [])
    for act in (_url, _restore, _destroy):
        refused = await act(client, cast.uploader, theirs)
        missing = await act(client, cast.uploader, MISSING_ID)
        assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__


async def test_a_keeper_an_invitee_and_a_stranger_see_nothing_in_either_view(
    client, capsys, db_session_factory
):
    cast = await _cast(client, capsys, db_session_factory)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    assert (await _remove(client, cast.host, theirs)).status_code == 200

    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        view = await _bin_view(client, headers, cast.gathering_id)
        assert (view.status_code, _ids(view)) == (200, [])
        assert (await _url(client, headers, theirs)).status_code == 404
    # A stranger draws the gathering 404 one door earlier, on both views.
    for params in ({}, {"removed": "true"}):
        refused = await client.get(
            f"/gatherings/{cast.gathering_id}/media", params=params, headers=cast.stranger
        )
        assert refused.status_code == 404


async def test_a_null_remover_row_is_in_nobodys_bin_view(client, capsys, db_session_factory):
    """A row removed before 0026 has no recorded remover, and CK-63's rule
    stands under CK-66: it is in NOBODY's bin — not listed in the host's
    bin view, not in any default list, not openable, not restorable. The
    two 2026-09-14 declines stay exactly where they are."""
    cast = await _cast(client, capsys, db_session_factory)
    legacy = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - timedelta(days=1),
    )
    assert (await _row(db_session_factory, legacy)).removed_by_person_id is None

    view = await _bin_view(client, cast.host, cast.gathering_id)
    assert (view.status_code, _ids(view)) == (200, [])
    for headers in (cast.host, cast.uploader, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == []
        for act in (_url, _restore, _destroy):
            refused = await act(client, headers, legacy)
            missing = await act(client, headers, MISSING_ID)
            assert (refused.status_code, refused.json()) == (404, missing.json()), act.__name__


async def test_a_guest_uploads_removed_row_is_in_the_gatherings_bin(
    client, capsys, db_session_factory
):
    """THE `IS DISTINCT FROM` CASE. A guest upload has a NULL uploader, and
    `removed_by != NULL` is NULL — a criterion written with `!=` would
    silently drop the guest's removed photograph out of the host's bin,
    which is exactly the row a host most needs a way back to (no uploader
    exists to re-upload it). It lists, opens, and restores — the guarded
    UPDATE carries the same predicate, so the restore is the second place
    `!=` would have broken."""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    guest = await _guest_photograph(
        db_session_factory,
        cast,
        removed_at=_now() - timedelta(hours=1),
        removed_by_person_id=host_person,
    )

    view = await _bin_view(client, cast.host, cast.gathering_id)
    assert _ids(view) == [guest]
    item = view.json()["media"][0]
    assert item["is_own"] is False
    assert item["uploader_display_name"] == "Cousin Ana"
    assert (await _url(client, cast.host, guest)).status_code == 200
    # And the way back works for it: live, stamped now by the host (it was
    # never published — a person published it, not the rule).
    restored = await _restore(client, cast.host, guest)
    assert restored.status_code == 200, restored.text
    status, state, removed_at, removed_by, published_at, publisher = await _state(
        db_session_factory, guest
    )
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert (removed_at, removed_by) == (None, None)
    assert published_at is not None and publisher == host_person
    await _stamp_invariants_hold(db_session_factory)


async def test_the_hosts_own_removal_is_their_personal_bin_not_the_gatherings(
    client, capsys, db_session_factory
):
    """A host removing THEIR OWN upload is its uploader and its remover, so
    the row is in their PERSONAL bin: their default list carries it (the
    CK-64 surface), and the gathering's bin view does not."""
    cast = await _cast(client, capsys, db_session_factory)
    hosts_own = await _hosts_own_photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    assert (await _remove(client, cast.host, hosts_own)).status_code == 200

    assert (await _bin_view(client, cast.host, cast.gathering_id)).json()["media"] == []
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == [hosts_own]


async def test_the_two_views_cannot_be_combined(client, capsys, db_session_factory):
    """`removed=true` with `awaiting_review=true` is a 422 on the query —
    a photograph cannot be awaiting review and in the bin at once, and a
    combined view would have to invent which criterion wins. The same 422
    for a non-host in the audience (it confirms nothing about either
    view); a stranger still draws the gathering 404 one door earlier."""
    cast = await _cast(client, capsys, db_session_factory)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    assert (await _remove(client, cast.host, theirs)).status_code == 200

    refused = await _bin_view(client, cast.host, cast.gathering_id, awaiting_review="true")
    assert refused.status_code == 422, refused.text
    (error,) = refused.json()["detail"]
    assert error["loc"] == ["query", "removed"]
    assert (
        await _bin_view(client, cast.uploader, cast.gathering_id, awaiting_review="true")
    ).status_code == 422
    assert (
        await _bin_view(client, cast.stranger, cast.gathering_id, awaiting_review="true")
    ).status_code == 404
    # Nothing about the row moved on any of it.
    assert (await _state(db_session_factory, theirs))[1] is PublicationState.REMOVED


async def test_search_composes_with_the_bin_view_and_never_reaches_past_it(
    client, capsys, db_session_factory
):
    """`q` narrows the bin view the way it narrows everything (CK-39: the
    search runs inside the audience filter, never beside it) — and a term
    matching a LIVE photograph returns nothing here, because the bin view
    is rows in the gathering's bin and nothing else."""
    cast = await _cast(client, capsys, db_session_factory)
    a = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    b = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    async with db_session_factory() as db:
        (await db.get(Media, a)).caption = "Grandma at the yard"
        (await db.get(Media, b)).caption = "Tommy at bat"
        (await db.get(Media, live)).caption = "yard sale"
        await db.commit()
    assert (await _remove(client, cast.host, a)).status_code == 200
    assert (await _remove(client, cast.host, b)).status_code == 200

    assert set(_ids(await _bin_view(client, cast.host, cast.gathering_id))) == {a, b}
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id, q="yard")) == [a]
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id, q="bat")) == [b]
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id, q="sale")) == []


# --- host restore ---------------------------------------------------------------


async def test_host_restore_in_an_open_gathering_goes_live_with_the_stamps_kept(
    client, capsys, db_session_factory
):
    """The way back from the gathering's bin (two-bins §4, CK-66). The
    gathering resolves open; a host-published row and a RULE-published one
    (publisher NULL — the worker's convention) each go back `live` with
    the publication pair EXACTLY as it was: going to the bin and back
    re-dates nothing, and a NULL publisher is a recorded fact ("the rule
    published this"), never a blank for the restore to fill in. Both
    removal columns clear; no count moves; the four stamp invariants
    hold."""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    published = _now() - timedelta(days=3)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _stamp_published(db_session_factory, theirs, published, host_person)
    rule_published = await _photograph(
        db_session_factory, cast, publication_state=PublicationState.LIVE
    )
    await _stamp_published(db_session_factory, rule_published, published, None)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.host, theirs)).status_code == 200
    assert (await _remove(client, cast.host, rule_published)).status_code == 200

    response = await _restore(client, cast.host, theirs)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["publication_state"]) == ("ready", "live")
    status, state, removed_at, removed_by, published_at, publisher = await _state(
        db_session_factory, theirs
    )
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert (removed_at, removed_by) == (None, None)
    assert (published_at, publisher) == (published, host_person)  # kept, not re-dated

    assert (await _restore(client, cast.host, rule_published)).status_code == 200
    *_, published_at, publisher = await _state(db_session_factory, rule_published)
    assert (published_at, publisher) == (published, None)  # the pair kept WHOLE

    # Live again for the whole read audience; the stranger still 404.
    for headers in (cast.uploader, cast.host, cast.keeper, cast.bystander):
        assert set(_ids(await _list(client, headers, cast.gathering_id))) == {theirs, rule_published}
        assert (await _url(client, headers, theirs)).status_code == 200
    assert (await _url(client, cast.stranger, theirs)).status_code == 404
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)
    await _stamp_invariants_hold(db_session_factory)


async def test_host_restore_goes_live_even_where_the_gathering_is_gated(
    client, capsys, db_session_factory
):
    """THE INVERSION OF THE UPLOADER'S RULE, decided (two-bins §4): only a
    restore by someone OTHER than the host passes back through the gate.
    Review is the host's, so the host putting a photograph back IS the
    host approving it — `live`, never `pending`, and nothing lands in
    their own queue for them to decide twice. (The uploader's restore in
    the same gathering still goes `pending` —
    test_removal_attribution.py's gated case, unedited.)"""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    published = _now() - timedelta(days=3)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _stamp_published(db_session_factory, theirs, published, host_person)
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.host, theirs)).status_code == 200
    # Review turned ON after the removal: for an uploader this would mean
    # `pending`; for the host it must not.
    await _gate(db_session_factory, cast, True)

    response = await _restore(client, cast.host, theirs)
    assert response.status_code == 200, response.text
    assert response.json()["publication_state"] == "live"
    status, state, removed_at, removed_by, published_at, publisher = await _state(
        db_session_factory, theirs
    )
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert (removed_at, removed_by) == (None, None)
    assert (published_at, publisher) == (published, host_person)
    # Nothing waits: the queue is empty, and the row is live for the
    # gathering's read audience.
    assert _ids(await _queue(client, cast.host, cast.gathering_id)) == []
    for headers in (cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [theirs]
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _stamp_invariants_hold(db_session_factory)


async def test_host_restore_of_a_declined_never_published_row_stamps_now_with_the_host(
    client, capsys, db_session_factory
):
    """The case the publisher rule exists for: a declined photograph was
    never published, so its pair is (NULL, NULL) — and a host restore
    publishes it, so the pair is stamped NOW, with THE HOST's person id:
    a person published it, not the rule (the kickoff's step 3). Everyone
    in the read audience sees it; no count moves; the invariants hold."""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    waiting = await _photograph(db_session_factory, cast)  # ready + pending, unstamped
    before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _decline(client, cast.host, waiting)).status_code == 200

    t0 = _now()
    response = await _restore(client, cast.host, waiting)
    assert response.status_code == 200, response.text
    assert response.json()["publication_state"] == "live"
    status, state, removed_at, removed_by, published_at, publisher = await _state(
        db_session_factory, waiting
    )
    assert (status, state) == (MediaStatus.READY, PublicationState.LIVE)
    assert (removed_at, removed_by) == (None, None)
    assert published_at is not None and abs((published_at - t0).total_seconds()) < 60
    assert publisher == host_person  # a person published it, not the rule
    for headers in (cast.uploader, cast.keeper, cast.bystander):
        assert _ids(await _list(client, headers, cast.gathering_id)) == [waiting]
    assert await _counts(db_session_factory, cast.gathering_id) == before
    await _invariants_hold(db_session_factory, cast.gathering_id)
    await _stamp_invariants_hold(db_session_factory)


async def test_host_restore_past_the_window_or_by_anyone_else_draws_the_404(
    client, capsys, db_session_factory
):
    """The bin has closed, or the caller is not its reader: the media 404,
    byte-identical to a missing id, and nothing moves. Past the window the
    HOST draws it too — the way back closes at REMOVED_BIN for both bins
    (two-bins §1.5). On a fresh gathering-bin row, a keeper, a second
    invitee, a stranger and THE UPLOADER each draw it — the uploader's
    exclusion is two-bins §2's whole point."""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    expired = await _photograph(
        db_session_factory,
        cast,
        publication_state=PublicationState.REMOVED,
        removed_at=_now() - REMOVED_BIN - timedelta(minutes=1),
        removed_by_person_id=host_person,
    )
    fresh = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    assert (await _remove(client, cast.host, fresh)).status_code == 200

    gone = await _restore(client, cast.host, expired)
    missing = await _restore(client, cast.host, MISSING_ID)
    assert (gone.status_code, gone.json()) == (404, missing.json())
    for headers in (cast.keeper, cast.bystander, cast.stranger, cast.uploader):
        refused = await _restore(client, headers, fresh)
        missing = await _restore(client, headers, MISSING_ID)
        assert (refused.status_code, refused.json()) == (404, missing.json())
    assert (await _state(db_session_factory, fresh))[1] is PublicationState.REMOVED
    assert (await _state(db_session_factory, expired))[1] is PublicationState.REMOVED


# --- host destroy: emptying, one photograph at a time ----------------------------


async def test_host_destroy_from_the_gatherings_bin_frees_it_and_it_leaves_both_views(
    client, capsys, db_session_factory
):
    """Emptying the gathering's bin is `destroy`, one photograph at a time
    (the kickoff's rule: no bulk empty). The mark frees the count and the
    bytes together, the verifier's two count invariants hold, and the row
    is gone from the bin view AND the default list at once — a row in
    destruction is visible to nobody."""
    cast = await _cast(client, capsys, db_session_factory)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    live = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    count_before, bytes_before = await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.host, theirs)).status_code == 200
    assert await _counts(db_session_factory, cast.gathering_id) == (count_before, bytes_before)
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id)) == [theirs]

    assert (await _destroy(client, cast.host, theirs)).status_code == 200
    assert (await _row(db_session_factory, theirs)).status is MediaStatus.DESTROYING
    assert await _counts(db_session_factory, cast.gathering_id) == (
        count_before - 1,
        bytes_before - LAYER_BYTES,
    )
    await _invariants_hold(db_session_factory, cast.gathering_id)
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id)) == []
    assert _ids(await _list(client, cast.host, cast.gathering_id)) == [live]


# --- the race --------------------------------------------------------------------


async def test_a_host_restore_that_loses_the_race_to_the_sweep_is_refused_and_changes_nothing(
    client, capsys, db_session_factory, monkeypatch
):
    """The host-path guarded UPDATE's lost race — the CK-63 uploader-race
    test's shape, on the gathering's bin: between the endpoint's read and
    its write the sweep marks the row `destroying`, the guard (still
    `ready`, still `removed`, still the gathering-bin shape) matches
    nothing, and the caller reads the lost-race 409. The row is exactly
    what the mark left: `destroying`, its removal columns intact as
    provenance — the HOST's id among them — and the counts where the mark
    put them. The read is stubbed to skip the row lock, because under the
    lock the mark would wait rather than race; the stub is the race, not
    a change to the endpoint."""
    cast = await _cast(client, capsys, db_session_factory)
    host_person = await _host_person_id(db_session_factory)
    theirs = await _photograph(db_session_factory, cast, publication_state=PublicationState.LIVE)
    await _resync_counts(db_session_factory, cast.gathering_id)
    assert (await _remove(client, cast.host, theirs)).status_code == 200
    removed_at_before = (await _row(db_session_factory, theirs)).removed_at
    real_read = media_api._restorable_row

    async def raced(db, ctx, target, now):
        row = await db.get(Media, target)
        gathering = await db.get(Gathering, row.gathering_id)
        async with db_session_factory() as other:
            marked = await destruction.mark_for_destruction(other, await other.get(Media, target))
            await other.commit()
        assert marked
        return row, gathering

    monkeypatch.setattr(media_api, "_restorable_row", raced)
    refused = await _restore(client, cast.host, theirs)
    monkeypatch.setattr(media_api, "_restorable_row", real_read)

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == media_api._CHANGED_WHILE_DECIDING
    assert refused.json()["detail"]["code"] == NOT_PENDING
    status, state, removed_at, removed_by, published_at, publisher = await _state(
        db_session_factory, theirs
    )
    assert (status, state) == (MediaStatus.DESTROYING, PublicationState.REMOVED)
    assert (removed_at, removed_by) == (removed_at_before, host_person)  # provenance kept
    assert await _counts(db_session_factory, cast.gathering_id) == (0, 0)  # the mark's
    await _invariants_hold(db_session_factory, cast.gathering_id)
    # Gone from every surface, the bin view included.
    assert _ids(await _bin_view(client, cast.host, cast.gathering_id)) == []
    assert (await _restore(client, cast.host, theirs)).status_code == 404
