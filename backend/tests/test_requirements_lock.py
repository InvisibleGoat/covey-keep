"""CK-72 — the lock cannot quietly stop being one.

Both Render services build with ``pip install -r requirements.txt`` and nothing
else, so the whole deployed dependency tree is whatever that file says. Since
CK-72 it is a universal, hash-checked lock compiled from ``requirements.in``
(``uv pip compile --universal --generate-hashes``) and never edited by hand;
the dev tools follow the same shape in ``requirements-dev.in`` →
``requirements-dev.txt``, constrained to the runtime lock.

These tests read the four files as TEXT — no network, no pip, no uv — and pin
the properties the build depends on:

- every line of both locks is ``name==version`` carrying at least one
  ``--hash=sha256:`` (pip runs in hash-checking mode only when EVERY
  requirement is hashed; one bare line would make pip refuse the whole
  install, and a line with a range would be resolved fresh on Render — the
  floating tree CK-72 exists to end);
- every hand-written requirement is an exact ``==`` pin — no ranges, no bare
  names — so the lock is reproducible from the .in and nothing re-resolves;
- every direct pin reappears in its lock at the same version, so a person
  cannot edit the .in and forget to recompile (or recompile and get a
  different version than they wrote);
- the runtime lock names no dev tool, so nothing in ``requirements-dev.in``
  ever reaches Render — ``uv`` in particular is a DEV tool only;
- every package present in both locks is at ONE version — the ``-c
  requirements.txt`` constraint made true — so the suite runs on exactly the
  deployed tree plus the test tools;
- the runtime lock is UNIVERSAL: ``uvloop`` is in it with a marker excluding
  ``win32``. A ``pip freeze`` or a platform-specific compile on the Windows dev
  machine would drop ``uvloop`` from the Linux deploy (the CLAUDE.md Gotcha),
  and this is the line that would fail.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
RUNTIME_IN = BACKEND / "requirements.in"
RUNTIME_LOCK = BACKEND / "requirements.txt"
DEV_IN = BACKEND / "requirements-dev.in"
DEV_LOCK = BACKEND / "requirements-dev.txt"

# The tools the kickoff names as never-on-Render. requirements-dev.in's own
# direct requirements are checked as well, so a tool added there later is
# covered without editing this set.
DEV_TOOLS = {"pytest", "pytest-asyncio", "uv"}

# A lock requirement: `name==version`, an optional ` ; marker`, and the
# trailing ` \` that continues onto its --hash lines.
_LOCK_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)(?: ; (.+?))? \\$")
# A hand-written requirement: `name[extras]==version`, nothing else.
_IN_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==(\S+)$")
_HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}( \\)?$")


def _canon(name: str) -> str:
    """PEP 503 normalisation: uv writes `pillow`, requirements.in says `Pillow`."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def _parse_lock(path: Path) -> dict[str, tuple[str, str | None, int]]:
    """name -> (version, marker, hash count). Fails on any line that is not a
    comment, a blank, a `name==version` requirement or one of its --hash
    continuations — a `-r`, a `-c`, a range or a bare name has no place in a
    lock pip installs in hash-checking mode."""
    out: dict[str, tuple[str, str | None, int]] = {}
    current: str | None = None
    for raw in _read_lines(path):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw[0].isspace():
            assert current is not None, f"{path.name}: continuation before any requirement: {raw!r}"
            assert _HASH.match(stripped), f"{path.name}: {current}: continuation is not a sha256 hash: {raw!r}"
            version, marker, count = out[current]
            out[current] = (version, marker, count + 1)
            continue
        match = _LOCK_LINE.match(raw)
        assert match, f"{path.name}: not an exact, hashed pin: {raw!r}"
        current = _canon(match.group(1))
        assert current not in out, f"{path.name}: {current} listed twice"
        out[current] = (match.group(2), match.group(3), 0)
    assert out, f"{path.name}: no requirements parsed"
    return out


