"""CK-100's fix-up — the email sends off the event loop.

In provider mode the adapter's HTTP call (`urllib.request.urlopen`, a 10 s
timeout) is blocking, and every caller is an async route: request-link (both
sends), the gathering and group invitation creates, and the email change (both
sends). Until this fix-up the call ran on the event loop, so each send stalled
every other request on that worker for as long as Resend took. Since then
`send_email` is a coroutine: its provider path awaits the call in a worker
thread (`asyncio.to_thread`), console mode and a reserved address print inline,
and every caller awaits it — so the route still answers after the send is
attempted, in the same order, with the same 202, bodies and lines.

No request leaves: every provider-mode test stubs `urlopen`. A stub that waits
does so on a `threading.Event` with a bound, so a blocked loop fails the test
rather than hanging it.
"""

import ast
import asyncio
import contextlib
import inspect
import threading
from pathlib import Path

import pytest

from app.config import settings
from app.services import email as email_service
from app.services.email import _recipient_ref, send_email
from tests.test_auth import _request_link

APP_DIR = Path(__file__).resolve().parent.parent / "app"

AUNT = "aunt.june@kinmail.net"
FAKE_KEY = "re_test_never_deployed_2222222222"
FROM = "hello@coveykeep.com"
# How long a waiting stub holds the send before it gives up. Long enough that
# a free loop always gets its turn first; short enough that a blocked loop
# fails the test in seconds.
SLOW_BOUND = 2.0


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def provider_mode(monkeypatch):
    monkeypatch.setattr(settings, "email_mode", "provider")
    monkeypatch.setattr(settings, "email_api_key", FAKE_KEY)
    monkeypatch.setattr(settings, "email_from", FROM)


async def test_the_loop_is_free_while_the_provider_answers(
    client, provider_mode, monkeypatch, capsys
):
    """A request-link for an address outside the reserved set reaches the
    provider (the invite-only note). While the stub holds the send, another
    coroutine on the loop keeps running and the route has not answered; once
    the stub is released the route answers 202 and the send succeeded. With
    the call on the loop, the stub held the loop itself: nothing else ran until
    its bound, and the route had already answered by the time anyone looked."""
    entered = threading.Event()
    release = threading.Event()
    seen = {}

    def _held(request, timeout=None):
        seen["thread"] = threading.get_ident()
        entered.set()
        seen["released"] = release.wait(timeout=SLOW_BOUND)
        if not seen["released"]:
            raise TimeoutError("the stub was never released")
        return _Response()

    monkeypatch.setattr(email_service.urllib.request, "urlopen", _held)
    loop = asyncio.get_running_loop()
    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.005)

    ticker = asyncio.create_task(_tick())
    request = asyncio.create_task(_request_link(client, "held.send@kinmail.net"))
    try:
        deadline = loop.time() + SLOW_BOUND
        while not entered.is_set():
            assert loop.time() < deadline, "the send never reached the provider"
            await asyncio.sleep(0.005)
        ticks_then = ticks
        await asyncio.sleep(0.05)
        assert not request.done(), (
            "the route had answered before the provider did: the send blocked the loop"
        )
        assert ticks > ticks_then, "nothing else on the loop ran while the provider answered"
        assert seen["thread"] != threading.get_ident()
        release.set()
        response = await asyncio.wait_for(request, timeout=SLOW_BOUND)
    finally:
        release.set()
        ticker.cancel()
        with contextlib.suppress(BaseException):
            await asyncio.wait_for(request, timeout=SLOW_BOUND)
    assert response.status_code == 202
    assert seen["released"] is True
    out = capsys.readouterr().out
    assert f"[email] provider-mode send ok for [{_recipient_ref('held.send@kinmail.net')}] status=200" in out


async def test_the_provider_call_runs_in_a_worker_thread_with_its_timeout(
    provider_mode, monkeypatch, capsys
):
    """The adapter itself does the threading, so no caller can forget it: a
    direct send, with no route around it, makes the call off the loop's
    thread, with the same 10 s timeout and the same line."""
    calls = []

    def _urlopen(request, timeout=None):
        calls.append((threading.get_ident(), timeout))
        return _Response()

    monkeypatch.setattr(email_service.urllib.request, "urlopen", _urlopen)
    assert await send_email(to=AUNT, subject="S", body="B") is True
    [(thread, timeout)] = calls
    assert thread != threading.get_ident()
    assert timeout == 10
    assert capsys.readouterr().out == (
        f"[email] provider-mode send ok for [{_recipient_ref(AUNT)}] status=200\n"
    )


async def test_console_mode_and_a_reserved_address_print_inline(monkeypatch, capsys):
    """Console mode, and a reserved address in provider mode, print on the
    loop with no thread: the line is out before `send_email` returns, exactly
    as it was printed before."""

    def _no_thread(*args, **kwargs):
        raise AssertionError("a thread was used for a send that prints")

    monkeypatch.setattr(asyncio, "to_thread", _no_thread)
    monkeypatch.setattr(settings, "email_mode", "console")
    assert await send_email(to=AUNT, subject="Subject", body="Body") is True
    assert capsys.readouterr().out == f"[email] console-mode send ok to={AUNT} subject='Subject'\nBody\n"

    monkeypatch.setattr(settings, "email_mode", "provider")
    monkeypatch.setattr(settings, "email_api_key", FAKE_KEY)
    monkeypatch.setattr(settings, "email_from", FROM)
    assert await send_email(to="t@example.com", subject="Subject", body="Body") is True
    assert capsys.readouterr().out == "[email] console-mode send ok to=t@example.com subject='Subject'\nBody\n"


def _send_calls(tree: ast.AST):
    """Every call of `send_email` in a module, with whether it is awaited. The
    syntax tree holds no comments and no strings' insides, so neither can pass
    for a call or hide one."""
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name == "send_email":
            yield node.lineno, isinstance(parents.get(node), ast.Await)


def test_every_send_in_the_application_is_awaited():
    """A coroutine called without `await` sends nothing, silently. Every call
    of `send_email` under `backend/app` is awaited, and the scan is not vacuous:
    each of the four emailing routers is found calling it."""
    assert inspect.iscoroutinefunction(send_email)
    found: dict[str, list[tuple[int, bool]]] = {}
    for path in sorted(APP_DIR.rglob("*.py")):
        calls = list(_send_calls(ast.parse(path.read_text(encoding="utf-8"))))
        if calls:
            found[path.relative_to(APP_DIR).as_posix()] = calls
    unawaited = [f"{name}:{line}" for name, calls in found.items() for line, awaited in calls if not awaited]
    assert unawaited == []
    for router in ("api/auth.py", "api/profile.py", "api/invitations.py", "api/group_invitations.py"):
        assert found.get(router), router
