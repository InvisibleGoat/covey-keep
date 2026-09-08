"""media: the derivative layer table, the job columns, and a label that no longer blocks a delete

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-07

Phase CK-32 — the media schema, first phase of the media arc. Schema only:
no R2, no endpoint, no dependency. The `media` table has existed since 0001
(re-pointed at the gathering at 0008) with no surface and no rows; this
migration AMENDS it (media pipeline record §10) — it does not create one.

(1) The status ladder grows (record §6.1): media_status gains
    pending_upload, uploaded, failed around 0001's processing | ready, so
    the DB order reads pending_upload | uploaded | processing | ready |
    failed. THE POSTGRES RULE, stated here so the next enum change does not
    learn it the hard way: ALTER TYPE ... ADD VALUE is permitted inside a
    transaction on PG 12+, but a label added in a transaction CANNOT BE
    USED until that transaction commits — not in a row, not in a CHECK, not
    in a column DEFAULT. This migration adds labels and uses none of them;
    a later migration that needs to write a new label must add it in a
    migration of its own, one commit earlier. (The one exception — a type
    created in the same transaction, which is what happens in a fresh test
    database running 0001..0016 as one transaction — is why the suite would
    not have caught a violation here; the deployed database would.)
    Labels are added IF NOT EXISTS because they cannot be dropped: the
    downgrade leaves them in place and says so.

(2) The media row IS the job (record §6.1 — no media_jobs table): attempts,
    available_at, claimed_at, last_error ride the row. And `status` loses
    its server default: a default of 'processing' would let an INSERT that
    omitted the rung be reclaimed by the worker fifteen minutes later
    against an object that was never uploaded. A writer must state the
    rung. (Setting the default to 'pending_upload' instead is exactly the
    use-a-new-label-in-the-same-transaction hazard from (1).)

(3) The derivative layer shape, decided
    (decisions/2026-09-07-media-derivative-schema-shape.md): one row per
    layer in `media_derivatives`, carrying the four facts about a stored
    object (key, MIME type, size, storage class) plus last_accessed, and
    NOTHING about lifecycle — no publication_state, no removed_at, no
    status, ever (media-layers record §8). The per-object columns leave the
    media row: storage_key, storage_class, last_accessed are dropped (a
    logical photograph has no key, class, or access time — its objects do;
    the quarantine original's key is derived from the row id, never
    stored); size_bytes and content_type are RENAMED to upload_size_bytes
    and upload_content_type, one meaning at every rung (the upload's
    declared size — the quota reservation's input, record §6.6 — and its
    declared MIME type), because `size_bytes` beside
    `media_derivatives.size_bytes` would carry two readings. The size
    becomes NOT NULL: the presigned PUT signs it as Content-Length, so it is
    known at intent, and a NULL would reserve nothing (sum ignores NULLs).
    The table is empty (verified on the dev and deployed databases — no
    surface has ever written it), so the NOT NULL add and the downgrade's
    NOT NULL re-add both pass; either fails loudly if that ever changes.

(4) media.occurrence_id gains ON DELETE SET NULL — the CK-30 dormant 500,
    closed by the phase that gives media a surface, as CK-30 recorded.
    The model's own docstring decides the rule ("a label, never an owner"):
    removing a date removes the label and keeps the photograph. Not a
    cascade, and not a third confirmable refusal beside CK-30's two — there
    is nothing to warn about when nothing is destroyed. The 0015 pattern:
    drop and re-create the named constraint, since a delete rule cannot be
    altered in place. `posts.occurrence_id` has the identical shape and no
    surface, and is deliberately NOT touched — recorded as a finding with
    its trigger (the phase that gives posts a surface), exactly as CK-30
    recorded this one.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0016'
down_revision: Union[str, Sequence[str], None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

media_layer = postgresql.ENUM(
    'archival', 'web', 'thumbnail', name='media_layer', create_type=False
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # --- (1) the status ladder ---------------------------------------------
    # Adds labels only; nothing below uses them (see the module docstring).
    op.execute("ALTER TYPE media_status ADD VALUE IF NOT EXISTS 'pending_upload' BEFORE 'processing'")
    op.execute("ALTER TYPE media_status ADD VALUE IF NOT EXISTS 'uploaded' BEFORE 'processing'")
    op.execute("ALTER TYPE media_status ADD VALUE IF NOT EXISTS 'failed'")

    # --- (2) the media row is the job --------------------------------------
    op.add_column('media', sa.Column('attempts', sa.Integer(), server_default=sa.text('0'), nullable=False))
    op.add_column('media', sa.Column('available_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('media', sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('media', sa.Column('last_error', sa.Text(), nullable=True))
    op.alter_column('media', 'status', server_default=None)

    # --- (3) the derivative layer shape ------------------------------------
    op.drop_column('media', 'storage_key')
    op.drop_column('media', 'storage_class')
    op.drop_column('media', 'last_accessed')
    op.alter_column('media', 'size_bytes', new_column_name='upload_size_bytes')
    op.alter_column('media', 'upload_size_bytes', existing_type=sa.BigInteger(), nullable=False)
    op.alter_column('media', 'content_type', new_column_name='upload_content_type')

    media_layer.create(bind, checkfirst=True)
    op.create_table('media_derivatives',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('media_id', sa.Uuid(), nullable=False),
    sa.Column('layer', media_layer, nullable=False),
    sa.Column('storage_key', sa.Text(), nullable=False),
    sa.Column('content_type', sa.Text(), nullable=False),
    sa.Column('size_bytes', sa.BigInteger(), nullable=False),
    sa.Column('storage_class', sa.Text(), nullable=False),
    sa.Column('last_accessed', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    # Containment: a stored representation cannot outlive its photograph
    # (the 0014 companions shape). Nothing here cascades from a person.
    sa.ForeignKeyConstraint(['media_id'], ['media.id'], name=op.f('fk_media_derivatives_media_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_media_derivatives')),
    # One row per layer per photograph; leads with media_id, so it also
    # indexes the FK and no separate index is created.
    sa.UniqueConstraint('media_id', 'layer', name=op.f('uq_media_derivatives_media_id_layer')),
    # One object, one row.
    sa.UniqueConstraint('storage_key', name=op.f('uq_media_derivatives_storage_key'))
    )

    # --- (4) the occurrence label no longer blocks a delete ----------------
    op.drop_constraint('fk_media_occurrence_id', 'media', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_media_occurrence_id'),
        'media',
        'occurrences',
        ['occurrence_id'],
        ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema — restores 0015's shape with ONE honest exception:
    the three media_status labels added in (1) CANNOT be removed (Postgres
    has no DROP VALUE), so they remain on the type after a downgrade. Every
    column, constraint, table, and default is genuinely restored; the
    dropped columns' VALUES are not (the table holds no rows — the
    NOT NULL re-add of storage_key fails loudly if that has changed)."""
    # (4)
    op.drop_constraint('fk_media_occurrence_id', 'media', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_media_occurrence_id'),
        'media',
        'occurrences',
        ['occurrence_id'],
        ['id'],
    )
    # (3)
    op.drop_table('media_derivatives')
    media_layer.drop(op.get_bind(), checkfirst=True)
    op.alter_column('media', 'upload_content_type', new_column_name='content_type')
    op.alter_column('media', 'upload_size_bytes', existing_type=sa.BigInteger(), nullable=True)
    op.alter_column('media', 'upload_size_bytes', new_column_name='size_bytes')
    # 0001's originals: storage_key NOT NULL with no default (the emptiness
    # guard), storage_class NOT NULL DEFAULT 'standard', last_accessed NULL.
    op.add_column('media', sa.Column('last_accessed', sa.DateTime(timezone=True), nullable=True))
    op.add_column('media', sa.Column('storage_class', sa.Text(), server_default=sa.text("'standard'"), nullable=False))
    op.add_column('media', sa.Column('storage_key', sa.Text(), nullable=False))
    # (2) — 'processing' is a 0001 label, usable in this transaction.
    op.alter_column('media', 'status', server_default=sa.text("'processing'"))
    op.drop_column('media', 'last_error')
    op.drop_column('media', 'claimed_at')
    op.drop_column('media', 'available_at')
    op.drop_column('media', 'attempts')
    # (1) — not undone; see the docstring.
