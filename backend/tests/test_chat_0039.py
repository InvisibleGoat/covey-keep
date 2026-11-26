"""Migration 0039 and the verifier's lines on reactions and reading positions
(CK-104; the chat record §5, §8, §14; database-schema decision 55).

0039 makes `post_reaction_kind` by CREATE TYPE — its seven labels are usable
in the transaction that made them — then `post_reactions`, keyed on the
message, the person and the kind, cascading from the message and with no
delete rule from the person; `posts.reactions_updated_at`; and
`chat_read_positions`, keyed on the person and the chat, which holds a place
and no time, and no foreign key on the post, because a held message is
destroyed later and the place it marked stays good. Nothing in 0039 names a
label that was added by `ALTER TYPE … ADD VALUE` (the CK-71 Gotcha): the
suite migrates from 0001 in one transaction, and such a label is unusable in
it. The last test reads the migration's own source for one.

The verifier: each new line green on a clean database and red on its plant,
run the way an operator runs it (the CK-57 shape).
"""

import ast
import re
from pathlib import Path
from uuid import UUID

from sqlalchemy import text

from tests.test_account_deletion import DELETE_BODY
from tests.test_chat_container import _container
from tests.test_chat_schema import _assert_green, _assert_red, _planted, _planted_many
from tests.test_gatherings import _signed_in_headers
from tests.test_group_gatherings import _create_in_group
from tests.test_group_invitations import _accept as _accept_group_invitation
from tests.test_group_invitations import _invite_token as _group_invite_token
from tests.test_group_membership import ADMIN, MEMBER, STRANGER, VERIFIER_TOTAL, _cast, _person_id
from tests.test_photo_count import _migrate, at_head_afterwards  # noqa: F401 — the fixture

KINDS = ["like", "heart", "laugh", "surprise", "sad", "thumbs_up", "celebrate"]
VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"

SHAPE = {
    "labels": "post_reaction_kind's labels are like, heart, laugh, surprise, sad, thumbs_up, celebrate",
    "reaction key": "post_reactions is keyed on (post_id, person_id, kind)",
    "cascade": "post_reactions.post_id's FK cascades from posts (a message destroyed takes its reactions)",
    "reactor": "post_reactions.person_id references people with no delete rule",
    "index": "index ix_post_reactions_person_id is on post_reactions (person_id)",
    "stamp": "posts.reactions_updated_at is nullable",
    "columns": (
        "chat_read_positions holds person_id, gathering_id, through_created_at and through_post_id, "
        "each NOT NULL, and nothing else"
    ),
    "position key": "chat_read_positions is keyed on (person_id, gathering_id)",
    "position FKs": "chat_read_positions references people and gatherings with no delete rule, and never a post",
}
DATA = {
    "one": "one reaction of a kind per person per message",
    "kinds": "every reaction is one of the seven kinds",
    "lines": "no reaction is on a line the chat wrote",
    "gone reactor": "no reaction is a deleted account's",
    "group": "no reading position is for a group's chat its person isn't in",
    "gathering": "no reading position is for a gathering's chat its person can't read",
    "gone reader": "no reading position is a deleted account's",
}
NEW_LINES = len(SHAPE) + len(DATA)
# The verifier stood at 484 at head 0038 (CK-102); these 16 lines take it to
# 500, the count every verifier pin in the suite reads since CK-104.
assert VERIFIER_TOTAL == 484 + NEW_LINES == 500


# --- the round trip -------------------------------------------------------------------


async def _shape(db_session_factory) -> dict:
    async with db_session_factory() as db:
        async def every(sql: str) -> list:
            return list((await db.execute(text(sql))).scalars())

        return {
            "head": await db.scalar(text("SELECT version_num FROM alembic_version")),
            "labels": await every(
                "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'post_reaction_kind' ORDER BY e.enumsortorder"
            ),
            "stamp": await every(
                "SELECT data_type || ':' || is_nullable FROM information_schema.columns "
                "WHERE table_name = 'posts' AND column_name = 'reactions_updated_at'"
            ),
            "reactions": set(
                await every(
                    "SELECT column_name || ':' || is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'post_reactions'"
                )
            ),
            "positions": set(
                await every(
                    "SELECT column_name || ':' || is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'chat_read_positions'"
                )
            ),
            "constraints": set(
                await every(
                    "SELECT c.conname || ':' || c.confdeltype::text FROM pg_constraint c "
                    "JOIN pg_class t ON t.oid = c.conrelid "
                    "WHERE t.relname IN ('post_reactions', 'chat_read_positions') AND c.contype IN ('p', 'f')"
                )
            ),
            "indexes": set(
                await every(
                    "SELECT indexname FROM pg_indexes WHERE tablename IN ('post_reactions', 'chat_read_positions')"
                )
            ),
        }


