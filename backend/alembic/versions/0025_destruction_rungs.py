"""media_status grows the destruction ladder: destroying, destroyed

Revision ID: 0025
Revises: 0024
Create Date: 2026-09-22

Phase CK-54 - Phase A of the bin arc (decisions/2026-09-20-the-bin-counts-
and-empties.md §6, §7.1, §7.2). Nothing in CoveyKeep has ever deleted a
published photograph's bytes: storage.py carried one delete function and it
was for quarantine originals. "Remove" set publication_state = 'removed',
stamped removed_at, left status = 'ready', and the three layers stayed in
R2 - which is why neither total_bytes nor photo_count has ever been
decremented. This migration adds the two rungs the routine that actually
destroys one needs.

(a) media_status += 'destroying' - claimable and retryable, the mirror of
    'processing'. The marking statement (api/media.py) moves a `ready` row
    here and decrements gatherings.photo_count and gatherings.total_bytes
    in ONE statement - the mirror of CK-51a's single-statement increment,
    for the same reason: in one statement the two columns cannot diverge.

(b) media_status += 'destroyed' - terminal, the mirror of 'ready': the
    three published objects are gone and the media_derivatives rows with
    them. The media row survives, carrying its provenance and its words
    (§7.2).

THE LABELS ARE ADDED AND NOT USED - THE CK-32 TRAP, RESTATED BECAUSE IT IS
THE ONE THING THAT COULD MAKE THIS MIGRATION FAIL ON THE DEPLOY AND PASS IN
THE SUITE. A Postgres enum label added inside a transaction cannot be used
until that transaction commits - not in a row, not in a CHECK, not in a
column default - and Alembic runs a migration as one transaction. A fresh
test database is the one exemption (it creates the type and adds the label
in the same transaction as everything else), so a violation here would be
green locally and abort the pre-deploy. So: no backfill, no default, no
CHECK, no UPDATE. Nothing in this file writes either label, and nothing
may be added to it that does. A phase needing to USE one adds it a
migration earlier - which is what this file is for.

ADD VALUE IF NOT EXISTS, and appended rather than placed: 0016 used BEFORE
clauses so the ingest ladder would read top to bottom in \\dT+ as well as in
the model, and these two come after it both chronologically and logically
(a photograph is destroyed after it was ready). The model's member order
matches.

THE DOWNGRADE DROPS NOTHING, and says so. Postgres cannot remove an enum
label; up / down / up is idempotent BECAUSE the adds are IF NOT EXISTS.
A downgrade past this revision with rows at either label would leave those
rows referencing labels the model no longer names - the reason the
downgrade is documented rather than made clever: there is no honest way to
reverse a destruction, and a migration must not pretend otherwise.

DATA-HANDLING: this migration adds two words to a type. It destroys
nothing, reads no image bytes, moves no object, and changes no audience
rule, publication state, consent record or quota number. What it enables -
the first path in the product that destroys a photograph, including
photographs of children - is application code in the same phase, and every
destruction on that path is deliberate: a person choosing permanent delete.
The scheduled half (the 30-day sweep) is Phase B and is deliberately NOT
here: nothing in this phase stamps a row into 'destroying' on a clock.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0025'
down_revision: Union[str, Sequence[str], None] = '0024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Appended after 'failed', in ladder order. IF NOT EXISTS so up / down / up
# works - the downgrade cannot remove them.
NEW_LABELS = ('destroying', 'destroyed')


def upgrade() -> None:
    """Upgrade schema - two labels, used by nothing in this transaction."""
    for label in NEW_LABELS:
        op.execute(f"ALTER TYPE media_status ADD VALUE IF NOT EXISTS '{label}'")


def downgrade() -> None:
    """Downgrade schema - A NO-OP, AND THE HONEST ONE.

    Postgres has no DROP VALUE: a label, once added to an enum type, stays.
    Recreating the type without the two labels would mean rewriting every
    column that uses it, and any row already at 'destroying' or 'destroyed'
    would have to be given some other rung - a lie in either direction
    ('ready' claims layers that are gone; 'failed' claims an upload that
    succeeded). So this downgrade leaves both labels in place and records
    that it did. The application code that writes them goes with the code
    revert; the type is wider than the model and nothing is harmed by it.
    """
    pass
