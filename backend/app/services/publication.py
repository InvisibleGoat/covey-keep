"""Publication — does a photograph wait for the host? The gate, resolved
through a ladder (CK-41; decisions/2026-09-09-consent-gate-defaults.md
2.0.0, §1).

No database, no network, no logging — the processing.py mould: this module
takes facts and returns an answer, and the three callers read the facts and
apply the answer. The worker's publish transaction (services/ingest.py,
step 4) applies it to `media.publication_state` — `ready → live` where the
gathering resolves open, `ready` and still `pending` where it resolves
gated; the restore (api/media.py::_gate_destination) applies it the same
way to a photograph put back by someone other than the host. The
gatherings router applies it to every gathering body, so
`requires_approval` there is the EFFECTIVE value and no consumer ever
handles a null.

THE ANSWER IS COMPUTED WHEN IT IS NEEDED, NEVER FROZEN. Not at create (the
create path writes nothing to the column), not at intent (nothing is
snapshotted onto the media row): a host who turns review on between an
upload and its processing gets a photograph that waits, and a group whose
default changes reaches every gathering under it. A snapshot on the media
row would be a second representation of the gate — the defect class
database-schema decision 20 and the media_tags.gathering_id rule both
exist to prevent — and this module returning only a boolean would make
CK-44 re-derive the ladder to say what the host is overriding, which is
why every answer names its SOURCE.

THE LADDER — readable as a list (see `resolve`): the first rung with an
answer wins, and a rung with no producer answers None and is passed over.

  1. HOST          The gathering's own setting — `gatherings.requires_approval`,
                   nullable since 0019, NULL meaning "nobody has decided".
                   The host's explicit choice, and it outranks everything
                   beneath it, the backstop included: the admin owns the
                   switch and we never do (record §5). Producer: CK-44's
                   override surface. Nothing writes it until then.

  2. GROUP         The home group's default — ONE group, the belongs-to
                   link (decisions/2026-09-02-groups-as-homes.md §3), never
                   the invited groups, of which there may be many. This is
                   the discriminator the record's §1 was reaching for with
                   the account kind and the SEASON type: the group is the
                   only thing that can tell a team's season from a family's.
                   ALWAYS None TODAY — since CK-76 a gathering CAN have a
                   home group (`gatherings.owning_group_id`, written at
                   create), but the `groups` column that will carry the
                   group's OWN default is still deliberately not added: a
                   column with no producer and no reach smuggles a feature
                   in as a schema detail (the media_tags.person_id
                   argument, applied to a different table). Producer: the
                   TEAM / CONGREGATION types, with a per-group override
                   column.

     BACKSTOP      An ORGANIZATION host with no group default → gated.
                   Belt and braces on the one case where the stakes are
                   children's photographs (record §9: org-owned gatherings
                   stay gated by default — where the children of people who
                   did not choose this product actually are). NOT the
                   primary discriminator: it stopped being that when §1 was
                   amended (a youth team run by a parent is person-hosted,
                   and this rung cannot see it — the group can). It costs
                   nothing today (no org account can exist) and contradicts
                   nothing later (a church's gatherings will also sit in a
                   church group saying the same). It sits BENEATH the two
                   rungs a person sets — the host's choice and the group's
                   default outrank it — and ABOVE the two that are defaults
                   of ours: a person's decision beats the backstop; our
                   templates and shapes do not.

  3. TEMPLATE      The gathering type's template —
                   `capability_profiles.requires_approval`, which already
                   exists (0001, keyed by group type, seeded
                   ('HOUSEHOLD', 'household-default', false)). This is what
                   record §10.1 meant by "read through the capability
                   profile": it was right about this rung and mistaken only
                   in scope — the profile is group-type-keyed and reachable
                   only through a home group, so it answers "what does this
                   kind of group usually do", not "does this gathering
                   wait". Rung 3 of four, not the whole rule. REACHED SINCE
                   CK-76 through the home group: the three callers read
                   `capability_profiles.requires_approval` through
                   `groups.capability_profile_id` as an outer join in the
                   statement each already runs, and hand it to
                   `resolve_gathering` as `template_default` — None for a
                   groupless gathering (the rung passed over, as before),
                   `false` for a household group's gathering, which
                   therefore resolves OPEN with source TEMPLATE: the same
                   answer a groupless gathering gets at rung 4, from one
                   rung higher. Producer of a `true`: the templates work,
                   which adds TEAM / CONGREGATION rows carrying it.

  4. JOIN_SHAPE    How a person gets in — the only rung with a producer.
                   PRIVATE (a specific invitation, or membership of an
                   invited group) → open: the people in the gathering
                   invited each other, and publication does not wait.
                   PUBLIC (a link anyone can use to join) → gated. PUBLIC
                   has no producer anywhere in the schema; its producer will
                   be the share link ("share this gathering" is the thing
                   that makes a gathering public). The member exists now
                   because the rule has two halves and a half-written rule
                   is worse than a late one.

Every gathering in the database is privately joined and person-hosted (or
hostless); a groupless one resolves OPEN at rung 4, and since CK-76 a
gathering in a household group resolves OPEN at rung 3 — so every one
resolves open, and `live`, a state no media row had ever held before 0019,
is reachable.

What "open" means, and does not (record §6, §9): open means `ready → live`
on processing completion. It does not mean reviewed. A gathering that
resolves open is UNREVIEWED, and no copy anywhere may describe it as safe,
screened, reviewed, or consent-verified. `publication_state` still exists
on every gathering of every type; `live` is a state a takedown moves out of
exactly as `pending` was. The removal and revocation chain is untouched.

DATA-HANDLING: this module names no person and reads no row. Its one
effect is to widen who may see a photograph from the uploader and the host
to the gathering's read audience, where the gathering resolves open — the
deliberate act of the decision it implements (record §9).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from app.models.enums import AccountKind


class JoinShape(str, Enum):
    """How a person gets into the gathering — rung 4's fact."""

    # A specific invitation (CK-25's person-targeted rows), or membership
    # of an invited group. Every gathering today.
    PRIVATE = "private"
    # A link anyone can use to join. No producer anywhere in the schema;
    # the share link will be its producer (record 2.0.0, §8).
    PUBLIC = "public"


