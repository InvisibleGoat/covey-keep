from enum import Enum

from app.models.base import db_enum


class GroupType(str, Enum):
    HOUSEHOLD = "HOUSEHOLD"
    CONGREGATION = "CONGREGATION"
    TEAM = "TEAM"
    CLUB = "CLUB"


class EventType(str, Enum):
    POTLUCK = "potluck"
    HOSTED = "hosted"
    HOSTED_WITH_HELP = "hosted_with_help"
    SIMPLE = "simple"
    WEDDING = "wedding"


class RSVPResponse(str, Enum):
    YES = "yes"
    NO = "no"
    MAYBE = "maybe"


class MediaStatus(str, Enum):
    PROCESSING = "processing"
    READY = "ready"


class PublicationState(str, Enum):
    PENDING = "pending"
    LIVE = "live"
    REMOVED = "removed"


# Single shared sa.Enum instance per Postgres type — several tables reference the
# same type, and duplicating instances would mean duplicate CREATE TYPE attempts.
GROUP_TYPE = db_enum(GroupType, "group_type")
EVENT_TYPE = db_enum(EventType, "event_type")
RSVP_RESPONSE = db_enum(RSVPResponse, "rsvp_response")
MEDIA_STATUS = db_enum(MediaStatus, "media_status")
PUBLICATION_STATE = db_enum(PublicationState, "publication_state")