AT_0039 = {
    "head": "0039",
    "labels": KINDS,
    "stamp": ["timestamp with time zone:YES"],
    "reactions": {"post_id:NO", "person_id:NO", "kind:NO", "created_at:NO"},
    "positions": {"person_id:NO", "gathering_id:NO", "through_created_at:NO", "through_post_id:NO"},
    "constraints": {
        "pk_post_reactions: ",
        "fk_post_reactions_post_id:c",
        "fk_post_reactions_person_id:a",
        "pk_chat_read_positions: ",
        "fk_chat_read_positions_person_id:a",
        "fk_chat_read_positions_gathering_id:a",
    },
    "indexes": {"pk_post_reactions", "ix_post_reactions_person_id", "pk_chat_read_positions"},
}
AT_0038 = {
    "head": "0038",
    "labels": [],
    "stamp": [],
    "reactions": set(),
    "positions": set(),
    "constraints": set(),
    "indexes": set(),
}


def _trimmed(shape: dict) -> dict:
    """A primary key's confdeltype is a blank, which asyncpg may hand back
    with or without its space."""
    return {**shape, "constraints": {name.strip() for name in shape["constraints"]}}


async def test_0039_round_trip_drops_both_tables_and_keeps_every_message(
    client, capsys, db_session_factory, at_head_afterwards
):
    cast = await _cast(client, capsys, db_session_factory)
    sent = await client.post(f"/groups/{cast.group_id}/chat", json={"body": "Kept through"}, headers=cast.member)
    assert sent.status_code == 201, sent.text
    message = sent.json()["id"]
    for kind in ("like", "heart"):
        on = await client.put(f"/messages/{message}/reactions", json={"kind": kind, "on": True}, headers=cast.admin)
        assert on.status_code == 200, on.text
    read = await client.put(f"/groups/{cast.group_id}/chat/read", json={"through": message}, headers=cast.admin)
    assert read.status_code == 204, read.text
    assert _trimmed(await _shape(db_session_factory)) == _trimmed(AT_0039)

    lines = await _migrate("downgrade", "0038", capsys)
    assert any(m.startswith("Running downgrade 0039 -> 0038") for m in lines), lines
    assert any(m.startswith("0039 downgrade dropped 2 reaction(s) and 1 reading position(s)") for m in lines), lines
    assert await _shape(db_session_factory) == AT_0038
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT body FROM posts"))).scalars().all() == ["Kept through"]

    lines = await _migrate("upgrade", "head", capsys)
    assert any(m.startswith("Running upgrade 0038 -> 0039") for m in lines), lines
    assert any(
        m.startswith("0039 made post_reactions and chat_read_positions, both empty") and "1 existing post(s)" in m
        for m in lines
    ), lines
    assert _trimmed(await _shape(db_session_factory)) == _trimmed(AT_0039)
    async with db_session_factory() as db:
        assert (await db.execute(text("SELECT body, reactions_updated_at FROM posts"))).all() == [
            ("Kept through", None)
        ]
        assert await db.scalar(text("SELECT count(*) FROM post_reactions")) == 0
        assert await db.scalar(text("SELECT count(*) FROM chat_read_positions")) == 0


async def test_0039s_info_line_counts_zero_on_a_table_that_held_nothing(
    db_session_factory, capsys, at_head_afterwards
):
    await _migrate("downgrade", "0038", capsys)
    lines = await _migrate("upgrade", "head", capsys)
    assert any(
        m.startswith("0039 made post_reactions and chat_read_positions, both empty") and "0 existing post(s)" in m
        for m in lines
    ), lines


