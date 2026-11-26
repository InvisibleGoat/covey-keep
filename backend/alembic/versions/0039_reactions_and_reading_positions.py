"""reactions on a message, and how far each person has read in a chat

Revision ID: 0039
Revises: 0038
Create Date: 2026-11-25

CK-104 (the chat's second pair, the backend;
decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md section 5 and
section 8; database-schema decision 55).

THE UPGRADE makes three things:

1.  `post_reaction_kind`, by CREATE TYPE. Its seven labels are usable in this
    transaction because the type is made in it - never by ALTER TYPE ... ADD
    VALUE, whose label is unusable in the transaction that added it (the
    CK-71 Gotcha). Nothing here names a label that was added that way, in the
    migration's code or in its SQL, so nothing is compared as text either.
2.  `post_reactions`: one row a person, a message and a kind, which is its
    key, so one person leaves at most one of each kind. `post_id` CASCADES:
    the sweep deletes a held message in one statement and its reactions go
    with it, under the old instance's sweep too. `person_id` has no delete
    rule (a person's row is never deleted) and an index, because deleting an
    account deletes that person's reactions. Beside it,
    `posts.reactions_updated_at`, nullable: when a message's reactions last
    changed, so a poll can send the message again. NULL means they never
    have.
3.  `chat_read_positions`: how far one person has read in one chat, as the
    read's own order - an instant and an id - and NOTHING ELSE. No time of
    when it moved, and no foreign key on the post: a held message is
    destroyed later and the place it marked stays good. `gathering_id` is a
    gathering's, or a group's container's. No delete rule: every path that
    ends a person's reading deletes the row itself
    (services/chat_reading.py).

NOTHING IS BACKFILLED: a chat nobody has opened is a first open, and a
message nobody has reacted to has no stamp.

THE DEPLOY'S WINDOW. The old instance serves while this runs. It reads and
writes `posts` by explicit columns, so the new one is never named; it writes
neither table, and its DELETE of a held message cascades into an empty one.

THE DOWNGRADE drops both tables, the column and the type, and counts what
went. Every message is kept.

DATA-HANDLING: a person, a message and which of seven signs they left on it,
with when; and the last item each person has read in each chat. No address,
no words, and nothing logged but counts.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0039'
down_revision: Union[str, Sequence[str], None] = '0038'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The same logger alembic's own "Running upgrade" lines use, so the counts
# land in the deploy log beside them at INFO (the 0023/0024/0028 pattern).
log = logging.getLogger("alembic.runtime.migration")

REACTION_KINDS = ('like', 'heart', 'laugh', 'surprise', 'sad', 'thumbs_up', 'celebrate')

# Created explicitly below (the 0016/0028 pattern), so the table's create
# never tries to create it a second time.
post_reaction_kind = postgresql.ENUM(*REACTION_KINDS, name='post_reaction_kind', create_type=False)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    post_reaction_kind.create(bind, checkfirst=True)
    op.create_table(
        'post_reactions',
        sa.Column('post_id', sa.Uuid(), nullable=False),
        sa.Column('person_id', sa.Uuid(), nullable=False),
        sa.Column('kind', post_reaction_kind, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['post_id'], ['posts.id'], name=op.f('fk_post_reactions_post_id'), ondelete='CASCADE'
        ),
        sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_post_reactions_person_id')),
        sa.PrimaryKeyConstraint('post_id', 'person_id', 'kind', name=op.f('pk_post_reactions')),
    )
    op.create_index(op.f('ix_post_reactions_person_id'), 'post_reactions', ['person_id'], unique=False)
    op.add_column('posts', sa.Column('reactions_updated_at', sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        'chat_read_positions',
        sa.Column('person_id', sa.Uuid(), nullable=False),
        sa.Column('gathering_id', sa.Uuid(), nullable=False),
        sa.Column('through_created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('through_post_id', sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(['person_id'], ['people.id'], name=op.f('fk_chat_read_positions_person_id')),
        sa.ForeignKeyConstraint(
            ['gathering_id'], ['gatherings.id'], name=op.f('fk_chat_read_positions_gathering_id')
        ),
        sa.PrimaryKeyConstraint('person_id', 'gathering_id', name=op.f('pk_chat_read_positions')),
    )
    # ASCII only: a Windows console under cp1252 raises on an em dash, and a
    # migration must not fail for a log line.
    log.info(
        "0039 made post_reactions and chat_read_positions, both empty: nothing backfilled; "
        "%d existing post(s) carry no reaction stamp",
        bind.execute(sa.text("SELECT count(*) FROM posts")).scalar_one(),
    )


def downgrade() -> None:
    """Downgrade schema - both tables, the column and the type go; every message stays."""
    bind = op.get_bind()
    reactions = bind.execute(sa.text("SELECT count(*) FROM post_reactions")).scalar_one()
    positions = bind.execute(sa.text("SELECT count(*) FROM chat_read_positions")).scalar_one()
    op.drop_table('chat_read_positions')
    op.drop_column('posts', 'reactions_updated_at')
    op.drop_index(op.f('ix_post_reactions_person_id'), table_name='post_reactions')
    op.drop_table('post_reactions')
    post_reaction_kind.drop(bind, checkfirst=True)
    log.info(
        "0039 downgrade dropped %d reaction(s) and %d reading position(s); every message kept",
        reactions,
        positions,
    )
