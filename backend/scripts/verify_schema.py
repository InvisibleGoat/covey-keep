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
    otherwise             the app's own DATABASE_URL from backend/.env

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
    # normalisation rather than reimplement it. Importing app.config also
    # constructs the settings singleton, so backend/.env must be present —
    # the same precondition uvicorn and alembic already have.
    from app.config import Settings, settings as app_settings
except Exception as exc:  # pragma: no cover - operator-facing guidance
    raise SystemExit(
        f"Could not load app.config ({exc.__class__.__name__}). "
        "backend/.env must exist with the required env surface - see "
        "backend/.env.example."
    )

# The migration revision this verifier is written against.
EXPECTED_REVISION = "0014"

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


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
    INTERNAL URL - the one config.py already normalises for the running app -
    runs unencrypted inside Render's network and connects fine. The EXTERNAL
    URL requires TLS and is handed out in libpq form, often with
    `?sslmode=require`. asyncpg has no `sslmode` parameter (it takes `ssl`),
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
        source = "DATABASE_URL (backend/.env)"

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
        # A remote host with no sslmode given: Render's external endpoint
        # refuses plaintext, so default to encrypted.
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
    # The quota computation's per-object source (0001).
    assert_columns(ck, columns, "media", present=("size_bytes",))

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
    for table in ("people", "accounts", "gatherings", "kept_gatherings"):
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