async def test_a_message_deleted_outright_takes_its_reactions_and_leaves_the_places_that_named_it(
    client, capsys, db_session_factory
):
    """The sweep's DELETE, in one statement: the reactions go by cascade, and
    a reading position that named the message stays, because there is no
    foreign key to stop it or to take it."""
    cast = await _cast(client, capsys, db_session_factory)
    sent = await client.post(f"/groups/{cast.group_id}/chat", json={"body": "Briefly"}, headers=cast.member)
    message = sent.json()["id"]
    on = await client.put(f"/messages/{message}/reactions", json={"kind": "sad", "on": True}, headers=cast.admin)
    assert on.status_code == 200, on.text
    read = await client.put(f"/groups/{cast.group_id}/chat/read", json={"through": message}, headers=cast.admin)
    assert read.status_code == 204, read.text
    async with db_session_factory() as db:
        await db.execute(text("DELETE FROM posts WHERE id = :m"), {"m": UUID(message)})
        await db.commit()
        assert await db.scalar(text("SELECT count(*) FROM post_reactions")) == 0
        assert await db.scalar(text("SELECT through_post_id FROM chat_read_positions")) == UUID(message)


# --- the verifier ---------------------------------------------------------------------


async def test_the_verifiers_0039_shape_lines_pass_and_each_fails_on_its_plant(db_session_factory):
    out = _assert_green()
    for label in SHAPE.values():
        assert any(row.startswith(f"PASS  {label}") for row in out.splitlines()), label
    plants = [
        (
            ["labels"],
            "ALTER TYPE post_reaction_kind RENAME VALUE 'celebrate' TO 'celebrate_planted'",
            "ALTER TYPE post_reaction_kind RENAME VALUE 'celebrate_planted' TO 'celebrate'",
        ),
        (
            ["reaction key"],
            "ALTER TABLE post_reactions DROP CONSTRAINT pk_post_reactions, "
            "ADD CONSTRAINT pk_post_reactions PRIMARY KEY (post_id, person_id)",
            "ALTER TABLE post_reactions DROP CONSTRAINT pk_post_reactions, "
            "ADD CONSTRAINT pk_post_reactions PRIMARY KEY (post_id, person_id, kind)",
        ),
        (
            ["cascade"],
            "ALTER TABLE post_reactions DROP CONSTRAINT fk_post_reactions_post_id, "
            "ADD CONSTRAINT fk_post_reactions_post_id FOREIGN KEY (post_id) REFERENCES posts (id)",
            "ALTER TABLE post_reactions DROP CONSTRAINT fk_post_reactions_post_id, "
            "ADD CONSTRAINT fk_post_reactions_post_id FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE",
        ),
        (
            ["reactor"],
            "ALTER TABLE post_reactions DROP CONSTRAINT fk_post_reactions_person_id, "
            "ADD CONSTRAINT fk_post_reactions_person_id FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE",
            "ALTER TABLE post_reactions DROP CONSTRAINT fk_post_reactions_person_id, "
            "ADD CONSTRAINT fk_post_reactions_person_id FOREIGN KEY (person_id) REFERENCES people (id)",
        ),
        (
            ["index"],
            "DROP INDEX ix_post_reactions_person_id",
            "CREATE INDEX ix_post_reactions_person_id ON post_reactions (person_id)",
        ),
        (
            ["stamp"],
            "ALTER TABLE posts ALTER COLUMN reactions_updated_at SET NOT NULL",
            "ALTER TABLE posts ALTER COLUMN reactions_updated_at DROP NOT NULL",
        ),
        # A time is the one thing this table must never hold.
        (
            ["columns"],
            "ALTER TABLE chat_read_positions ADD COLUMN updated_at timestamptz",
            "ALTER TABLE chat_read_positions DROP COLUMN updated_at",
        ),
        (
            ["columns"],
            "ALTER TABLE chat_read_positions ALTER COLUMN through_post_id DROP NOT NULL",
            "ALTER TABLE chat_read_positions ALTER COLUMN through_post_id SET NOT NULL",
        ),
        (
            ["position key"],
            "ALTER TABLE chat_read_positions DROP CONSTRAINT pk_chat_read_positions, "
            "ADD CONSTRAINT pk_chat_read_positions PRIMARY KEY (person_id, gathering_id, through_post_id)",
            "ALTER TABLE chat_read_positions DROP CONSTRAINT pk_chat_read_positions, "
            "ADD CONSTRAINT pk_chat_read_positions PRIMARY KEY (person_id, gathering_id)",
        ),
        (
            ["position FKs"],
            "ALTER TABLE chat_read_positions ADD CONSTRAINT fk_chat_read_positions_planted "
            "FOREIGN KEY (through_post_id) REFERENCES posts (id)",
            "ALTER TABLE chat_read_positions DROP CONSTRAINT fk_chat_read_positions_planted",
        ),
        (
            ["position FKs"],
            "ALTER TABLE chat_read_positions DROP CONSTRAINT fk_chat_read_positions_person_id, "
            "ADD CONSTRAINT fk_chat_read_positions_person_id FOREIGN KEY (person_id) REFERENCES people (id) "
            "ON DELETE CASCADE",
            "ALTER TABLE chat_read_positions DROP CONSTRAINT fk_chat_read_positions_person_id, "
            "ADD CONSTRAINT fk_chat_read_positions_person_id FOREIGN KEY (person_id) REFERENCES people (id)",
        ),
    ]
    for keys, plant, undo in plants:
        async with _planted(db_session_factory, plant, undo):
            _assert_red([SHAPE[key] for key in keys])
    _assert_green()