class Source(str, Enum):
    """Which rung answered. Returned with every resolution so CK-44's
    accuracy statement (record §5) can say what the host is overriding
    without re-deriving the ladder."""

    HOST = "HOST"
    GROUP = "GROUP"
    TEMPLATE = "TEMPLATE"
    JOIN_SHAPE = "JOIN_SHAPE"
    ORG_BACKSTOP = "ORG_BACKSTOP"


@dataclass(frozen=True)
class Resolution:
    # True: publication waits for the host (`ready` stays `pending` until
    # the host says so). False: `ready → live` on processing completion.
    requires_approval: bool
    source: Source


def resolve(
    *,
    host_setting: Optional[bool],
    group_default: Optional[bool],
    template_default: Optional[bool],
    join_shape: JoinShape,
    host_kind: Optional[AccountKind],
) -> Resolution:
    """The ladder, as a list. The first rung with an answer wins; a rung
    that answers None (no producer yet, or nobody decided) is passed over.

    host_setting     rung 1 — gatherings.requires_approval (NULL = inherit)
    group_default    rung 2 — the home group's default (always None today)
    template_default rung 3 — the type's template via the home group
                     (always None today)
    join_shape       rung 4 — PRIVATE opens, PUBLIC gates (the only rung
                     with a producer; PRIVATE everywhere today)
    host_kind        the backstop's fact — the host account's kind, None
                     for a hostless (claimable) gathering, which the
                     backstop does not fire on (there is no organisation
                     accountable for it; the join shape answers, as it does
                     for a person's gathering — the claim flow's question,
                     not this module's)
    """
    rungs: tuple[tuple[Source, Optional[bool]], ...] = (
        (Source.HOST, host_setting),
        (Source.GROUP, group_default),
        # The backstop: beneath the rungs a person sets, above ours.
        (Source.ORG_BACKSTOP, True if host_kind == AccountKind.ORGANIZATION else None),
        (Source.TEMPLATE, template_default),
        (Source.JOIN_SHAPE, join_shape == JoinShape.PUBLIC),
    )
    for source, answer in rungs:
        if answer is not None:
            return Resolution(requires_approval=answer, source=source)
    raise AssertionError("the join shape always answers")  # pragma: no cover


def resolve_gathering(
    *,
    host_setting: Optional[bool],
    host_kind: Optional[AccountKind],
    template_default: Optional[bool],
) -> Resolution:
    """The ladder applied to a gathering as gatherings exist today: privately
    joined (no public join mechanism exists — record §7), with the home
    group's TEMPLATE reachable since CK-76 and the home group's own DEFAULT
    still not. The three callers — the worker's publish transaction
    (services/ingest.py step 4), the restore's gate read
    (api/media.py::_gate_destination) and the gatherings router's bodies —
    go through here, so the home group was wired in ONE place: this
    function grew `template_default`, and `resolve` did not change.

    template_default  rung 3 — the home group's type's template,
                      `capability_profiles.requires_approval` read through
                      `groups.capability_profile_id` (CK-76); None for a
                      groupless gathering, so the rung is passed over
                      exactly as before. The household template is
                      `false`, so a group gathering resolves OPEN with
                      source TEMPLATE where a groupless one resolves open at
                      JOIN_SHAPE: the answer does not change, only the rung
                      that gave it. REQUIRED, not defaulted, so a fourth
                      caller cannot forget the group (a caller that cannot
                      know it passes None and says so).
    Rung 2 — the group's OWN default — stays None: no `groups` column
    exists for it, and it arrives with the TEAM / CONGREGATION types
    (record §8's closing condition).
    """
    return resolve(
        host_setting=host_setting,
        group_default=None,
        template_default=template_default,
        join_shape=JoinShape.PRIVATE,
        host_kind=host_kind,
    )
