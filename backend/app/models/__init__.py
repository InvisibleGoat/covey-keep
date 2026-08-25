"""Phase 1 spine models (keeper spine since CK-12). Importing this package
registers every table on Base.metadata (alembic autogenerate depends on that)."""

from app.models.account import Account
from app.models.attendance import AttendanceRecord
from app.models.auth import (
    EmailChangeRequest,
    MagicLinkToken,
    Session,
    TosAcceptance,
    WebauthnChallenge,
    WebauthnCredential,
)
from app.models.base import Base
from app.models.capability import CapabilityProfile, Role, RoleLadder
from app.models.consent import ConsentRecord
from app.models.enums import (
    AccountKind,
    GatheringType,
    GroupType,
    MediaStatus,
    PublicationState,
    RSVPResponse,
)
from app.models.gathering import Gathering, GatheringInvitation, Occurrence
from app.models.group import Group, SubGroup
from app.models.household import Household, Person
from app.models.items import ItemClaim, ItemSlot
from app.models.media import Media
from app.models.membership import Membership
from app.models.next_step import NextStepAcceptance, NextStepDismissal, NextStepTrigger
from app.models.organization import Organization
from app.models.post import Post
from app.models.rsvp import RSVP

__all__ = [
    "Account",
    "AccountKind",
    "AttendanceRecord",
    "Base",
    "CapabilityProfile",
    "ConsentRecord",
    "EmailChangeRequest",
    "Gathering",
    "GatheringInvitation",
    "GatheringType",
    "Group",
    "GroupType",
    "Household",
    "ItemClaim",
    "ItemSlot",
    "MagicLinkToken",
    "Media",
    "MediaStatus",
    "Membership",
    "NextStepAcceptance",
    "NextStepDismissal",
    "NextStepTrigger",
    "Occurrence",
    "Organization",
    "Person",
    "Post",
    "PublicationState",
    "RSVP",
    "RSVPResponse",
    "Role",
    "RoleLadder",
    "Session",
    "SubGroup",
    "TosAcceptance",
    "WebauthnChallenge",
    "WebauthnCredential",
]