async def test_the_verifiers_0039_data_lines_pass_and_each_fails_on_its_plant(client, capsys, db_session_factory):
    cast = await _cast(client, capsys, db_session_factory)
    joiner = await _signed_in_headers(client, capsys, "joiner@example.com")
    token = await _group_invite_token(client, capsys, cast.admin, cast.group_id, "joiner@example.com")
    assert (await _accept_group_invitation(client, joiner, token))["status"] == "accepted"
    gone = await _person_id(db_session_factory, "joiner@example.com")
    sent = await client.post(f"/groups/{cast.group_id}/chat", json={"body": "Hello"}, headers=cast.member)
    assert sent.status_code == 201, sent.text
    message = sent.json()["id"]
    dinner = await _create_in_group(client, cast.member, cast.group_id, title="Sunday dinner")
    told = await client.post(f"/gatherings/{dinner['id']}/chat", json={"body": "Seven"}, headers=cast.member)
    assert told.status_code == 201, told.text
    on = await client.put(f"/messages/{message}/reactions", json={"kind": "like", "on": True}, headers=cast.admin)
    assert on.status_code == 200, on.text
    # The host's place in the gathering, an invitee's, and a member's in the
    # group: every way in the two audience lines read, held by somebody.
    for address, through, headers in (
        (f"/groups/{cast.group_id}/chat/read", message, cast.admin),
        (f"/gatherings/{dinner['id']}/chat/read", told.json()["id"], cast.member),
        (f"/gatherings/{dinner['id']}/chat/read", told.json()["id"], cast.admin),
    ):
        marked = await client.put(address, json={"through": through}, headers=headers)
        assert marked.status_code == 204, (address, marked.text)
    deleted = await client.post("/me/delete", json=DELETE_BODY, headers=joiner)
    assert deleted.status_code == 204, deleted.text
    async with db_session_factory() as db:
        join_line = await db.scalar(text("SELECT id FROM posts WHERE kind::text = 'joined'"))
    p = {
        "c": UUID(await _container(db_session_factory, cast.group_id)),
        "d": UUID(dinner["id"]),
        "m": UUID(message),
        "j": join_line,
        "admin": await _person_id(db_session_factory, ADMIN),
        "member": await _person_id(db_session_factory, MEMBER),
        "stranger": await _person_id(db_session_factory, STRANGER),
        "gone": gone,
    }
    out = _assert_green()
    for label in DATA.values():
        assert any(row.startswith(f"PASS  {label}") for row in out.splitlines()), label
    assert "INFO  post_reactions rows: 1" in out
    assert "INFO  chat_read_positions rows: 3" in out

    plants = [
        # The key goes with the plant, so its own line fires beside it.
        (
            ["reaction key", "one"],
            "ALTER TABLE post_reactions DROP CONSTRAINT pk_post_reactions; "
            "INSERT INTO post_reactions (post_id, person_id, kind) VALUES (:m, :admin, 'like')",
            "DELETE FROM post_reactions; "
            "ALTER TABLE post_reactions ADD CONSTRAINT pk_post_reactions PRIMARY KEY (post_id, person_id, kind); "
            "INSERT INTO post_reactions (post_id, person_id, kind) VALUES (:m, :admin, 'like')",
        ),
        (
            ["labels", "kinds"],
            "ALTER TYPE post_reaction_kind RENAME VALUE 'like' TO 'like_planted'",
            "ALTER TYPE post_reaction_kind RENAME VALUE 'like_planted' TO 'like'",
        ),
        (
            ["lines"],
            "INSERT INTO post_reactions (post_id, person_id, kind) VALUES (:j, :member, 'celebrate')",
            "DELETE FROM post_reactions WHERE post_id = :j",
        ),
        # A deleted account's membership and invitations are KEPT, attributed
        # to the anonymized row, so nothing but these two lines sees either.
        (
            ["gone reactor"],
            "INSERT INTO post_reactions (post_id, person_id, kind) VALUES (:m, :gone, 'heart')",
            "DELETE FROM post_reactions WHERE person_id = :gone",
        ),
        (
            ["gone reader"],
            "INSERT INTO chat_read_positions (person_id, gathering_id, through_created_at, through_post_id) "
            "VALUES (:gone, :c, now(), :m)",
            "DELETE FROM chat_read_positions WHERE person_id = :gone",
        ),
        (
            ["group"],
            "INSERT INTO chat_read_positions (person_id, gathering_id, through_created_at, through_post_id) "
            "VALUES (:stranger, :c, now(), :m)",
            "DELETE FROM chat_read_positions WHERE person_id = :stranger",
        ),
        (
            ["gathering"],
            "INSERT INTO chat_read_positions (person_id, gathering_id, through_created_at, through_post_id) "
            "VALUES (:stranger, :d, now(), :m)",
            "DELETE FROM chat_read_positions WHERE person_id = :stranger",
        ),
        # A group's member with no place on the gathering is not its reader.
        (
            ["gathering"],
            "UPDATE gathering_invitations SET person_id = :stranger WHERE gathering_id = :d AND person_id = :admin",
            "UPDATE gathering_invitations SET person_id = :admin WHERE gathering_id = :d AND person_id = :stranger",
        ),
    ]
    for keys, plant, undo in plants:
        labels = [DATA.get(key) or SHAPE[key] for key in keys]
        async with _planted_many(db_session_factory, plant, undo, p):
            _assert_red(labels)
    _assert_green()


