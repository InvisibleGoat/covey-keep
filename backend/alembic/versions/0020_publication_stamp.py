"""media.published_at and media.published_by_person_id — the publication stamp

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-13

Phase CK-43 — the host's review: the queue, publish, decline, and the
publication stamp (decisions/2026-09-13-the-hosts-review.md §7). Two
nullable columns on `media`, and nothing else.

WHY. A consent architecture that cannot say who published a photograph of
a child, or when, has a gap exactly where its evidence should be. Removal
has been stamped since 0001 (`removed_at`); publication was not; the
asymmetry was the tell. A dispute, a takedown, a revocation, or a parent
asking "who decided this could be seen" reads these two columns.

(1) media.published_at — timestamptz, nullable, no default. Stamped in the
    SAME guarded statement that writes `publication_state = 'live'`: by the
    worker's publish transaction where the gathering resolves open
    (services/ingest.py step 4), by the host's publish where it resolves
    gated (api/media.py). Only over `pending`, like the state itself — a
    takedown is never undone, and never re-dated.

(2) media.published_by_person_id — uuid, nullable, FK -> people with NO
    delete rule (provenance, never a subject — MediaTag.added_by_person_id's
    shape; account deletion is anonymization, never a cascade).
    NULL WHEN THE RULE PUBLISHED IT: an ungated gathering's photographs are
    published by the publication ladder at `ready` — the worker applying a
    setting that says no approval is required — not by a person, and NULL
    is that fact rather than missing data. Non-NULL means a host acted.
    Do not "fix" this column to NOT NULL, and do not write the host's id
    where the worker published: the difference between "the product's
    default published this" and "this person published this" is the whole
    evidentiary point.

NOTHING IS BACKFILLED. Every `live` row on the database at 0020 was
published by migration 0019's one-time correction or by CK-41's worker
before this column existed; each reads NULL on both columns forever — the
0018 precedent (`filename`): inventing a value would be the product
claiming to know something it does not. After 0020 every path that writes
`live` stamps `published_at`, so the count of unstamped `live` rows can
only ever shrink (the verifier records it as a fact, never a failure).

The downgrade drops both columns; the values are lost, and nothing else is
touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0020'
down_revision: Union[str, Sequence[str], None] = '0019'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no default, no backfill — see the docstring for why both
    # of those are rules rather than omissions.
    op.add_column('media', sa.Column('published_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('media', sa.Column('published_by_person_id', sa.Uuid(), nullable=True))
    # Provenance: no delete rule — nothing cascades from a person.
    op.create_foreign_key(
        op.f('fk_media_published_by_person_id'),
        'media',
        'people',
        ['published_by_person_id'],
        ['id'],
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0019's shape. The stamps'
    VALUES are gone; nothing else is touched."""
    op.drop_constraint(op.f('fk_media_published_by_person_id'), 'media', type_='foreignkey')
    op.drop_column('media', 'published_by_person_id')
    op.drop_column('media', 'published_at')
