"""CK-100 — reserved test addresses stay in the log, and a guarded email mode
(THE DESIGN §2, §3).

§2: an address at a domain reserved for testing — example.com, example.net,
example.org, and the names RFC 2606 and RFC 6761 reserve (the `example`,
`test`, `invalid` and `localhost` top-level names), each with every name
beneath it — is never sent to the provider: its message prints in console
form, link and all, in either mode. Every other address, in provider mode, is
named in the log by a hash prefix alone. ONE function decides.

§3: `EMAIL_MODE` is exactly `console` or `provider`; provider mode requires
`EMAIL_API_KEY` and `EMAIL_FROM`; `EMAIL_FROM` is a bare address. Each refusal
names the field and echoes no value (hide_input_in_errors, and the messages
themselves). The key takes no shape check: Resend's documentation shows
example keys and states no fixed prefix (measured at CK-100, its API
reference and API-keys pages).

No request leaves: every provider-mode test stubs `urlopen`.
"""

import json
import re
import urllib.error
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from app.brand import FROM_DISPLAY_NAME
from app.config import Settings, WorkerSettings, settings
from app.services import email as email_service
from app.services.email import _recipient_ref, is_reserved_address, send_email
from tests.test_auth import LINK_RE, _request_link
from tests.test_gatherings import _create as _create_gathering
from tests.test_gatherings import _signed_in_headers
from tests.test_invitations import _invite

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

AUNT = "aunt.may@kinmail.net"
FAKE_KEY = "re_test_never_deployed_0000000000"
FROM = "hello@coveykeep.com"


# --- §2: the reserved set, both directions -----------------------------------

RESERVED = [
    "a@example.com",
    "a@example.net",
    "a@example.org",
    "a@sub.example.com",
    "a@deep.sub.example.org",
    "a@example",
    "a@thing.example",
    "a@test",
    "a@mail.test",
    "a@invalid",
    "a@nowhere.invalid",
    "a@localhost",
    "a@app.localhost",
    "A.Person@EXAMPLE.COM",
    "a@example.com.",
    # The domain is what follows the LAST @: a quoted local part may hold one
    # (RFC 5322), so reading the first @ would call this a kinmail address.
    '"a@kinmail.net"@example.com',
]

NOT_RESERVED = [
    "a@gmail.com",
    "a@coveykeep.com",
    "a@coveykeep.app",
    "a@kinmail.net",
    "a@example.co",
    "a@examples.com",
    "a@notexample.com",
    "a@example-family.com",
    "a@example.com.au",
    "a@example.com.evil.org",
    "a@test.com",
    "a@mytest.org",
    "a@localhost.com",
    "a@invalid.io",
    "example.com@kinmail.net",
]


@pytest.mark.parametrize("address", RESERVED)
def test_a_reserved_address_is_reserved(address):
    assert is_reserved_address(address) is True


@pytest.mark.parametrize("address", NOT_RESERVED)
def test_every_other_address_is_not(address):
    assert is_reserved_address(address) is False


def test_one_function_decides():
    """The set lives in services/email.py and nowhere else in the application;
    the sign-in router asks that one function."""
    hits = []
    for path in (BACKEND_DIR / "app").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        # Any mention at all, quoted or not, with or without an @ before it:
        # a second decision written as `endswith("@example.com")` names it too.
        if re.search(r"example\.(com|net|org)", text):
            hits.append(path.relative_to(BACKEND_DIR).as_posix())
    assert hits == ["app/services/email.py"]
    auth_source = (BACKEND_DIR / "app" / "api" / "auth.py").read_text(encoding="utf-8")
    assert "from app.services.email import" in auth_source
    assert "is_reserved_address" in auth_source


# --- §2: provider mode -------------------------------------------------------


class _Sent:
    def __init__(self) -> None:
        self.requests = []


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def provider(monkeypatch):
    """Provider mode with a key and a sender, and a stub in place of the
    network: every request is recorded and answered 200."""
    sent = _Sent()

    def _urlopen(request, timeout=None):
        sent.requests.append(request)
        return _Response()

    monkeypatch.setattr(settings, "email_mode", "provider")
    monkeypatch.setattr(settings, "email_api_key", FAKE_KEY)
    monkeypatch.setattr(settings, "email_from", FROM)
    monkeypatch.setattr(email_service.urllib.request, "urlopen", _urlopen)
    return sent


def _payload(request) -> dict:
    return json.loads(request.data.decode())


