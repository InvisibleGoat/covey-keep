"""Two-mode transactional email adapter (Paper Goose transactional-email
standard v1.0.0; Sale Hopper's `app/emailer.py` is the worked example).

Modes, selected by EMAIL_MODE:

- ``console`` (the default, what a local run and the suite use): the full
  message — magic link included — prints to stdout, i.e. the service logs.
  Console mode must never be the deployed mode once real users exist.
- ``provider``: a plain-stdlib HTTP POST to the provider API (Resend) — no SDK,
  no requests, no new dependency. Since CK-100 its settings are boot-checked
  (``app/config.py``: the mode exactly one of the two, the key and the sender
  required in provider mode). The deploy runs it since CK-100's switch, ONE
  COMMIT setting render.yaml's EMAIL_MODE to provider — a commit, because a
  Blueprint sync can put a dashboard value back to the file's — and its
  rollback is that line set back to console.

A RESERVED TEST ADDRESS — at example.com, example.net or example.org, or under
the ``example``, ``test``, ``invalid`` or ``localhost`` top-level names (RFC
2606, RFC 6761), each with every name beneath it — is never sent to the
provider: its message prints in console form, link and all, in either mode, so
a test account can still sign in from the log once real email is on. ONE
function decides, ``is_reserved_address``, and the sign-in router asks it too
(an address it answers for may sign up without an invitation). In provider
mode no other address is ever printed.

A send failure degrades, never raises: the caller's account/token records exist
whether or not the email went out, so ``send_email`` returns a bool and nothing
on this path may propagate an exception. Provider-mode log lines identify the
recipient by hash prefix only — email addresses stay out of application logs.

``send_email`` is a coroutine, and every caller awaits it (pinned by a scan of
the application). The provider's HTTP call is blocking — ``urlopen`` with a
10 s timeout — and every caller is an async route, so it runs in a worker
thread (``asyncio.to_thread``) and is awaited: the event loop serves other
requests while Resend answers, and the route still answers after the send is
attempted, in the same order, with the same lines. Console mode and a reserved
address print inline, on the loop. This module does the threading so that no
caller can forget it.
"""

import asyncio
import hashlib
import json
import urllib.request

from app import __version__
from app.brand import FROM_DISPLAY_NAME
from app.config import settings

# Load-bearing, not decoration: Cloudflare fronts the provider API and answers
# stdlib urllib's default agent with 403 / error code 1010, silently. Pinned by
# test — note urllib reads it back via get_header("User-agent").
USER_AGENT = f"covey-keep-api/{__version__}"

_PROVIDER_ENDPOINT = "https://api.resend.com/emails"


# The names reserved for testing and documentation: RFC 2606 §2 and §3
# (example.com, .net, .org; the example, test, invalid and localhost top-level
# names) and RFC 6761 §6, which reserves the same four top-level names. Each
# name and every name beneath it. Nothing else.
_RESERVED_NAMES = (
    "example.com",
    "example.net",
    "example.org",
    "example",
    "test",
    "invalid",
    "localhost",
)


def is_reserved_address(address: str) -> bool:
    """True for an address at a domain reserved for testing, and only then.

    The domain is everything after the last ``@``, compared without case and
    without a trailing root dot; it is reserved when it IS one of the reserved
    names or ends with ``.`` and one of them. Never a substring test: a@
    examples.com, a@example.com.au and example.com@kinmail.net are real
    addresses that reach the provider.
    """
    domain = address.rpartition("@")[2].strip().lower().rstrip(".")
    return any(domain == name or domain.endswith("." + name) for name in _RESERVED_NAMES)


def _recipient_ref(to: str) -> str:
    """Greppable non-PII recipient reference for provider-mode log lines."""
    return hashlib.sha256(to.encode()).hexdigest()[:12]


def build_provider_request(*, to: str, subject: str, body: str) -> urllib.request.Request:
    payload = json.dumps(
        {
            # EMAIL_FROM stays a bare address — it is environment, not brand;
            # the display-name half rides in from app/brand.py (name-gate §4).
            "from": f"{FROM_DISPLAY_NAME} <{settings.email_from}>",
            "to": [to],
            "subject": subject,
            "text": body,
        }
    ).encode()
    return urllib.request.Request(
        _PROVIDER_ENDPOINT,
        data=payload,
        headers={
            "Authorization": f"Bearer {settings.email_api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )


async def send_email(*, to: str, subject: str, body: str) -> bool:
    if settings.email_mode == "provider" and not is_reserved_address(to):
        # The blocking call goes to a worker thread and is awaited, so the loop
        # stays free and the caller still answers after the send is attempted.
        return await asyncio.to_thread(_send_via_provider, to=to, subject=subject, body=body)
    # Console mode prints the full message (link and address included) to the
    # service logs — the whole flow is verifiable from logs, and no real mail
    # can ever leave a dev or local run. A reserved test address takes this
    # path in provider mode too (CK-100): it reaches no provider, and only a
    # reserved address is ever printed there.
    print(
        f"[email] console-mode send ok to={to} subject={subject!r}\n{body}",
        flush=True,
    )
    return True


def _send_via_provider(*, to: str, subject: str, body: str) -> bool:
    ref = _recipient_ref(to)
    if not settings.email_api_key or not settings.email_from:
        print(
            f"[email] provider-mode send failed for [{ref}]: "
            "EMAIL_API_KEY / EMAIL_FROM not configured",
            flush=True,
        )
        return False
    try:
        request = build_provider_request(to=to, subject=subject, body=body)
        with urllib.request.urlopen(request, timeout=10) as response:
            print(
                f"[email] provider-mode send ok for [{ref}] status={response.status}",
                flush=True,
            )
            return True
    except Exception as exc:  # noqa: BLE001 — a send failure must never fail the request
        print(f"[email] provider-mode send failed for [{ref}]: {exc}", flush=True)
        return False
