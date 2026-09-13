"""CK-41 — the publication gate: one ladder, four rungs, one backstop
(app/services/publication.py; decisions/2026-09-09-consent-gate-defaults.md
2.0.0 §1). Pure — no database, no client; the resolver takes facts and
returns an answer with the rung that gave it.

The load-bearing pins:
- every rung, in order: a host setting beats a group default beats a
  template beats the join shape, and each answer names its own source;
- the backstop: an ORGANIZATION host with no group default gates, whatever
  the join shape — and a group default of False beats it (the rung above
  it answered), as does the host's own False (the admin owns the switch);
- PUBLIC gates a person-hosted groupless gathering; PRIVATE opens it;
- a SEASON created by a person, groupless and private, resolves OPEN — the
  deliberate reversal of record 1.0.0 §1 factor 3;
- a hostless gathering resolves through the join shape, not the backstop.
"""

import pytest

from app.models import Gathering, GatheringType, PublicationState
from app.models.enums import AccountKind
from app.services.publication import JoinShape, Resolution, Source, resolve, resolve_gathering

PERSON = AccountKind.PERSON
ORG = AccountKind.ORGANIZATION


def _resolve(**overrides) -> Resolution:
    """Today's facts unless overridden: no host setting, no group, no
    template, privately joined, person-hosted."""
    facts = dict(
        host_setting=None,
        group_default=None,
        template_default=None,
        join_shape=JoinShape.PRIVATE,
        host_kind=PERSON,
    )
    facts.update(overrides)
    return resolve(**facts)


# --- every rung, in order -------------------------------------------------------


def test_the_rungs_answer_in_order_and_each_names_its_source():
    # Everything set, every rung disagreeing with the one beneath it: the
    # host wins, then the group, then the template, then the join shape.
    everything = dict(
        host_setting=True,
        group_default=False,
        template_default=True,
        join_shape=JoinShape.PUBLIC,  # would gate on its own
    )
    assert _resolve(**everything) == Resolution(True, Source.HOST)

    del everything["host_setting"]
    assert _resolve(**everything) == Resolution(False, Source.GROUP)

    del everything["group_default"]
    assert _resolve(**everything) == Resolution(True, Source.TEMPLATE)

    del everything["template_default"]
    assert _resolve(**everything) == Resolution(True, Source.JOIN_SHAPE)

    # And the same order with the polarity flipped — a rung's answer is its
    # own, never "the first True".
    assert _resolve(host_setting=False, group_default=True) == Resolution(False, Source.HOST)
    assert _resolve(group_default=True, template_default=False) == Resolution(True, Source.GROUP)
    assert _resolve(template_default=False, join_shape=JoinShape.PUBLIC) == Resolution(
        False, Source.TEMPLATE
    )


def test_a_rung_with_no_answer_is_passed_over_never_read_as_false():
    # None is "no producer / nobody decided", not an answer of open.
    assert _resolve(join_shape=JoinShape.PUBLIC) == Resolution(True, Source.JOIN_SHAPE)


# --- the backstop -----------------------------------------------------------------


@pytest.mark.parametrize("join_shape", list(JoinShape))
def test_an_organization_host_with_no_group_default_is_gated_whatever_the_join_shape(join_shape):
    # Belt and braces on the one case where the stakes are children's
    # photographs (record §9): with nobody having decided, an org-hosted
    # gathering waits — privately joined or not.
    assert _resolve(host_kind=ORG, join_shape=join_shape) == Resolution(True, Source.ORG_BACKSTOP)


def test_a_group_default_of_false_beats_the_backstop():
    # The rung above it answered: a church group that has said its
    # gatherings do not wait is a decision a person made, and the backstop
    # sits beneath the rungs a person sets.
    assert _resolve(host_kind=ORG, group_default=False) == Resolution(False, Source.GROUP)
    # And a template of False does NOT — templates are ours, not theirs.
    assert _resolve(host_kind=ORG, template_default=False) == Resolution(True, Source.ORG_BACKSTOP)


def test_the_hosts_own_setting_beats_the_backstop_in_both_directions():
    # The admin owns the switch, and we never do (record §5): an org host
    # who turns review off is obeyed, and one who turns it on gets HOST as
    # the source, not the backstop.
    assert _resolve(host_kind=ORG, host_setting=False) == Resolution(False, Source.HOST)
    assert _resolve(host_kind=ORG, host_setting=True) == Resolution(True, Source.HOST)


# --- the join shape, the only rung with a producer -----------------------------


def test_public_gates_and_private_opens_a_person_hosted_groupless_gathering():
    assert _resolve(join_shape=JoinShape.PUBLIC) == Resolution(True, Source.JOIN_SHAPE)
    assert _resolve(join_shape=JoinShape.PRIVATE) == Resolution(False, Source.JOIN_SHAPE)


def test_a_hostless_gathering_resolves_through_the_join_shape():
    # No organisation stands behind a claimable gathering, so the backstop
    # does not fire; whether a keeper may upload into one is the claim
    # flow's question (CK-34 refuses it today), not the ladder's.
    assert _resolve(host_kind=None) == Resolution(False, Source.JOIN_SHAPE)
    assert _resolve(host_kind=None, join_shape=JoinShape.PUBLIC) == Resolution(
        True, Source.JOIN_SHAPE
    )


# --- today's gatherings, through the one wiring point ---------------------------


def test_a_season_created_by_a_person_groupless_and_private_resolves_open():
    """THE DELIBERATE REVERSAL of consent-gate defaults 1.0.0 §1 factor 3
    ("a SEASON waits regardless"), amended to 2.0.0 on 2026-09-13: the
    type was standing in for the group, and the group is what tells a
    team's season from a family's. A family that creates a season inherits
    their family group's open default; a team's season inherits the team
    group's gated one — and until rung 2 exists, a person's groupless
    private season resolves OPEN at the join shape like every other
    gathering. Do not "fix" this back by reading the type: the record's §8
    closes the SEASON item with the forward requirement that no TEAM or
    CONGREGATION group, and no gathering under one, ships before rung 2."""
    season = Gathering(
        gathering_type=GatheringType.SEASON,
        title="Bowling 2026-27",
        publication_state=PublicationState.LIVE,
    )
    assert season.requires_approval is None  # create writes nothing here
    assert resolve_gathering(host_setting=season.requires_approval, host_kind=PERSON) == Resolution(
        False, Source.JOIN_SHAPE
    )


def test_resolve_gathering_is_todays_facts_no_group_no_template_private():
    # Every gathering in the database today: groupless, privately joined —
    # so a person's resolves open at rung 4, an organisation's gates at the
    # backstop, and a host's own setting wins over either.
    assert resolve_gathering(host_setting=None, host_kind=PERSON) == Resolution(
        False, Source.JOIN_SHAPE
    )
    assert resolve_gathering(host_setting=None, host_kind=ORG) == Resolution(
        True, Source.ORG_BACKSTOP
    )
    assert resolve_gathering(host_setting=True, host_kind=PERSON) == Resolution(True, Source.HOST)
    assert resolve_gathering(host_setting=False, host_kind=ORG) == Resolution(False, Source.HOST)
    assert resolve_gathering(host_setting=None, host_kind=None) == Resolution(
        False, Source.JOIN_SHAPE
    )
