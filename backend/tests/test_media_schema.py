"""CK-32 — the media schema: derivative layers as rows, the job columns, and
the occurrence label that no longer blocks a delete (migration 0016).

Schema-shape tests, the test_schema_keeper.py kind — no endpoint touches
media yet (the intent endpoint is CK-33, the worker CK-34), so what can be
pinned here is the shape every later phase inherits:

- the status ladder in the DATABASE matches the model's enum exactly (a
  drift `alembic check` cannot see — Alembic does not diff enum labels);
- `status` has no server default: a writer must state the rung;
- the object columns live on the derivative rows, not on the photograph,
  and the derivative table carries NO state of its own — the media-layers
  §8 binding, asserted structurally;
- one row per layer; the layers die with their photograph (CASCADE);
- and the CK-30 dormant 500, proven closed for media: deleting a date that
  has a photograph attached keeps the photograph and clears only its label
  — the endpoint neither 500s nor counts it as a third reason to refuse.
"""

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.models import (
    Media,
    MediaDerivative,
    MediaLayer,
    MediaStatus,
    Occurrence,
    PublicationState,
)
from tests.test_gatherings import _create, _signed_in_headers
from tests.test_invitations import _accept, _invite_token
from tests.test_rsvps import _put_rsvp
from tests.test_schema_keeper import _mk_gathering


def _media(gathering_id, *, occurrence_id=None, status=MediaStatus.READY) -> Media:
    return Media(
        gathering_id=gathering_id,
        occurrence_id=occurrence_id,
        guest_name="guest",
        upload_content_type="image/jpeg",
        upload_size_bytes=4_200_000,
        status=status,
        publication_state=PublicationState.PENDING,
    )


def _derivative(media_id, layer: MediaLayer, **overrides) -> MediaDerivative:
    row = dict(
        media_id=media_id,
        layer=layer,
        storage_key=f"test/{media_id}/{layer.value}",
        content_type="image/jpeg",
        size_bytes=1_000,
        storage_class="standard",
    )
    row.update(overrides)
    return MediaDerivative(**row)


async def _enum_labels(db, typname: str) -> list[str]:
    return [
        r[0]
        for r in await db.execute(
            text(
                "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid "
                "WHERE typname = :t ORDER BY enumsortorder"
            ),
            {"t": typname},
        )
    ]


async def _columns(db, table: str) -> dict[str, tuple[str, str | None]]:
    """column -> (is_nullable, column_default)."""
    return {
        r[0]: (r[1], r[2])
        for r in await db.execute(
            text(
                "SELECT column_name, is_nullable, column_default "
                "FROM information_schema.columns WHERE table_name = :t"
            ),
            {"t": table},
        )
    }


# --- the ladder ----------------------------------------------------------------


async def test_status_ladder_in_the_database_matches_the_model(db_session_factory):
    """0016 grew media_status from 0001's pair to the five-rung ladder, in
    ladder order (the new labels placed with BEFORE clauses). The model's
    enum must match the DB label for label — Alembic's autogenerate does not
    compare enum values, so this is the only place that drift would show."""
    async with db_session_factory() as db:
        labels = await _enum_labels(db, "media_status")
        assert labels == ["pending_upload", "uploaded", "processing", "ready", "failed"]
        assert labels == [m.value for m in MediaStatus]
        layers = await _enum_labels(db, "media_layer")
        assert layers == ["archival", "web", "thumbnail"]
        assert layers == [m.value for m in MediaLayer]


