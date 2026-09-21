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

- Quota usage is a COUNT OF PHOTO-EQUIVALENTS over the gatherings that
  RESOLVE to an account — computed fresh on every call (roadmap §2). Since
  CK-51b (decisions/2026-09-20-photographs-are-the-currency.md §3) the
  unit is the photograph, never the byte: a photograph is 1 whatever the
  file weighed, because every upload is re-encoded to the same three
  fixed-target layers (the pipeline's output ceiling is what makes the
  currency honest). `photo_count` itself is a maintained fact about one
  gathering, not a cached answer to a question about an account. The sum
  also carries the uploads IN FLIGHT on those gatherings — ONE per row that
  has been issued a presigned PUT and has not yet been published or failed
  (media pipeline record §6.6: a RESERVATION, not a check — fifty
  concurrent intents each checked against the same headroom would overshoot
  it by forty-nine files; the reserved quantity is the batch's item count,
  never a byte size). `photo_count` moves only at publish, by one; the
  reservation releases at that moment, or when the row fails or is reaped
  — never earlier. `account_usage` IS THE ONE QUOTA PATH: the reservation
  lives inside it rather than beside it, for the reason CK-13 banned a
  second refcount. Since CK-50 the UPLOAD GATE asks the same resolver for
  its subject (api/media.py::_enforce_limits via resolved_keeper_of — v2
  §6): the gathering's resolved keeper's row is locked and its usage
  checked, never the host's; a gathering that resolves UNKEPT refuses the
  upload — no quota subject. `total_bytes` stays maintained beside the
  count and is no longer a quota input: cost reporting, and the currency
  record §5's monitor (services/ingest.py, at the one UPDATE). CHARGED,
  NEVER VISIBLE: `photo_count` counts `ready` rows whatever their
  publication state, so a photograph in the 30-day bin still counts — it
  is still stored — and a surface that shows this number as "your photos"
  is the defect the bin record §4 exists to prevent.
- Grace state is derived from ONE timestamp (`last_keeper_left_at`) plus the
  policy constants below — never persisted. Under one keeper "the last
  keeper left" and "the keeper left" are the same event, so the stamp's
  meaning did not move. The 30/90 thresholds are v2 §5's ladder in design
  and inert in code — see the note on `grace_state`.
- A memorial is exempt by TYPE (keeper record §9.4): quota-free and never in
  grace, keyed on `gathering_type == MEMORIAL`, never a flag. Exempt from
  the ACCOUNT quota is not unbounded: a memorial carries its own ceiling
  (MEMORIAL_CEILING_PHOTOGRAPHS — in photographs since CK-51b: one unit
  across every gathering type), evaluated against the gathering's own count
  by gathering_units — the upload path is the only place that comparison
  can land (CK-34), which is why it is easy to omit by writing the
  exemption and stopping.

Live callers: gathering creation (api/gatherings.py, CK-16) via keep — the
creator becomes keeper in the same transaction that births the gathering —
the read audience (api/gatherings.py::_gathering_for_read via
resolved_keeper_of; the list statement and api/media.py::_visible_media via
keeps_gathering), the account deletion path (profile.py) via
lapse_kept_statuses, and the upload-intent endpoint (api/media.py, CK-34;
its subject the resolved keeper since CK-50; counting photographs since
CK-51b) via resolved_keeper_of / account_usage / account_quota /
gathering_units — and, on its REFUSAL path alone, account_bin_count (the
one caller it may ever have; see its docstring). Every function that
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
    PublicationState,
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

# Entitlement (keeper record v2 §15.1; the currency record §3): the free
# tier is 10,000 PHOTO-EQUIVALENTS, and every account is on it — the paid
# ladder is the storage-tier phase's, which will make account_quota read a
# subscription instead of returning this. A photograph is 1, whatever the
# file weighed; video, when it lands, enters at a rate the product
# PUBLISHES (currency record §4), never at a measured ratio. Provisional
# — and the monitor below moves a PRICE when the real average drifts,
# never this unit. Until CK-51b the constant here was 10 GB, in bytes;
# 10,000 photographs at the measured size is ≈11.3 GB, a ≈13% raise, not
# a cut.
FREE_TIER_PHOTOGRAPHS = 10_000

