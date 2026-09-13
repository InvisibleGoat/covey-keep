"""gatherings.requires_approval learns to say "nobody has decided"; the rows that never decided say it; ready photographs in gatherings that resolve open go live

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-13

Phase CK-41 — the publication gate: a default that inherits, and the first
photograph that goes live (decisions/2026-09-09-consent-gate-defaults.md
2.0.0). Three steps, one table's column and one table's rows.

(a) gatherings.requires_approval DROP NOT NULL, and the server default
    dropped with it. NULL MEANS INHERIT: nobody has decided, and the
    publication ladder (app/services/publication.py) answers at publish
    time from the rungs beneath — the home group's default, the type's
    template, the join shape. A default that fired on insert would decide
    on the host's behalf and defeat inheritance, and database-schema
    decision 22's whole point was that the server default is never the
    product rule; now there is none to mistake for one.

(b) EVERY EXISTING ROW SET TO NULL. Not re-evaluated, not set to false —
    set to UNDECIDED, which is what is true: every `true` in the database
    is CK-16's fail-closed interim (decision 22), and no override surface
    has ever existed, so no person has ever expressed a preference here.
    THIS IS WHY THE CORRECTION DOES NOT RECUR: from CK-44 onward the
    column can carry a host's intent, and a phase that backfilled it after
    that would be overwriting someone's choice. 0019 is the one migration
    that may write this column wholesale, and only because nothing in it
    was ever chosen. Do not read it as precedent.

(c) media.publication_state = 'live' where status = 'ready' AND
    publication_state = 'pending' AND the gathering resolves open. After
    (b) every host setting is NULL, no gathering has a home group, and no
    public join mechanism exists, so the ladder's resolution for every
    gathering is: the org backstop (an ORGANIZATION host → gated), else
    the join shape (private → open). The SQL is therefore a join to
    `accounts` and nothing more — a hostless gathering resolves open too
    (no backstop fires; the join shape answers), so the join is LEFT and
    the test is "not an organisation". `failed`, `pending_upload`,
    `uploaded`, `processing` and `removed` rows are untouched. THE
    RESOLVER'S LOGIC IS DUPLICATED IN SQL HERE, ONCE, DELIBERATELY: a
    one-instant correction of rows written under a superseded default,
    not a standing second implementation of publication.py — the worker
    resolves every later row through the module at publish time.

The downgrade restores NOT NULL and must therefore choose a value for the
NULLs: false. It cannot distinguish "inherited open" from "the host chose
open" and does not pretend to — nothing before 0019 could carry a choice,
and after CK-44 a downgrade would lose the host's `true` as readily as
anything else, which is the honest price of a downgrade across a column
whose meaning changed. (c) is NOT reversed: a photograph published by this
migration stays `live`, the way 0014's downgrade says what it leaves
behind rather than inventing a state.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0019'
down_revision: Union[str, Sequence[str], None] = '0018'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # (a) nullable, no server default — NULL means inherit.
    op.alter_column(
        'gatherings',
        'requires_approval',
        existing_type=sa.Boolean(),
        nullable=True,
        server_default=None,
    )
    # (b) every row: undecided. See the docstring for why this never recurs.
    op.execute("UPDATE gatherings SET requires_approval = NULL")
    # (c) ready + pending, in a gathering that resolves open — the ladder
    # in SQL, once: no host setting (all NULL after (b)), no home group, no
    # public join; the org backstop, else the join shape. LEFT JOIN: a
    # hostless gathering has no organisation behind it and resolves open.
    op.execute(
        "UPDATE media m SET publication_state = 'live' "
        "FROM gatherings g LEFT JOIN accounts a ON a.id = g.host_account_id "
        "WHERE m.gathering_id = g.id "
        "AND m.status = 'ready' AND m.publication_state = 'pending' "
        "AND a.kind IS DISTINCT FROM 'ORGANIZATION'::account_kind"
    )


def downgrade() -> None:
    """Downgrade schema — 0018's NOT NULL DEFAULT false restored. Every NULL
    becomes false: this cannot tell "inherited open" from "the host chose
    open" and does not pretend to. (c) is not reversed — the rows it
    published stay `live`; the downgrade says what it leaves behind."""
    op.execute("UPDATE gatherings SET requires_approval = false WHERE requires_approval IS NULL")
    op.alter_column(
        'gatherings',
        'requires_approval',
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.text('false'),
    )
