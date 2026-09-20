"""gatherings.photo_count - the photograph count, backfilled and maintained, read by nothing; and the two keeper-column indexes

Revision ID: 0024
Revises: 0023
Create Date: 2026-09-20

Phase CK-51a - the EXPAND half of the quota's change of currency
(decisions/2026-09-20-photographs-are-the-currency.md 2.1.0 §3, §6). The
quota will count photo-equivalents rather than bytes - a photograph is 1,
whatever the file weighed - and this migration adds the column that count
is kept in, backfills it, and (through services/ingest.py, in the same
phase) starts maintaining it. NOTHING READS IT. The cutover - account_quota,
account_usage, gathering_bytes and _in_flight_bytes_of re-denominated, the
refusal copy, the currency record §5's monitor line - is CK-51b, and the
split is a deploy hazard, not tidiness:

THE DEPLOY WINDOW (render.yaml line 15). Render runs the web service's
pre-deploy `alembic upgrade head` while the OLD instance is still serving,
and the new instance takes over some seventy seconds later; the worker is
a separate service on its own deploy clock. A phase that both added this
column and switched the quota's readers to it would have the OLD worker
publishing photographs into `total_bytes` and not into `photo_count` for
that whole window, so the quota would read low from its very first request
and stay low forever, silently. Splitting expand from cutover means the
count is maintained through one full deploy before anything consults it:
by the time CK-51b's readers arrive, every worker that can publish a
photograph has been incrementing the column.

(a) gatherings.photo_count - INTEGER NOT NULL DEFAULT 0. A SERVER DEFAULT
    IS CORRECT HERE, unlike media.status at 0016 (where a default was a
    reclaim trap): every gathering starts at zero and the writer only ever
    adds to it, so there is no rung a default could silently choose.

(b) THE BACKFILL: each gathering's count of `media` rows at
    `status = 'ready'` - EXACTLY the rung scripts/verify_schema.py's
    total_bytes assertion counts ("every gathering's total_bytes equals the
    sum over its ready photographs' layers"), and the rung at which
    services/ingest.py moves total_bytes. The criterion is copied, not
    re-derived, so the two columns describe the same rows from the first
    commit. Note what that set includes: a `ready` row whose
    publication_state is `removed` COUNTS - see (d).

(c) THE TWO KEEPER-COLUMN INDEXES, owed since 0023 and re-homed twice:
    ix_gatherings_keeper_account_id and ix_groups_keeper_account_id. An
    index arrives with its reader, and the reader has existed since CK-49b:
    services/keeping.py::account_usage's WHERE is
    `gatherings.keeper_account_id = :account OR groups.keeper_account_id =
    :account` over every gathering. 0023's kickoff carried the re-run and
    the drop alone (a migration that destroys data is not the place for a
    "while we're here"); CK-50 was "no migration"; this is the first
    scheduled migration since, so the index lands here (currency record
    §6). Named exactly as the models' `index=True` names them
    (base.py's `ix_%(column_0_label)s`), so `alembic check` is clean.

(d) NO DECREMENT, ANYWHERE - deliberate, not an omission. `total_bytes` is
    never decremented, removal included: a removed photograph keeps its
    three layers in the published bucket for the 30-day contributor-
    visible bin (api/media.py REMOVED_BIN), and the sweep that would free
    them does not exist. `photo_count` mirrors that exactly. The invariant
    the verifier asserts - photo_count equals the count of ready rows -
    holds only because neither column moves on removal; a decrement on
    decline would break it on the first declined photograph. When the
    bin's sweep is built it owes BOTH columns, together, in one statement,
    or they diverge (database-schema.md, the 0024 section).

(e) The backfilled total is reported on an INFO line whatever it is, on
    alembic's own logger so it lands in the deploy log beside `Running
    upgrade` (the 0023 pattern), ASCII only. The deploy holds nine real
    gatherings with photographs on several of them, so A ZERO THERE IS A
    FINDING, not an absence of one. (The local dev DB holds no gatherings;
    a zero there is expected and is the same line.)

The downgrade drops both indexes and the column, genuinely: the count is
recomputable from `media` (which is why a backfill exists at all), so
nothing is lost, and up / down / up is idempotent - the second upgrade
recounts the same rows to the same numbers.

DATA-HANDLING: this migration derives a count of photographs - photographs
of children among them - from rows that already exist. It reads no image
bytes, moves no object, and changes no audience rule, publication state,
consent record or removal path. Nothing user-visible changes: the quota
still reads bytes until CK-51b. The failure mode is a count that disagrees
with reality, which the verifier's new assertion makes loud rather than
silent.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0024'
down_revision: Union[str, Sequence[str], None] = '0023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the count
# lands in the deploy log beside them at INFO (the 0023 pattern).
log = logging.getLogger("alembic.runtime.migration")

# (b) The backfill. `m.status = 'ready'` is the verifier's total_bytes
# criterion verbatim - the same rung, the same rows. Publication state is
# deliberately NOT a term: a removed-but-ready row holds its layers and
# its bytes, and counts (see (d) in the docstring).
BACKFILL = """
UPDATE gatherings g
   SET photo_count = (
         SELECT count(*) FROM media m
          WHERE m.gathering_id = g.id
            AND m.status = 'ready'
       )
"""

REPORT = """
SELECT count(*)                                AS gatherings,
       count(*) FILTER (WHERE photo_count > 0) AS with_photographs,
       coalesce(sum(photo_count), 0)           AS photographs
  FROM gatherings
"""


def upgrade() -> None:
    """Upgrade schema."""
    # (a) The column, with the server default that is right for a counter
    # every row starts at zero.
    op.add_column(
        'gatherings',
        sa.Column('photo_count', sa.Integer(), server_default=sa.text('0'), nullable=False),
    )

    # (b) The backfill, then (e) the report - whatever the number is.
    conn = op.get_bind()
    conn.execute(sa.text(BACKFILL))
    gatherings, with_photographs, photographs = conn.execute(sa.text(REPORT)).one()
    # ASCII only: a Windows console under cp1252 raises on an em dash, and
    # a migration must not fail for a log line.
    log.info(
        "0024 backfilled gatherings.photo_count from ready media rows: "
        "%d photograph(s) across %d of %d gathering(s) "
        "(on a database that holds photographs, a zero here is a finding)",
        photographs,
        with_photographs,
        gatherings,
    )

    # (c) The two keeper-column indexes, owed since 0023.
    op.create_index(
        op.f('ix_gatherings_keeper_account_id'), 'gatherings', ['keeper_account_id'], unique=False
    )
    op.create_index(
        op.f('ix_groups_keeper_account_id'), 'groups', ['keeper_account_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema - both indexes and the column, genuinely. Nothing is
    lost that `media` cannot recount: the next upgrade backfills the same
    rows to the same numbers."""
    op.drop_index(op.f('ix_groups_keeper_account_id'), table_name='groups')
    op.drop_index(op.f('ix_gatherings_keeper_account_id'), table_name='gatherings')
    op.drop_column('gatherings', 'photo_count')
