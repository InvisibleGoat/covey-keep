from enum import Enum

from app.models.base import db_enum


class AccountKind(str, Enum):
    PERSON = "PERSON"
    ORGANIZATION = "ORGANIZATION"


class GroupType(str, Enum):
    HOUSEHOLD = "HOUSEHOLD"
    CONGREGATION = "CONGREGATION"
    TEAM = "TEAM"
    CLUB = "CLUB"


class GatheringType(str, Enum):
    """The 0001 event types plus the keeper-model additions (CK-12): a season
    (kept whole, one-year cap), a memorial (decedent-gated, quota-exempt), and
    the church gathering (retreat/VBS/baptism — the keepable church object,
    distinct from a service, which is not a gathering at all)."""

    POTLUCK = "potluck"
    HOSTED = "hosted"
    HOSTED_WITH_HELP = "hosted_with_help"
    SIMPLE = "simple"
    WEDDING = "wedding"
    SEASON = "season"
    MEMORIAL = "memorial"
    CHURCH_GATHERING = "church_gathering"


class InvitationChannel(str, Enum):
    """How a pending invitation reaches its destination (CK-25). Channel-
    agnostic from the first row (launch-shape decision 2026-08-31: the primary
    invitation channel is a text message, not email — people have their
    friends' numbers, not their addresses). EMAIL is the only deliverable
    channel today; SMS is accepted by this enum and refused at the API
    boundary (blocked upstream by A2P registration, therefore by the name
    gate), so enabling it is a validator-and-delivery change, never a
    migration against live invitation rows."""

    EMAIL = "EMAIL"
    SMS = "SMS"


class RSVPResponse(str, Enum):
    YES = "yes"
    NO = "no"
    MAYBE = "maybe"


class RSVPListVisibility(str, Enum):
    """Who may read an occurrence's RSVP list (CK-27) — the host's first real
    per-gathering option, a value on the gathering in requires_approval's
    shape (never a capability-profile lookup at read time). HOST_ONLY: the
    admin alone. INVITEES: the CK-25 read audience (keeper, admin, or accepted
    invitee). ATTENDEES: those whose own response is yes. Two rules hold in
    every mode: the admin always sees the full list (a narrower setting must
    never show the host less than HOST_ONLY does), and the caller always sees
    their own RSVP (no one is locked out of their own answer)."""

    HOST_ONLY = "HOST_ONLY"
    INVITEES = "INVITEES"
    ATTENDEES = "ATTENDEES"


class MediaStatus(str, Enum):
    """The ingest job's ladder — the media row IS the job (media pipeline
    record §6.1; 0016 grew it from 0001's `processing | ready`). This is the
    MACHINE's answer and only that: publication_state is the host's, a
    separate column that never collapses into this one (record §5).

    pending_upload  a presigned PUT was issued; nothing confirmed yet.
    uploaded        the bytes are confirmed in quarantine; claimable.
    processing      claimed by the worker (claimed_at stamped; reclaimable
                    after the timeout — a re-claim, never a re-create).
    ready           the derivative rows exist and the quarantine original is
                    deleted — "processed", which is not "published".
    failed          the retry ladder is spent; last_error says why, and the
                    quarantine object was deleted at that moment.

    Member order mirrors the DB's enumsortorder (0016 placed the new labels
    around the 0001 pair with BEFORE clauses), so the ladder reads top to
    bottom in both places."""

    PENDING_UPLOAD = "pending_upload"
    UPLOADED = "uploaded"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class MediaLayer(str, Enum):
    """The three stored representations of one photograph
    (decisions/2026-08-25-media-derivative-layers.md §1), as the discriminator
    on media_derivatives (CK-32). Design-fixed, so a native enum (database-
    schema decision 2): a fourth layer is a decision record plus one
    ADD VALUE, never a value that grows as data."""

    ARCHIVAL = "archival"
    WEB = "web"
    THUMBNAIL = "thumbnail"


class PublicationState(str, Enum):
    PENDING = "pending"
    LIVE = "live"
    REMOVED = "removed"


# Single shared sa.Enum instance per Postgres type — several tables reference the
# same type, and duplicating instances would mean duplicate CREATE TYPE attempts.
ACCOUNT_KIND = db_enum(AccountKind, "account_kind")
GROUP_TYPE = db_enum(GroupType, "group_type")
GATHERING_TYPE = db_enum(GatheringType, "gathering_type")
INVITATION_CHANNEL = db_enum(InvitationChannel, "invitation_channel")
RSVP_RESPONSE = db_enum(RSVPResponse, "rsvp_response")
RSVP_LIST_VISIBILITY = db_enum(RSVPListVisibility, "rsvp_list_visibility")
MEDIA_STATUS = db_enum(MediaStatus, "media_status")
MEDIA_LAYER = db_enum(MediaLayer, "media_layer")
PUBLICATION_STATE = db_enum(PublicationState, "publication_state")
