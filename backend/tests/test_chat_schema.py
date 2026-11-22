"""Migration 0038 and the verifier's chat lines (CK-102; the chat record
§14; database-schema decision 54).

0038 adds the label `group_media` to `gathering_type` — and NOTHING else in
0038 names it, because a label added by `ALTER TYPE … ADD VALUE` cannot be
used in the transaction that added it and the suite migrates in one (the
CK-71 Gotcha) — then `post_kind`, `posts.kind`, a nullable body under two
CHECKs, `posts.removed_by_person_id` under a third, the date's FK set to
`ON DELETE SET NULL`, and two indexes, dropping the single-column
`ix_posts_gathering_id` the composite leads with. The downgrade drops what
0038 added and restores the FK; it leaves the label, which PostgreSQL cannot
remove, and the upgrade's `IF NOT EXISTS` makes the round trip clean.

The verifier: each new line green on a clean database and red on its plant,
run the way an operator runs it (the CK-57 shape). Every comparison with the
new label is `::text`, so a database without it reads zero, not an error.
"""

import re
from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy import text

from tests.test_chat_container import _container
from tests.test_destruction import _verifier
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_gatherings import _signed_in_headers
from tests.test_group_membership import ADMIN, MEMBER, VERIFIER_TOTAL, _cast, _person_id
from tests.test_photo_count import _migrate, at_head_afterwards  # noqa: F401 — the fixture

POST_KINDS = ["message", "joined", "outside_invitations_on", "outside_invitations_off"]

SHAPE = {
    "kind": "posts.kind is NOT NULL",
    "body": "posts.body is nullable",
    "remover": "posts.removed_by_person_id is nullable",
    "labels": "post_kind's labels are message, joined, outside_invitations_on, outside_invitations_off",
    "remover target": "posts.removed_by_person_id references people",
    "remover rule": "posts.removed_by_person_id has no delete rule (nothing cascades from a person)",
    "date rule": "posts.occurrence_id's FK sets NULL when its date is deleted",
    "body iff message": "CHECK ck_posts_body_iff_message exists",
    "body length": "CHECK ck_posts_body_length exists",
    "removed iff": "CHECK ck_posts_removed_iff_removed exists",
    "reading index": "index ix_posts_gathering_id_created_at_id is on posts (gathering_id, created_at, id)",
    "rate index": "index ix_posts_author_person_id_created_at is on posts (author_person_id, created_at)",
    "single index": "the single-column ix_posts_gathering_id is gone (the reading index leads with gathering_id)",
    "label": "gathering_type carries 'group_media'",
}
DATA = {
    "belongs": "every group_media gathering belongs to a group",
    "one": "no group holds more than one group_media gathering",
    "host": "no group_media gathering has a host",
    "date": "no group_media gathering has a date",
    "rows": "no group_media gathering has an invitation, a pending invitation, a place row or a co-host",
    "cover": "no group_media gathering has a cover or an outside setting",
    "author": "every post has an author and no guest name",
    "no date": "no post names a date",
    "states": "every post is live or removed, never pending",
    "held": "every removed post carries when and by whom, and no live post does",
    "join": "every join line sits in its group's container",
    "setting": "every setting line sits on a group's gathering, never the container",
}
NEW_LINES = len(SHAPE) + len(DATA)
# The verifier stood at 458 at head 0037 (CK-92); these 26 lines take it to
# 484, the count every verifier pin in the suite reads since CK-102.
assert VERIFIER_TOTAL == 458 + NEW_LINES == 484


async def _sql(db_session_factory, sql: str, params: dict | None = None) -> None:
    async with db_session_factory() as db:
        await db.execute(text(sql), params or {})
        await db.commit()


@asynccontextmanager
async def _planted(db_session_factory, plant: str, undo: str, params: dict | None = None):
    await _sql(db_session_factory, plant, params)
    try:
        yield
    finally:
        await _sql(db_session_factory, undo, params)


def _assert_red(labels: list[str]) -> None:
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL - len(labels), len(labels), 1), out
    for label in labels:
        assert f"FAIL  {label}" in out, (label, out)


def _assert_green() -> str:
    passed, failed, code, out = _verifier()
    assert (passed, failed, code) == (VERIFIER_TOTAL, 0, 0), out
    return out


# --- the round trip -------------------------------------------------------------------


