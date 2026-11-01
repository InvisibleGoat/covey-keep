"""uploaded covers: cover_images, and a second cover source on gatherings and groups

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-01

Phase CK-83b — uploaded covers: a cover picture from the device, processed by
the worker and kept apart from the photographs, replaced or cleared by the
latest act (decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3
item 3's second half). One new table, one new column on each subject, the
subject's CHECK widened, and nothing else.

THE TABLE, `cover_images` — ONE ROW PER UPLOADED COVER AND ITS JOB (the
media row's pattern: the row IS the job, pipeline record §6.1). A SIBLING of
`media`, never a kind of it: every reader of `media` means a photograph, and
a cover is not one (§1.3; the CK-77 Gotcha's sibling-relation rule).

    id                      uuid PK, gen_random_uuid()
    gathering_id            uuid NULL, FK -> gatherings (no delete rule)
    group_id                uuid NULL, FK -> groups (no delete rule)
    uploaded_by_person_id   uuid NOT NULL, FK -> people (no delete rule) —
                            provenance, in no body; a deleted account keeps
                            its anonymized person row, and the cover stays
    content_type            text NOT NULL — declared at intent, signed in
    size_bytes              bigint NOT NULL — declared at intent, signed in
    status                  media_status NOT NULL, NO server default — the
                            media ladder's own type and rungs
    attempts                integer NOT NULL DEFAULT 0
    available_at            timestamptz NULL
    claimed_at              timestamptz NULL
    last_error              text NULL — operator-only (CK-57)
    failure_reason          media_failure_reason NULL — set iff `failed`
    superseded_at           timestamptz NULL — a later act superseded this
                            upload while it was in flight
    web_content_type        text NULL     } the two layers' facts, recorded
    web_size_bytes          bigint NULL   } at `ready`, cleared at
    thumbnail_content_type  text NULL     } `destroyed` — all four or none
    thumbnail_size_bytes    bigint NULL   }
    created_at              timestamptz NOT NULL DEFAULT now()

    CHECK ck_cover_images_one_subject:
        num_nonnulls(gathering_id, group_id) = 1
    CHECK ck_cover_images_layers_all_or_none:
        num_nonnulls(web_content_type, web_size_bytes,
                     thumbnail_content_type, thumbnail_size_bytes) IN (0, 4)
    INDEX ix_cover_images_gathering_id ON (gathering_id) WHERE gathering_id IS NOT NULL
    INDEX ix_cover_images_group_id     ON (group_id)     WHERE group_id IS NOT NULL
    — the supersede statement's readers (services/covers.py), run under the
    subject's lock on every cover act.

NO KEY IS STORED: the quarantine original is `covers/<id>` and the published
objects `covers/<id>/web` and `covers/<id>/thumbnail`, derived from the id by
services/storage.py. The quarantine bucket's 24-hour lifecycle rule is
bucket-wide by design (pipeline record §6.3), so it covers this keyspace with
no change; every R2 credential is scoped to a bucket, never a prefix (§11),
so nothing in a dashboard moves.

ON EACH OF `gatherings` AND `groups`:

    cover_image_id          uuid NULL, FK -> cover_images (no delete rule) —
                            the uploaded cover, a `ready` row of this same
                            subject (verifier-asserted), written by the
                            worker at `ready` and cleared by the latest act
    INDEX ix_<table>_cover_image_id ON (cover_image_id)
        WHERE cover_image_id IS NOT NULL

    CHECK ck_<table>_cover_all_or_none, WIDENED (dropped and recreated under
    its own name):
        num_nonnulls(cover_media_id, cover_image_id) <= 1
        AND num_nonnulls(cover_media_id, cover_image_id,
                         cover_set_at, cover_set_by_person_id) IN (0, 3)
    — at most one source, and a cover (either one) set iff its version and
    its setter are: with at most one pointer, three non-nulls means exactly
    one pointer with both stamps, and no pointer allows at most two.

THE FKs CLOSE A CYCLE (gatherings <-> cover_images, groups <-> cover_images),
so the models mark the subjects' side `use_alter`; here the table comes first
and the subjects' columns and FKs after, which is all `use_alter` means for a
migration.

THE ENUM LABELS. Both columns use EXISTING types (`create_type=False`), and
nothing here names a label: `failed`, `destroying` and `destroyed` were
added to `media_status` by ALTER TYPE … ADD VALUE, and the suite builds its
database from 0001 in ONE transaction, where such a label is unusable (the
CK-71 Gotcha) — so no CHECK or partial index on this table reads `status`.
The set-iff rules on it are the verifier's.

NOTHING IS BACKFILLED: no uploaded cover exists, and every existing subject
row satisfies the widened CHECK as it satisfied the old one.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING (expand-only): a new table nobody
reads, two nullable columns with no default, and a CHECK that admits every
row the old one did — all invisible to the CK-83a instance serving during
this pre-deploy window, which selects none of it and writes only photograph
covers (`cover_image_id` NULL, which the widened CHECK admits exactly as the
old one did).

THE DOWNGRADE removes it all, in reverse. An uploaded cover set since cannot
survive it — the old CHECK would refuse a row with a version and a setter but
no photograph — so the stamps of every uploaded cover are cleared first, in
one UPDATE per subject (the cover goes with the table it lived in); then the
CHECK is restored to its 0035 form, the columns and the table dropped. The
objects in R2 are not this migration's to delete; the quarantine rule takes
any original, and a published cover object outlives a downgrade as a
photograph's does.

DATA-HANDLING: a cover image is a picture an organiser uploaded for their
group or gathering, with its metadata stripped by the photographs' own code
path; the table names who uploaded it (provenance, in no body). Nothing here
reads a row or logs anything.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0036'
down_revision: Union[str, Sequence[str], None] = '0035'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SUBJECTS = ('gatherings', 'groups')

# Existing types — referenced, never created or dropped here.
media_status = postgresql.ENUM(name='media_status', create_type=False)
media_failure_reason = postgresql.ENUM(name='media_failure_reason', create_type=False)

WIDENED = (
    'num_nonnulls(cover_media_id, cover_image_id) <= 1 '
    'AND num_nonnulls(cover_media_id, cover_image_id, cover_set_at, cover_set_by_person_id) IN (0, 3)'
)
NARROW_0035 = 'num_nonnulls(cover_media_id, cover_set_at, cover_set_by_person_id) IN (0, 3)'


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'cover_images',
        sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('gathering_id', sa.Uuid(), nullable=True),
        sa.Column('group_id', sa.Uuid(), nullable=True),
        sa.Column('uploaded_by_person_id', sa.Uuid(), nullable=False),
        sa.Column('content_type', sa.Text(), nullable=False),
        sa.Column('size_bytes', sa.BigInteger(), nullable=False),
        sa.Column('status', media_status, nullable=False),
        sa.Column('attempts', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('available_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('failure_reason', media_failure_reason, nullable=True),
        sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('web_content_type', sa.Text(), nullable=True),
        sa.Column('web_size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('thumbnail_content_type', sa.Text(), nullable=True),
        sa.Column('thumbnail_size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(
            'num_nonnulls(gathering_id, group_id) = 1', name=op.f('ck_cover_images_one_subject')
        ),
        sa.CheckConstraint(
            'num_nonnulls(web_content_type, web_size_bytes, thumbnail_content_type, '
            'thumbnail_size_bytes) IN (0, 4)',
            name=op.f('ck_cover_images_layers_all_or_none'),
        ),
        sa.ForeignKeyConstraint(
            ['gathering_id'], ['gatherings.id'], name=op.f('fk_cover_images_gathering_id')
        ),
        sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_cover_images_group_id')),
        sa.ForeignKeyConstraint(
            ['uploaded_by_person_id'], ['people.id'], name=op.f('fk_cover_images_uploaded_by_person_id')
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_cover_images')),
    )
    op.create_index(
        'ix_cover_images_gathering_id',
        'cover_images',
        ['gathering_id'],
        unique=False,
        postgresql_where=sa.text('gathering_id IS NOT NULL'),
    )
    op.create_index(
        'ix_cover_images_group_id',
        'cover_images',
        ['group_id'],
        unique=False,
        postgresql_where=sa.text('group_id IS NOT NULL'),
    )
    for table in SUBJECTS:
        op.add_column(table, sa.Column('cover_image_id', sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f'fk_{table}_cover_image_id'), table, 'cover_images', ['cover_image_id'], ['id']
        )
        op.create_index(
            op.f(f'ix_{table}_cover_image_id'),
            table,
            ['cover_image_id'],
            unique=False,
            postgresql_where=sa.text('cover_image_id IS NOT NULL'),
        )
        op.drop_constraint(op.f(f'ck_{table}_cover_all_or_none'), table, type_='check')
        op.create_check_constraint(op.f(f'ck_{table}_cover_all_or_none'), table, WIDENED)


def downgrade() -> None:
    """Downgrade schema — what the upgrade made goes, in reverse; every
    uploaded cover set since goes with it (its stamps cleared first, so the
    0035 CHECK can stand again)."""
    for table in reversed(SUBJECTS):
        op.execute(
            f'UPDATE {table} SET cover_image_id = NULL, cover_set_at = NULL, '
            'cover_set_by_person_id = NULL WHERE cover_image_id IS NOT NULL'
        )
        op.drop_constraint(op.f(f'ck_{table}_cover_all_or_none'), table, type_='check')
        op.create_check_constraint(op.f(f'ck_{table}_cover_all_or_none'), table, NARROW_0035)
        op.drop_index(op.f(f'ix_{table}_cover_image_id'), table_name=table)
        op.drop_constraint(op.f(f'fk_{table}_cover_image_id'), table, type_='foreignkey')
        op.drop_column(table, 'cover_image_id')
    op.drop_index('ix_cover_images_group_id', table_name='cover_images')
    op.drop_index('ix_cover_images_gathering_id', table_name='cover_images')
    op.drop_table('cover_images')
