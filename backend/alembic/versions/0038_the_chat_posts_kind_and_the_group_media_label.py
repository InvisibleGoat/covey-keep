"""the chat: posts' kind, the hold's remover, and the group's container type

Revision ID: 0038
Revises: 0037
Create Date: 2026-11-21

Phase CK-102 - messages in a group's chat and a gathering's, with the 30-day
hold (decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §2,
§3, §6, §9, §14; decisions/2026-09-02-group-chat-and-media.md §4). The
`posts` table has stood since 0001 (re-pointed at the gathering at 0008)
with no writer; this migration gives it what the chat needs, and adds the
type the group's container is made with.

gathering_type gains 'group_media'
    ALTER TYPE ... ADD VALUE IF NOT EXISTS, AND NOTHING ELSE IN THIS
    MIGRATION NAMES IT. A label added this way cannot be used in the
    transaction that added it, and the suite migrates from 0001 in one
    transaction (the CK-71 Gotcha): no CHECK, partial index or data
    statement here may mention it. The code compares it at runtime, and the
    verifier compares `gathering_type::text`. The container is made by
    services/group_chat.py's helper, never by a migration.

post_kind  ENUM ('message', 'joined', 'outside_invitations_on', 'outside_invitations_off')
    CREATE TYPE, so its labels are usable here (the CHECK below names one).

posts.kind   post_kind NOT NULL
    Added with a server default of 'message' so the existing rows take it,
    and the default then dropped: every writer names the kind. The table has
    had no writer, so the INFO line's count is zero expected on the deploy -
    a non-zero count is a finding.

posts.body   text, NULLABLE since 0038
    CHECK ck_posts_body_iff_message:  (kind = 'message') = (body IS NOT NULL)
    CHECK ck_posts_body_length:       body IS NULL OR char_length(body) BETWEEN 1 AND 4000
    A line the chat writes itself carries no words; a message carries 1 to
    4,000 characters (code points: Python's len and char_length agree).

posts.removed_by_person_id   uuid NULL, FK -> people (NO delete rule)
    CHECK ck_posts_removed_iff_removed:
        (publication_state = 'removed') = (removed_at IS NOT NULL)
        AND (removed_at IS NULL) = (removed_by_person_id IS NULL)
    Who removed a message, the writer themselves or the people who run the
    place - the hold's "by whom". `publication_state` is 0001's CREATE TYPE
    (no label was ever added to it), so the CHECK may name 'removed'.

posts.occurrence_id's FK   ON DELETE SET NULL
    Closes the defect 0016 recorded (the identical shape on media went at
    0016; this one waited for the phase that gives posts a surface). No
    message names a date, so the column stays NULL.

Indexes
    ix_posts_gathering_id_created_at_id   (gathering_id, created_at, id) - the read, newest first, and paging
    ix_posts_author_person_id_created_at  (author_person_id, created_at) - the rate limit's count
    ix_posts_gathering_id DROPPED: every lookup by gathering_id (the chat's
    read, the FK check when a gathering row is deleted) is served by the
    composite's leading column.

SAFE UNDER THE RENDER PRE-DEPLOY ORDERING. The CK-101 instance serving
during the pre-deploy window names no post and never reads the new label;
it selects gatherings by explicit columns, and no row of the new type exists
until the new instance makes one.

THE DOWNGRADE drops what the upgrade made, in reverse, and restores the FK
and the single-column index. The lines the chat wrote itself carry no body,
which 0037's NOT NULL cannot hold, so they are DELETED first, with an INFO
line counting them; every message is kept (a held one keeps its removed_at
and loses its remover). It LEAVES THE LABEL: PostgreSQL cannot remove an
enum label, and the upgrade's IF NOT EXISTS makes a round trip clean. A
container left behind is a gathering of a type 0037's code does not know.

DATA-HANDLING: a kind and a remover on a row that already held a person's
words, name and time. No address, nothing logged but two counts.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0038'
down_revision: Union[str, Sequence[str], None] = '0037'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the counts
# land in the deploy log beside them at INFO (the 0023/0024/0028 pattern).
log = logging.getLogger("alembic.runtime.migration")

POST_KINDS = ('message', 'joined', 'outside_invitations_on', 'outside_invitations_off')

# Created explicitly below (the 0016/0028 pattern), so the column's add
# never tries to create it a second time.
post_kind = postgresql.ENUM(*POST_KINDS, name='post_kind', create_type=False)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    # --- the container's type: the label alone, named nowhere else here -----
    op.execute("ALTER TYPE gathering_type ADD VALUE IF NOT EXISTS 'group_media'")

    # --- the kind ------------------------------------------------------------
    post_kind.create(bind, checkfirst=True)
    existing = bind.execute(sa.text("SELECT count(*) FROM posts")).scalar_one()
    op.add_column(
        'posts', sa.Column('kind', post_kind, nullable=False, server_default='message')
    )
    op.alter_column('posts', 'kind', server_default=None)
    # ASCII only: a Windows console under cp1252 raises on an em dash, and a
    # migration must not fail for a log line.
    log.info(
        "0038 gave posts a kind: %d existing row(s), each a message "
        "(zero expected - the table had no writer; a non-zero count is a finding)",
        existing,
    )

    # --- the body: a message's alone, 1 to 4,000 characters -----------------
    op.alter_column('posts', 'body', existing_type=sa.Text(), nullable=True)
    op.create_check_constraint(
        op.f('ck_posts_body_iff_message'), 'posts', "(kind = 'message') = (body IS NOT NULL)"
    )
    op.create_check_constraint(
        op.f('ck_posts_body_length'), 'posts', "body IS NULL OR char_length(body) BETWEEN 1 AND 4000"
    )

    # --- the remover, and the hold's CHECK -----------------------------------
    op.add_column('posts', sa.Column('removed_by_person_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_posts_removed_by_person_id'), 'posts', 'people', ['removed_by_person_id'], ['id']
    )
    op.create_check_constraint(
        op.f('ck_posts_removed_iff_removed'),
        'posts',
        "(publication_state = 'removed') = (removed_at IS NOT NULL) "
        "AND (removed_at IS NULL) = (removed_by_person_id IS NULL)",
    )

    # --- the date's FK sets NULL (0016's recorded defect) --------------------
    op.drop_constraint(op.f('fk_posts_occurrence_id'), 'posts', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_posts_occurrence_id'), 'posts', 'occurrences', ['occurrence_id'], ['id'],
        ondelete='SET NULL',
    )

    # --- the two indexes; the single-column one goes --------------------------
    op.create_index(
        op.f('ix_posts_gathering_id_created_at_id'), 'posts', ['gathering_id', 'created_at', 'id'], unique=False
    )
    op.create_index(
        op.f('ix_posts_author_person_id_created_at'), 'posts', ['author_person_id', 'created_at'], unique=False
    )
    op.drop_index(op.f('ix_posts_gathering_id'), table_name='posts')


def downgrade() -> None:
    """Downgrade schema - what the upgrade made goes, in reverse; the label stays."""
    bind = op.get_bind()
    lines = bind.execute(sa.text("DELETE FROM posts WHERE kind <> 'message'")).rowcount
    log.info(
        "0038 downgrade deleted %d line(s) the chat wrote itself "
        "(they carry no words, and 0037's posts.body is NOT NULL); every message kept",
        lines,
    )
    op.create_index(op.f('ix_posts_gathering_id'), 'posts', ['gathering_id'], unique=False)
    op.drop_index(op.f('ix_posts_author_person_id_created_at'), table_name='posts')
    op.drop_index(op.f('ix_posts_gathering_id_created_at_id'), table_name='posts')
    op.drop_constraint(op.f('fk_posts_occurrence_id'), 'posts', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_posts_occurrence_id'), 'posts', 'occurrences', ['occurrence_id'], ['id']
    )
    op.drop_constraint(op.f('ck_posts_removed_iff_removed'), 'posts', type_='check')
    op.drop_constraint(op.f('fk_posts_removed_by_person_id'), 'posts', type_='foreignkey')
    op.drop_column('posts', 'removed_by_person_id')
    op.drop_constraint(op.f('ck_posts_body_length'), 'posts', type_='check')
    op.drop_constraint(op.f('ck_posts_body_iff_message'), 'posts', type_='check')
    op.alter_column('posts', 'body', existing_type=sa.Text(), nullable=False)
    op.drop_column('posts', 'kind')
    post_kind.drop(bind, checkfirst=True)
    # 'group_media' stays on gathering_type: PostgreSQL cannot remove a label.