async def test_a_reserved_address_never_reaches_the_provider_its_message_printed(
    provider, monkeypatch, capsys
):
    # MOVED at CK-100's fix-up, with its reason: send_email is a coroutine since
    # the sends moved off the event loop, so this test awaits it. Nothing else.
    built = []
    real_build = email_service.build_provider_request

    def _recording_build(**kwargs):
        built.append(kwargs["to"])
        return real_build(**kwargs)

    monkeypatch.setattr(email_service, "build_provider_request", _recording_build)
    body = "Sign in:\n\nhttp://testserver/auth/verify?token=abc123\n\nOnce."
    assert await send_email(to="throwaway@example.com", subject="Subject", body=body) is True
    assert built == []
    assert provider.requests == []
    assert capsys.readouterr().out == (
        f"[email] console-mode send ok to=throwaway@example.com subject='Subject'\n{body}\n"
    )


async def test_a_reserved_address_signs_in_from_the_log_in_provider_mode(
    client, provider, capsys
):
    response = await _request_link(client, "throwaway@example.com")
    assert response.status_code == 202
    out = capsys.readouterr().out
    assert LINK_RE.search(out)
    assert "provider-mode" not in out
    assert provider.requests == []


async def test_a_real_address_in_provider_mode_is_never_printed(provider, capsys):
    # MOVED at CK-100's fix-up: awaits the coroutine (the reason above).
    body = "Sign in:\n\nhttp://testserver/auth/verify?token=secret-token-value\n\nOnce."
    assert await send_email(to=AUNT, subject="A subject line", body=body) is True
    out = capsys.readouterr().out
    assert out == f"[email] provider-mode send ok for [{_recipient_ref(AUNT)}] status=200\n"
    for secret in (AUNT, "kinmail", "auth/verify", "secret-token-value", "A subject line", FAKE_KEY):
        assert secret not in out
    # And the message went to the provider whole.
    [request] = provider.requests
    assert request.full_url == "https://api.resend.com/emails"
    payload = _payload(request)
    assert payload["to"] == [AUNT]
    assert payload["text"] == body
    assert payload["from"] == f"{FROM_DISPLAY_NAME} <{FROM}>"


async def test_a_failed_send_to_a_real_address_prints_no_address(provider, monkeypatch, capsys):
    # MOVED at CK-100's fix-up: awaits the coroutine (the reason above).
    def _refused(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(email_service.urllib.request, "urlopen", _refused)
    assert await send_email(to=AUNT, subject="S", body="http://testserver/auth/verify?token=t") is False
    out = capsys.readouterr().out
    assert out.startswith(f"[email] provider-mode send failed for [{_recipient_ref(AUNT)}]: ")
    assert AUNT not in out and "kinmail" not in out and "token" not in out


async def test_through_the_routes_provider_mode_prints_no_address_and_no_link(
    client, provider, capsys
):
    headers = await _signed_in_headers(client, capsys, "host@example.com")
    gathering = await _create_gathering(client, headers)
    assert (await _invite(client, headers, gathering["id"], AUNT)).status_code == 201
    assert (await _request_link(client, AUNT)).status_code == 202
    assert (await _request_link(client, "stranger@kinmail.net")).status_code == 202
    out = capsys.readouterr().out
    # The host's own sign-in printed its link (reserved); nothing after it
    # names an address outside the reserved set, a link or a token.
    after_host = out.split("provider-mode", 1)[1]
    for secret in (AUNT, "stranger@", "kinmail", "auth/verify", "invitations/accept", "token="):
        assert secret not in after_host
    assert out.count("[email] provider-mode send ok") == 3
    # The invitation, the sign-in link and the note, each to its own address.
    to = [_payload(r)["to"] for r in provider.requests]
    assert to == [[AUNT], [AUNT], ["stranger@kinmail.net"]]
    assert "auth/verify?token=" in _payload(provider.requests[1])["text"]
    assert _payload(provider.requests[2])["subject"].endswith("is open by invitation")


# --- §3: the guarded mode ----------------------------------------------------


def _rendered(excinfo) -> str:
    return str(excinfo.value) + repr(excinfo.value)


def _locs(excinfo) -> list[tuple]:
    return [tuple(err["loc"]) for err in excinfo.value.errors()]


@pytest.mark.parametrize("bad", ["Provider", "CONSOLE", "smtp", "resend", "consoIe", ""])
def test_email_mode_must_be_exactly_console_or_provider(bad):
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, email_mode=bad)
    assert _locs(excinfo) == [("email_mode",)]
    rendered = _rendered(excinfo)
    assert "email_mode" in rendered
    assert "input_value" not in rendered
    if bad:
        assert bad not in rendered


