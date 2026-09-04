"""Keeping — the keeper-model lifecycle (CK-13, keeper record §2.3–2.7, §8).

The `kept_gatherings` relation is the SINGLE source of truth for both the
reference count and the quota arithmetic. Everything here derives from it at
request time:

- Quota usage is a sum over an account's kept gatherings' `total_bytes` —
  computed fresh on every call, never stored (roadmap §2). `total_bytes`
  itself is a maintained fact about one gathering, not a cached answer to a
  question about an account.
- Grace state is derived from ONE timestamp (`last_keeper_left_at`) plus the
  policy constants below — never persisted. Two stored dates could disagree
  with each other and with the refcount; a derived state cannot.
- A memorial is exempt by TYPE (keeper record §9.4): quota-free and never in
  grace, keyed on `gathering_type == MEMORIAL`, never a flag.

Live callers: gathering creation (api/gatherings.py, CK-16) via keep — the
creator becomes first keeper in the same transaction that births the
gathering — and the account deletion path (profile.py) via
lapse_kept_statuses. Every function that writes leaves the commit to the
caller, so the kept-row change and its side effects (grace stamp, admin
relinquishment) land in the caller's transaction or not at all.
"""

from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Gathering, GatheringType, KeptGathering

# Grace policy (keeper record §2.7): when the last keeper leaves, 30 days
# archived-but-recoverable, deletable at 90. Constants in code, thresholds
# derived — never stored per-gathering.
ARCHIVE_AFTER = timedelta(days=30)
DELETE_AFTER = timedelta(days=90)


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
    """Bytes counted against the account's quota: the sum of `total_bytes`
    over its kept gatherings, memorials exempt. Computed fresh on every call
    — the entitlement/quota rule (roadmap §2) — and logical size, not
    physical: every keeper of a gathering counts it in full while the bytes
    are stored once (keeper record §2.3)."""
    total = await db.scalar(
        select(func.coalesce(func.sum(Gathering.total_bytes), 0))
        .select_from(KeptGathering)
        .join(Gathering, Gathering.id == KeptGathering.gathering_id)
        .where(
            KeptGathering.account_id == account.id,
            Gathering.gathering_type != GatheringType.MEMORIAL,
        )
    )
    return int(total)


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
