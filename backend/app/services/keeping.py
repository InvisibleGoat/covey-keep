"""Keeping — the keeper-model lifecycle (CK-13, keeper record §2.3–2.7, §8).

The `kept_gatherings` relation is the SINGLE source of truth for both the
reference count and the quota arithmetic. Everything here derives from it at
request time:

- Quota usage is a sum over an account's kept gatherings' `total_bytes` —
  computed fresh on every call, never stored (roadmap §2). `total_bytes`
  itself is a maintained fact about one gathering, not a cached answer to a
  question about an account. Since CK-34 the sum also carries the bytes IN
  FLIGHT on those gatherings — the declared size of every upload that has
  been issued a presigned PUT and has not yet been published or failed
  (media pipeline record §6.6: a RESERVATION, not a check — fifty
  concurrent intents each checked against the same headroom would overshoot
  it by forty-nine files). `total_bytes` moves only at publish, by the sum
  over the derivative rows; the reservation releases at that moment, or
  when the row fails or is reaped — never earlier. THIS FUNCTION IS THE ONE
  QUOTA PATH: the reservation lives inside it rather than beside it, for
  the reason CK-13 banned a second refcount.
- Grace state is derived from ONE timestamp (`last_keeper_left_at`) plus the
  policy constants below — never persisted. Two stored dates could disagree
  with each other and with the refcount; a derived state cannot.
- A memorial is exempt by TYPE (keeper record §9.4): quota-free and never in
  grace, keyed on `gathering_type == MEMORIAL`, never a flag. Exempt from
  the ACCOUNT quota is not unbounded: a memorial carries its own ceiling
  (MEMORIAL_CEILING_BYTES), evaluated against the gathering's own bytes by
  gathering_bytes — the upload path is the only place that comparison can
  land (CK-34), which is why it is easy to omit by writing the exemption
  and stopping.

Live callers: gathering creation (api/gatherings.py, CK-16) via keep — the
creator becomes first keeper in the same transaction that births the
gathering — the account deletion path (profile.py) via
lapse_kept_statuses, and the upload-intent endpoint (api/media.py, CK-34)
via account_usage / account_quota / gathering_bytes. Every function that
writes leaves the commit to the caller, so the kept-row change and its side
effects (grace stamp, admin relinquishment) land in the caller's
transaction or not at all.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Account,
    Gathering,
    GatheringType,
    KeptGathering,
    Media,
    MediaStatus,
)

# Grace policy (keeper record §2.7): when the last keeper leaves, 30 days
# archived-but-recoverable, deletable at 90. Constants in code, thresholds
# derived — never stored per-gathering.
ARCHIVE_AFTER = timedelta(days=30)
DELETE_AFTER = timedelta(days=90)

# Entitlement (keeper record §9.1): the free tier is 10 GB, and every account
# is on it — the paid ladder (50 / 100) is the storage-tier phase's, which
# will make account_quota read a subscription instead of returning this.
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
    memorial is live regardless — it never enters grace."""
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


async def keep(
    db: AsyncSession,
    account: Account,
    gathering: Gathering,
    *,
    now: Optional[datetime] = None,
) -> KeptGathering:
    """Account starts keeping the gathering. Anyone keeping ends grace —
    the stamp clears in the same transaction as the kept-row insert. Keeping
    twice is rejected by the unique constraint (IntegrityError on flush)."""
    now = now or datetime.now(timezone.utc)
    row = KeptGathering(account_id=account.id, gathering_id=gathering.id, kept_at=now)
    db.add(row)
    gathering.last_keeper_left_at = None
    await db.flush()
    return row


async def unkeep(
    db: AsyncSession,
    account: Account,
    gathering: Gathering,
    *,
    now: Optional[datetime] = None,
) -> None:
    """Account reverts from keeper to observer. In one transaction with the
    kept-row delete: host is relinquished if this account held it (the
    gathering becomes claimable — keeper record §9.2), and if this was the
    last keeper the grace stamp is set. A memorial never gets the stamp: it
    never enters grace, whatever its keeper count."""
    now = now or datetime.now(timezone.utc)
    result = await db.execute(
        delete(KeptGathering).where(
            KeptGathering.account_id == account.id,
            KeptGathering.gathering_id == gathering.id,
        )
    )
    if result.rowcount == 0:
        raise LookupError("account does not keep this gathering")
    if gathering.host_account_id == account.id:
        gathering.host_account_id = None
    remaining = await db.scalar(
        select(func.count())
        .select_from(KeptGathering)
        .where(KeptGathering.gathering_id == gathering.id)
    )
    if remaining == 0 and gathering.gathering_type != GatheringType.MEMORIAL:
        gathering.last_keeper_left_at = now
    await db.flush()