async def _shape(db_session_factory) -> dict:
    async with db_session_factory() as db:
        def one(sql: str):
            return db.scalar(text(sql))

        return {
            "head": await one("SELECT version_num FROM alembic_version"),
            "columns": set(
                (
                    await db.execute(
                        text(
                            "SELECT column_name || ':' || is_nullable FROM information_schema.columns "
                            "WHERE table_name = 'posts' AND column_name IN ('kind', 'body', 'removed_by_person_id')"
                        )
                    )
                ).scalars()
            ),
            "post_kind": await one("SELECT count(*) FROM pg_type WHERE typname = 'post_kind'"),
            "label": await one(
                "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'gathering_type' AND e.enumlabel = 'group_media'"
            ),
            "date rule": await one(
                "SELECT confdeltype::text FROM pg_constraint WHERE conname = 'fk_posts_occurrence_id'"
            ),
            "indexes": set(
                (await db.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'posts'"))).scalars()
            ),
            "checks": set(
                (
                    await db.execute(
                        text(
                            "SELECT conname FROM pg_constraint WHERE conrelid = 'posts'::regclass AND contype = 'c'"
                        )
                    )
                ).scalars()
            ),
        }


async def test_0038_round_trip_leaves_the_label_and_keeps_what_has_a_body(
    client, capsys, db_session_factory, at_head_afterwards
):
    cast = await _cast(client, capsys, db_session_factory)
    joiner = await _signed_in_headers(client, capsys, "joiner@example.com")
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, "joiner@example.com")
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"
    sent = await client.post(f"/groups/{cast.group_id}/chat", json={"body": "Kept through"}, headers=cast.member)
    assert sent.status_code == 201, sent.text
    head = await _shape(db_session_factory)
    assert head == {
        "head": "0038",
        "columns": {"kind:NO", "body:YES", "removed_by_person_id:YES"},
        "post_kind": 1,
        "label": 1,
        "date rule": "n",
        "indexes": {
            "pk_posts",
            "ix_posts_parent_post_id",
            "ix_posts_occurrence_id",
            "ix_posts_gathering_id_created_at_id",
            "ix_posts_author_person_id_created_at",
        },
        "checks": {
            "ck_posts_identity_present",
            "ck_posts_body_iff_message",
            "ck_posts_body_length",
            "ck_posts_removed_iff_removed",
        },
    }

    lines = await _migrate("downgrade", "0037", capsys)
    assert any(m.startswith("Running downgrade 0038 -> 0037") for m in lines), lines
    assert any(m.startswith("0038 downgrade deleted 1 line(s) the chat wrote itself") for m in lines), lines
    down = await _shape(db_session_factory)
    assert down == {
        "head": "0037",
        "columns": {"body:NO"},
        "post_kind": 0,
        "label": 1,  # PostgreSQL cannot remove a label; the upgrade's IF NOT EXISTS
        "date rule": "a",
        "indexes": {"pk_posts", "ix_posts_parent_post_id", "ix_posts_occurrence_id", "ix_posts_gathering_id"},
        "checks": {"ck_posts_identity_present"},
    }
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT body FROM posts"))).scalars().all() == ["Kept through"]

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0037 -> 0038") for m in lines), lines
    assert any(m.startswith("0038 gave posts a kind: 1 existing row(s), each a message") for m in lines), lines
    assert await _shape(db_session_factory) == head
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT kind::text, body FROM posts"))).all() == [("message", "Kept through")]


async def test_0038s_info_line_counts_zero_on_a_table_that_held_nothing(
    db_session_factory, capsys, at_head_afterwards
):
    await _migrate("downgrade", "0037", capsys)
    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("0038 gave posts a kind: 0 existing row(s)") for m in lines), lines


# --- the verifier ---------------------------------------------------------------------


