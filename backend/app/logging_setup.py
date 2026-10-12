"""The API's own logging — the `covey-keep` namespace configured, and
nothing else (CK-73.1).

THE DEFECT THIS CLOSES. The worker configures logging at its entry point
(`app/worker.py::main`: `logging.basicConfig(level=INFO, stream=stdout)`,
which configures the ROOT); the web service never did. Python's root
logger sits at WARNING with no handler, so every INFO record an `app/`
module ever emitted in the API process — `covey-keep.billing`'s one line
per handled webhook event among them — was dropped before it reached a
stream, and its WARNING and ERROR lines surfaced only through Python's
last-resort handler, on stderr. CK-73's deploy check (iq) looked for the
webhook's INFO line in Render's log and found uvicorn's access lines
alone; every INFO line the API was ever meant to write had been silent,
CK-73's being the first anyone looked for.

WHAT IS CONFIGURED, AND WHAT IS NOT. `configure_logging` sets the
`covey-keep` logger — the namespace every application logger lives under
— to INFO and gives it ONE handler writing to stdout in the worker's
format, so a line reads the same from either service. It touches NOTHING
ELSE:

- NOT THE ROOT. A root `basicConfig(level=INFO)` would make every
  library's INFO line visible too — botocore's and stripe's among them,
  whose INFO lines carry request URLs — which is the reason storage.py
  and services/billing.py pin those loggers above DEBUG and at WARNING.
  Only our own namespace is turned on, so a library line can never
  become visible by accident, and the `stripe` (WARNING) and
  `botocore.*` (INFO) pins stand exactly as they were.
- `propagate` STAYS TRUE, deliberately. The suite's `caplog` captures at
  the root, and CK-73's never-log pins — no URL, no email, no payload in
  ANY log record, with the root at DEBUG — read `caplog.records`; a
  namespace that stopped propagating would make every one of those pins
  pass VACUOUSLY, asserting silence over an empty list. In production the
  root has no handler (uvicorn configures only its own `uvicorn.*`
  loggers, with `disable_existing_loggers: False`; nothing here
  configures the root), so propagation writes nothing twice. Under pytest
  a record reaches this handler AND the root's capture — two captured
  copies, and no assertion the worse for it.

IDEMPOTENT. Called once, at `app.main`'s import. The handler is MARKED
(`_API_HANDLER_MARK`), and a second call — a second import of `app.main`,
uvicorn's reloader re-importing the application, a test calling it on
purpose — finds the mark and adds nothing: one handler, one line per
record, however many times the module is imported in a process.

THE WORKER IS UNTOUCHED, and must never import this module: it configures
the root in its own entry point, and a `covey-keep` handler beside a root
handler would write every worker line twice. Its import graph does not
load `app.main` (pinned since CK-59; re-asserted at CK-73.1), and
`app.main` is this function's only caller.

WHAT THESE LINES MAY CARRY, now that they are visible: ids, event types,
plan names, counts — never an email, a URL, a key, a payload, a filename,
a caption or a tag (the never-log rule). Every INFO-or-above call under
`app/` that the web import graph reaches was enumerated at CK-73.1 (its
report) and found to carry ids alone; the pins that keep it so are in
tests/test_billing.py.
"""

from __future__ import annotations

import logging
import sys
from typing import IO, Optional

# The namespace every application logger lives under — `covey-keep.billing`
# in this process; `covey-keep.ingest` and `covey-keep.worker` exist in the
# worker's and never emit here.
NAMESPACE = "covey-keep"

# The worker's format, verbatim (app/worker.py::main's basicConfig), so a
# line reads the same from either service. Pinned equal by test, against
# the worker's source — which this module does not touch.
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"

# The attribute that marks the one handler this module adds, so a second
# call finds it rather than adding another.
_API_HANDLER_MARK = "covey_keep_api_handler"


def api_handler() -> Optional[logging.Handler]:
    """The handler this module added to the namespace logger, or None when
    `configure_logging` has not run in this process."""
    for handler in logging.getLogger(NAMESPACE).handlers:
        if getattr(handler, _API_HANDLER_MARK, False):
            return handler
    return None


def configure_logging(stream: Optional[IO[str]] = None) -> logging.Handler:
    """Configure the `covey-keep` namespace: INFO, one marked handler to
    `stream` (stdout by default) in the worker's format. Idempotent — a
    second call returns the handler the first added and changes nothing,
    `stream` included. The root logger and `propagate` are never touched
    (the module docstring says why each)."""
    existing = api_handler()
    if existing is not None:
        return existing
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    setattr(handler, _API_HANDLER_MARK, True)
    logger = logging.getLogger(NAMESPACE)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return handler