def test_provider_mode_requires_the_key(monkeypatch):
    monkeypatch.delenv("EMAIL_API_KEY", raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, email_mode="provider", email_from=FROM)
    assert _locs(excinfo) == [("email_api_key",)]
    rendered = _rendered(excinfo)
    assert "EMAIL_API_KEY" in rendered and "input_value" not in rendered
    assert FROM not in rendered


def test_provider_mode_requires_the_sender(monkeypatch):
    monkeypatch.delenv("EMAIL_FROM", raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, email_mode="provider", email_api_key=FAKE_KEY)
    assert _locs(excinfo) == [("email_from",)]
    rendered = _rendered(excinfo)
    assert "EMAIL_FROM" in rendered and "input_value" not in rendered
    assert FAKE_KEY not in rendered


def test_provider_mode_with_neither_names_both(monkeypatch):
    monkeypatch.delenv("EMAIL_API_KEY", raising=False)
    monkeypatch.delenv("EMAIL_FROM", raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, email_mode="provider")
    assert sorted(_locs(excinfo)) == [("email_api_key",), ("email_from",)]


@pytest.mark.parametrize("mode", ["console", "provider"])
@pytest.mark.parametrize(
    "bad",
    [
        "CoveyKeep <hello@coveykeep.com>",
        "<hello@coveykeep.com>",
        '"Covey" hello@coveykeep.com',
        "hello@coveykeep.com, other@coveykeep.com",
        "hello at coveykeep.com",
        "hello@",
        "@coveykeep.com",
        "hello@coveykeep",
        "hello@@coveykeep.com",
        " hello@coveykeep.com",
    ],
)
def test_the_sender_must_be_a_bare_address(mode, bad):
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None, email_mode=mode, email_api_key=FAKE_KEY, email_from=bad)
    assert _locs(excinfo) == [("email_from",)]
    rendered = _rendered(excinfo)
    assert "input_value" not in rendered
    assert bad.strip() not in rendered
    assert FAKE_KEY not in rendered


def test_console_mode_boots_with_neither_variable(monkeypatch):
    monkeypatch.delenv("EMAIL_API_KEY", raising=False)
    monkeypatch.delenv("EMAIL_FROM", raising=False)
    monkeypatch.setenv("EMAIL_MODE", "console")
    built = Settings(_env_file=None)
    assert (built.email_mode, built.email_api_key, built.email_from) == ("console", "", "")
    # And the mode's own default is console.
    monkeypatch.delenv("EMAIL_MODE")
    assert Settings(_env_file=None).email_mode == "console"


def test_provider_mode_boots_with_both_and_the_key_takes_no_shape_check():
    # Resend states no fixed key prefix (CK-100 measured its documentation),
    # so any non-empty key boots; only an empty one is refused.
    for key in (FAKE_KEY, "any-shape-at-all"):
        built = Settings(_env_file=None, email_mode="provider", email_api_key=key, email_from=FROM)
        assert (built.email_mode, built.email_api_key, built.email_from) == ("provider", key, FROM)


def test_the_worker_reads_none_of_it():
    assert not any("email" in name for name in WorkerSettings.model_fields)


def test_render_yaml_declares_the_two_and_sends_through_the_provider():
    # THE PIN MOVED at CK-100's switch, with its reason: the switch is ONE
    # COMMIT setting this line to provider, made after the checks, the domain
    # verified in Resend, the key in covey-keep-api's dashboard and the smoke
    # script passed. Until then it pinned console. A commit, because a
    # Blueprint sync puts a dashboard value back to the file's; the code
    # default stays console (test_console_mode_boots_with_neither_variable).
    blueprint = yaml.safe_load((REPO_ROOT / "render.yaml").read_text(encoding="utf-8"))
    services = {service["name"]: service for service in blueprint["services"]}
    api = {var["key"]: var for var in services["covey-keep-api"]["envVars"]}
    assert api["EMAIL_MODE"] == {"key": "EMAIL_MODE", "value": "provider"}
    assert api["EMAIL_FROM"] == {"key": "EMAIL_FROM", "value": FROM}
    assert api["EMAIL_API_KEY"] == {"key": "EMAIL_API_KEY", "sync": False}
    worker = [var["key"] for var in services["covey-keep-worker"]["envVars"]]
    assert not any(key.startswith("EMAIL_") for key in worker)
