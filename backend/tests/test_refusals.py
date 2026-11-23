"""A refusal never carries the value it refused, and writing one cannot fail
(CK-102's second fix-up).

FastAPI's own 422 repeats the refused value (`input`) and is written by
`JSONResponse`, which can fail on the value itself: half an emoji is not
UTF-8, `NaN` is not JSON, a nest can be too deep for the encoder to walk, and
bytes that are not UTF-8 cannot be decoded. The failure is a 500, and its
traceback prints the `RequestValidationError` behind it, whose text is every
refused value — so until this fix-up such a body wrote a message's words, or
a sign-in request's address, to the API's log. `app/refusals.py` answers
instead: the same 422 at the same `loc`, with no `input`, filtered before the
encoder walks it and written as ASCII.

WHAT IS READ is what the log would hold either way: every record with the
root at DEBUG, and the traceback uvicorn would write of an exception that
escaped (`_logged`). A traceback prints the source lines of the frames it
names, this file's among them, so the words looked for are joined at run
time, as in `test_hidden_parameters.py`.
"""

import ast
import json
import logging
from pathlib import Path

import pytest
from fastapi.exceptions import RequestValidationError
from sqlalchemy import text

from app.api.auth import TOS_VERSION
from app.config import settings
from app.main import app
from tests.test_chat import _gread, _posts_count
from tests.test_gatherings import _signed_in_headers
from tests.test_hidden_parameters import ADDRESS, WORD, _logged
from tests.test_outside_invitations import _world

APP_DIR = Path(__file__).resolve().parent.parent / "app"

ORIGIN = settings.allowed_origins_list[0]

HALF = "\ud83d"  # the first half of an emoji: not UTF-8, sent as an escape
WORDS = f"{WORD} and the rest of a private message"
NAN = float("nan")
DEEP = 1500  # past Python's recursion limit, short of the JSON scanner's

KEPT = {"loc", "msg", "type"}


def _json(body) -> bytes:
    """What a browser's `JSON.stringify` sends of half an emoji — an escape —
    and what a hand-made request sends of `NaN`."""
    return json.dumps(body, ensure_ascii=True).encode("ascii")


# One refused body each: the bytes sent, the content type, and where the
# refusal lands. The first five are the review's. Half an emoji in a field's
# NAME refuses the whole body, the name as its `input` and not in its `loc`.
BODIES = {
    "half an emoji in the message": (
        _json({"body": WORDS + HALF}),
        "application/json",
        [(["body", "body"], "string_unicode")],
    ),
    "half an emoji in an unknown field": (
        _json({"body": "Hi", "mood": WORDS + HALF}),
        "application/json",
        [(["body", "mood"], "extra_forbidden")],
    ),
    "half an emoji in an unknown field's name": (
        _json({"body": "Hi", WORDS + HALF: 1}),
        "application/json",
        [(["body"], "string_unicode")],
    ),
    "NaN beside the words": (
        _json({"body": [WORDS, NAN]}),
        "application/json",
        [(["body", "body"], "string_type")],
    ),
    "a list for a body, NaN beside the words": (
        _json([WORDS, NAN]),
        "application/json",
        [(["body"], "model_attributes_type")],
    ),
    "a nest too deep to walk, beside the words": (
        f'{{"body": ["{WORDS}", {"[" * DEEP}{"]" * DEEP}]}}'.encode("ascii"),
        "application/json",
        [(["body", "body"], "string_type")],
    ),
    "bytes that are not UTF-8, sent as text": (
        WORDS.encode("ascii") + b"\xff",
        "text/plain",
        [(["body"], "model_attributes_type")],
    ),
}


async def _post(client, url: str, raw: bytes, headers: dict, caplog, content_type: str = "application/json"):
    """The answer, or None where none could be written, and everything the
    log would hold of the request either way."""
    caplog.clear()
    response, written = None, ""
    with caplog.at_level(logging.DEBUG):
        try:
            response = await client.post(url, content=raw, headers={**headers, "content-type": content_type})
        except Exception as exc:  # noqa: BLE001 — what uvicorn would log
            written = _logged(exc)
    return response, caplog.text + written


def _places(response) -> list[tuple]:
    return [(entry["loc"], entry["type"]) for entry in response.json()["detail"]]


# --- the words never reach a record, a traceback or the answer -------------------------


