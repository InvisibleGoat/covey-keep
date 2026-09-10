"""Verify a database's schema shape against what the migrations claim to build.

READ-ONLY, by construction and by intent. Every statement is a SELECT; the
connection additionally sets `default_transaction_read_only=on`, so a write
that slipped in would be rejected by the server rather than by this comment.
Nothing here prints a personal-data column — only counts, table names, and
column names.

Why a committed script instead of ad-hoc SQL (CK-13.1): this connects to a
database holding real email addresses. Ad-hoc SQL is written once under
pressure and reviewed by nobody; a script is reviewable, repeatable, and can be
re-run after every future migration.

Usage (from the repo root or backend/):

    python backend/scripts/verify_schema.py

Target selection:
    VERIFY_DATABASE_URL   if set, the database to verify (Render's EXTERNAL
                          connection string when checking a deploy)
    otherwise             the app's own DATABASE_URL — from the process
                          environment (the Render Web Shell route, where no
                          .env exists), else backend/.env

**The credential is supplied by environment variable and never persisted.**
Do not put a deployed connection string in .env, .env.example, render.yaml, a
test fixture, a commit, or this file. In PowerShell:

    $env:VERIFY_DATABASE_URL = Read-Host "Render external connection string"

(`Read-Host` keeps it out of PSReadLine's on-disk history; a pasted inline
assignment would not.)

Exit code is 0 only if every assertion passed.
"""

from __future__ import annotations

import asyncio
import os
import sys
import urllib.parse
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

try:
    # Imported to REUSE the app's postgresql:// -> postgresql+asyncpg://
    # normalisation rather than reimplement it. Importing `settings` from
    # app.config constructs the web settings singleton (lazily on that
    # import since CK-35), so the required env surface must be present - in
    # the process environment or backend/.env - the same precondition
    # uvicorn and alembic already have.
    from app.config import Settings, settings as app_settings
except Exception as exc:  # pragma: no cover - operator-facing guidance
    raise SystemExit(
        f"Could not load app.config ({exc.__class__.__name__}). "
        "The required env surface must be present in the process environment "
        "or backend/.env - see backend/.env.example."
    )

# The migration revision this verifier is written against.
EXPECTED_REVISION = "0018"

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


def _database_url_source() -> str:
    """Where Settings found DATABASE_URL: the process environment (Render's
    Web Shell, or an exported shell) outranks backend/.env, so check it first."""
    if any(name.upper() == "DATABASE_URL" for name in os.environ):
        return "process environment"
    if (BACKEND_DIR / ".env").exists():
        return "backend/.env"
    return "unknown"