async def account_usage(db: AsyncSession, account: Account) -> int:
    """Bytes counted against the account's quota: over its kept gatherings,
    memorials exempt, the sum of `total_bytes` (published) PLUS the declared
    size of every in-flight upload (the CK-34 reservation). Computed fresh
    on every call — the entitlement/quota rule (roadmap §2) — and logical
    size, not physical: every keeper of a gathering counts it in full while
    the bytes are stored once (keeper record §2.3); the reservation follows
    the same rule, so an upload in flight counts against every keeper of
    its gathering exactly as it will once published. ONE statement: the
    in-flight bytes ride a correlated subquery per kept gathering."""
    total = await db.scalar(
        select(
            func.coalesce(
                func.sum(Gathering.total_bytes + _in_flight_bytes_of(Gathering.id)), 0
            )
        )
        .select_from(KeptGathering)
        .join(Gathering, Gathering.id == KeptGathering.gathering_id)
        .where(
            KeptGathering.account_id == account.id,
            Gathering.gathering_type != GatheringType.MEMORIAL,
        )
    )
    return int(total)


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


async def lapse_kept_statuses(
    db: AsyncSession, account_id: UUID, *, now: datetime
) -> None:
    """An anonymized person's kept statuses lapse (keeper record §8): their
    kept rows are hard-deleted, and any gathering that just lost its last
    keeper is stamped exactly as unkeep would stamp it — a deleted account
    must not silently hold a gathering alive forever. Called from the account
    deletion transaction (profile.py); the caller commits."""
    kept_gathering_ids = (
        await db.scalars(
            select(KeptGathering.gathering_id).where(
                KeptGathering.account_id == account_id
            )
        )
    ).all()
    # Host is relinquished everywhere this account held it, kept or not — a
    # deleted account left as host would block the claimable state forever.
    await db.execute(
        update(Gathering)
        .where(Gathering.host_account_id == account_id)
        .values(host_account_id=None)
    )
    if not kept_gathering_ids:
        return
    await db.execute(
        delete(KeptGathering).where(KeptGathering.account_id == account_id)
    )
    # Stamp exactly as unkeep would: only where no keeper remains, and never
    # on a memorial.
    await db.execute(
        update(Gathering)
        .where(
            Gathering.id.in_(kept_gathering_ids),
            Gathering.gathering_type != GatheringType.MEMORIAL,
            ~exists(
                select(KeptGathering.id).where(
                    KeptGathering.gathering_id == Gathering.id
                )
            ),
        )
        .values(last_keeper_left_at=now)
    )


# --- The keeper shape, half-built (CK-49a; keeper record v2 §3.1) ------------
#
# Migration 0022 added `groups.keeper_account_id`, `gatherings.keeper_account_id`
# and `gatherings.owning_group_id` (the last with no writer), backfilled the
# two keeper columns once from the relation above, and added the CHECK that
# keeps a group gathering's keeper out of its own row. NOTHING BELOW THIS LINE
# IS CALLED BY ANYTHING BUT ITS OWN TESTS: every function above still reads
# `kept_gatherings`, which stays the truth for quota, audience, grace and the
# deletion lapse until CK-49b switches the consumers, rewrites this module and
# drops the relation. The resolver is added first, alone, so the cutover has
# a tested answer to "who keeps this?" before it changes a single reader.


class KeeperSource(str, Enum):
    """Which rung answered — returned with every resolution, for the reason
    services/publication.py returns its Source: a consumer handed a bare
    account id cannot explain itself, and CK-49b's quota sum, storage screen
    and claim button all need to say WHY this account (record §3.1)."""

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

    NOT CALLED BY ANY CONSUMER YET. CK-49b wires it into the quota sum, the
    read audience, the grace derivation and the deletion lapse; every
    consumer asks this function and never reads the column directly
    (record §3.1). Until then `kept_gatherings` answers every live question.
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
