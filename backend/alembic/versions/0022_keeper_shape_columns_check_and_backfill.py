"""the keeper shape arrives, and nothing reads it yet: owning_group_id, keeper_account_id on groups and gatherings, the CHECK, and the backfill

Revision ID: 0022
Revises: 0021
Create Date: 2026-09-18

Phase CK-49a — the additive half of keeper model v2
(decisions/2026-09-17-keeper-model-v2.md 1.3.0 §3.1, §5, §15.9). ONE RULE
GOVERNS THIS MIGRATION AND THE PHASE AROUND IT: it changes no behavior.
`kept_gatherings` stays, and stays the single source of truth for every
reader — the quota sum, the read audience, the grace derivation, the
deletion lapse. Nothing reads the columns this migration adds except the
phase's own tests and the verifier; the consumers switch, the keeping
service is rewritten, and `kept_gatherings` is dropped at CK-49b
(migration 0023). The seam is deliberate: this half is reversible and
provably inert, so if the cutover goes wrong this half is still good.

Five steps, in an order that is load-bearing:

(a) gatherings.owning_group_id — nullable FK → groups. NO WRITER AND NO
    READER. The belongs-to link (decisions/2026-09-02-groups-as-homes.md
    §3) is Arc B's — the write path, the home-group default, publication
    rungs 2 and 3 — and none of that is built here. The column exists now
    because the record's structural guarantee (e) names it, and a CHECK
    over a column that does not exist is a sentence in a document; with
    the column present the CHECK is honest and the resolver's group rung
    is testable. The 0019 precedent (`requires_approval` sat nullable
    with no writer until CK-44) and the CK-45 precedent (`TEAM` schema-
    valid, endpoint-refused). Every row is NULL and stays NULL until Arc B.

(b) groups.keeper_account_id — nullable FK → accounts. The first ACCOUNT
    fact on `groups` (record §7: the keeper is an account, the admin is a
    person; two facts, two spines). NULL is the unkept state (§5).

(c) gatherings.keeper_account_id — nullable FK → accounts. A standalone
    gathering's own keeper; a group gathering has none of its own (e).

(d) THE BACKFILL, BEFORE THE CONSTRAINT. Each gathering takes its single
    existing keeper from `kept_gatherings`; each group takes the account
    of its admin person (`groups.admin_person_id` → `people.account_id`),
    because the creator is still the first keeper (§3.1) and the creator
    is the admin CK-45 wrote. A gathering with no kept row — the deploy
    holds exactly one, the CK-16 deletion test's leftover with its
    `last_keeper_left_at` stamped — backfills to NULL, and THAT IS
    CORRECT, NOT MISSING DATA: both columns NULL is legal under (e) and
    is §5's Unkept rung. No default is invented for it. A group whose
    admin was relinquished (account deletion, CK-45) backfills to NULL
    for the same reason. A deleted account is never assigned: the
    deletion path hard-deletes its kept rows and relinquishes its group
    admin before this migration could see either.

    The backfill refuses to choose: if any gathering holds more than one
    kept row it raises before writing anything, because "its single
    existing keeper" is then not a fact and a migration that picked one
    silently would be deciding who is answerable for a family's
    photographs. The deployed data was verified on 2026-09-18 — nine
    gatherings with exactly one keeper each, one with none — and the
    test database is empty when this runs; the guard is for the database
    nobody checked.

    THE BACKFILL IS A SNAPSHOT, AND IT GOES STALE BY DESIGN. This phase
    makes no writer for the new columns — `keep()` still writes a
    `kept_gatherings` row and nothing else — so every gathering created
    between 0022 and the cutover holds a kept row and a NULL
    `keeper_account_id`. That divergence is the price of the seam, and
    CK-49b's migration 0023 must run this backfill again over the rows
    that arrived in between BEFORE it drops `kept_gatherings`. A 0023
    that dropped the table on the strength of this backfill alone would
    orphan every gathering created after this deploy.

(e) THEN the CHECK: `owning_group_id IS NULL OR keeper_account_id IS
    NULL` on gatherings, named `ck_gatherings_group_gathering_has_no_
    keeper` so the verifier and the downgrade can address it. The
    `gathering_invitations` exactly-one-target idiom applied as at-most-
    one: "a group gathering has no keeper of its own" is structural, not
    remembered — a second copy of the group's keeper on the gathering
    row would be the two-representations defect this schema keeps
    banning (database-schema decision 20's class).

    WHY (d) BEFORE (e): a CHECK validates every existing row the instant
    it is added. Constrain-then-populate dies at (e) on any database
    holding rows, leaving the schema half-migrated and hand-unpickable.
    On today's data it would in fact survive — every `owning_group_id`
    is NULL, so no row can violate it whatever (d) writes — but a
    migration whose correctness depends on a column being empty is a
    trap for the next person who reorders it. Populate, then constrain.

Deliberately NOT in this migration: no index on any of the three columns
(an index arrives with its reader — CK-49b writes the queries), no
NOT NULL anywhere (NULL is a state on all three — §5), no change to
`kept_gatherings`, no change to `last_keeper_left_at` (where the stamp
lives once keeping moves to the group is record §12 item 9, CK-49b's
call), no group-count constant or override column (§3.3 is withdrawn in
full at §15.2), no writer for (a), no memorial validator.

The downgrade drops the constraint, then the three columns with their
FKs. It cannot restore `kept_gatherings` rows because it never removed
any — the relation is untouched in both directions — and it loses the
backfilled values, which the next upgrade recomputes from the relation
that is still there. Up / down / up is therefore genuinely idempotent
while `kept_gatherings` exists, and only while it does.

DATA-HANDLING: (d) assigns, for the first time, the account that will
later be answerable for nine real gatherings' bytes — photographs of
identifiable people among them — and whose lapse will eventually start a
deletion clock. Nothing here starts that clock: no consumer reads the
column, no consent rule, audience criterion or publication state changes,
and the safeguards on the clock (export before anything past Frozen, the
in-app alert, the claim path — record §9, §15.9) are not built here and
are not implied by anything here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0022'
down_revision: Union[str, Sequence[str], None] = '0021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# At most one of the two: a gathering that belongs to a group finds its
# keeper through the group and never stores it beside itself. Both NULL is
# legal — the Unkept rung.
GROUP_GATHERING_HAS_NO_KEEPER_CHECK = "owning_group_id IS NULL OR keeper_account_id IS NULL"


def upgrade() -> None:
    """Upgrade schema."""
    # (a) The belongs-to link, as a column with no writer. Arc B owns the
    # write path; nothing populates this and nothing consults it.
    op.add_column('gatherings', sa.Column('owning_group_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_gatherings_owning_group_id'), 'gatherings', 'groups', ['owning_group_id'], ['id']
    )

    # (b) A group's keeper — an account, never a person. NULL = unkept.
    op.add_column('groups', sa.Column('keeper_account_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_groups_keeper_account_id'), 'groups', 'accounts', ['keeper_account_id'], ['id']
    )

    # (c) A standalone gathering's own keeper. NULL = unkept, or in a group.
    op.add_column('gatherings', sa.Column('keeper_account_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_gatherings_keeper_account_id'), 'gatherings', 'accounts', ['keeper_account_id'], ['id']
    )

    # (d) The backfill — BEFORE the constraint (see the docstring).
    conn = op.get_bind()
    many_keepers = conn.execute(
        sa.text(
            "SELECT count(*) FROM ("
            "  SELECT gathering_id FROM kept_gatherings GROUP BY gathering_id HAVING count(*) > 1"
            ") m"
        )
    ).scalar_one()
    if many_keepers:
        # Refuse to choose. No id is printed: the message names a count,
        # and the operator reads the rows in psql.
        raise RuntimeError(
            f"0022 refuses to run: {many_keepers} gathering(s) hold more than one "
            "kept_gatherings row, so no single existing keeper can be backfilled — "
            "resolve the rows by hand, then re-run"
        )
    # A gathering with no kept row gets NULL from the scalar subquery: the
    # Unkept rung, deliberately — no default is invented.
    op.execute(
        "UPDATE gatherings g SET keeper_account_id = "
        "(SELECT k.account_id FROM kept_gatherings k WHERE k.gathering_id = g.id)"
    )
    # The creator is still the first keeper, and CK-45 wrote the creator as
    # admin; a group whose admin was relinquished gets NULL the same way.
    op.execute(
        "UPDATE groups g SET keeper_account_id = "
        "(SELECT p.account_id FROM people p WHERE p.id = g.admin_person_id)"
    )

    # (e) The CHECK, after every row it will validate is populated.
    op.create_check_constraint(
        op.f('ck_gatherings_group_gathering_has_no_keeper'),
        'gatherings',
        GROUP_GATHERING_HAS_NO_KEEPER_CHECK,
    )


def downgrade() -> None:
    """Downgrade schema — the constraint, then the three columns with their
    FKs. `kept_gatherings` was never touched, so nothing is restored to it;
    the backfilled values are lost and the next upgrade recomputes them
    from the relation, which is still the truth."""
    op.drop_constraint(
        op.f('ck_gatherings_group_gathering_has_no_keeper'), 'gatherings', type_='check'
    )
    op.drop_constraint(op.f('fk_gatherings_keeper_account_id'), 'gatherings', type_='foreignkey')
    op.drop_column('gatherings', 'keeper_account_id')
    op.drop_constraint(op.f('fk_groups_keeper_account_id'), 'groups', type_='foreignkey')
    op.drop_column('groups', 'keeper_account_id')
    op.drop_constraint(op.f('fk_gatherings_owning_group_id'), 'gatherings', type_='foreignkey')
    op.drop_column('gatherings', 'owning_group_id')