# The memorial ceiling (keeper record §9.4, decided 2026-08-31 as 5 GB;
# currency record §8 at 2.4.0): free, permanent, and quota-exempt UP TO
# 5,000 PHOTOGRAPHS per memorial gathering, revisable UPWARD ONLY —
# lowering it is the retroactive change plan §7.6 forbids. ONE UNIT ACROSS
# EVERY GATHERING TYPE: photographs for gatherings and groups but gigabytes
# for memorials would be a daily support question — the same person, the
# same product, two currencies. 5,000 is ≈5.67 GB at the measured size,
# which SATISFIES the raise-only rule rather than straining it (a round
# product number, not a conversion of the 5 GB). Compared against the
# gathering's own count (gathering_units), never against any account's
# usage.
MEMORIAL_CEILING_PHOTOGRAPHS = 5_000

# The measured cost of ONE stored photograph through the shipped pipeline
# (CK-46 check (fb), 2026-09-17: archival 893,696 B on Infrequent Access +
# web 233,890 B + thumbnail 7,044 B on Standard). A COST MODEL WITH EXACTLY
# ONE RUNTIME USE — the monitor in services/ingest.py, which logs the
# charged unit beside the actual stored bytes at the one UPDATE (currency
# record §5: what we charge must never be less than what we store). NEVER
# A QUOTA UNIT, NEVER IN A REFUSAL, NEVER IN A COMPARISON: nothing here or
# in api/media.py may multiply, divide or compare against it — the quota is
# a count, and the byte model audits the count instead of deriving it.
# Provisional (one sample); the monitor is what retires it. Pinned by test:
# this name appears in ingest.py and nowhere else outside this file.
PHOTOGRAPH_BYTES = 1_134_630

# The rungs at which an upload is RESERVED — one photo-equivalent per row,
# whatever it declared (CK-51b): a presigned PUT issued (pending_upload),
# the bytes confirmed in quarantine (uploaded), the worker on them
# (processing). Released at `ready` (photo_count takes over) and at
# `failed` (nothing stored). Pipeline record §6.6 names
# pending_upload alone; the reservation is widened to every in-flight rung
# deliberately — a confirmed upload whose reservation lapsed at confirm
# would hold real bytes in quarantine against nobody's quota until the
# worker published it, and until CK-35 there is no worker.
IN_FLIGHT_STATUSES = (
    MediaStatus.PENDING_UPLOAD,
    MediaStatus.UPLOADED,
    MediaStatus.PROCESSING,
)


