"""rsvps follow their occurrence: ON DELETE CASCADE on rsvps.occurrence_id

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-06

Phase CK-30 — a date that can be removed. Since CK-27 gave rsvps rows a way
to exist, DELETE /occurrences/{id} has 500'd on any date somebody answered:
delete_occurrence did a bare db.delete(occurrence) and this FK carried no
ondelete, so the constraint raised an IntegrityError that surfaced as an
unhandled 500 — live and reachable through CK-18's per-date remove control.

An RSVP to a date cannot outlive the date, and the schema should say so
rather than leaving a handler to remember it: the FK gains ON DELETE CASCADE,
matching rsvp_companions' shape (0014). Companions then cascade transitively
(rsvps -> rsvp_companions already cascades), so a deleted occurrence takes
the answers and the names declared on them together. Whether the delete is
ALLOWED to destroy answers is the endpoint's decision (refuse once with a
count, then obey a confirmed request — CK-30's other half); the cascade only
makes the confirmed path leave nothing dangling.

Deliberately NOT touched: the other FKs pointing at occurrences
(attendance_records, item_slots, item_claims NOT NULL; posts, media
nullable — all without ondelete). None has a surface yet, and the right
behaviour for each is a separate question: a photo attached to a removed
date may well deserve to survive it, unlike an RSVP to it. Enumerated and
recorded as known latent issues in reference/backend/database-schema.md.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0015'
down_revision: Union[str, Sequence[str], None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # A delete rule cannot be altered in place — the constraint is dropped and
    # re-created under the same conventional name (fk_%(table)s_%(column)s),
    # so the DB stays in step with the metadata naming convention.
    op.drop_constraint('fk_rsvps_occurrence_id', 'rsvps', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_rsvps_occurrence_id'),
        'rsvps',
        'occurrences',
        ['occurrence_id'],
        ['id'],
        ondelete='CASCADE',
    )


def downgrade() -> None:
    """Downgrade schema — genuinely restores 0014's shape: the same FK, no
    delete rule (NO ACTION), same name."""
    op.drop_constraint('fk_rsvps_occurrence_id', 'rsvps', type_='foreignkey')
    op.create_foreign_key(
        op.f('fk_rsvps_occurrence_id'),
        'rsvps',
        'occurrences',
        ['occurrence_id'],
        ['id'],
    )