class Checks:
    """A pass/fail tally that prints as it goes."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            print(f"PASS  {label}")
        else:
            self.failed += 1
            print(f"FAIL  {label}" + (f"  --  {detail}" if detail else ""))
        return ok

    def info(self, label: str, value: object) -> None:
        print(f"INFO  {label}: {value}")


def resolve_target() -> tuple[str, dict, list[str]]:
    """Return (sqlalchemy_url, connect_args, notes).

    The URL itself is never printed - it is a live credential. `notes` holds
    the operator-facing lines: which env var supplied the target, the TLS mode,
    and any query parameters dropped (names only).

    The TLS handling is the confusing part of verifying a deploy. Render's
    INTERNAL URL - the one config.py already normalises for the running app,
    and the one the Web Shell route sees in the process environment - carries
    no sslmode and connects fine (this script still asks for TLS on it, as
    on any remote host - see the branch below). The EXTERNAL URL requires
    TLS and is handed out in libpq form, often with `?sslmode=require`. asyncpg has no `sslmode` parameter (it takes `ssl`),
    and SQLAlchemy forwards leftover query parameters to the driver as keyword
    arguments - so passing the external URL through unchanged fails with an
    unexpected-keyword TypeError rather than anything that mentions SSL. Every
    query parameter is therefore dropped from the URL and TLS is passed through
    connect_args instead.
    """
    raw = os.environ.get("VERIFY_DATABASE_URL")
    source = "VERIFY_DATABASE_URL"
    if not raw:
        raw = app_settings.database_url
        # Report where the fallback actually came from (CK-33): on Render's
        # Web Shell there is no .env — the value is in the process
        # environment, which pydantic-settings reads ahead of the file.
        source = f"DATABASE_URL ({_database_url_source()})"

    url = Settings._force_asyncpg_scheme(raw.strip())

    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((v for k, v in query if k.lower() == "sslmode"), None)

    connect_args: dict = {
        # Belt and braces on top of "every statement below is a SELECT": the
        # server rejects a write on this connection outright.
        "server_settings": {
            "application_name": "covey-keep-verify-schema",
            "default_transaction_read_only": "on",
        }
    }

    if sslmode:
        # asyncpg speaks the same vocabulary as libpq's sslmode, just under a
        # different argument name.
        if sslmode.lower() != "disable":
            connect_args["ssl"] = sslmode.lower()
        tls = sslmode.lower()
    elif (parts.hostname or "") not in LOCAL_HOSTS:
        # A remote host with no sslmode given — Render's EXTERNAL endpoint
        # (which refuses plaintext) and equally its INTERNAL host, the one
        # the Web Shell route reaches through DATABASE_URL: this branch asks
        # asyncpg for TLS on both, so the Web Shell connection is encrypted
        # too, not merely "inside Render's network". Only a local host
        # connects in the clear.
        connect_args["ssl"] = "require"
        tls = "require (defaulted for a remote host)"
    else:
        tls = "off (local host)"

    notes = [f"source: {source}", f"TLS: {tls}"]
    dropped = sorted({k for k, _ in query})
    if dropped:
        # Names only - never the values, and never the URL.
        notes.append("dropped URL parameters (handled via connect_args): " + ", ".join(dropped))

    cleaned = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))
    return cleaned, connect_args, notes


async def load_schema(conn) -> tuple[set[str], dict[str, dict[str, bool]], set[str]]:
    """Read table names, column nullability, and CHECK-constraint names."""
    tables = {
        row[0]
        for row in (
            await conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
                )
            )
        ).all()
    }

    columns: dict[str, dict[str, bool]] = {}
    for table_name, column_name, is_nullable in (
        await conn.execute(
            text(
                "SELECT table_name, column_name, is_nullable "
                "FROM information_schema.columns WHERE table_schema = 'public'"
            )
        )
    ).all():
        columns.setdefault(table_name, {})[column_name] = is_nullable == "YES"

    checks = {
        row[0]
        for row in (
            await conn.execute(
                text(
                    "SELECT c.conname FROM pg_constraint c "
                    "JOIN pg_namespace n ON n.oid = c.connamespace "
                    "WHERE c.contype = 'c' AND n.nspname = 'public'"
                )
            )
        ).all()
    }
    return tables, columns, checks


async def scalar(conn, sql: str) -> int:
    return (await conn.execute(text(sql))).scalar_one()


async def enum_labels(conn, typname: str) -> list[str]:
    """A Postgres enum's labels in sort order. Read from pg_enum because
    Alembic's autogenerate never diffs enum labels — a label missing on a
    deployed database is invisible to `alembic check`."""
    return [
        row[0]
        for row in (
            await conn.execute(
                text(
                    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid "
                    "WHERE t.typname = :t ORDER BY e.enumsortorder"
                ),
                {"t": typname},
            )
        ).all()
    ]


async def fk_rule(conn, conname: str):
    """(referenced table, delete rule) for a named FK, or None. confdeltype
    is a "char" — cast to text so the driver hands back a string ('a' = NO
    ACTION, 'c' = CASCADE, 'n' = SET NULL), not bytes."""
    return (
        await conn.execute(
            text(
                "SELECT confrelid::regclass::text, confdeltype::text FROM pg_constraint "
                "WHERE conname = :c AND contype = 'f'"
            ),
            {"c": conname},
        )
    ).first()


def assert_columns(
    ck: Checks,
    columns: dict[str, dict[str, bool]],
    table: str,
    *,
    present: tuple[str, ...] = (),
    absent: tuple[str, ...] = (),
    not_null: tuple[str, ...] = (),
    nullable: tuple[str, ...] = (),
) -> None:
    cols = columns.get(table)
    if cols is None:
        ck.check(False, f"{table}: table exists", "table missing, so its columns cannot be checked")
        return
    for column in present:
        ck.check(column in cols, f"{table}.{column} exists")
    for column in absent:
        ck.check(column not in cols, f"{table}.{column} is gone", "column still present")
    for column in not_null:
        if column in cols:
            ck.check(not cols[column], f"{table}.{column} is NOT NULL", "column is nullable")
        else:
            ck.check(False, f"{table}.{column} is NOT NULL", "column missing")
    for column in nullable:
        if column in cols:
            ck.check(cols[column], f"{table}.{column} is nullable", "column is NOT NULL")
        else:
            ck.check(False, f"{table}.{column} is nullable", "column missing")


async def verify(conn, ck: Checks) -> None:
    tables, columns, check_constraints = await load_schema(conn)

    # --- Migration head ----------------------------------------------------
    print("\n-- migration head --")
    if "alembic_version" in tables:
        # Read it as a list, not scalar_one(): an empty table (never migrated)
        # and multiple rows (divergent heads) are both real deployment
        # pathologies, and each deserves a legible failure rather than a
        # traceback from the verifier itself.
        revisions = (
            (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalars().all()
        )
        ck.check(
            list(revisions) == [EXPECTED_REVISION],
            f"alembic_version is at {EXPECTED_REVISION}",
            f"found {sorted(revisions)!r}" if revisions else "alembic_version is empty",
        )
    else:
        ck.check(False, "alembic_version table exists", "no alembic_version table")

    # --- Keeper spine, structural (0008) -----------------------------------
    print("\n-- keeper spine tables (0008/0009) --")
    for table in ("accounts", "gatherings", "occurrences", "gathering_invitations", "kept_gatherings"):
        ck.check(table in tables, f"table {table} exists", "missing")
    for table in ("events", "event_series"):
        ck.check(table not in tables, f"table {table} is dropped", "table still exists")

    print("\n-- children re-pointed at occurrences --")
    for table in ("rsvps", "attendance_records", "item_slots", "item_claims"):
        assert_columns(ck, columns, table, present=("occurrence_id",), absent=("event_id",))

    print("\n-- posts and media hang on the gathering --")
    for table in ("posts", "media"):
        assert_columns(
            ck,
            columns,
            table,
            absent=("event_id",),
            not_null=("gathering_id",),
            nullable=("occurrence_id",),
        )
    # --- The media schema (0016, CK-32; 0017, CK-34) — extends this block
    # rather than opening a new one: the table has been here since 0001 and
    # the media arc AMENDS it (pipeline record §10). Rows exist since CK-34's
    # intent endpoint; the row count is informational below, and the
    # data-integrity checks further down are properties of whatever rows
    # exist, never counts (pending rows are reaped opportunistically). -----
    print("\n-- media: the status ladder (0016) --")
    # The media row IS the job (record §6.1): five rungs, in ladder order.
    media_status = await enum_labels(conn, "media_status")
    for label in ("pending_upload", "uploaded", "processing", "ready", "failed"):
        ck.check(label in media_status, f"media_status carries {label!r}", "label missing")
    status_default = (
        await conn.execute(
            text(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'media' "
                "AND column_name = 'status'"
            )
        )
    ).scalar()
    # 0001 defaulted status to 'processing'; under the ladder that default
    # would let an INSERT that omitted the rung be reclaimed by the worker
    # against an object never uploaded. A writer must state the rung.
    ck.check(
        status_default is None,
        "media.status has no server default (a writer states the rung)",
        f"default is {status_default!r}",
    )

    print("\n-- media: the job columns (0016) --")
    assert_columns(
        ck,
        columns,
        "media",
        not_null=("attempts",),
        nullable=("available_at", "claimed_at", "last_error"),
    )

    print("\n-- media: uploaded_at is stamped at confirm, never at intent (0017) --")
    # The row is born at intent (that instant is created_at); uploaded_at is
    # NULL until the confirm step verifies the object and moves the row to
    # `uploaded` — claimed_at's shape. 0001's NOT NULL DEFAULT now() would
    # stamp intent time under a name that says otherwise (CK-34).
    assert_columns(ck, columns, "media", nullable=("uploaded_at",))
    uploaded_at_default = (
        await conn.execute(
            text(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'media' "
                "AND column_name = 'uploaded_at'"
            )
        )
    ).scalar()
    ck.check(
        uploaded_at_default is None,
        "media.uploaded_at has no server default (the confirm step stamps it)",
        f"default is {uploaded_at_default!r}",
    )

    print("\n-- media: the object columns live on the derivative rows (0016) --")
    # The photograph stores no object: key, class, and access time belong
    # to a stored object (a media_derivatives row), and the quarantine
    # original's key is derived from the row id, never stored. The two
    # upload facts are named for what they are — the 0001 names would carry
    # two readings beside media_derivatives.size_bytes.
    assert_columns(
        ck,
        columns,
        "media",
        absent=("storage_key", "storage_class", "last_accessed", "size_bytes", "content_type"),
        not_null=("upload_content_type", "upload_size_bytes"),
    )
    ck.check("media_derivatives" in tables, "table media_derivatives exists", "missing")
    assert_columns(
        ck,
        columns,
        "media_derivatives",
        not_null=("media_id", "layer", "storage_key", "content_type", "size_bytes", "storage_class"),
        nullable=("last_accessed",),
        # THE BINDING (media-layers record §8, consent record §1): no
        # per-layer lifecycle, ever. The three layers share the ONE
        # publication_state on media and die as a unit; a phase that adds
        # any of these here is adding the two-places-that-can-disagree
        # defect CK-13 spent a phase removing. Assert the absence so it
        # cannot be added quietly.
        absent=("publication_state", "removed_at", "status", "deleted_at"),
    )
    media_layer = await enum_labels(conn, "media_layer")
    for label in ("archival", "web", "thumbnail"):
        ck.check(label in media_layer, f"media_layer carries {label!r}", "label missing")
    derivative_fk = await fk_rule(conn, "fk_media_derivatives_media_id")
    ck.check(
        derivative_fk is not None and derivative_fk[0] == "media",
        "media_derivatives.media_id references media",
        "FK missing or pointing elsewhere",
    )
    ck.check(
        derivative_fk is not None and derivative_fk[1] == "c",
        "derivative rows are deleted with their photograph (ON DELETE CASCADE)",
        f"delete rule is {derivative_fk[1]!r}" if derivative_fk else "FK missing",
    )
    unique_constraints = {
        row[0]
        for row in (
            await conn.execute(
                text(
                    "SELECT c.conname FROM pg_constraint c "
                    "JOIN pg_namespace n ON n.oid = c.connamespace "
                    "WHERE c.contype = 'u' AND n.nspname = 'public'"
                )
            )
        ).all()
    }
    # One row per layer per photograph; one object per row.
    for name in ("uq_media_derivatives_media_id_layer", "uq_media_derivatives_storage_key"):
        ck.check(name in unique_constraints, f"UNIQUE {name} exists", "constraint missing")

    print("\n-- media: the occurrence label no longer blocks a delete (0016) --")
    # The CK-30 dormant 500, closed for media by the phase that gives it a
    # surface: a label, never an owner — a removed date clears the label
    # and keeps the photograph. SET NULL, not CASCADE.
    label_fk = await fk_rule(conn, "fk_media_occurrence_id")
    ck.check(
        label_fk is not None and label_fk[0] == "occurrences",
        "media.occurrence_id references occurrences",
        "FK missing or pointing elsewhere",
    )
    ck.check(
        label_fk is not None and label_fk[1] == "n",
        "a removed date clears the photograph's label (ON DELETE SET NULL)",
        f"delete rule is {label_fk[1]!r}" if label_fk else "FK missing",
    )

    # --- Keeper lifecycle (0009) -------------------------------------------
    print("\n-- gatherings lifecycle columns (0009) --")
    assert_columns(
        ck,
        columns,
        "gatherings",
        present=(
            "created_by_account_id",
            # host_account_id: the admin column renamed at 0013 (CK-28) —
            # the same assertion, its subject renamed with the column.
            "host_account_id",
            "last_keeper_left_at",
            "memorial_decedent_name",
            "total_bytes",
        ),
        # account_id was renamed, not added alongside; archive_at/delete_at must
        # never exist — grace is DERIVED from last_keeper_left_at, never stored.
        absent=("account_id", "archive_at", "delete_at"),
    )

    print("\n-- gatherings updated_at (0010) --")
    # CK-16 made gatherings user-mutable; the stamp column follows the
    # people.updated_at precedent — nullable, stamped on patch.
    assert_columns(ck, columns, "gatherings", present=("updated_at",), nullable=("updated_at",))

    print("\n-- pending invitations (0011) --")
    # The CK-25 pending table: channel-agnostic (channel + destination, never
    # an email column), hashed-token-only, with the consumed/revoked state
    # stamps both nullable. Its rows are reaped opportunistically (CK-24), so
    # nothing here COUNTS them — shape and normalization only.
    ck.check(
        "gathering_invitations_pending" in tables,
        "table gathering_invitations_pending exists",
        "missing",
    )
    assert_columns(
        ck,
        columns,
        "gathering_invitations_pending",
        not_null=(
            "channel",
            "destination",
            "token_hash",
            "expires_at",
            "invited_by_person_id",
        ),
        nullable=("consumed_at", "revoked_at"),
        # The destination lives HERE, ephemerally — never as an email column
        # on gathering_invitations, and never as a pre-created people row.
        absent=("email", "person_id"),
    )

    print("\n-- rsvp surface (0012) --")
    # is_observer -> stay_included: a column named for a retired word is how
    # the confusion returns (participation-terminology record, 2026-09-02).
    # The visibility setting is a NOT NULL value on the gathering, the
    # requires_approval shape.
    assert_columns(
        ck,
        columns,
        "rsvps",
        absent=("is_observer",),
        not_null=("stay_included",),
    )
    assert_columns(ck, columns, "gatherings", not_null=("rsvp_list_visibility",))

    print("\n-- rsvp companions replace the head counts (0014) --")
    # CK-29: store WHO, compute how many. The typed counts are gone — a typed
    # count can disagree with the list of names beside it, a computed one
    # cannot — and the row that CK-27 made mutable finally carries an
    # updated_at (nullable, NULL until first changed: the 0004/0010 shape).
    assert_columns(
        ck,
        columns,
        "rsvps",
        absent=("adult_count", "child_count"),
        present=("updated_at",),
        nullable=("updated_at",),
    )
    ck.check("rsvp_companions" in tables, "table rsvp_companions exists", "missing")
    assert_columns(
        ck,
        columns,
        "rsvp_companions",
        not_null=("rsvp_id", "position", "name"),
        # A companion is a NAME, never somebody the system knows — no person,
        # no account, no destination may ever appear here.
        absent=("person_id", "account_id", "email", "destination"),
    )
    # The FK is the deletion story: companion rows are third-party names an
    # attendee declared, and they die with their RSVP (ON DELETE CASCADE).
    companion_fk = (
        await conn.execute(
            text(
                # confdeltype is a "char" — cast to text so the driver hands
                # back a string ('c' = CASCADE), not bytes.
                "SELECT confrelid::regclass::text, confdeltype::text FROM pg_constraint "
                "WHERE conname = 'fk_rsvp_companions_rsvp_id' AND contype = 'f'"
            )
        )
    ).first()
    ck.check(
        companion_fk is not None and companion_fk[0] == "rsvps",
        "rsvp_companions.rsvp_id references rsvps",
        "FK missing or pointing elsewhere",
    )
    ck.check(
        companion_fk is not None and companion_fk[1] == "c",
        "companion rows are deleted with their RSVP (ON DELETE CASCADE)",
        f"delete rule is {companion_fk[1]!r}" if companion_fk else "FK missing",
    )

    print("\n-- rsvps follow their occurrence (0015) --")
    # CK-30: an RSVP to a date cannot outlive the date. The FK carries the
    # deletion story the handler used to be trusted to remember (a bare
    # delete against the old no-ondelete FK was an IntegrityError-turned-500,
    # live since CK-27); a deleted occurrence takes its RSVPs, whose
    # companions then cascade transitively through the 0014 FK above.
    rsvp_fk = (
        await conn.execute(
            text(
                "SELECT confrelid::regclass::text, confdeltype::text FROM pg_constraint "
                "WHERE conname = 'fk_rsvps_occurrence_id' AND contype = 'f'"
            )
        )
    ).first()
    ck.check(
        rsvp_fk is not None and rsvp_fk[0] == "occurrences",
        "rsvps.occurrence_id references occurrences",
        "FK missing or pointing elsewhere",
    )
    ck.check(
        rsvp_fk is not None and rsvp_fk[1] == "c",
        "rsvps are deleted with their occurrence (ON DELETE CASCADE)",
        f"delete rule is {rsvp_fk[1]!r}" if rsvp_fk else "FK missing",
    )

    print("\n-- groups steward -> admin rename (0009) --")
    assert_columns(
        ck,
        columns,
        "groups",
        present=("admin_person_id", "backup_admin_person_id"),
        absent=("steward_person_id", "backup_steward_person_id"),
    )

    print("\n-- named CHECK constraints --")
    for name in (
        "ck_gatherings_memorial_decedent_name",
        "ck_gathering_invitations_exactly_one_target",
        "ck_gathering_invitations_pending_consumed_or_revoked",
    ):
        ck.check(name in check_constraints, f"CHECK {name} exists", "constraint missing")

    # --- Data integrity ----------------------------------------------------
    # This is the half that only means something against a database with rows:
    # 0008's accounts backfill had real people and organizations to act on only
    # in the Render dev database.
    print("\n-- accounts backfill integrity (0008) --")
    if {"people", "organizations", "accounts"} <= tables:
        people_count = await scalar(conn, "SELECT count(*) FROM people")
        org_count = await scalar(conn, "SELECT count(*) FROM organizations")
        account_count = await scalar(conn, "SELECT count(*) FROM accounts")

        orphan_people = await scalar(
            conn,
            "SELECT count(*) FROM people p LEFT JOIN accounts a ON a.id = p.account_id "
            "WHERE p.account_id IS NULL OR a.id IS NULL OR a.kind <> 'PERSON'",
        )
        ck.check(
            orphan_people == 0,
            "every person has an account of kind PERSON",
            f"{orphan_people} person row(s) with a missing, dangling, or wrong-kind account",
        )

        orphan_orgs = await scalar(
            conn,
            "SELECT count(*) FROM organizations o LEFT JOIN accounts a ON a.id = o.account_id "
            "WHERE o.account_id IS NULL OR a.id IS NULL OR a.kind <> 'ORGANIZATION'",
        )
        ck.check(
            orphan_orgs == 0,
            "every organization has an account of kind ORGANIZATION",
            f"{orphan_orgs} organization row(s) with a missing, dangling, or wrong-kind account",
        )

        ck.check(
            account_count == people_count + org_count,
            "accounts count == people + organizations (no orphans, no duplicates)",
            f"accounts={account_count}, people={people_count}, organizations={org_count}",
        )

        shared = await scalar(
            conn,
            "SELECT count(*) FROM (SELECT account_id FROM people "
            "GROUP BY account_id HAVING count(*) > 1) d",
        )
        ck.check(shared == 0, "no two people share an account_id", f"{shared} shared account_id(s)")
    else:
        ck.check(False, "accounts backfill integrity", "people/organizations/accounts missing")

    print("\n-- keeper invariant (0009) --")
    if {"gatherings", "kept_gatherings"} <= tables:
        # The load-bearing invariant: a gathering with at least one keeper is
        # never in grace. Vacuously true while both tables are empty — it is
        # written now because it is what will matter once keeping is reachable.
        breached = await scalar(
            conn,
            "SELECT count(*) FROM gatherings g WHERE g.last_keeper_left_at IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM kept_gatherings k WHERE k.gathering_id = g.id)",
        )
        ck.check(
            breached == 0,
            "no kept gathering carries a last_keeper_left_at stamp",
            f"{breached} gathering(s) both kept and in grace",
        )
    else:
        ck.check(False, "keeper invariant", "gatherings/kept_gatherings missing")

    print("\n-- occurrence text integrity (CK-20) --")
    if "occurrences" in tables:
        # NULL is the ONE representation of "no location / no map link" — the
        # API validators trim and reject blanks (CK-20), so an empty string
        # here means something wrote around them. Same class as the keeper
        # invariant above: vacuous while the columns hold no blanks, written
        # now because it is what will matter.
        blank_text = await scalar(
            conn,
            "SELECT count(*) FROM occurrences WHERE location = '' OR map_url = ''",
        )
        ck.check(
            blank_text == 0,
            "no occurrence stores an empty-string location or map_url",
            f"{blank_text} occurrence row(s) with an empty-string location or map_url",
        )
        # CK-21: map_url is rendered as a link href, so its scheme is
        # allowlisted to http/https by the API validator — any other scheme
        # here means something wrote around it, and a javascript: value is
        # script execution in a reader's browser. The accepted set literally
        # starts with http:// or https:// (the validator requires a netloc),
        # so the prefix match IS the scheme check for stored rows. Detail
        # prints the count only — a map link can identify a home, so the
        # value itself is never printed.
        bad_scheme = await scalar(
            conn,
            "SELECT count(*) FROM occurrences WHERE map_url IS NOT NULL "
            "AND map_url !~* '^https?://'",
        )
        ck.check(
            bad_scheme == 0,
            "no occurrence stores a map_url with a non-http(s) scheme",
            f"{bad_scheme} occurrence row(s) with a non-http(s) map_url scheme",
        )
    else:
        ck.check(False, "occurrence text integrity", "occurrences table missing")

    print("\n-- rsvp integrity (CK-27) --")
    if "rsvps" in tables:
        # Guest identity is a later phase: an account-holder RSVP (person_id
        # set) must never also carry guest_name/guest_email — a row that does
        # means something wrote around the router. Same class as the blank-
        # location check: vacuous until it isn't.
        ghost_guests = await scalar(
            conn,
            "SELECT count(*) FROM rsvps WHERE person_id IS NOT NULL "
            "AND (guest_name IS NOT NULL OR guest_email IS NOT NULL)",
        )
        ck.check(
            ghost_guests == 0,
            "no account-holder RSVP carries guest identity",
            f"{ghost_guests} rsvp row(s) with both a person and guest fields",
        )
        # stay_included modifies a "no" ("can't make it — keep me included");
        # the API refuses it with any other response, so a row like this means
        # something wrote around the validator. Interest data only — nothing
        # here (or anywhere) reads it for authorization.
        stray_flags = await scalar(
            conn,
            "SELECT count(*) FROM rsvps WHERE stay_included AND response <> 'no'",
        )
        ck.check(
            stray_flags == 0,
            "stay_included accompanies a 'no' response only",
            f"{stray_flags} rsvp row(s) with stay_included on a non-'no' response",
        )
    else:
        ck.check(False, "rsvp integrity", "rsvps table missing")

    print("\n-- companion integrity (CK-29) --")
    if "rsvp_companions" in tables:
        # NULL-shaped absence is "not in the list": the API trims and rejects
        # blanks (the CK-20 discipline), so a blank name here means something
        # wrote around it. Names are third-party personal data — the detail
        # prints the count only, never a value.
        blank_names = await scalar(
            conn,
            "SELECT count(*) FROM rsvp_companions WHERE btrim(name) = ''",
        )
        ck.check(
            blank_names == 0,
            "no companion row stores a blank name",
            f"{blank_names} companion row(s) with a blank name",
        )
        # The API caps the list at 10 per RSVP; more means something wrote
        # around the bound.
        over_bound = await scalar(
            conn,
            "SELECT count(*) FROM (SELECT rsvp_id FROM rsvp_companions "
            "GROUP BY rsvp_id HAVING count(*) > 10) o",
        )
        ck.check(
            over_bound == 0,
            "no RSVP holds more than 10 companions",
            f"{over_bound} RSVP(s) over the companion bound",
        )
        # Companions accompany a "yes" or "maybe" only — on a "no" they are
        # the noise the dropped head counts used to manufacture ("two people
        # are not coming with me"), refused at the API. stay_included's shape.
        on_a_no = await scalar(
            conn,
            "SELECT count(*) FROM rsvp_companions c JOIN rsvps r ON r.id = c.rsvp_id "
            "WHERE r.response = 'no'",
        )
        ck.check(
            on_a_no == 0,
            "no declined RSVP carries companions",
            f"{on_a_no} companion row(s) hanging off a 'no'",
        )
    else:
        ck.check(False, "companion integrity", "rsvp_companions table missing")

    print("\n-- media derivative integrity (CK-32) --")
    if {"media", "media_derivatives"} <= tables:
        # Publish is the last step and is atomic (pipeline record §8): the
        # worker writes the derivative rows in the same transaction that
        # moves the media row to `ready` (CK-36), so no derivative row ever
        # hangs off a photograph in any other rung. A row here means a
        # worker wrote around that — a half-published photograph. Detail
        # prints the count only.
        premature = await scalar(
            conn,
            "SELECT count(*) FROM media_derivatives d JOIN media m ON m.id = d.media_id "
            "WHERE m.status <> 'ready'",
        )
        ck.check(
            premature == 0,
            "no derivative row hangs off a photograph that is not ready",
            f"{premature} derivative row(s) under a non-ready media row",
        )
    else:
        ck.check(False, "media derivative integrity", "media/media_derivatives missing")

    print("\n-- media publish integrity (CK-36) --")
    if {"media", "media_derivatives", "gatherings"} <= tables:
        # The publish transaction's three consequences on data, each a
        # property of whatever rows exist (never a count). Detail prints
        # counts only — a key is a function of a row id and is never
        # printed.
        # (1) A ready photograph has all three layers, one row each: the
        # transaction writes the three rows together or not at all, and a
        # ready row with fewer is a half-published photograph (or one
        # whose layers were deleted around the row).
        incomplete = await scalar(
            conn,
            "SELECT count(*) FROM media m WHERE m.status = 'ready' AND "
            "(SELECT count(DISTINCT d.layer) FROM media_derivatives d WHERE d.media_id = m.id) <> 3",
        )
        ck.check(
            incomplete == 0,
            "every ready photograph has exactly its three layers",
            f"{incomplete} ready media row(s) without all three derivative rows",
        )
        # (2) The storage class per layer (media-layers record §4):
        # archival on Infrequent Access, web and thumbnail on Standard,
        # spelled as R2 spells them. A row on the wrong class is a
        # photograph paying the wrong price — or being served from cold.
        misclassed = await scalar(
            conn,
            "SELECT count(*) FROM media_derivatives WHERE "
            "(layer = 'archival' AND storage_class <> 'STANDARD_IA') OR "
            "(layer <> 'archival' AND storage_class <> 'STANDARD')",
        )
        ck.check(
            misclassed == 0,
            "archival layers are on Infrequent Access; web and thumbnail on Standard",
            f"{misclassed} derivative row(s) on the wrong storage class",
        )
        # (3) gatherings.total_bytes is a maintained fact — the sum over
        # the derivative rows of the gathering's ready photographs, moved
        # in the transaction that writes those rows. A gathering whose
        # total disagrees with its rows had a publish land half-done, or
        # something moved total_bytes around the worker — either way the
        # quota is counting bytes that are not there, or missing bytes
        # that are.
        drifted = await scalar(
            conn,
            "SELECT count(*) FROM gatherings g WHERE g.total_bytes <> "
            "(SELECT coalesce(sum(d.size_bytes), 0) FROM media_derivatives d "
            " JOIN media m ON m.id = d.media_id "
            " WHERE m.gathering_id = g.id AND m.status = 'ready')",
        )
        ck.check(
            drifted == 0,
            "every gathering's total_bytes equals the sum over its ready photographs' layers",
            f"{drifted} gathering(s) whose total_bytes disagrees with its derivative rows",
        )
    else:
        ck.check(False, "media publish integrity", "media/media_derivatives/gatherings missing")

    print("\n-- media upload integrity (CK-34) --")
    if "media" in tables:
        # Properties of whatever rows exist — never a count (pending rows
        # are reaped opportunistically, the CK-24 rule). Detail prints the
        # count only; a media row names a person and a gathering, and no
        # column of it is ever printed.
        # (1) uploaded_at is set when and only when the row has left
        # pending_upload: the confirm step stamps it in the transaction that
        # moves the rung, and nothing else writes it (0017).
        stamp_mismatch = await scalar(
            conn,
            "SELECT count(*) FROM media "
            "WHERE (status = 'pending_upload') <> (uploaded_at IS NULL)",
        )
        ck.check(
            stamp_mismatch == 0,
            "uploaded_at is set when and only when the row has left pending_upload",
            f"{stamp_mismatch} media row(s) whose uploaded_at disagrees with status",
        )
        # (2) Every upload declares a size the intent endpoint would have
        # accepted: positive and at most 25 MB (decimal — record §6.6). The
        # presigned PUT signs the same number, so a row outside the bound
        # was written around the endpoint.
        out_of_bounds = await scalar(
            conn,
            "SELECT count(*) FROM media "
            "WHERE upload_size_bytes <= 0 OR upload_size_bytes > 25000000",
        )
        ck.check(
            out_of_bounds == 0,
            "every media row declares a size within (0, 25 MB]",
            f"{out_of_bounds} media row(s) outside the upload size bound",
        )
        # (3) Every upload declares an image type — video is refused at the
        # intent endpoint (record §6.4), explicitly, never accepted-then-
        # failed. A prefix match rather than the endpoint's exact allowlist:
        # widening the allowlist within images must not fail a deployed
        # verifier, but a video type must.
        non_image = await scalar(
            conn,
            "SELECT count(*) FROM media WHERE upload_content_type NOT LIKE 'image/%'",
        )
        ck.check(
            non_image == 0,
            "every media row declares an image content type (video is refused at intent)",
            f"{non_image} media row(s) with a non-image content type",
        )
    else:
        ck.check(False, "media upload integrity", "media table missing")

    print("\n-- media job integrity (CK-35) --")
    if "media" in tables:
        # The worker's two invariants over the job columns, properties of
        # whatever rows exist. Detail prints the count only.
        # (1) claimed_at is the reclaim clock and means "a worker holds this
        # row": set when and only when the row is `processing`. The claim
        # service stamps it at claim and clears it with every outcome
        # (release, retry, dead-letter), so a disagreement means something
        # wrote around it — a stranded row the reclaim timeout would rescue
        # every fifteen minutes forever, or a processing row nothing can
        # reclaim.
        claim_mismatch = await scalar(
            conn,
            "SELECT count(*) FROM media "
            "WHERE (status = 'processing') <> (claimed_at IS NOT NULL)",
        )
        ck.check(
            claim_mismatch == 0,
            "claimed_at is set when and only when the row is processing",
            f"{claim_mismatch} media row(s) whose claimed_at disagrees with status",
        )
        # (2) A dead-lettered row says why: `failed` always carries a
        # last_error (operator terms — the outcome, never the file), because
        # a failure with no reason is one nobody can act on. Never printed.
        silent_failures = await scalar(
            conn,
            "SELECT count(*) FROM media WHERE status = 'failed' "
            "AND (last_error IS NULL OR btrim(last_error) = '')",
        )
        ck.check(
            silent_failures == 0,
            "every failed media row carries a last_error",
            f"{silent_failures} failed media row(s) with no last_error",
        )
    else:
        ck.check(False, "media job integrity", "media table missing")

    print("\n-- media: words on a photograph (0018, CK-39) --")
    # The uploader's file name and the person's caption are nullable text on
    # the photograph — NULL is the one representation of "no name" / "no
    # caption", and the rows written before 0018 read NULL forever (nothing
    # is backfilled). Tags are ROWS, in a table with two columns it must
    # never grow (asserted absent below).
    assert_columns(ck, columns, "media", nullable=("filename", "caption"))
    ck.check("media_tags" in tables, "table media_tags exists", "missing")
    assert_columns(
        ck,
        columns,
        "media_tags",
        not_null=("media_id", "tag", "added_by_person_id"),
        # NO `gathering_id`: a tag hangs off a media row, which hangs off a
        # gathering — a column here is a second representation of a fact
        # the join already answers (the CK-13 refcount defect). And NO
        # person id for a TAGGED person, nullable or otherwise: a free-text
        # tag is the uploader's claim about their own photograph; a person
        # tag is a claim about someone else, and it gets its own record and
        # its own table when decided — a nullable column here would smuggle
        # the feature in as a schema detail (added_by_person_id is
        # provenance — who wrote the words — and is asserted present above).
        absent=("gathering_id", "person_id", "tagged_person_id", "subject_person_id"),
    )
    tag_fk = await fk_rule(conn, "fk_media_tags_media_id")
    ck.check(
        tag_fk is not None and tag_fk[0] == "media",
        "media_tags.media_id references media",
        "FK missing or pointing elsewhere",
    )
    # A tag on a deleted photograph is an assertion with nothing behind it;
    # a takedown removes the words with the picture.
    ck.check(
        tag_fk is not None and tag_fk[1] == "c",
        "tag rows are deleted with their photograph (ON DELETE CASCADE)",
        f"delete rule is {tag_fk[1]!r}" if tag_fk else "FK missing",
    )
    ck.check(
        "uq_media_tags_media_id_tag" in unique_constraints,
        "UNIQUE uq_media_tags_media_id_tag exists (one photograph, one tag, once)",
        "constraint missing",
    )

    print("\n-- media words integrity (CK-39) --")
    if {"media", "media_tags"} <= tables:
        # Properties of whatever rows exist. Detail prints counts only — a
        # caption is free text on a photograph of a child, a file name is
        # the uploader's, and a tag is a word about a photograph; none is
        # ever printed.
        # (1) The API trims and refuses blanks (the CK-20 discipline), so a
        # blank here means something wrote around it — and "" would be a
        # second representation of "no name" / "no caption" beside NULL.
        blank_words = await scalar(
            conn,
            "SELECT count(*) FROM media WHERE btrim(filename) = '' OR btrim(caption) = ''",
        )
        ck.check(
            blank_words == 0,
            "no media row stores a blank filename or caption",
            f"{blank_words} media row(s) with a blank filename or caption",
        )
        blank_tags = await scalar(conn, "SELECT count(*) FROM media_tags WHERE btrim(tag) = ''")
        ck.check(
            blank_tags == 0,
            "no tag row stores a blank tag",
            f"{blank_tags} tag row(s) with a blank tag",
        )
        # (2) Two tags differing only in case are ONE tag — the API refuses
        # the pair; the UNIQUE beneath it is exact-match only, so a
        # case-variant pair here means something wrote around the API.
        case_twins = await scalar(
            conn,
            "SELECT count(*) FROM (SELECT media_id, lower(tag) FROM media_tags "
            "GROUP BY media_id, lower(tag) HAVING count(*) > 1) t",
        )
        ck.check(
            case_twins == 0,
            "no photograph carries two tags that differ only in case",
            f"{case_twins} (photograph, tag) pair(s) duplicated under lower()",
        )
        # (3) The API caps the list at 20 per photograph; more means
        # something wrote around the bound.
        over_bound = await scalar(
            conn,
            "SELECT count(*) FROM (SELECT media_id FROM media_tags "
            "GROUP BY media_id HAVING count(*) > 20) o",
        )
        ck.check(
            over_bound == 0,
            "no photograph holds more than 20 tags",
            f"{over_bound} photograph(s) over the tag bound",
        )
    else:
        ck.check(False, "media words integrity", "media/media_tags missing")

    print("\n-- pending invitation integrity (CK-25) --")
    if "gathering_invitations_pending" in tables:
        # An EMAIL destination is stored normalized (trimmed + lowercased) by
        # the API validator — a row that isn't means something wrote around
        # it. Not a row COUNT (this table is reaped opportunistically and a
        # count would flap on an idle DB — the CK-24 rule); a property of
        # whatever rows exist. Detail prints the count only: a destination is
        # a third party's address and is never printed.
        unnormalized = await scalar(
            conn,
            "SELECT count(*) FROM gathering_invitations_pending "
            "WHERE channel = 'EMAIL' AND destination <> lower(btrim(destination))",
        )
        ck.check(
            unnormalized == 0,
            "every EMAIL pending-invitation destination is stored normalized",
            f"{unnormalized} pending row(s) with an unnormalized destination",
        )
    else:
        ck.check(
            False, "pending invitation integrity", "gathering_invitations_pending missing"
        )

    # --- Informational -----------------------------------------------------
    print("\n-- row counts (informational, not assertions) --")
    # `media` joins the list at CK-34, the phase that first writes it: a
    # count above zero is a fact to record against the baseline, never a
    # failure — and pending rows come and go with the reap.
    for table in ("people", "accounts", "gatherings", "kept_gatherings", "media"):
        if table in tables:
            ck.info(f"{table} rows", await scalar(conn, f"SELECT count(*) FROM {table}"))
        else:
            ck.info(f"{table} rows", "table missing")


async def main() -> int:
    url, connect_args, notes = resolve_target()
    # Output stays ASCII-only: a Windows console under cp1252 raises
    # UnicodeEncodeError on an em dash, and a verifier must not fail for
    # cosmetic reasons.
    print(f"covey-keep schema verifier - expecting migration head {EXPECTED_REVISION}")
    for note in notes:
        print(f"  {note}")

    engine = create_async_engine(url, connect_args=connect_args)
    ck = Checks()
    try:
        async with engine.connect() as conn:
            await verify(conn, ck)
    finally:
        await engine.dispose()

    print(f"\n{ck.passed} passed, {ck.failed} failed")
    return 1 if ck.failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
