"""media.failure_reason - why a photograph could not be kept, for the person

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-10

Phase CK-71 - a photograph that cannot be kept says why, and can be
dismissed (decisions/2026-09-06-media-pipeline-architecture.md §6.5, as
amended at CK-71). One new enum type, one nullable column on `media`, a
one-time backfill, and nothing else.

WHY. Every `failed` row read the same to the person - "We couldn't process
this photo." - whether a retry could fix it (the upload never completed; the
worker was interrupted three times) or never could (over the pixel guard;
bytes the decoder refuses). The difference lived only in `last_error`, which
is OPERATOR-ONLY by design and stays out of every body (CK-57;
api/media.py::_media_body). So the person's half of the fact gets a column
of its own, written by the worker at the dead-letter BESIDE `last_error`
(services/ingest.py - the same guarded statement as `status = 'failed'`)
and NEVER derived from it at runtime.

media_failure_reason - ENUM ('too_large', 'unreadable', 'upload_incomplete',
    'interrupted'): four values that each name what the PERSON can do,
    never what went wrong inside - the pixel guard (a smaller copy works);
    every other Undecodable (no copy of this file will); the quarantine
    object missing (uploading again works); the transient ladder spent, or
    three abandonments at reclaim (uploading again works). Design-fixed, so
    a native enum (database-schema decision 2); a fifth value is a decision
    record, never a catch-all.

media.failure_reason - media_failure_reason, nullable, NO server default.
    Set IF AND ONLY IF the row is `failed` (scripts/verify_schema.py asserts
    the iff): every path that writes `failed` writes a reason in the same
    statement, `failed` is terminal so nothing ever clears one, and a
    `ready` row never carries one.

THE NEW TYPE'S LABELS ARE SAFE IN THIS TRANSACTION; `media_status`'S ARE
NOT ON A FRESH DATABASE - THE CK-32 TRAP, MET FROM THE OTHER SIDE. The trap
is `ALTER TYPE ... ADD VALUE`: a label added that way cannot be used until
the transaction that added it commits (Postgres's UnsafeNewEnumValueUsage),
which is why 0016 and 0025 add labels and use none. A type CREATED inside
the transaction is different: its labels were made by CREATE TYPE, not ADD
VALUE, and are usable at once (measured on this PostgreSQL 16: CREATE TYPE
+ a table + an INSERT and a WHERE on the new label, in one transaction,
work) - which is what lets `media_failure_reason`'s labels be written by
the backfill below rather than one migration later. The round trip in
tests/test_failure_reason.py confirms it against planted rows.

BUT THE BACKFILL ALSO NAMES `media_status`'S `'failed'`, AND THAT LABEL IS
A 0016 ADD VALUE. On the deploy and the dev database it has been committed
since 2026-09-07 and `status = 'failed'` runs; the TEST SUITE builds its
database from 0001 in ONE transaction (alembic/env.py's single
begin_transaction), and there `'failed'` is itself an uncommitted new value
- this migration's first draft failed the suite with `unsafe use of new
value "failed" of enum type media_status`. (Measured, and worth recording
against 0025's docstring, which calls a fresh database the one EXEMPTION:
on PostgreSQL 16.15 a label added by ADD VALUE is unsafe in its transaction
even when the type was created in that same transaction - the suite CATCHES
this trap rather than hiding it; what it cannot catch is a label whose
ADD VALUE is already committed locally.) So the backfill compares
`status::text`, which reads each row's existing value and never constructs
the label, and runs identically in both. Nothing else about the statement
changes; `status::text = 'failed'` is the same rows as `status = 'failed'`.

THE BACKFILL - the ONE-TIME exception to "never derived from last_error",
in this migration alone. Every `failed` row that exists was dead-lettered
before the column did, and the only record of why is the text the code
wrote. CK-71's STEP 0 enumerated every text a `failed` row could have
carried since CK-35 from the history of services/ingest.py - four texts,
each with a stable PREFIX that has never moved - and each maps to exactly
one reason. The UPDATEs run in the order below, because `too_large` is the
narrower prefix of the undecodable text and must be classified BEFORE the
general `unreadable`:

    could not process the upload as a photograph: larger than the ...
                                                        -> too_large
    could not process the upload as a photograph: ...   -> unreadable
    quarantine object missing: ...                      -> upload_incomplete
    claimed N times and never finished: ...             -> interrupted
    storage did not answer after N attempts ...         -> interrupted

An INFO line on alembic's own logger reports the count per reason and the
count LEFT NULL (the 0023/0024 pattern; ASCII only). ZERO LEFT NULL IS THE
EXPECTED ANSWER: a non-zero count means a `failed` row carries a text the
enumeration did not find, and it is a FINDING the deploy check reads - the
verifier's new invariant fails on exactly that row - never something to
patch with a fifth value or a catch-all. Nothing else moves; `last_error`
is untouched.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT,
with one window stated. Adding a nullable column with no default is
invisible to the OLD web instance Render keeps serving - it neither reads
nor writes it, its INSERTs omit it and get NULL, its SELECTs name their
columns. The OLD worker is on its own deploy clock: a row it dead-letters
between this migration and its new instance taking over lands `failed`
with a NULL reason, exactly the state the verifier's invariant fails on,
and is classified by hand with the same prefixes. The window is a minute
or two, a dead-letter inside it needs an unprocessable upload at that
moment, and the frontend reads a NULL reason as its defensive fallback
line - so nothing breaks for the person either way.

The downgrade drops the column and then the type; the reasons are lost,
nothing else is touched, and the next upgrade recomputes them from
`last_error` to the same values (up / down / up is idempotent).

DATA-HANDLING: this migration classifies rows that already exist, reading
a text the code itself wrote (never a word from the file, never a person).
It reads no image bytes, moves no object, deletes nothing, and changes no
audience rule, publication state or count. The column it adds carries four
coarse values that are safe in every body; `last_error` stays where it was.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0028'
down_revision: Union[str, Sequence[str], None] = '0027'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the counts
# land in the deploy log beside them at INFO (the 0023/0024 pattern).
log = logging.getLogger("alembic.runtime.migration")

REASONS = ('too_large', 'unreadable', 'upload_incomplete', 'interrupted')

# The type, created explicitly below (the 0016 media_layer pattern) so the
# column's add never tries to create it a second time.
failure_reason = postgresql.ENUM(*REASONS, name='media_failure_reason', create_type=False)

# THE BACKFILL, in classification order - too_large BEFORE the general
# undecodable prefix. Each pattern is a LIKE over the stable prefix of a
# text services/ingest.py has written since CK-35 (STEP 0's table); the
# texts carry no `%` or `_`, and the patterns ride as bound values.
BACKFILL = (
    ('too_large', "could not process the upload as a photograph: larger than the %"),
    ('unreadable', "could not process the upload as a photograph: %"),
    ('upload_incomplete', "quarantine object missing: %"),
    ('interrupted', "claimed % times and never finished: %"),
    ('interrupted', "storage did not answer after % attempts%"),
)

# `status::text`, never `status = 'failed'`: see the docstring - on a fresh
# database the `'failed'` label is uncommitted in this very transaction, and
# the text cast reads the rows without constructing it. The new type's
# labels need no such care; CAST(:reason AS media_failure_reason) is fine.
CLASSIFY = sa.text(
    "UPDATE media SET failure_reason = CAST(:reason AS media_failure_reason) "
    "WHERE status::text = 'failed' AND failure_reason IS NULL AND last_error LIKE :pattern"
)

LEFT_NULL = sa.text(
    "SELECT count(*) FROM media WHERE status::text = 'failed' AND failure_reason IS NULL"
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    # The type first - NEW in this transaction, so its labels are usable in
    # the backfill below (see the docstring: not the CK-32 trap).
    failure_reason.create(bind, checkfirst=True)
    # Nullable, no default, no backfill of anything but `failed` rows.
    op.add_column('media', sa.Column('failure_reason', failure_reason, nullable=True))

    counts = {reason: 0 for reason in REASONS}
    for reason, pattern in BACKFILL:
        result = bind.execute(CLASSIFY, {"reason": reason, "pattern": pattern})
        counts[reason] += result.rowcount
    left_null = bind.execute(LEFT_NULL).scalar_one()
    # ASCII only: a Windows console under cp1252 raises on an em dash, and a
    # migration must not fail for a log line. Zero left NULL is the expected
    # answer; a non-zero count is a finding, never a reason to add a value.
    log.info(
        "0028 backfilled media.failure_reason from last_error on failed rows: "
        "%d too_large, %d unreadable, %d upload_incomplete, %d interrupted; "
        "%d failed row(s) left NULL (zero expected - a non-zero count is a finding)",
        counts['too_large'],
        counts['unreadable'],
        counts['upload_incomplete'],
        counts['interrupted'],
        left_null,
    )


def downgrade() -> None:
    """Downgrade schema - genuinely restores 0027's shape: the column, then
    the type. The reasons are lost and the next upgrade recomputes them;
    nothing else is touched."""
    op.drop_column('media', 'failure_reason')
    failure_reason.drop(op.get_bind(), checkfirst=True)