# --- no label ADD VALUE added is named in 0039 (the CK-71 Gotcha) ---------------------


def _added_labels() -> set[str]:
    """Every label a migration added with ALTER TYPE … ADD VALUE: the quoted
    ones read where they stand, and 0025's loop from the tuple it walks."""
    added: set[str] = set()
    for path in sorted(VERSIONS.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        for label in re.findall(r"ADD VALUE IF NOT EXISTS '([^']+)'", source):
            if label == "{label}":
                (named,) = re.findall(r"^NEW_LABELS = \(([^)]*)\)", source, re.M)
                added.update(re.findall(r"'([a-z_]+)'", named))
            else:
                added.add(label)
    return added


def _named_labels(source: str) -> set[str]:
    """The added labels a migration's CODE names, in any string or name it
    runs — its docstrings are prose and are left out."""
    tree = ast.parse(source)
    prose = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef))
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    words: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in prose:
            words.update(re.findall(r"[a-z_]+", node.value))
        elif isinstance(node, ast.Name):
            words.add(node.id)
    return words & _added_labels()


def test_0039_names_no_label_that_add_value_added():
    assert {"uploaded", "failed", "destroying", "destroyed", "group_media"} <= _added_labels()
    (path,) = VERSIONS.glob("0039_*.py")
    source = path.read_text(encoding="utf-8")
    assert _named_labels(source) == set()
    # The plant: the same file, with one line that names one.
    planted = source + "\n\ndef _planted():\n    op.execute(\"SELECT 1 FROM gatherings WHERE gathering_type = 'group_media'\")\n"
    assert _named_labels(planted) == {"group_media"}