async def test_the_verifiers_chat_shape_lines_pass_and_each_fails_on_its_plant(db_session_factory):
    """On a database with no posts (each test starts empty), so a NOT NULL
    can be planted on `body`. Every plant is undone in a `finally`."""
    out = _assert_green()
    for label in SHAPE.values():
        assert any(row.startswith(f"PASS  {label}") for row in out.splitlines()), label
    plants = [
        (["kind"], "ALTER TABLE posts ALTER COLUMN kind DROP NOT NULL", "ALTER TABLE posts ALTER COLUMN kind SET NOT NULL"),
        (["body"], "ALTER TABLE posts ALTER COLUMN body SET NOT NULL", "ALTER TABLE posts ALTER COLUMN body DROP NOT NULL"),
        (
            ["remover"],
            "ALTER TABLE posts ALTER COLUMN removed_by_person_id SET NOT NULL",
            "ALTER TABLE posts ALTER COLUMN removed_by_person_id DROP NOT NULL",
        ),
        (
            ["labels"],
            "ALTER TYPE post_kind RENAME VALUE 'joined' TO 'joined_planted'",
            "ALTER TYPE post_kind RENAME VALUE 'joined_planted' TO 'joined'",
        ),
        (
            ["remover rule"],
            "ALTER TABLE posts DROP CONSTRAINT fk_posts_removed_by_person_id, ADD CONSTRAINT fk_posts_removed_by_person_id "
            "FOREIGN KEY (removed_by_person_id) REFERENCES people (id) ON DELETE CASCADE",
            "ALTER TABLE posts DROP CONSTRAINT fk_posts_removed_by_person_id, ADD CONSTRAINT fk_posts_removed_by_person_id "
            "FOREIGN KEY (removed_by_person_id) REFERENCES people (id)",
        ),
        (
            ["remover target", "remover rule"],
            "ALTER TABLE posts DROP CONSTRAINT fk_posts_removed_by_person_id",
            "ALTER TABLE posts ADD CONSTRAINT fk_posts_removed_by_person_id "
            "FOREIGN KEY (removed_by_person_id) REFERENCES people (id)",
        ),
        (
            ["date rule"],
            "ALTER TABLE posts DROP CONSTRAINT fk_posts_occurrence_id, ADD CONSTRAINT fk_posts_occurrence_id "
            "FOREIGN KEY (occurrence_id) REFERENCES occurrences (id)",
            "ALTER TABLE posts DROP CONSTRAINT fk_posts_occurrence_id, ADD CONSTRAINT fk_posts_occurrence_id "
            "FOREIGN KEY (occurrence_id) REFERENCES occurrences (id) ON DELETE SET NULL",
        ),
        (
            ["body iff message"],
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_body_iff_message TO ck_posts_planted_a",
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_planted_a TO ck_posts_body_iff_message",
        ),
        (
            ["body length"],
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_body_length TO ck_posts_planted_b",
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_planted_b TO ck_posts_body_length",
        ),
        (
            ["removed iff"],
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_removed_iff_removed TO ck_posts_planted_c",
            "ALTER TABLE posts RENAME CONSTRAINT ck_posts_planted_c TO ck_posts_removed_iff_removed",
        ),
        (
            ["reading index"],
            "DROP INDEX ix_posts_gathering_id_created_at_id",
            "CREATE INDEX ix_posts_gathering_id_created_at_id ON posts (gathering_id, created_at, id)",
        ),
        (
            ["rate index"],
            "DROP INDEX ix_posts_author_person_id_created_at",
            "CREATE INDEX ix_posts_author_person_id_created_at ON posts (author_person_id, created_at)",
        ),
        (["single index"], "CREATE INDEX ix_posts_gathering_id ON posts (gathering_id)", "DROP INDEX ix_posts_gathering_id"),
        (
            ["label"],
            "ALTER TYPE gathering_type RENAME VALUE 'group_media' TO 'group_media_planted'",
            "ALTER TYPE gathering_type RENAME VALUE 'group_media_planted' TO 'group_media'",
        ),
    ]
    for keys, plant, undo in plants:
        async with _planted(db_session_factory, plant, undo):
            _assert_red([SHAPE[key] for key in keys])
    _assert_green()


