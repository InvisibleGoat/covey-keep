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
