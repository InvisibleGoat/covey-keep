"""media.removed_by_person_id — who removed a photograph

Revision ID: 0026
Revises: 0025
Create Date: 2026-09-27

Phase CK-63 — who removed it: removal attribution, the uploader's view
narrowed to their own removals, and restore from your own bin
(decisions/2026-09-27-two-bins.md §3, §4). One nullable column on `media`,
and nothing else.

WHY. There are two bins, and a photograph is in exactly one — the bin of
whoever removed it (two-bins §1, §2). An uploader removing their own
photograph is taking it back, and nobody else may put it back; a host
removing (or declining) someone else's is moderation, and the uploader
never sees it again. Until this column the code could not tell the two
apart: a host's decline and an uploader's own removal were the same row,
and both sat in the uploader's view for thirty days. Nothing could restore
a photograph at all, and nothing could be built to — a restore endpoint
without this fact would let an uploader restore a photograph the host
declined, which the record forbids outright.

media.removed_by_person_id — uuid, nullable, FK -> people with NO delete
    rule (provenance, never a subject — `published_by_person_id`'s shape,
    0020; account deletion is anonymization, never a cascade). Written by
    `POST /media/{id}/remove` and `POST /media/{id}/decline` in the SAME
    guarded statement that stamps `removed_at`, never a second one; cleared
    with `removed_at` by `POST /media/{id}/restore`. `destroy` and the sweep
    leave it alone: a destroyed row keeps its remover as provenance, which
    is what the removal log (two-bins §5) will read.

NO SERVER DEFAULT, AND NOTHING IS BACKFILLED. A row removed before this
migration has no recorded remover, and NULL means exactly that — not "the
uploader", not "the host". The read rule treats a NULL remover as visible to
nobody (api/media.py::_visible_media): we cannot tell a self-removal from a
decline after the fact, and showing a declined photograph to its uploader is
the harm the record exists to prevent, so the unknown case is hidden rather
than guessed at. The two CK-43/CK-44 declines of 2026-09-14 are among those
rows; they stay NULL and are swept on or after 2026-10-14 exactly as before
(the sweep never reads this column).

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING WITHOUT AN EXPAND/CONTRACT SPLIT.
`render.yaml` runs this migration while the OLD web instance is still
serving. Adding a nullable column with no default is invisible to that
instance: the old code neither reads nor writes it, its INSERTs omit it and
get NULL, its SELECTs name their columns. Nothing here drops, renames,
constrains or rewrites anything the old code touches.

The downgrade drops the FK and the column; the values are lost, and nothing
else is touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0026'
down_revision: Union[str, Sequence[str], None] = '0025'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no default, no backfill — see the docstring for why each
    # of those is a rule rather than an omission.
    op.add_column('media', sa.Column('removed_by_person_id', sa.Uuid(), nullable=True))
    # Provenance: no delete rule — nothing cascades from a person.
    op.create_foreign_key(
        op.f('fk_media_removed_by_person_id'),
        'media',
        'people',
        ['removed_by_person_id'],
        ['id'],
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0025's shape. The remover's
    VALUES are gone; nothing else is touched."""
    op.drop_constraint(op.f('fk_media_removed_by_person_id'), 'media', type_='foreignkey')
    op.drop_column('media', 'removed_by_person_id')