async def test_the_verifiers_chat_data_lines_pass_and_each_fails_on_its_plant(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    joiner = await _signed_in_headers(client, capsys, "joiner@example.com")
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, "joiner@example.com")
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"
    sent = await client.post(f"/groups/{cast.group_id}/chat", json={"body": "Hello"}, headers=cast.member)
    assert sent.status_code == 201, sent.text
    message = UUID(sent.json()["id"])
    dinner = await _create_in_group(client, cast.member, cast.group_id, title="Sunday dinner")
    on = await client.put(f"/gatherings/{dinner['id']}/outside-invitations", json={"on": True}, headers=cast.member)
    assert on.status_code == 200, on.text
    container = UUID(await _container(db_session_factory, cast.group_id))
    async with db_session_factory() as db:
        join_line = await db.scalar(text("SELECT id FROM posts WHERE kind::text = 'joined'"))
        setting_line = await db.scalar(text("SELECT id FROM posts WHERE kind::text = 'outside_invitations_on'"))
        admin_account = await db.scalar(text("SELECT account_id FROM people WHERE email = :e"), {"e": ADMIN})
    member = await _person_id(db_session_factory, MEMBER)
    admin = await _person_id(db_session_factory, ADMIN)
    p = {
        "c": container,
        "g": UUID(cast.group_id),
        "d": UUID(dinner["id"]),
        "o": UUID(dinner["occurrences"][0]["id"]),
        "m": message,
        "j": join_line,
        "s": setting_line,
        "acct": admin_account,
        "member": member,
        "admin": admin,
    }
    out = _assert_green()
    for label in DATA.values():
        assert any(row.startswith(f"PASS  {label}") for row in out.splitlines()), label
    assert "INFO  posts rows: 3" in out

    plants = [
        # A container with no group fails its own line AND the join line's:
        # a join line in a container that belongs to no group is not in its
        # group's container, so both fire, and both are named.
        (
            ["belongs", "join"],
            "UPDATE gatherings SET owning_group_id = NULL WHERE id = :c",
            "UPDATE gatherings SET owning_group_id = :g WHERE id = :c",
        ),
        (
            ["one"],
            "INSERT INTO gatherings (id, created_by_account_id, gathering_type, title, publication_state, owning_group_id) "
            "VALUES ('c1020000-0000-4000-8000-0000000000aa', :acct, 'group_media', 'Group chat', 'live', :g)",
            "DELETE FROM gatherings WHERE id = 'c1020000-0000-4000-8000-0000000000aa'",
        ),
        (["host"], "UPDATE gatherings SET host_account_id = :acct WHERE id = :c", "UPDATE gatherings SET host_account_id = NULL WHERE id = :c"),
        (
            ["date"],
            "INSERT INTO occurrences (gathering_id, starts_at) VALUES (:c, now() + interval '3 days')",
            "DELETE FROM occurrences WHERE gathering_id = :c",
        ),
        (
            ["rows"],
            "INSERT INTO gathering_invitations (gathering_id, person_id, invited_by_person_id) VALUES (:c, :member, :admin)",
            "DELETE FROM gathering_invitations WHERE gathering_id = :c",
        ),
        (
            ["cover"],
            "UPDATE gatherings SET outside_invitations_since = now(), outside_invitations_by_person_id = :admin WHERE id = :c",
            "UPDATE gatherings SET outside_invitations_since = NULL, outside_invitations_by_person_id = NULL WHERE id = :c",
        ),
        (["author"], "UPDATE posts SET guest_name = 'A guest' WHERE id = :m", "UPDATE posts SET guest_name = NULL WHERE id = :m"),
        (["no date"], "UPDATE posts SET occurrence_id = :o WHERE id = :s", "UPDATE posts SET occurrence_id = NULL WHERE id = :s"),
        (
            ["states"],
            "UPDATE posts SET publication_state = 'pending' WHERE id = :m",
            "UPDATE posts SET publication_state = 'live' WHERE id = :m",
        ),
        (
            ["removed iff", "held"],
            "ALTER TABLE posts DROP CONSTRAINT ck_posts_removed_iff_removed; "
            "UPDATE posts SET publication_state = 'removed' WHERE id = :m",
            "UPDATE posts SET publication_state = 'live' WHERE id = :m; "
            "ALTER TABLE posts ADD CONSTRAINT ck_posts_removed_iff_removed CHECK ("
            "(publication_state = 'removed') = (removed_at IS NOT NULL) "
            "AND (removed_at IS NULL) = (removed_by_person_id IS NULL))",
        ),
        (["join"], "UPDATE posts SET gathering_id = :d WHERE id = :j", "UPDATE posts SET gathering_id = :c WHERE id = :j"),
        (["setting"], "UPDATE posts SET gathering_id = :c WHERE id = :s", "UPDATE posts SET gathering_id = :d WHERE id = :s"),
    ]
    for keys, plant, undo in plants:
        labels = [DATA.get(key) or SHAPE[key] for key in keys]
        async with _planted_many(db_session_factory, plant, undo, p):
            _assert_red(labels)
    _assert_green()


@asynccontextmanager
async def _planted_many(db_session_factory, plant: str, undo: str, params: dict):
    """A plant of one or more statements (`;`-separated), each run with the
    parameters it names."""
    async def run(sql: str) -> None:
        async with db_session_factory() as db:
            for statement in [s.strip() for s in sql.split(";") if s.strip()]:
                names = {k: v for k, v in params.items() if re.search(rf":{k}\b", statement)}
                await db.execute(text(statement), names)
            await db.commit()

    await run(plant)
    try:
        yield
    finally:
        await run(undo)
