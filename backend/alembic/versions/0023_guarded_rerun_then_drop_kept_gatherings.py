"""the guarded re-run of 0022's backfill, then kept_gatherings is dropped

Revision ID: 0023
Revises: 0022
Create Date: 2026-09-19

Phase CK-49c — the CONTRACT half of keeper model v2's expand (0022, CK-49a)
/ migrate (CK-49b, no migration) / contract (this file)
(decisions/2026-09-17-keeper-model-v2.md 1.5.0 §3.1). After this migration
`kept_gatherings` does not exist, and the keeper is `keeper_account_id` on
`gatherings` and on `groups`, nothing else, anywhere.

THIS IS THE LAST MIGRATION THAT CAN EVER READ THE RELATION, and the shape
of its one UPDATE is the whole phase. Read the guard's reasoning before
touching the predicate.

Two steps, in an order that is the point:

(a) THE RE-RUN, BEFORE THE DROP. 0022 backfilled `gatherings.keeper_account_id`
    from each gathering's single kept row, and then its own docstring said
    the backfill was a snapshot that goes stale by design: CK-49a made no
    writer for the column, so `keep()` kept writing `kept_gatherings` and
    nothing wrote the column, and every gathering created between 0022's
    deploy and CK-49b's holds a kept row beside a NULL column. Those rows
    are what this UPDATE exists for. CK-49b's check (fl) counted them on
    the deploy on 2026-09-19: ZERO (nothing was created in the seam), so
    the expected affected-row count here is 0 — and a zero is reported,
    not skipped, because zero is itself the finding. A non-zero count is a
    gathering created in the seam, exactly what the re-run is for.

    THE GUARDS. The predicate carries four, and the second is the one that
    matters:

      g.keeper_account_id IS NULL     -- only a column nobody has written
      g.last_keeper_left_at IS NULL   -- THE RELEASE GUARD. NOT OPTIONAL.
      g.owning_group_id IS NULL       -- the CHECK's other side
      the kept row's account is not anonymized   -- the memorial edge

    WHY THE RELEASE GUARD EXISTS. Since CK-49b, `services/keeping.py`'s
    `unkeep()` and `lapse_kept_statuses()` NULL `keeper_account_id` and
    stamp `last_keeper_left_at` — and NEITHER TOUCHES `kept_gatherings`
    (verified in the source, 2026-09-19/20: neither function names the
    table). So a gathering that was deliberately released after the
    cutover, or whose keeper's account was deleted after it, sits with a
    NULL column, a stamp, and its ORIGINAL kept row still present. A re-run
    that read only "column NULL, kept row present" would read that stale
    row and hand the gathering back to a keeper who released it — or to an
    anonymized account — silently, inside a migration, one statement
    before the evidence is dropped forever. `last_keeper_left_at IS NULL`
    is what stops it: the stamp is the record that the keeper LEFT, and a
    gathering that carries it is Unkept on purpose (v2 §5), not a seam row.

    WHY THE FOURTH GUARD (WORKING-ON-NOW 1.89.0, the CK-49c scope note):
    a memorial is never stamped — `unkeep()` and the lapse leave
    `last_keeper_left_at` NULL on a memorial by design (keeper record
    §9.4: it never enters grace) — so the release guard cannot protect it.
    A memorial whose keeper's account was deleted after CK-49b holds a
    NULL column, NO stamp, and a stale kept row naming the now-anonymized
    account, and the three-guard predicate would assign that account
    back. The same shape arises for a non-memorial created in the seam
    whose creator's account was deleted afterwards: the lapse's UPDATE
    matches on the column, which was already NULL, so it neither NULLs
    nor stamps, and the kept row still names the deleted account. Both
    are refused by reading `people.anonymized_at` through the kept row's
    account: an anonymized account is never assigned (0022's own rule),
    whatever the other three guards say. Such a gathering stays NULL — the
    Unkept rung, a state — and this migration invents no stamp for it: a
    backfill is not a lapse, and a lapse the deployed code never ran is
    not this file's to perform. No memorial exists on the dev deploy
    (v2 §3.5); the guard is for the database nobody checked.

    `owning_group_id IS NULL` is the CHECK's other side
    (`ck_gatherings_group_gathering_has_no_keeper`): a group gathering has
    no keeper of its own, and writing one would fail the constraint — the
    guard costs nothing and keeps the UPDATE from ever being the thing
    that trips it. No gathering has an owning group until Arc B writes the
    column.

    THE 0022 REFUSAL IS CARRIED. If any gathering holds more than one kept
    row the migration raises before writing anything (the transaction
    rolls back whole, the table survives, the operator reads the rows in
    psql), because "its single kept row's account" is then not a fact and
    a migration that picked one would be deciding who is answerable for a
    family's photographs. 0022 refused the same way and found none; since
    CK-49b nothing writes the table, so the count cannot have grown — the
    guard is a discipline, not an expectation.

(b) THEN `DROP TABLE kept_gatherings`. Safe in THIS deploy, and only
    because of what the previous phase did: `render.yaml` runs the web
    service's pre-deploy `alembic upgrade head` while the OLD instance is
    still serving, which is why CK-49b did not drop the table — the old
    code read it. The code serving during this migration is CK-49b's,
    which reads and writes `kept_gatherings` nowhere (the quiet-relation
    grep; check (fk) on 2026-09-19, where a gathering the relation had
    never heard of worked end to end). Do not read this as a licence to
    drop tables under a pre-deploy migration in general — it is true here
    because the reader was removed one deploy earlier, and for no other
    reason.

THE DOWNGRADE CANNOT RESTORE A SINGLE ROW. It recreates the table with
0009's exact shape — the columns, `kept_at`'s server default, the primary
key, the unique constraint, both foreign keys and both indexes — and the
table comes back EMPTY, because the data is gone: (b) destroyed the only
remaining record of who kept a gathering under the old model. A downgrade
that silently produced an empty table would be dishonest; this one
produces an empty table and says so. What the downgrade does NOT undo
either: the values (a) wrote into `keeper_account_id` stay — 0022's
downgrade is the one that drops that column, and it would recompute
nothing on the way back up, because the relation it recomputes from is
empty. Up / down / up is therefore NOT idempotent across this file: the
first upgrade is the last one that can move a row.

DATA-HANDLING: this migration destroys the only remaining record of who
kept a gathering under the old model, irreversibly. The four guards in (a)
are what keep that destruction from also rewriting who is answerable for
nine real gatherings' bytes, photographs of identifiable people among
them: without the release guard, a gathering deliberately released would
be handed back to its former keeper, or to a deleted account, silently and
irreversibly. No consent rule, audience criterion, publication state or
removal path is touched. The lapse ladder that can eventually delete
photographs (v2 §5) is still not built; nothing here starts a clock.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0023'
down_revision: Union[str, Sequence[str], None] = '0022'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the count
# lands in the deploy log beside them at INFO (alembic.ini configures the
# `alembic` logger at INFO on the console handler).
log = logging.getLogger("alembic.runtime.migration")

# (a) The re-run. Every guard is load-bearing; the docstring says why each
# one is there. `k.account_id` is the kept row's account; the fourth guard
# reads its person's anonymization stamp through it.
RERUN_BACKFILL = """
UPDATE gatherings g
   SET keeper_account_id = k.account_id
  FROM kept_gatherings k
 WHERE k.gathering_id = g.id
   AND g.keeper_account_id IS NULL
   AND g.last_keeper_left_at IS NULL
   AND g.owning_group_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM people p
          WHERE p.account_id = k.account_id
            AND p.anonymized_at IS NOT NULL
       )
