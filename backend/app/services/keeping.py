"""Keeping — who keeps a gathering, and what follows from it (CK-13; rewritten
against the keeper column at CK-49b, keeper record v2 §3.1).

THE KEEPER IS A COLUMN, RESOLVED THROUGH THE HOME. A standalone gathering
carries its own keeper (`gatherings.keeper_account_id`); a gathering that
belongs to a group has none of its own and is kept by the group's
(`groups.keeper_account_id`, reached through `gatherings.owning_group_id`);
both NULL is the Unkept rung (§5) — a state, never an error. `resolve_keeper`
is the ladder, and EVERY consumer asks it: a caller holding a row goes
through `resolved_keeper_of`, a WHERE clause that decides which rows are
fetched at all goes through `keeps_gathering` (the same ladder as SQL — see
its docstring for why that is safe and what pins it). Nothing reads the
column directly, and nothing outside this module writes it.

THE OLD KEPT RELATION NO LONGER EXISTS (CK-49c, migration 0023). It stayed
in the schema through CK-49b's deploy on purpose — Render runs the web
service's pre-deploy migration while the OLD instance is still serving, and
the old code read it — and 0023 re-ran 0022's backfill under the release
guard (a stamped gathering is Unkept on purpose and gets no keeper back;
an anonymized account is never assigned) and then dropped it. The keeper
column is the only representation there is; a second one — a boolean, a
counter, a relation kept "for safety" — is the defect database-schema
decision 20 exists to ban.

What is DERIVED, and never stored, is unchanged in its rule:

- Quota usage is a sum over the gatherings that RESOLVE to an account —
  computed fresh on every call (roadmap §2). `total_bytes` itself is a
  maintained fact about one gathering, not a cached answer to a question
  about an account. Since CK-34 the sum also carries the bytes IN FLIGHT on
  those gatherings — the declared size of every upload that has been issued
  a presigned PUT and has not yet been published or failed (media pipeline
  record §6.6: a RESERVATION, not a check — fifty concurrent intents each
  checked against the same headroom would overshoot it by forty-nine
  files). `total_bytes` moves only at publish, by the sum over the
  derivative rows; the reservation releases at that moment, or when the row
  fails or is reaped — never earlier. `account_usage` IS THE ONE QUOTA PATH:
  the reservation lives inside it rather than beside it, for the reason
  CK-13 banned a second refcount. Since CK-50 the UPLOAD GATE asks the same
  resolver for its subject (api/media.py::_enforce_limits via
  resolved_keeper_of — v2 §6): the gathering's resolved keeper's row is
  locked and its usage checked, never the host's; a gathering that
  resolves UNKEPT refuses the upload — no quota subject.
- Grace state is derived from ONE timestamp (`last_keeper_left_at`) plus the
  policy constants below — never persisted. Under one keeper "the last
  keeper left" and "the keeper left" are the same event, so the stamp's
  meaning did not move. The 30/90 thresholds are v2 §5's ladder in design
  and inert in code — see the note on `grace_state`.
- A memorial is exempt by TYPE (keeper record §9.4): quota-free and never in
  grace, keyed on `gathering_type == MEMORIAL`, never a flag. Exempt from
  the ACCOUNT quota is not unbounded: a memorial carries its own ceiling
  (MEMORIAL_CEILING_BYTES), evaluated against the gathering's own bytes by
  gathering_bytes — the upload path is the only place that comparison can
  land (CK-34), which is why it is easy to omit by writing the exemption
  and stopping.

Live callers: gathering creation (api/gatherings.py, CK-16) via keep — the
creator becomes keeper in the same transaction that births the gathering —
the read audience (api/gatherings.py::_gathering_for_read via
resolved_keeper_of; the list statement and api/media.py::_visible_media via
keeps_gathering), the account deletion path (profile.py) via
lapse_kept_statuses, and the upload-intent endpoint (api/media.py, CK-34;
its subject the resolved keeper since CK-50) via resolved_keeper_of /
account_usage / account_quota / gathering_bytes. Every function that
writes leaves the commit to the caller, so the keeper write and its side
effects (grace stamp, host relinquishment) land in the caller's transaction
or not at all.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models import (
    Account,
    Gathering,
    GatheringType,
    Group,
    Media,
    MediaStatus,
)

# Grace policy (keeper record §2.7): when the keeper leaves, 30 days
# archived-but-recoverable, deletable at 90. Constants in code, thresholds
# derived — never stored per-gathering.
#
# DELIBERATELY UNTOUCHED AT CK-49b. Keeper record v2 §5 replaces these two
# rungs with five — Kept → Dunning → Unkept → Frozen → Deleted, 360 days on
# paid — and that is new BEHAVIOUR, not a representation swap: it arrives
# with the surfaces that give it entrances and exits (the in-app alert, the
# claim button, the storage screen), and nothing past Frozen ships until
# export exists (§9). These constants and grace_state are INERT either way:
# nothing outside tests/test_keeping.py calls grace_state (verified
# 2026-09-18). Do not "fix" the numbers here ahead of the ladder.
ARCHIVE_AFTER = timedelta(days=30)
DELETE_AFTER = timedelta(days=90)

# Entitlement (keeper record §9.1): the free tier is 10 GB, and every account
# is on it — the paid ladder is the storage-tier phase's, which will make
# account_quota read a subscription instead of returning this. (v2 §15.1
# restates the allowance as 10,000 photo-equivalents on the ACCOUNT; the
# number here changes with that phase, not with the cutover.)
# Decimal units, deliberately: "10 GB" means what the keeper record, the
# consumer storage convention (iCloud, Google) and R2's own pricing mean by
# it — 10^9 bytes, never 2^30. One convention for every byte figure here.
FREE_TIER_BYTES = 10_000_000_000

# The memorial ceiling (keeper record §9.4, decided 2026-08-31): free,
# permanent, and quota-exempt UP TO 5 GB per memorial gathering, video
# included, revisable UPWARD ONLY — lowering it is the retroactive change
# plan §7.6 forbids. Compared against the gathering's own bytes
# (gathering_bytes), never against any account's usage.
MEMORIAL_CEILING_BYTES = 5_000_000_000

# The rungs at which an upload's declared bytes are RESERVED: a presigned
# PUT issued (pending_upload), the bytes confirmed in quarantine (uploaded),
# the worker on them (processing). Released at `ready` (total_bytes takes
# over) and at `failed` (nothing stored). Pipeline record §6.6 names
# pending_upload alone; the reservation is widened to every in-flight rung
# deliberately — a confirmed upload whose reservation lapsed at confirm
# would hold real bytes in quarantine against nobody's quota until the
# worker published it, and until CK-35 there is no worker.
IN_FLIGHT_STATUSES = (
    MediaStatus.PENDING_UPLOAD,
    MediaStatus.UPLOADED,
    MediaStatus.PROCESSING,
)


def _in_flight_bytes_of(gathering_id_column):
    """A correlated scalar subquery: the declared bytes of every in-flight
    upload on one gathering. Zero when there are none (sum over no rows is
    NULL; coalesced)."""
    return (
        select(func.coalesce(func.sum(Media.upload_size_bytes), 0))
        .where(
            Media.gathering_id == gathering_id_column,
            Media.status.in_(IN_FLIGHT_STATUSES),
        )
        .correlate(Gathering)
        .scalar_subquery()
    )


class GraceState(str, Enum):
    LIVE = "live"
    ARCHIVED = "archived"
    DUE_FOR_DELETION = "due_for_deletion"


def grace_state(gathering: Gathering, now: datetime) -> GraceState:
    """Derived, never persisted. A kept gathering (stamp NULL) is live; a
    memorial is live regardless — it never enters grace.

    UNTOUCHED AT CK-49b, and inert: no consumer calls this (only its own
    tests do). Keeper record v2 §5's five-rung ladder replaces the two
    thresholds it derives, and the ladder arrives with its surfaces — the
    note on ARCHIVE_AFTER / DELETE_AFTER above. The stamp it reads kept its
    meaning through the cutover: under one keeper, "the last keeper left"
    and "the keeper left" are one event."""
    if gathering.gathering_type == GatheringType.MEMORIAL:
        return GraceState.LIVE
    if gathering.last_keeper_left_at is None:
        return GraceState.LIVE
    elapsed = now - gathering.last_keeper_left_at
    if elapsed >= DELETE_AFTER:
        return GraceState.DUE_FOR_DELETION
    if elapsed >= ARCHIVE_AFTER:
        return GraceState.ARCHIVED
    return GraceState.LIVE


# --- The resolver: who keeps this gathering? (CK-49a; keeper record v2 §3.1) --
#
# Added at CK-49a beneath the old service and called by nothing; since CK-49b
# it is the spine of this module — every function below that needs the
# keeper asks it, through one of the two wiring helpers after it, and never
# reads the column on its own.


class KeeperSource(str, Enum):
    """Which rung answered — returned with every resolution, for the reason
    services/publication.py returns its Source: a consumer handed a bare
    account id cannot explain itself, and the quota sum, the storage screen
    and the claim button all need to say WHY this account (record §3.1)."""

    # The owning group's keeper — the gathering belongs to a group, and the
    # group is the home (§3.1: "a group is a home and holds one keeper").
    GROUP = "GROUP"
    # The gathering's own keeper — a standalone gathering in its person's
    # own home.
    OWN = "OWN"
    # Nobody — §5's Unkept rung: read-only, claimable, fully visible. Both
    # facts were NULL. Whether it is the GROUP that is unkept or the
    # gathering itself is the caller's row to read (`owning_group_id`);
    # the resolver reports the rung, not the remedy.
    UNKEPT = "UNKEPT"


@dataclass(frozen=True)
class KeeperResolution:
    # The account answerable for the gathering's bytes, or None (UNKEPT).
    keeper_account_id: Optional[UUID]
    source: KeeperSource


def resolve_keeper(
    *,
    group_keeper_account_id: Optional[UUID],
    own_keeper_account_id: Optional[UUID],
) -> KeeperResolution:
    """Who keeps this gathering? The ladder, as a list — the
    services/publication.py mould: facts in, an answer and where it came
    from out; no database, no network, no logging.

    group_keeper_account_id  rung 1 — the owning group's `keeper_account_id`,
                             None when the gathering belongs to no group OR
                             its group has no keeper (both read as "the
                             group does not answer")
    own_keeper_account_id    rung 2 — the gathering's own `keeper_account_id`

    The first rung with an answer wins; both None is UNKEPT (§5), which is
    a state and not an error — the deploy's "Test Event" is one.

    TWO FACTS, AND `groups.archived_at` IS NOT ONE OF THEM (record §3.1,
    added at 1.2.2). An archived group still keeps its gatherings: archiving
    is a visibility and activity state, not a storage one
    (decisions/2026-09-17-a-group-is-archived-never-deleted.md §4) — the
    bytes are still stored and someone is still answerable for them, so the
    keeper resolves through the group exactly as when the group is active.
    A resolver that consulted the archive state would be deciding a
    lifecycle question inside a lookup, and lifecycle is the ladder's job
    (§5): a keeper who archives a group is still its keeper, still billed
    for it, and stops paying by releasing or lapsing (§4), a different act
    with a different surface. DO NOT ADD THE PARAMETER. The signature is
    pinned by test so a later "fix" that threads the archive state through
    here fails before it ships. (At 0022 the column does not exist either —
    the archive record is designed, not built — which is why the pin is on
    this signature and not on a row.)

    Both facts set is REFUSED, not resolved. The CHECK
    `ck_gatherings_group_gathering_has_no_keeper` makes that row impossible
    to store, so a caller passing both has read the wrong columns — a group
    keeper for a gathering that has no group, or a row from a database
    where the CHECK is gone — and the publication ladder's pass-over-None
    discipline would hide exactly that mistake. The two-representations
    defect (database-schema decision 20's class) is the thing the CHECK
    exists to prevent; the resolver does not quietly prefer one copy.

    Called, since CK-49b, by everything in this module that needs the
    keeper — through `resolved_keeper_of` for a loaded row and, as the same
    ladder in SQL, through `keeps_gathering` for the audience criteria — and
    by nothing that reads the column directly (record §3.1).
    """
    if group_keeper_account_id is not None and own_keeper_account_id is not None:
        raise ValueError(
            "a gathering cannot both belong to a group with a keeper and carry its "
            "own — the CHECK forbids the row; the caller read the wrong columns"
        )
    rungs: tuple[tuple[KeeperSource, Optional[UUID]], ...] = (
        (KeeperSource.GROUP, group_keeper_account_id),
        (KeeperSource.OWN, own_keeper_account_id),
    )
    for source, answer in rungs:
        if answer is not None:
            return KeeperResolution(keeper_account_id=answer, source=source)
    return KeeperResolution(keeper_account_id=None, source=KeeperSource.UNKEPT)


async def resolved_keeper_of(db: AsyncSession, gathering: Gathering) -> KeeperResolution:
    """The resolver for a row the caller already holds — publication.py's
    `resolve_gathering` counterpart, the ONE place a loaded gathering's two
    facts are read and handed to `resolve_keeper`. The group's keeper is
    fetched only when the gathering belongs to a group (no gathering does
    until Arc B writes `owning_group_id`), so today this is no query at
    all; when it is one, it is one indexed lookup."""
    group_keeper_account_id: Optional[UUID] = None
    if gathering.owning_group_id is not None:
        group_keeper_account_id = await db.scalar(
            select(Group.keeper_account_id).where(Group.id == gathering.owning_group_id)
        )
    return resolve_keeper(
        group_keeper_account_id=group_keeper_account_id,
        own_keeper_account_id=gathering.keeper_account_id,
    )


def keeps_gathering(account_id: UUID, gathering_id):
    """The resolver's ladder as ONE SQL criterion: TRUE when the gathering
    whose id is `gathering_id` (a column expression — `Gathering.id` in the
    list statement, `Media.gathering_id` in the media audience) resolves to
    `account_id`. For the WHERE clauses that decide which rows are fetched
    at all — the list's one statement (the CK-20 statement-count pin) and
    `_visible_media`'s three-branch criterion (CK-37) — where a Python
    function cannot sit.

    `coalesce(the group's keeper, the gathering's own)` IS the ladder — rung
    1, else rung 2 — and it is only safe because the CHECK
    `ck_gatherings_group_gathering_has_no_keeper` makes a both-set row
    impossible: on a legal row "the first non-NULL" and "the first rung with
    an answer" are the same thing, so there is nothing for `resolve_keeper`'s
    refusal to refuse and the SQL form cannot quietly prefer one copy. Both
    forms are pinned to agree on every legal shape (tests/test_keeper_shape.py);
    a consumer holding a row asks `resolved_keeper_of`, never this.

    Aliased on purpose: both callers already have `Gathering` in their outer
    FROM, and an un-aliased reference would be auto-correlated to it — a
    join to nothing that reads as a bug in the audience.
    """
    kept = aliased(Gathering, name="kept_gathering")
    home = aliased(Group, name="keeping_group")
    return exists(
        select(kept.id)
        .select_from(kept)
        .outerjoin(home, home.id == kept.owning_group_id)
        .where(
            kept.id == gathering_id,
            func.coalesce(home.keeper_account_id, kept.keeper_account_id) == account_id,
        )
    )


# --- The writers -----------------------------------------------------------------


async def keep(
    db: AsyncSession,
    account: Account,
    gathering: Gathering,
    *,
    now: Optional[datetime] = None,
) -> KeeperResolution:
    """Account starts keeping the gathering: the keeper column is written and
    grace ends — the stamp clears in the same flush. Returns the resolution
    the row now answers with (its own keeper, `OWN`).

    A gathering that already has a keeper is REFUSED, whoever asks: the
    same account keeping twice was rejected by the relation's unique
    constraint and still is; a second account is not a second keeper but a
    TRANSFER — atomic, needing the recipient's headroom, its own act with
    its own surface (record §4) — and this function is not it. Nothing
    written on refusal. A gathering that belongs to a group has no keeper of
    its own to write (the CHECK refuses the row); keeping the group is Arc
    B's surface."""
    now = now or datetime.now(timezone.utc)
    if gathering.keeper_account_id is not None:
        raise ValueError(
            "the gathering already has a keeper — keeping it again is a transfer "
            "(keeper record v2 §4), not a second keep"
        )
    gathering.keeper_account_id = account.id
    gathering.last_keeper_left_at = None
    await db.flush()
    return KeeperResolution(keeper_account_id=account.id, source=KeeperSource.OWN)


async def unkeep(
    db: AsyncSession,
    account: Account,
    gathering: Gathering,
    *,
    now: Optional[datetime] = None,
) -> None:
    """The keeper steps back. In one flush with the column going NULL: host
    is relinquished if this account held it (the gathering becomes
    claimable — keeper record §9.2), and the grace stamp is set — under one
    keeper the keeper leaving IS the last keeper leaving, so the stamp's
    meaning is exactly what it was. A memorial never gets the stamp: it
    never enters grace. An account that is not the gathering's own keeper
    is refused loudly — including the keeper of a group the gathering
    belongs to, who releases the GROUP (Arc B's surface), never one
    gathering out of it."""
    now = now or datetime.now(timezone.utc)
    if gathering.keeper_account_id != account.id:
        raise LookupError("account does not keep this gathering")
    gathering.keeper_account_id = None
    if gathering.host_account_id == account.id:
        gathering.host_account_id = None
    if gathering.gathering_type != GatheringType.MEMORIAL:
        gathering.last_keeper_left_at = now
    await db.flush()


# --- The derived facts -----------------------------------------------------------


async def account_usage(db: AsyncSession, account: Account) -> int:
    """Bytes counted against the account's quota: over the gatherings that
    RESOLVE to it — its own, and every gathering of a group it keeps —
    memorials exempt, the sum of `total_bytes` (published) PLUS the declared
    size of every in-flight upload (the CK-34 reservation). Computed fresh
    on every call — the entitlement/quota rule (roadmap §2). ONE statement
    fetches the candidates with their two facts and their bytes (the
    in-flight bytes ride a correlated subquery per gathering); the RESOLVER
    decides which count, row by row — the SQL WHERE is a candidate filter
    (a superset: either fact naming the account), never the answer, so a row
    the CHECK forbids raises here instead of being counted once or twice.
    With one keeper there is no logical-size device: a gathering counts
    against exactly one account, and the bytes are stored once."""
    rows = (
        await db.execute(
            select(
                Gathering.keeper_account_id.label("own_keeper"),
                Group.keeper_account_id.label("group_keeper"),
                (Gathering.total_bytes + _in_flight_bytes_of(Gathering.id)).label("bytes"),
            )
            .select_from(Gathering)
            .outerjoin(Group, Group.id == Gathering.owning_group_id)
            .where(
                Gathering.gathering_type != GatheringType.MEMORIAL,
                or_(
                    Gathering.keeper_account_id == account.id,
                    Group.keeper_account_id == account.id,
                ),
            )
        )
    ).all()
    total = 0
    for own_keeper, group_keeper, bytes_ in rows:
        resolution = resolve_keeper(
            group_keeper_account_id=group_keeper, own_keeper_account_id=own_keeper
        )
        if resolution.keeper_account_id == account.id:
            total += int(bytes_)
    return total


async def account_quota(db: AsyncSession, account: Account) -> int:
    """The bytes the account is entitled to keep. Every account is on the
    free tier until the storage-tier phase gives this a subscription to
    read; it takes the session and the account now so that phase changes
    one function and no caller. Never stored (roadmap §2)."""
    return FREE_TIER_BYTES


async def gathering_bytes(db: AsyncSession, gathering: Gathering) -> int:
    """One gathering's own bytes: published (`total_bytes`) plus in flight
    (the reservation). The memorial ceiling's subject (keeper record §9.4):
    a memorial is exempt from every ACCOUNT's quota and bounded by its OWN
    size — a different comparison from every other type, made here so the
    upload path has one function to call rather than a sum to re-derive."""
    total = await db.scalar(
        select(Gathering.total_bytes + _in_flight_bytes_of(Gathering.id)).where(
            Gathering.id == gathering.id
        )
    )
    return int(total or 0)


# --- The deletion leg --------------------------------------------------------------


async def lapse_kept_statuses(
    db: AsyncSession, account_id: UUID, *, now: datetime
) -> None:
    """An anonymized person's keeping lapses (keeper record §8): the keeper
    column goes NULL wherever the deleted account held it, and every
    gathering that just lost its keeper is stamped exactly as unkeep would
    stamp it — a deleted account must not silently hold a gathering alive
    forever. Called from the account deletion transaction (profile.py); the
    caller commits.

    Three writes, each guarded on the column and never on a relation:
    (1) host relinquished on every gathering this account hosted, kept or
    not — a deleted account left as host would block the claimable state
    forever; (2) `gatherings.keeper_account_id` NULLed and, on every
    non-memorial gathering it held, `last_keeper_left_at` stamped — under
    one keeper there is no "does another keeper remain" to ask; (3)
    `groups.keeper_account_id` NULLed wherever this account held it, the
    CK-45 admin relinquishment's reasoning applied to the keeper column: an
    anonymized account cannot answer for a home's bytes. NO stamp is
    written on a group — where a group's lapse stamp lives is v2 §12 item
    9's group half, handed to Arc B, because no gathering resolves through
    a group until Arc B writes `owning_group_id`, so nothing can lose a
    keeper by this write today and there is no row to reason about."""
    await db.execute(
        update(Gathering)
        .where(Gathering.host_account_id == account_id)
        .values(host_account_id=None)
    )
    # Stamp exactly as unkeep would: on every non-memorial gathering this
    # account kept of its own — one statement, the stamp and the NULL in it
    # together, so no row can carry the stamp with the keeper still set or
    # lose its keeper unstamped.
    await db.execute(
        update(Gathering)
        .where(
            Gathering.keeper_account_id == account_id,
            Gathering.gathering_type != GatheringType.MEMORIAL,
        )
        .values(keeper_account_id=None, last_keeper_left_at=now)
    )
    await db.execute(
        update(Gathering)
        .where(Gathering.keeper_account_id == account_id)
        .values(keeper_account_id=None)
    )
    await db.execute(
        update(Group)
        .where(Group.keeper_account_id == account_id)
        .values(keeper_account_id=None)
    )
