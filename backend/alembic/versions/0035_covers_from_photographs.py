"""covers from photographs: a cover pointer on gatherings and groups

Revision ID: 0035
Revises: 0034
Create Date: 2026-10-31

Phase CK-83a — covers from photographs: "Use as cover" for a gathering and a
group, the cover cleared when its photograph stops being published
(decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 3).
Six nullable columns, two CHECKs and two partial indexes, and nothing else.

On EACH of `gatherings` and `groups`, three columns:

    cover_media_id           uuid NULL, FK -> media (no delete rule, the
                             house habit) — the photograph that is the cover
    cover_set_at             timestamptz NULL — when it was set: the cover's
                             VERSION (setting the same photograph again does
                             not move it, so a client's cache stays valid)
    cover_set_by_person_id   uuid NULL, FK -> people (no delete rule) —
                             provenance, which person set it, like
                             `published_by_person_id`; never in a body. A
                             deleted account keeps its anonymized person row,
                             so this stays a pointer to a former member.

    CHECK ck_<table>_cover_all_or_none:
        num_nonnulls(cover_media_id, cover_set_at, cover_set_by_person_id) IN (0, 3)
    — the three are one fact: set together by the set path, cleared together
    by the clearing statement and the organisers' DELETE.

    INDEX ix_<table>_cover_media_id ON (cover_media_id)
        WHERE cover_media_id IS NOT NULL
    — the clearing statement's reader (services/covers.py::clear_covers_of:
    `WHERE cover_media_id = :media_id`, run in the transaction of every
    removal and destruction). Partial, because nearly every row has no
    cover and the statement never asks for NULL.

A POINTER, CLEARED — NEVER RESOLVED THROUGH LIVENESS. A cover chosen from a
photograph clears when that photograph stops being published (§1.3): the
transaction that removes or destroys it NULLs every pointer to it. A
pointer left to be filtered at read time would be a second representation
of "is this the cover", and a restore would quietly bring it back.

THE TWO FKs TO `media` CLOSE A CYCLE IN THE FOREIGN KEYS (media ->
gatherings -> groups -> media, and gatherings <-> media), so the models
mark them `use_alter`; here they are created after their columns exist,
which is all `use_alter` means for a migration. No delete rule: nothing in
the product deletes a `ready` photograph's row (destruction keeps it; only
`dismiss` deletes, and only a `failed` row, which can never be a cover).

NOTHING IS BACKFILLED: no cover exists. CK-83b adds a second source beside
`cover_media_id` (an uploaded cover) and widens the CHECK; nothing here
anticipates it.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING (expand-only): six nullable
columns with no default, two CHECKs every existing row satisfies (all
three NULL), two indexes — all invisible to the CK-82 instance serving
during this pre-deploy window, which selects none of the columns and
inserts rows that leave them NULL.

THE DOWNGRADE drops what the upgrade made, in reverse — the indexes, the
CHECKs, the FKs, the columns — and every cover set since goes with them.

DATA-HANDLING: a cover names a photograph its subject's organiser chose, and
which person chose it (provenance, in no body). Nothing here reads a row or
logs anything.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0035'
down_revision: Union[str, Sequence[str], None] = '0034'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SUBJECTS = ('gatherings', 'groups')


def upgrade() -> None:
    """Upgrade schema."""
    for table in SUBJECTS:
        op.add_column(table, sa.Column('cover_media_id', sa.Uuid(), nullable=True))
        op.add_column(table, sa.Column('cover_set_at', sa.DateTime(timezone=True), nullable=True))
        op.add_column(table, sa.Column('cover_set_by_person_id', sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f'fk_{table}_cover_media_id'), table, 'media', ['cover_media_id'], ['id']
        )
        op.create_foreign_key(
            op.f(f'fk_{table}_cover_set_by_person_id'),
            table,
            'people',
            ['cover_set_by_person_id'],
            ['id'],
        )
        op.create_check_constraint(
            op.f(f'ck_{table}_cover_all_or_none'),
            table,
            'num_nonnulls(cover_media_id, cover_set_at, cover_set_by_person_id) IN (0, 3)',
        )
        op.create_index(
            op.f(f'ix_{table}_cover_media_id'),
            table,
            ['cover_media_id'],
            unique=False,
            postgresql_where=sa.text('cover_media_id IS NOT NULL'),
        )


def downgrade() -> None:
    """Downgrade schema — what the upgrade made goes, in reverse; every cover
    set since goes with it."""
    for table in reversed(SUBJECTS):
        op.drop_index(op.f(f'ix_{table}_cover_media_id'), table_name=table)
        op.drop_constraint(op.f(f'ck_{table}_cover_all_or_none'), table, type_='check')
        op.drop_constraint(op.f(f'fk_{table}_cover_set_by_person_id'), table, type_='foreignkey')
        op.drop_constraint(op.f(f'fk_{table}_cover_media_id'), table, type_='foreignkey')
        op.drop_column(table, 'cover_set_by_person_id')
        op.drop_column(table, 'cover_set_at')
        op.drop_column(table, 'cover_media_id')