@pytest.mark.parametrize("raw, content_type, places", BODIES.values(), ids=BODIES.keys())
async def test_a_refused_message_is_a_422_that_prints_none_of_its_words(
    client, capsys, db_session_factory, caplog, raw, content_type, places
):
    """Through both chat doors: the group's and the gathering's."""
    world = await _world(client, capsys, db_session_factory)
    cast = world.cast
    await _gread(client, cast.admin, cast.group_id)
    before = await _posts_count(db_session_factory)
    for url in (f"/groups/{cast.group_id}/chat", f"/gatherings/{world.gathering_id}/chat"):
        response, held = await _post(client, url, raw, cast.admin, caplog, content_type)
        assert WORD not in held, url
        assert response is not None and response.status_code == 422, url
        assert _places(response) == places, url
        for entry in response.json()["detail"]:
            assert set(entry) == KEPT, url
        assert WORD not in response.text, url
        assert response.content.isascii(), url
    assert await _posts_count(db_session_factory) == before


async def test_a_refused_sign_in_request_is_a_422_that_prints_no_address(
    client, capsys, db_session_factory, caplog
):
    """Outside the chat, and with no session: the address beside what can't
    be written."""
    rest = {"tos_accepted": True, "tos_version": TOS_VERSION}
    deep = f'{{"email": ["{ADDRESS}", {"[" * DEEP}{"]" * DEEP}], "tos_accepted": true, "tos_version": 1}}'
    for raw, places in (
        (_json({"email": [ADDRESS, NAN], **rest}), [(["body", "email"], "string_type")]),
        (_json({"email": {"address": ADDRESS + HALF}, **rest}), [(["body", "email"], "string_type")]),
        (_json([ADDRESS, NAN]), [(["body"], "model_attributes_type")]),
        (deep.encode("ascii"), [(["body", "email"], "string_type")]),
    ):
        response, held = await _post(client, "/auth/request-link", raw, {}, caplog)
        assert ADDRESS not in held
        assert response is not None and response.status_code == 422
        assert _places(response) == places
        assert all(set(entry) == KEPT for entry in response.json()["detail"])
        assert ADDRESS not in response.text
    assert ADDRESS not in capsys.readouterr().out
    async with db_session_factory() as db:
        assert await db.scalar(text("SELECT count(*) FROM magic_link_tokens")) == 0


# --- what an ordinary refusal carries ----------------------------------------------------


async def test_an_ordinary_refusal_carries_its_place_its_words_and_its_type_and_no_value(
    client, capsys, db_session_factory
):
    """Five routers, and a refusal of each kind: a validator of the app's, a
    missing field, an unknown one, a query, a length, a body that is not
    JSON. Each entry whole, as FastAPI's own but for `input`."""
    cast = (await _world(client, capsys, db_session_factory)).cast
    admin = {**cast.admin, "content-type": "application/json"}

    async def refused(method: str, url: str, raw: bytes | None, headers: dict) -> list[dict]:
        response = await client.request(method, url, content=raw, headers=headers)
        assert response.status_code == 422, (url, response.text)
        assert response.headers["content-type"] == "application/json"
        assert list(response.json()) == ["detail"]
        return response.json()["detail"]

    declined = {"email": ADDRESS, "tos_accepted": False, "tos_version": TOS_VERSION}
    assert await refused("POST", "/auth/request-link", _json(declined), {"content-type": "application/json"}) == [
        {
            "type": "value_error",
            "loc": ["body", "tos_accepted"],
            "msg": "Value error, the Terms of Service must be affirmatively accepted",
            "ctx": {"error": {}},
        }
    ]
    assert await refused("POST", "/groups", b"{}", admin) == [
        {"type": "missing", "loc": ["body", "name"], "msg": "Field required"}
    ]
    assert await refused("POST", "/groups", _json({"name": "The Finches", "colour": WORD}), admin) == [
        {"type": "extra_forbidden", "loc": ["body", "colour"], "msg": "Extra inputs are not permitted"}
    ]
    assert await refused("GET", f"/calendar?from={WORD}&to=2026-12-01T00:00:00Z", None, cast.admin) == [
        {
            "type": "datetime_from_date_parsing",
            "loc": ["query", "from"],
            "msg": "Input should be a valid datetime or date, invalid character in year",
            "ctx": {"error": "invalid character in year"},
        }
    ]
    assert await refused("POST", f"/groups/{cast.group_id}/chat", _json({"body": " "}), admin) == [
        {
            "type": "string_too_short",
            "loc": ["body", "body"],
            "msg": "String should have at least 1 character",
            "ctx": {"min_length": 1},
        }
    ]
    assert await refused("PATCH", "/me/profile", b'{"display_name": ', admin) == [
        {
            "type": "json_invalid",
            "loc": ["body", 17],
            "msg": "JSON decode error",
            "ctx": {"error": "Expecting value"},
        }
    ]


