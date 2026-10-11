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

    AND THE DESTRUCTION LADDER (CK-54, migration 0025) — a SECOND job on the
    same row, entered from `ready` and from nowhere else, because only a
    `ready` row has layers to destroy:

    destroying      the bytes are owed a deletion and the photograph is
                    already uncounted: the marking statement moved the row
                    off `ready` and decremented the gathering's
                    `photo_count` and `total_bytes` together. Claimable and
                    retryable — it mirrors `processing`, with `claimed_at`
                    NULL meaning "marked, never claimed" rather than
                    malformed (there is no queued rung before it; the API
                    marks straight here). A row that exhausts the retry
                    ladder STAYS here with `last_error` set: it is not
                    charged, its bytes may still exist, and `failed` would
                    be a lie about which job failed — and would make the
                    row visible again (see below).
    destroyed       terminal: the three published objects are gone and the
                    `media_derivatives` rows with them. The `media` row
                    survives carrying its provenance AND its words — the
                    filename, the caption, the tags (the bin record §7.2:
                    a caption is not a likeness, and *a photograph captioned
                    "Jenny at bat" was deleted* is an audit trail where
                    *something was deleted* is not).

    NEITHER DESTRUCTION RUNG IS VISIBLE TO ANYBODY. `api/media.py::
    _visible_media` excludes both, which is what makes §7.2's requirement —
    the surviving words unreachable by any list, search or surface — a
    property of the one audience criterion rather than a rule every reader
    must remember. Nothing counts them either: they are outside
    `keeping.IN_FLIGHT_STATUSES` and are not `ready`, so a row in
    destruction charges nobody and sits in no bin count.

    Member order mirrors the DB's enumsortorder (0016 placed the new labels
    around the 0001 pair with BEFORE clauses; 0025 appends these two after
    `failed`), so the ladder reads top to bottom in both places."""

    PENDING_UPLOAD = "pending_upload"
    UPLOADED = "uploaded"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"
    DESTROYING = "destroying"
    DESTROYED = "destroyed"


class MediaFailureReason(str, Enum):
    """WHY a photograph could not be kept — for the PERSON (CK-71, migration
    0028; pipeline record §6.5: failure belongs to the uploader). Written by
    the worker at the dead-letter BESIDE `last_error` and NEVER derived from
    it at runtime: `last_error` is the operator's text and rides no body;
    this is the person's value and rides every media body, which is safe
    because none of its four values names the file's contents. Each names
    what the uploader can DO, never what went wrong inside:

    too_large          the pixel guard refused it (processing.MAX_PIXELS,
                       ~50 megapixels — a phone panorama). A smaller copy
                       will work.
    unreadable         every other Undecodable — not an image, an
                       unsupported format, truncated, corrupt. No copy of
                       this file will work.
    upload_incomplete  the quarantine object was missing when the worker
                       ran — the upload never completed, or the 24-hour
                       rule took it first. Uploading again works.
    interrupted        the transient ladder was spent (the store did not
                       answer three times), or the worker was interrupted
                       mid-job on three claims. Uploading again works.

    SET IF AND ONLY IF THE ROW IS `failed` (verifier-asserted): every path
    that writes `failed` writes one of these in the SAME guarded statement,
    `failed` is terminal so nothing ever clears one, and a `ready` row never
    carries one. The Undecodable exception carries its kind from the branch
    that raised it (processing.py); the other dead-letter paths know their
    own. Design-fixed, so a native enum (database-schema decision 2): a
    fifth value is a decision record, never a catch-all."""

    TOO_LARGE = "too_large"
    UNREADABLE = "unreadable"
    UPLOAD_INCOMPLETE = "upload_incomplete"
    INTERRUPTED = "interrupted"


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


class BillingProvider(str, Enum):
    """Which payment provider a billing row belongs to (CK-73, migration
    0029; paid-tiers record §4). `stripe` is the only value today: the
    rows name their provider so that a plan bought through a store later is
    another row with another provider, read by the same allowance rule —
    and nothing in the quota path may name a provider. A second value is a
    decision record plus one ADD VALUE, one migration earlier than any
    migration that writes it (the CK-32 trap)."""

    STRIPE = "stripe"


class BillingPlan(str, Enum):
    """What is sold (paid-tiers record §3): a plan is NAMED BY WHAT IT HOLDS
    — 100,000 photographs, 300,000 photographs — never "Plus" or "Pro", and
    the number each grants lives in services/keeping.py::PLAN_PHOTOGRAPHS,
    derived at read time and never stored (record §6). A subscription's
    plan is read from its price's LOOKUP KEY, never the price's id.
    Design-fixed, so a native enum (database-schema decision 2): a third
    plan is a decision record (keeper v2 §15.7's trigger), never a value
    that grows as data."""

    PHOTOS_100K = "photos_100k"
    PHOTOS_300K = "photos_300k"


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
MEDIA_FAILURE_REASON = db_enum(MediaFailureReason, "media_failure_reason")
PUBLICATION_STATE = db_enum(PublicationState, "publication_state")
BILLING_PROVIDER = db_enum(BillingProvider, "billing_provider")
BILLING_PLAN = db_enum(BillingPlan, "billing_plan")