def _parse_in(path: Path) -> tuple[dict[str, str], list[str]]:
    """name -> version for every pin, plus the `-c` lines it carries."""
    pins: dict[str, str] = {}
    constraints: list[str] = []
    for raw in _read_lines(path):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("-c "):
            constraints.append(stripped)
            continue
        match = _IN_LINE.match(stripped)
        assert match, f"{path.name}: not an exact `name==version` pin: {raw!r}"
        pins[_canon(match.group(1))] = match.group(3)
    assert pins, f"{path.name}: no pins parsed"
    return pins, constraints


@pytest.mark.parametrize("lock", [RUNTIME_LOCK, DEV_LOCK], ids=["runtime", "dev"])
def test_every_lock_requirement_is_an_exact_pin_with_a_hash(lock: Path) -> None:
    parsed = _parse_lock(lock)
    unhashed = sorted(name for name, (_, _, count) in parsed.items() if count < 1)
    assert unhashed == [], f"{lock.name}: pins with no --hash: {unhashed}"
    header = _read_lines(lock)[:2]
    assert header[0].startswith("# This file was autogenerated by uv"), header
    assert "--universal" in header[1] and "--generate-hashes" in header[1], header


@pytest.mark.parametrize("hand_written", [RUNTIME_IN, DEV_IN], ids=["runtime", "dev"])
def test_every_hand_written_requirement_is_an_exact_pin(hand_written: Path) -> None:
    # _parse_in asserts the shape of every non-comment line; a range, a bare
    # name or a `>=` fails inside it with the offending line in the message.
    pins, _ = _parse_in(hand_written)
    assert all(re.fullmatch(r"[A-Za-z0-9.!+*]+", v) for v in pins.values()), pins


@pytest.mark.parametrize(
    ("hand_written", "lock"),
    [(RUNTIME_IN, RUNTIME_LOCK), (DEV_IN, DEV_LOCK)],
    ids=["runtime", "dev"],
)
def test_every_direct_pin_is_in_its_lock_at_the_same_version(hand_written: Path, lock: Path) -> None:
    pins, _ = _parse_in(hand_written)
    locked = _parse_lock(lock)
    for name, version in pins.items():
        assert name in locked, f"{hand_written.name} pins {name}=={version} but {lock.name} lacks it — recompile"
        assert locked[name][0] == version, (
            f"{hand_written.name} pins {name}=={version} but {lock.name} has {locked[name][0]} — recompile"
        )


def test_the_runtime_lock_names_no_dev_tool() -> None:
    runtime = _parse_lock(RUNTIME_LOCK)
    dev_direct, _ = _parse_in(DEV_IN)
    never_on_render = {_canon(n) for n in DEV_TOOLS} | set(dev_direct)
    leaked = sorted(never_on_render & set(runtime))
    assert leaked == [], f"dev tools in requirements.txt, which Render installs: {leaked}"
    # The three the kickoff names, checked by name so the assertion cannot go
    # vacuous if requirements-dev.in is ever emptied.
    for tool in DEV_TOOLS:
        assert _canon(tool) not in runtime, tool


def test_the_dev_lock_is_constrained_to_the_runtime_lock() -> None:
    _, constraints = _parse_in(DEV_IN)
    assert constraints == ["-c requirements.txt"], constraints
    _, runtime_constraints = _parse_in(RUNTIME_IN)
    assert runtime_constraints == [], runtime_constraints
    runtime = _parse_lock(RUNTIME_LOCK)
    dev = _parse_lock(DEV_LOCK)
    shared = sorted(set(runtime) & set(dev))
    assert shared, "the dev tools share packages with the runtime (anyio, idna, h11…) — none found"
    disagreeing = {n: (runtime[n][0], dev[n][0]) for n in shared if runtime[n][0] != dev[n][0]}
    assert disagreeing == {}, f"a shared package at two versions: {disagreeing}"


def test_the_runtime_lock_is_universal() -> None:
    runtime = _parse_lock(RUNTIME_LOCK)
    assert "uvloop" in runtime, "uvloop missing: the lock was compiled for Windows, not universally"
    _, marker, _ = runtime["uvloop"]
    assert marker and "sys_platform != 'win32'" in marker, marker
    # And the lock itself says how it was made.
    assert "--universal" in _read_lines(RUNTIME_LOCK)[1]