async def test_status_has_no_default_so_a_writer_must_state_the_rung(
    db_session_factory,
):
    """0001 defaulted status to 'processing'. Under the ladder that default
    is a trap: an INSERT that omitted the rung would be reclaimed by the
    worker fifteen minutes later against an object never uploaded. So the
    default is gone — an omitted status is a NOT NULL violation, not a
    silently wrong row."""
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        db.add(
            Media(
                gathering_id=gathering.id,
                guest_name="guest",
                upload_content_type="image/jpeg",
                upload_size_bytes=1,
                publication_state=PublicationState.PENDING,
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_job_columns_start_empty_and_attempts_starts_at_zero(db_session_factory):
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        media = _media(gathering.id, status=MediaStatus.PENDING_UPLOAD)
        db.add(media)
        await db.commit()
        await db.refresh(media)
        assert media.attempts == 0
        assert media.available_at is None
        assert media.claimed_at is None
        assert media.last_error is None


# --- the shape: objects on the derivative rows, state on the photograph -------


async def test_object_columns_live_on_derivatives_and_derivatives_carry_no_state(
    db_session_factory,
):
    """The split, read from information_schema. The media row describes the
    photograph and its job and stores NO object (the 0001 object columns are
    gone; the upload facts are named for what they are). The derivative row
    describes one stored object and carries NO lifecycle — the media-layers
    §8 binding: nothing per-layer exists that could diverge from the one
    publication_state on media."""
    async with db_session_factory() as db:
        media = await _columns(db, "media")
        for gone in ("storage_key", "storage_class", "last_accessed", "size_bytes", "content_type"):
            assert gone not in media, gone
        assert media["upload_content_type"][0] == "NO"
        assert media["upload_size_bytes"][0] == "NO"
        assert media["status"] == ("NO", None)  # NOT NULL, no default
        assert media["attempts"][0] == "NO"
        for nullable in ("available_at", "claimed_at", "last_error"):
            assert media[nullable][0] == "YES", nullable

        deriv = await _columns(db, "media_derivatives")
        for required in ("media_id", "layer", "storage_key", "content_type", "size_bytes", "storage_class"):
            assert deriv[required][0] == "NO", required
        assert deriv["last_accessed"][0] == "YES"
        # storage_class deliberately has no default — the worker states the
        # class per layer, and a 'standard' default would let an archival
        # row land on the wrong class silently.
        assert deriv["storage_class"][1] is None
        for forbidden in ("publication_state", "removed_at", "status", "deleted_at", "archived_at"):
            assert forbidden not in deriv, forbidden


async def test_one_row_per_layer_one_object_per_row_and_the_layers_die_as_a_unit(
    db_session_factory,
):
    """UNIQUE(media_id, layer): a photograph has at most one row per layer.
    UNIQUE(storage_key): one object is one row. ON DELETE CASCADE: the
    stored representations cannot outlive the photograph — the row-side
    half of "deleted as a unit" (the object-side half is the worker's, at
    the end of the removal bin)."""
    async with db_session_factory() as db:
        gathering, _ = await _mk_gathering(db)
        media = _media(gathering.id)
        db.add(media)
        await db.flush()
        for layer in MediaLayer:
            db.add(_derivative(media.id, layer))
        await db.commit()
        media_id = media.id

    async with db_session_factory() as db:
        db.add(_derivative(media_id, MediaLayer.WEB, storage_key="test/second-web"))
        with pytest.raises(IntegrityError):
            await db.flush()
    async with db_session_factory() as db:
        other = _media(gathering.id)
        db.add(other)
        await db.flush()
        db.add(
            _derivative(other.id, MediaLayer.WEB, storage_key=f"test/{media_id}/web")
        )
        with pytest.raises(IntegrityError):
            await db.flush()

    async with db_session_factory() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(MediaDerivative)
                .where(MediaDerivative.media_id == media_id)
            )
        ) == 3
        await db.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
        await db.commit()
        assert (
            await db.scalar(
                select(func.count())
                .select_from(MediaDerivative)
                .where(MediaDerivative.media_id == media_id)
            )
        ) == 0


# --- the label that no longer blocks a delete ---------------------------------


async def test_deleting_a_date_keeps_the_photograph_and_clears_only_its_label(
    client, capsys, db_session_factory
):
    """The CK-30 dormant 500, closed for media: `delete_occurrence` counts
    only RSVPs before deleting, and `media.occurrence_id` carried no
    ON DELETE, so a date with a photograph on it would have raised an
    IntegrityError the moment media had a surface. With SET NULL (0016) the
    photograph survives and loses its label — and it is deliberately not a
    third reason to refuse: an unanswered date with a photograph deletes on
    the first request, and an answered one warns about the answers only
    (the count is people, and a photograph is destroyed by neither path)."""
    headers = await _signed_in_headers(client, capsys, "photographer@example.com")
    created = await _create(
        client,
        headers,
        occurrences=[
            {"starts_at": "2026-09-01T18:00:00+00:00"},
            {"starts_at": "2026-09-08T18:00:00+00:00"},
            {"starts_at": "2026-09-15T18:00:00+00:00"},
        ],
    )
    first_id, second_id, third_id = (o["id"] for o in created["occurrences"])
    async with db_session_factory() as db:
        unlabeled = _media(created["id"])
        on_first = _media(created["id"], occurrence_id=first_id)
        on_second = _media(created["id"], occurrence_id=second_id)
        db.add_all([unlabeled, on_first, on_second])
        await db.commit()
        media_ids = {
            "unlabeled": unlabeled.id,
            "first": on_first.id,
            "second": on_second.id,
        }

    # An unanswered date with a photograph: no refusal, no 500 — 204.
    assert (await client.delete(f"/occurrences/{first_id}", headers=headers)).status_code == 204

    # An answered date with a photograph: the RSVP warning fires with the
    # RSVP count alone, and the confirmed delete proceeds.
    token = await _invite_token(client, capsys, headers, created["id"], "guest@example.com")
    headers_invitee = await _signed_in_headers(client, capsys, "guest@example.com")
    await _accept(client, headers_invitee, token)
    await _put_rsvp(client, headers_invitee, second_id, {"response": "yes"})
    refused = await client.delete(f"/occurrences/{second_id}", headers=headers)
    assert refused.status_code == 409
    assert refused.json()["detail"]["rsvp_count"] == 1
    assert (
        await client.delete(f"/occurrences/{second_id}?confirm=true", headers=headers)
    ).status_code == 204

    async with db_session_factory() as db:
        remaining = {str(o.id) for o in (await db.execute(select(Occurrence))).scalars()}
        assert remaining == {third_id}
        rows = {m.id: m for m in (await db.execute(select(Media))).scalars()}
        # Every photograph survived, still on its gathering...
        assert set(rows) == set(media_ids.values())
        assert all(str(m.gathering_id) == created["id"] for m in rows.values())
        # ...and the two that were labeled with a removed date lost only
        # the label.
        assert rows[media_ids["first"]].occurrence_id is None
        assert rows[media_ids["second"]].occurrence_id is None
        assert rows[media_ids["unlabeled"]].occurrence_id is None
