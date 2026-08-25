"""Two-mode transactional email adapter (Paper Goose transactional-email
standard v1.0.0; Sale Hopper's `app/emailer.py` is the worked example).

Modes, selected by EMAIL_MODE:

- ``console`` (default, what this phase deploys): the full message — magic link
  included — prints to stdout, i.e. the service logs. Console mode must never
  be the deployed mode once real users exist.
- ``provider``: a plain-stdlib HTTP POST to the provider API — no SDK, no
  requests, no new dependency. Written but unreachable this phase: no key is
  configured, and the mode flip is its own later phase (separate from any code
  deploy, per the standard's cutover ordering).

A send failure degrades, never raises: the caller's account/token records exist
whether or not the email went out, so ``send_email`` returns a bool and nothing
on this path may propagate an exception. Provider-mode log lines identify the
recipient by hash prefix only — email addresses stay out of application logs.
"""

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


def send_email(*, to: str, subject: str, body: str) -> bool:
    if settings.email_mode == "provider":
        return _send_via_provider(to=to, subject=subject, body=body)
    # Console mode prints the full message (link and address included) to the
    # service logs — the whole flow is verifiable from logs, and no real mail
    # can ever leave a dev or local run.
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