def _in_flight_count_of(gathering_id_column):
    """A correlated scalar subquery: the NUMBER of in-flight uploads on one
    gathering — each one photo-equivalent, whatever it declared (CK-51b;
    until then this subquery SUMMED their declared bytes). Zero when there
    are none (COUNT over no rows is 0). ONE criterion, two
    consumers: account_usage (the account's sum) and gathering_units (a
    memorial's own)."""
    return (
        select(func.count(Media.id))
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
    """PHOTO-EQUIVALENTS counted against the account's quota: over the
    gatherings that RESOLVE to it — its own, and every gathering of a group
    it keeps — memorials exempt, the sum of `photo_count` (published) PLUS
    the number of in-flight uploads (the CK-34 reservation, one per row —
    the batch's item count, since CK-51b). THE UNIT IS THE PHOTOGRAPH: a
    photograph is 1 whatever it weighed (currency record §3), and the byte
    columns are not read here. Computed fresh on every call — the
    entitlement/quota rule (roadmap §2). ONE statement fetches the
    candidates with their two facts and their count (the in-flight count
    rides a correlated subquery per gathering); the RESOLVER decides which
    count, row by row — the SQL WHERE is a candidate filter (a superset:
    either fact naming the account), never the answer, so a row the CHECK
    forbids raises here instead of being counted once or twice. With one
    keeper there is no logical-size device: a gathering counts against
    exactly one account, and the photograph is stored once.

    CHARGED, NEVER VISIBLE (bin record §4, binding): `photo_count` counts
    `ready` rows regardless of `publication_state`, so a photograph in the
    30-day bin still counts here — it is still stored. This number is the
    quota's and the refusal's; a surface that shows it as "your photos" is
    the defect that section exists to prevent (charged = visible + in the
    bin, and only the first is a column). The bin's size is
    `account_bin_count`, computed on the refusal path alone."""
    rows = (
        await db.execute(
            select(
                Gathering.keeper_account_id.label("own_keeper"),
                Group.keeper_account_id.label("group_keeper"),
                (Gathering.photo_count + _in_flight_count_of(Gathering.id)).label("units"),
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
    for own_keeper, group_keeper, units in rows:
        resolution = resolve_keeper(
            group_keeper_account_id=group_keeper, own_keeper_account_id=own_keeper
        )
        if resolution.keeper_account_id == account.id:
            total += int(units)
    return total


async def account_quota(db: AsyncSession, account: Account) -> int:
    """The PHOTO-EQUIVALENTS the account is entitled to keep. Every account
    is on the free tier until the storage-tier phase gives this a
    subscription to read; it takes the session and the account now so that
    phase changes one function and no caller — the signature the byte
    version promised, kept through the cutover. Never stored (roadmap
    §2)."""
    return FREE_TIER_PHOTOGRAPHS


async def gathering_units(db: AsyncSession, gathering: Gathering) -> int:
    """One gathering's OWN count, in photographs: published (`photo_count`)
    plus in flight (the reservation — one per row). The memorial ceiling's
    subject (keeper record §9.4; in photographs since CK-51b, currency
    record §8): a memorial is exempt from every ACCOUNT's quota and bounded
    by its OWN count — never any account's usage — a different comparison
    from every other type, which is why it lives here rather than being
    re-derived at the call site. (Until CK-51b this function summed the
    gathering's bytes under a name that said so; the same shape, the byte
    columns swapped for the count.)"""
    total = await db.scalar(
        select(Gathering.photo_count + _in_flight_count_of(Gathering.id)).where(
            Gathering.id == gathering.id
        )
    )
    return int(total or 0)


async def account_bin_count(db: AsyncSession, account: Account) -> int:
    """How many of the photographs charged to this account are in the bin —
    `ready` AND `removed` — over the same gatherings account_usage counts
    (the ones that resolve to the account, memorials exempt: a memorial's
    bin frees nothing on the account). CALLED ONLY FROM THE REFUSAL PATH
    (api/media.py::_enforce_limits, after the quota has already refused),
    so the refusal can say what a person can do about it — bin record §5:
    where the space is full and the bin is not empty, the refusal names the
    bin and offers to empty it; where the bin is empty it names no bin.

    NOT FOLDED INTO account_usage, DELIBERATELY: account_usage is the hot
    path — it runs inside every upload intent under the keeper's row lock —
    and the bin is a per-gathering COUNT over `media` that only a refusal
    needs; paying for it on every upload to answer a question the accepted
    path never asks would be the wrong trade. Same candidate query, same
    resolver loop, a different measure. NOT A QUOTA INPUT — nothing may add
    it to, or subtract it from, usage (a binned photograph is charged; that
    is bin record §3's whole point). Nothing else may call it — pinned by
    test: the name appears in api/media.py exactly once, inside
    _enforce_limits."""
    binned = (
        select(func.count(Media.id))
        .where(
            Media.gathering_id == Gathering.id,
            Media.status == MediaStatus.READY,
            Media.publication_state == PublicationState.REMOVED,
        )
        .correlate(Gathering)
        .scalar_subquery()
    )
    rows = (
        await db.execute(
            select(
                Gathering.keeper_account_id.label("own_keeper"),
                Group.keeper_account_id.label("group_keeper"),
                binned.label("binned"),
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
    for own_keeper, group_keeper, count in rows:
        resolution = resolve_keeper(
            group_keeper_account_id=group_keeper, own_keeper_account_id=own_keeper
        )
        if resolution.keeper_account_id == account.id:
            total += int(count)
    return total


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