"""


def upgrade() -> None:
    """Upgrade schema."""
    conn = op.get_bind()

    # The 0022 refusal, carried: refuse to choose between two keepers.
    many_keepers = conn.execute(
        sa.text(
            "SELECT count(*) FROM ("
            "  SELECT gathering_id FROM kept_gatherings GROUP BY gathering_id HAVING count(*) > 1"
            ") m"
        )
    ).scalar_one()
    if many_keepers:
        # No id is printed: the message names a count, and the operator
        # reads the rows in psql. The transaction rolls back whole; the
        # table is still there afterwards.
        raise RuntimeError(
            f"0023 refuses to run: {many_keepers} gathering(s) hold more than one "
            "kept_gatherings row, so no single existing keeper can be backfilled; "
            "resolve the rows by hand, then re-run"
        )

    # (a) The guarded re-run, BEFORE the drop. The affected-row count is
    # reported whatever it is: zero is the expected answer on the deploy
    # (CK-49b's check (fl) counted zero seam rows on 2026-09-19) and is the
    # finding, not an absence of one.
    result = conn.execute(sa.text(RERUN_BACKFILL))
    rerun_count = result.rowcount
    # ASCII only, the verifier's discipline: a Windows console under cp1252
    # raises on an em dash, and a migration must not fail for a log line.
    log.info(
        "0023 re-ran 0022's backfill under the release guard: "
        "keeper_account_id set on %d gathering(s) from a kept row "
        "(expected 0; every non-zero row is a gathering created in the seam)",
        rerun_count,
    )

    # (b) Then the drop. The indexes and constraints go with the table.
    op.drop_table('kept_gatherings')


def downgrade() -> None:
    """Downgrade schema — recreate `kept_gatherings` in 0009's exact shape,
    EMPTY. Not one row is restored: the upgrade destroyed the data, and
    nothing in the database can rebuild it. The values the upgrade wrote
    into `gatherings.keeper_account_id` stay as they are — 0022 owns that
    column, and on a later upgrade its backfill recomputes from this empty
    table and would NULL them, which is why up / down / up is not
    idempotent past this file. This downgrade exists so the schema can be
    walked back for a diagnostic; it is not a way to get the relation's
    contents back."""
    op.create_table(
        'kept_gatherings',
        sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('account_id', sa.Uuid(), nullable=False),
        sa.Column('gathering_id', sa.Uuid(), nullable=False),
        sa.Column(
            'kept_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False
        ),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ['account_id'], ['accounts.id'], name=op.f('fk_kept_gatherings_account_id')
        ),
        sa.ForeignKeyConstraint(
            ['gathering_id'], ['gatherings.id'], name=op.f('fk_kept_gatherings_gathering_id')
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_kept_gatherings')),
        sa.UniqueConstraint(
            'account_id', 'gathering_id', name=op.f('uq_kept_gatherings_account_id_gathering_id')
        ),
    )
    op.create_index(
        op.f('ix_kept_gatherings_account_id'), 'kept_gatherings', ['account_id'], unique=False
    )
    op.create_index(
        op.f('ix_kept_gatherings_gathering_id'), 'kept_gatherings', ['gathering_id'], unique=False
    )
