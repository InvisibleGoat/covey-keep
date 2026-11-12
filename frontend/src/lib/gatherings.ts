// Gathering API types and shared helpers (CK-17). Shapes mirror
// backend/app/api/gatherings.py's response bodies exactly — see
// reference/backend/api-reference.md, Gatherings router.
import type { CoverBody } from './covers'
import type { OutsideInvitationsBody } from './outsideInvitations'
import { formatDayWithYear, formatTime, formatWeekdayDay } from './datetime'
import { photoCountLabel } from './media'

export interface Occurrence {
  id: string
  gathering_id: string
  starts_at: string
  ends_at: string | null
  location: string | null
  map_url: string | null
  // The caller's OWN answer on this date (CK-87), on every occurrence a
  // gathering body carries — the create body and the detail: `yes`, `maybe`,
  // `no`, or null where they have not answered. The page's answer chip reads
  // it (labels in lib/rsvps.ts). Optional because the occurrence routes' own
  // bodies carry none — the page re-reads the gathering after every date act
  // — and because the photos-only view carries no occurrences at all, so the
  // field is never read there (the CK-80 Gotcha).
  caller_response?: string | null
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
  // The cover (CK-83a/CK-83b, on every gathering body, list items and the
  // memory view included): one of the gathering's published photographs —
  // named by `media_id` — or an uploaded picture, with `set_at` its version;
  // null until an organiser sets one. Optional: a body without it reads as
  // none and draws the empty cover (lib/covers.ts, CK-84).
  cover?: CoverBody | null
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
//
// On a group's gathering the body also carries the outside-invitation
// setting (CK-92) — `outside_invitations` (`{on, since, by, may_change}`),
// `caller_in_group` and `outside_alert` — each null on a standalone
// gathering. Optional and read through lib/outsideInvitations.ts's
// `outsideFlags` alone (CK-93), so a body without them renders nothing new.
export interface GatheringWithOccurrences extends Gathering {
  occurrences: Occurrence[] | null
  outside_invitations?: OutsideInvitationsBody | null
  caller_in_group?: boolean | null
  outside_alert?: boolean | null
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

// --- Your gatherings in the mockup's layout (CK-85) ---------------------------

// The instant an item's date names — its next date under the backend's
// next-or-most-recent rule — in the FULL view alone. The photos-only view
// carries no date, so nothing is read there (withheld is not empty).
function nextStart(item: GatheringListItem): number | null {
  if (!viewOf(item.caller_view).full || item.next_occurrence === null) return null
  const at = Date.parse(item.next_occurrence.starts_at)
  return Number.isFinite(at) ? at : null
}

// THE ONE RULE FOR "COMING UP" (CK-85): a full-view item whose next date
// starts at or after `now`. The backend's `next_occurrence` is the earliest
// date at or after now, or the latest past one when every date has passed,
// so a date before `now` means nothing is still to come — and a date that
// has started and not yet ended reads as past by the same rule. The menu's
// *Gatherings coming up* and the page's *Coming up* both come from
// `gatheringSections` below, so the two can never disagree.
export function isComingUp(item: GatheringListItem, now: number): boolean {
  const at = nextStart(item)
  return at !== null && at >= now
}

export interface GatheringSections {
  // Soonest first: the first is the page's featured card.
  comingUp: GatheringListItem[]
  // Most recent first. A full-view item with no date — the backend never
  // sends one (creation needs a date and the last is undeletable) — goes
  // last rather than vanishing from the page.
  past: GatheringListItem[]
  // The photos-only view, in the server's order: no date to sort by, and
  // nothing may claim these are over.
  photosOnly: GatheringListItem[]
}

// Your gatherings' three sections, from the one list read. Each sort is
// stable, so equal dates keep the server's order.
export function gatheringSections(items: GatheringListItem[], now: number): GatheringSections {
  const comingUp: { item: GatheringListItem; at: number }[] = []
  const past: { item: GatheringListItem; at: number | null }[] = []
  const photosOnly: GatheringListItem[] = []
  for (const item of items) {
    if (viewOf(item.caller_view).photosOnly) {
      photosOnly.push(item)
      continue
    }
    const at = nextStart(item)
    if (at !== null && isComingUp(item, now)) comingUp.push({ item, at })
    else past.push({ item, at })
  }
  comingUp.sort((a, b) => a.at - b.at)
  past.sort((a, b) => (a.at === null ? (b.at === null ? 0 : 1) : b.at === null ? -1 : b.at - a.at))
  return {
    comingUp: comingUp.map(({ item }) => item),
    past: past.map(({ item }) => item),
    photosOnly,
  }
}

// The mockup's word for a gathering that belongs to no group.
export const NOT_IN_A_GROUP = 'Not in a group'

// A card's first line: the group — or *Not in a group* — and the type.
export function cardPlaceLine(item: GatheringListItem): string {
  return `${item.group ? item.group.name : NOT_IN_A_GROUP} · ${gatheringTypeLabel(item.gathering_type)}`
}

// A card's line in its pieces (CK-87): each date — *Thu, Dec 24*, *Oct 3,
// 2026* — and each time — *6:30 PM* — is a piece the card keeps whole on
// screen (`keep`), so a narrow card never breaks inside one (*3 dates · next
// Thu, Dec* / *24* in CK-86's screenshot); the line may still break between
// its pieces, at *·* or before *next*. The text is the pieces joined, with
// no character replaced, so every line reads exactly as it did.
export interface LinePiece {
  text: string
  keep: boolean
}

export function lineText(pieces: LinePiece[]): string {
  return pieces.map((piece) => piece.text).join('')
}

const kept = (text: string): LinePiece => ({ text, keep: true })
const loose = (text: string): LinePiece => ({ text, keep: false })

// A section's count line on a group's page (CK-88.1b): how many photos, and —
// on a full-view gathering that is not coming up and has a date — the day with
// its year, kept whole. A date in progress reads as past (the one rule); nothing
// reads `next_occurrence` on a photos-only item. Against the same `now` as the
// strip, so the two agree.
export function sectionCountPieces(item: GatheringListItem, count: number, zone: string, now: number): LinePiece[] {
  const photos = photoCountLabel(count)
  if (!viewOf(item.caller_view).full || item.next_occurrence === null || isComingUp(item, now)) return [loose(photos)]
  return [loose(`${photos} · `), kept(formatDayWithYear(item.next_occurrence.starts_at, zone))]
}

// A card's second line, every date and time in `zone`: a coming-up item with
// more than one date — *4 dates · next Thu, Oct 15* — or with one — *Thu,
// Oct 15 · 6:30 PM*; a past item its day with the year — *Oct 3, 2026*; a
// photos-only item PHOTOS_ONLY_ITEM and no date, because none was sent. The
// same `now` as the sections, so a card's line and its section agree.
export function cardDatePieces(item: GatheringListItem, zone: string, now: number): LinePiece[] | null {
  if (viewOf(item.caller_view).photosOnly) return [loose(PHOTOS_ONLY_ITEM)]
  if (item.next_occurrence === null) return null
  const startsAt = item.next_occurrence.starts_at
  if (!isComingUp(item, now)) return [kept(formatDayWithYear(startsAt, zone))]
  const day = formatWeekdayDay(startsAt, zone)
  const count = item.occurrence_count ?? 1
  return count > 1
    ? [loose(`${count} dates · next `), kept(day)]
    : [kept(day), loose(' · '), kept(formatTime(startsAt, zone))]
}

export function cardDateLine(item: GatheringListItem, zone: string, now: number): string | null {
  const pieces = cardDatePieces(item, zone, now)
  return pieces === null ? null : lineText(pieces)
}

// The featured card's one line: the group, the type, the next date's day
// and its time — *The Lees · Potluck · Thu, Oct 15 · 6:30 PM*, the day and
// the time each kept whole. Only a coming-up item is featured, so it always
// has its date.
export function featuredPieces(item: GatheringListItem, zone: string): LinePiece[] {
  const pieces = [loose(cardPlaceLine(item))]
  if (item.next_occurrence) {
    pieces.push(loose(' · '), kept(formatWeekdayDay(item.next_occurrence.starts_at, zone)))
    pieces.push(loose(' · '), kept(formatTime(item.next_occurrence.starts_at, zone)))
  }
  return pieces
}

export function featuredLine(item: GatheringListItem, zone: string): string {
  return lineText(featuredPieces(item, zone))
}
