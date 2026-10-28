// Gathering API types and shared helpers (CK-17). Shapes mirror
// backend/app/api/gatherings.py's response bodies exactly — see
// reference/backend/api-reference.md, Gatherings router.
import { formatInstant } from './datetime'

export interface Occurrence {
  id: string
  gathering_id: string
  starts_at: string
  ends_at: string | null
  location: string | null
  map_url: string | null
}

export interface Gathering {
  id: string
  gathering_type: string
  title: string
  memorial_decedent_name: string | null
  // The publication gate (CK-41): `requires_approval` is the EFFECTIVE
  // value, resolved through the ladder — read by the Photos section to
  // know whether a ready photograph waits. `requires_approval_override` is
  // the host's own setting: true gates, false opens, null inherits — the
  // switch on the edit surface writes true and null (CK-44; false is the
  // API's third value, produced by nothing until a group default exists).
  requires_approval: boolean
  requires_approval_override: boolean | null
  // Who may read the occurrence RSVP lists (CK-27) — the gathering's
  // setting, written by an organiser (the host or, since CK-68, a co-host):
  // HOST_ONLY | INVITEES | ATTENDEES. Labels live in lib/rsvps.ts. NULL in
  // the photos-only view (CK-77's memory view): the RSVP setting is
  // logistics, withheld — never read as a value there (CK-80).
  rsvp_list_visibility: string | null
  publication_state: string
  created_by_account_id: string
  // The host's account (CK-28: the admin column renamed — the product says
  // host; a group has an admin, a gathering has a host). Null is the
  // claimable state. Since CK-69 it GATES NOTHING on the page: the caller's
  // role comes from `caller_role` below, and no surface decides a role by
  // comparing account ids (a co-host's account is not this one, and the
  // server would let them do most of what the host does).
  host_account_id: string | null
  // What the CALLER is to this gathering (CK-68, on every gathering body):
  // the host, a co-host, or neither — an invitee, a keeper, a former host.
  // The one source of the role on the surface (CK-69); read through
  // `roleFlags` below, never compared by hand, so anything unknown gates
  // closed in one place.
  caller_role: CallerRole
  // The group the gathering belongs to (CK-76, on every gathering body), or
  // null for a standalone gathering: its id and name, what every member
  // already reads on the group — never its keeper, its admin or its roster.
  group: GatheringGroup | null
  // What the CALLER GETS of this gathering (CK-77, on every gathering body):
  // `full` for the invited tier — the host, a co-host, an invitee — and
  // `memory` for a member only shared with a group's gathering, who gets the
  // photographs and nothing else. Read through `viewOf` below and nowhere
  // by hand (CK-80), so anything unknown shows less.
  caller_view: CallerView
  created_at: string
  updated_at: string | null
}

export type CallerRole = 'host' | 'co_host' | null

export type CallerView = 'full' | 'memory'

export interface GatheringGroup {
  id: string
  name: string
}

// The two flags every gated control reads (CK-69; the classification is
// CK-68's, one line per check in the api-reference's Co-hosts router):
// `isHost` for the RESERVED set — the review switch, the queue, publish and
// decline, the batch, deleting someone else's photograph permanently,
// making and removing co-hosts — and `organises` (the host OR a co-host)
// for the DELEGABLE set — editing the gathering and its dates, invitations,
// the full RSVP list, taking a published photograph down, the Removed view
// and putting back from it. Anything but the two known roles — null, a
// missing field, a value this build does not know — gates CLOSED: a
// control that cannot succeed teaches a person the product does something
// it does not, and the server would 404 it.
export interface RoleFlags {
  isHost: boolean
  organises: boolean
}

export function roleFlags(role: unknown): RoleFlags {
  const isHost = role === 'host'
  return { isHost, organises: isHost || role === 'co_host' }
}

// The one place the view is read (CK-80; CK-77's `caller_view`), in
// `roleFlags`' shape: `full` ONLY for exactly `'full'`; anything else —
// `'memory'`, null, a missing field, a value this build does not know — is
// the PHOTOS-ONLY view. This gates closed: an unknown view shows less, never
// the dates. No surface reads `caller_view` by hand, and in the photos-only
// view no surface reads `occurrences`, `rsvp_list_visibility`,
// `next_occurrence` or `occurrence_count` — the server sends them NULL, and
// withheld is not empty (the CK-30 precedent): rendering a NULL as `[]` or 0
// would claim a gathering with no dates.
export interface ViewFlags {
  full: boolean
  photosOnly: boolean
}

export function viewOf(view: unknown): ViewFlags {
  const full = view === 'full'
  return { full, photosOnly: !full }
}

// The detail body: the gathering plus its dates. `occurrences` is NULL in
// the photos-only view (CK-77) — the dates are logistics, withheld.
export interface GatheringWithOccurrences extends Gathering {
  occurrences: Occurrence[] | null
}

// A GET /gatherings item (CK-20): the gathering plus an occurrence summary.
// next_occurrence is the earliest occurrence at or after now, or — when every
// date has passed — the latest past one; the backend owns that rule (it is
// documented in the api-reference), so the list never re-derives it from
// per-gathering detail fetches. Null defensively in the full view (creation
// requires an occurrence and the last one is undeletable), and NULL — with
// `occurrence_count` — in the photos-only view, where the dates are
// withheld (CK-77). The same item shape rides `GET /groups/{id}/gatherings`.
export interface GatheringListItem extends Gathering {
  next_occurrence: { id: string; starts_at: string } | null
  occurrence_count: number | null
}

// The GatheringType values the API accepts, with their user-facing labels
// (vocabulary rule: these are the typed Gathering variants).
export const GATHERING_TYPES: { value: string; label: string }[] = [
  { value: 'potluck', label: 'Potluck' },
  { value: 'hosted', label: 'Hosted' },
  { value: 'hosted_with_help', label: 'Hosted, with help' },
  { value: 'simple', label: 'Simple' },
  { value: 'wedding', label: 'Wedding' },
  { value: 'season', label: 'Season' },
  { value: 'memorial', label: 'Memorial' },
  { value: 'church_gathering', label: 'Church gathering' },
]

export function gatheringTypeLabel(value: string): string {
  return GATHERING_TYPES.find((t) => t.value === value)?.label ?? value
}

// The photos-only view's two lines (CK-80): on a list item in place of the
// date, and beneath the header of the gathering's own page. Neither says
// why, names who chose, or promises anything: the person sees the
// photographs, and the dates and plans are for the people invited.
export const PHOTOS_ONLY_ITEM = 'You can see its photos'
export const PHOTOS_ONLY_LINE =
  "You can see this gathering's photos. Its dates and plans are for the people invited."

// The line under a list item's title (Your gatherings, and a group's own
// list): the type, then the next date under the backend's
// next-or-most-recent rule — or, in the photos-only view, PHOTOS_ONLY_ITEM
// and no date, because none was sent — then, where asked, the group's name.
export function listItemLine(item: GatheringListItem, zone: string, withGroup: boolean): string {
  const parts = [gatheringTypeLabel(item.gathering_type)]
  if (viewOf(item.caller_view).full) {
    if (item.next_occurrence) parts.push(formatInstant(item.next_occurrence.starts_at, zone))
  } else {
    parts.push(PHOTOS_ONLY_ITEM)
  }
  if (withGroup && item.group) parts.push(item.group.name)
  return parts.join(' · ')
}
