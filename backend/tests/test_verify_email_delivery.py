"""CK-100 — scripts/verify_email_delivery.py, the smoke test, offline
(THE DESIGN §5).

Steven runs the script from covey-keep-api's Web Shell with EMAIL_MODE=provider
in that one command's environment; it asks for a recipient, sends ONE message
with no link and no token through `send_email`, and prints the adapter's
status line. It never prints the key, the recipient or the message, and it
touches no database. These tests run it against a stubbed `urlopen`: no
request leaves.
"""

import importlib.util
import json
import re
import sys
import urllib.error
from pathlib import Path

import pytest

from app.brand import FROM_DISPLAY_NAME
from app.config import settings
from app.services import email as email_service
from app.services.email import USER_AGENT

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "verify_email_delivery.py"

FAKE_KEY = "re_test_never_deployed_1111111111"
FROM = "hello@coveykeep.com"
RECIPIENT = "steven.real@kinmail.net"


@pytest.fixture(scope="module")
def script():
    spec = importlib.util.spec_from_file_location("verify_email_delivery", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def requests(monkeypatch):
    sent = []

    def _urlopen(request, timeout=None):
        sent.append(request)
        return _Response()

    monkeypatch.setattr(email_service.urllib.request, "urlopen", _urlopen)
    return sent


@pytest.fixture
def provider(monkeypatch, requests):
    monkeypatch.setattr(settings, "email_mode", "provider")
    monkeypatch.setattr(settings, "email_api_key", FAKE_KEY)
    monkeypatch.setattr(settings, "email_from", FROM)
    return requests


def _never_asked(prompt: str) -> str:
    raise AssertionError("the recipient was asked for")


def test_one_message_with_the_user_agent_and_a_bare_sender(script, provider, capsys):
    assert script.main(ask=lambda prompt: RECIPIENT) == 0
    [request] = provider
    assert request.full_url == "https://api.resend.com/emails"
    assert request.get_header("User-agent") == USER_AGENT
    payload = json.loads(request.data.decode())
    assert payload["to"] == [RECIPIENT]
    # The `from` header: the brand's display name and the bare EMAIL_FROM.
    assert payload["from"] == f"{FROM_DISPLAY_NAME} <{FROM}>"
    assert re.fullmatch(r"[^<>@]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>", payload["from"])
    # No link and no token in the message.
    text = payload["subject"] + payload["text"]
    assert "http" not in text and "token" not in text.lower()
    out = capsys.readouterr().out
    assert "provider-mode send ok for [" in out and "status=200" in out
    # Nothing secret printed: not the key, the recipient or the message.
    for secret in (FAKE_KEY, RECIPIENT, "kinmail", payload["subject"], payload["text"]):
        assert secret not in out


def test_console_mode_is_refused_before_anything_is_asked(script, requests, monkeypatch, capsys):
    monkeypatch.setattr(settings, "email_mode", "console")
    assert script.main(ask=_never_asked) != 0
    assert requests == []
    assert "EMAIL_MODE=provider" in capsys.readouterr().out


@pytest.mark.parametrize("typed", ["me@example.com", "  ", ""])
def test_a_reserved_or_empty_recipient_is_refused(script, provider, capsys, typed):
    assert script.main(ask=lambda prompt: typed) != 0
    assert provider == []
    out = capsys.readouterr().out
    if typed.strip():
        assert typed not in out


def test_a_refused_send_exits_one_and_prints_nothing_secret(script, provider, monkeypatch, capsys):
    def _refused(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(email_service.urllib.request, "urlopen", _refused)
    assert script.main(ask=lambda prompt: RECIPIENT) == 1
    out = capsys.readouterr().out
    assert "provider-mode send failed for [" in out and "403" in out
    for secret in (FAKE_KEY, RECIPIENT, "kinmail"):
        assert secret not in out


def test_the_script_touches_no_database():
    code = "\n".join(
        line
        for line in SCRIPT.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    )
    # Only the code after the docstring is scanned for imports.
    code = code.split('"""', 2)[2]
    for name in ("app.db", "app.models", "app.api", "sqlalchemy", "asyncpg", "psycopg"):
        assert name not in code, name
