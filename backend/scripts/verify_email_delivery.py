"""Prove real email leaves through Resend (CK-100; THE DESIGN §5).

Run before CK-100's switch, and again after any change to the key, the
sending address or the domain's records: this script sends ONE
message through the application's own adapter (app/services/email.py's
send_email, so the request the product makes is what gets tested: the
endpoint, the User-Agent Cloudflare insists on, the bare EMAIL_FROM behind the
brand's display name) to an address the operator types in, and prints the
adapter's status line.

The message carries no link and no token. Output is the adapter's line, which
names the recipient by a hash prefix alone, and PASS or FAIL: never the key,
never the recipient, never the message. The script touches no database.

Run it where the key already lives, so it never leaves Render, with provider
mode set for that one command (the service runs provider since the switch,
and the prefix keeps the command working if it is ever set back):

    Render dashboard -> covey-keep-api -> Shell
    cd ~/project/src/backend && EMAIL_MODE=provider python scripts/verify_email_delivery.py

It asks for a recipient: type an inbox you control. A reserved test address
(example.com and the rest) is refused, because it never reaches the provider.
Then look in that inbox, the spam folder included.

Exit code: 0 if the provider accepted the message, 1 if it refused it or the
send failed, 2 if the script refused to send (not provider mode, or no usable
recipient).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Callable

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

try:
    # Importing app.config constructs the settings singleton, so the API's
    # environment must be present; in provider mode that includes
    # EMAIL_API_KEY and EMAIL_FROM, and a missing one refuses here by name.
    from app.brand import PRODUCT_NAME
    from app.config import settings
    from app.services.email import is_reserved_address, send_email
except Exception as exc:  # pragma: no cover - operator-facing guidance
    fields = ""
    if hasattr(exc, "errors"):
        try:
            fields = ", ".join(".".join(str(part) for part in err["loc"]) for err in exc.errors())
        except Exception:  # noqa: BLE001 - the field names are a courtesy
            fields = ""
    raise SystemExit(
        f"Could not load the settings ({exc.__class__.__name__}"
        + (f": {fields}" if fields else "")
        + "). Run it on covey-keep-api with EMAIL_MODE=provider; EMAIL_API_KEY and "
        "EMAIL_FROM must be set."
    )

SUBJECT = f"{PRODUCT_NAME} email check"
BODY = (
    f"This is a test message from {PRODUCT_NAME}, sent to check that its email "
    "is delivered. There's nothing to do, and you can delete it."
)


def main(ask: Callable[[str], str] = input) -> int:
    # ASCII-only output, as the other verifiers: a Windows console under cp1252
    # must not fail the script for cosmetic reasons.
    print("covey-keep email delivery check")
    if settings.email_mode != "provider":
        print(
            "  refused: the service is in console mode, so nothing would be sent. "
            "Run it as EMAIL_MODE=provider python scripts/verify_email_delivery.py"
        )
        return 2

    recipient = ask("Recipient address (your own): ").strip()
    if "@" not in recipient:
        print("  refused: no recipient address was given")
        return 2
    if is_reserved_address(recipient):
        print(
            "  refused: that is a reserved test address, which never reaches the "
            "provider; type an inbox you control"
        )
        return 2

    # send_email prints the adapter's own line: the recipient's hash prefix and
    # the provider's status, or why the send failed. It never raises. It is the
    # routes' coroutine, run here on a loop of its own, so the script sends
    # through exactly the path the product does.
    ok = asyncio.run(send_email(to=recipient, subject=SUBJECT, body=BODY))
    if ok:
        print("PASS: the provider accepted the message. Look for it in that inbox, spam included.")
        return 0
    print("FAIL: the message was not sent. The line above says why.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