async def test_a_refusals_own_words_may_be_any_script_and_are_written_in_ascii(client, capsys):
    """The app's messages hold an em dash and an unknown field's name holds
    whatever its sender called it: escaped on the wire, the same words read."""
    headers = {**await _signed_in_headers(client, capsys, "maya@example.com"), "content-type": "application/json"}
    for method, url, body, place, words in (
        (
            "POST",
            "/groups",
            {"name": "The Finches", "café 🐦": 1},
            ["body", "café 🐦"],
            "Extra inputs are not permitted",
        ),
        (
            "PATCH",
            "/me/profile",
            {},
            ["body"],
            "Value error, nothing to update — provide display_name and/or timezone",
        ),
    ):
        refused = await client.request(method, url, content=_json(body), headers=headers)
        assert refused.status_code == 422
        assert refused.content.isascii()
        assert [(e["loc"], e["msg"]) for e in refused.json()["detail"]] == [(place, words)]


async def test_a_refusal_of_half_an_emoji_wherever_it_stands_is_written():
    """Called as the app calls it, with half an emoji in each of the four
    things it keeps. Pydantic lets none through to them today; a version that
    does must not bring the 500 back."""
    refuse = app.exception_handlers[RequestValidationError]
    entry = {
        "type": "some" + HALF,
        "loc": ("body", "mood" + HALF),
        "msg": "no" + HALF,
        "input": WORDS + HALF,
        "ctx": {"error": "why" + HALF},
        "url": WORDS,
    }
    response = await refuse(None, RequestValidationError([entry]))
    assert response.status_code == 422
    assert response.media_type == "application/json"
    assert response.body.isascii()
    kept = {key: entry[key] for key in ("type", "loc", "msg", "ctx")}
    assert json.loads(response.body) == {"detail": [{**kept, "loc": list(entry["loc"])}]}


async def test_a_json_body_that_is_not_utf_8_is_still_the_400_it_was(client, capsys, db_session_factory, caplog):
    """FastAPI's own, raised before any field is read; nothing is printed."""
    cast = (await _world(client, capsys, db_session_factory)).cast
    raw = b'{"body": "' + WORDS.encode("ascii") + b'\xff"}'
    response, held = await _post(client, f"/groups/{cast.group_id}/chat", raw, cast.admin, caplog)
    assert WORD not in held
    assert response.status_code == 400
    assert response.json() == {"detail": "There was an error parsing the body"}


async def test_a_refusal_answers_an_allowed_origin_with_the_cors_headers(client, capsys, db_session_factory, caplog):
    """The frontend reads a refusal's body, so the browser must let it: an
    ordinary one, and one that could not be written until now."""
    headers = {**await _signed_in_headers(client, capsys, "maya@example.com"), "origin": ORIGIN}
    for raw in (b"{}", _json({"name": [WORD, NAN]}), _json({"name": "x", "mood" + HALF: 1})):
        response, held = await _post(client, "/groups", raw, headers, caplog)
        assert WORD not in held
        assert response is not None and response.status_code == 422
        assert response.headers["access-control-allow-origin"] == ORIGIN
        assert response.headers["access-control-allow-credentials"] == "true"
        elsewhere, _ = await _post(client, "/groups", raw, {**headers, "origin": "https://evil.example"}, caplog)
        assert elsewhere.status_code == 422
        assert "access-control-allow-origin" not in elsewhere.headers


# --- where it lives ----------------------------------------------------------------------


def test_the_module_imports_no_router_and_has_nothing_to_log_with():
    """It imports nothing of the app's, so no router; and a refusal is never
    logged, so it has no logger and prints nothing. Read from the syntax
    tree, where no comment and no string can pass for an import."""
    tree = ast.parse((APP_DIR / "refusals.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0
            imported.add(node.module)
    assert not [name for name in imported if name.split(".")[0] in {"app", "logging"}]
    assert "print" not in {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
