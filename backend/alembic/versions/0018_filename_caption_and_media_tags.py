"""media.filename, media.caption, and the media_tags table

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-10

Phase CK-39 — words on a photograph: the filename, a caption, tags, and
finding things by them (decisions/2026-09-10-captions-tags-and-finding-a-
photograph.md). Three additions, one table's scope plus its new child.

(1) media.filename — nullable text. The uploader's original file name,
    taken at intent, never changed. It closes CK-38's finding (di): after a
    reload a row read "Photo — added by You" because the table had nowhere
    to put the name — an absence, not a bug — and on a `failed` row that
    meant a person could not tell WHICH photograph failed. Nullable because
    every existing row predates it and NOTHING IS BACKFILLED: the rows
    written before 0018 read NULL forever, and that is correct — NULL is the
    one representation of "no name" (a blank is refused at the intent, the
    CK-13/CK-20 discipline). A display string and nothing else: it never
    reaches a storage key, a path, or a header.

(2) media.caption — nullable text. The person's own words over the file
    name; set by the uploader alone under merge-patch semantics (CK-22):
    explicit null clears it, a blank is refused, absent leaves it alone.

(3) media_tags — one row per (photograph, tag): `media_id` (FK → media,
    ON DELETE CASCADE — a tag on a deleted photograph is an assertion with
    nothing behind it), the tag text, who added it (`added_by_person_id`,
    FK → people with NO delete rule: provenance, and account deletion is
    anonymization, never a cascade), and when. UNIQUE (media_id, tag) so
    one photograph cannot carry the same tag twice. A TABLE rather than an
    array column, decided before this phase: gathering-scoped tags and
    person tags are both plausible later, and a table makes each a smaller
    change.

    TWO COLUMNS THIS TABLE MUST NEVER GROW. No `gathering_id` — a tag hangs
    off a media row, which hangs off a gathering, and a column here would
    be a second representation of a fact the join already answers (the
    defect CK-13 banned for the refcount, CK-32 kept out of
    media_derivatives). And no `person_id` for a TAGGED person, not even
    nullable — a free-text tag is the uploader's claim about their own
    photograph; a person tag is a claim about someone else, the shape
    consent-and-compliance.md carries an open finding on, and it gets its
    own record and its own table when it is decided. verify_schema.py
    asserts both absent.

No index for search. `GET /gatherings/{id}/media?q=` is a case-insensitive
substring match over caption, tag and filename — a `%term%` cannot use an
ordinary index, and choosing between a trigram index and full-text search
needs data this product does not have. Decided, not overlooked; the
revisit trigger is the first gathering holding a few hundred photographs.

The downgrade drops the table and the two columns; nothing else changed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0018'
down_revision: Union[str, Sequence[str], None] = '0017'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # (1) and (2): nullable, no default, no backfill.
    op.add_column('media', sa.Column('filename', sa.Text(), nullable=True))
    op.add_column('media', sa.Column('caption', sa.Text(), nullable=True))
    # (3)
    op.create_table('media_tags',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('media_id', sa.Uuid(), nullable=False),
    sa.Column('tag', sa.Text(), nullable=False),
    sa.Column('added_by_person_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # Provenance: who wrote the words. No delete rule — nothing cascades
    # from a person (account deletion is anonymization).
    sa.ForeignKeyConstraint(['added_by_person_id'], ['people.id'], name=op.f('fk_media_tags_added_by_person_id')),
    # Containment: a tag cannot outlive its photograph (the 0014/0016 shape).
    sa.ForeignKeyConstraint(['media_id'], ['media.id'], name=op.f('fk_media_tags_media_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_media_tags')),
    # One photograph, one tag, once. Leads with media_id, so it also indexes
    # the FK and no separate index is created.
    sa.UniqueConstraint('media_id', 'tag', name=op.f('uq_media_tags_media_id_tag'))
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0017's shape. The tags and the
    two columns' VALUES are gone; nothing else is touched."""
    op.drop_table('media_tags')
    op.drop_column('media', 'caption')
    op.drop_column('media', 'filename')
