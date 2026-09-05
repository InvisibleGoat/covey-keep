// RSVP API types and helpers (CK-27). Shapes mirror backend/app/api/rsvps.py's
// response bodies exactly — see reference/backend/api-reference.md, RSVPs.
//
// arrival_time is the deliberate EXCEPTION to the lib/datetime.ts rule: it is
// a bare time of day on the occurrence's own day, already relative to the zone
// that occurrence displays in — no date, no zone. Running it through
// wallClockToInstant would shift it by the profile-zone offset, silently, for
// anyone whose profile zone differs from the venue's. Nothing in this module
// takes a zone; formatting pins itself to UTC so the browser's own zone can
// never enter the arithmetic.

export interface OwnRsvp {
  id: string
  occurrence_id: string
  response: string
  stay_included: boolean
  // Named companions (CK-29): the people you declared you're bringing —
  // names, nothing more. Replaced wholesale on every write.
  companions: string[]
  arrival_time: string | null
  created_at: string
  updated_at: string | null
}

export interface RsvpListRow {
  id: string
  display_name: string
  response: string
  stay_included: boolean
  companions: string[]
  // Computed server-side at read time — the row's person plus their
  // companions. Never stored, never typed by anyone.
  total: number
  arrival_time: string | null
}

export interface RsvpLists {
  visibility: string
  own: OwnRsvp | null
  rsvps: RsvpListRow[]
}

// The three responses in the terminology record's plain language. "Can't make
// it" is the API's "no"; "keep me included" is its stay_included modifier —
// an interest preference, never a fourth response and never a permission.
export const RSVP_RESPONSES: { value: string; label: string }[] = [
  { value: 'yes', label: 'Going' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'no', label: "Can't make it" },
]

export function rsvpResponseLabel(value: string): string {
  return RSVP_RESPONSES.find((r) => r.value === value)?.label ?? value
}

// The host's RSVP-list visibility choices (gatherings.rsvp_list_visibility),
// in the order the selector offers them — the default first.
export const RSVP_LIST_VISIBILITIES: { value: string; label: string }[] = [
  { value: 'INVITEES', label: 'Everyone invited' },
  { value: 'ATTENDEES', label: 'People who are going' },
  { value: 'HOST_ONLY', label: 'Only me' },
]

export function rsvpListVisibilityLabel(value: string): string {
  return RSVP_LIST_VISIBILITIES.find((v) => v.value === value)?.label ?? value
}

// "Store who, compute how many" (CK-29): the headline number the host reads
// is derived from the named people on the "Going" rows — each row's `total`
// is computed server-side from its names, and this sums them. A count nobody
// typed cannot disagree with the list of names beside it.
export function totalGoing(rows: RsvpListRow[]): number {
  return rows
    .filter((row) => row.response === 'yes')
    .reduce((sum, row) => sum + row.total, 0)
}

// "15:30:00" (the API's bare-time serialization) → "15:30" for a type="time"
// input. A pass-through of the wall clock — no Date, no zone, no conversion.
export function timeForInput(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 5)
}

// "15:30" or "15:30:00" → the locale's clock rendering ("3:30 PM"). Built at
// a fixed UTC instant and formatted in UTC, so the two zone applications
// cancel by construction — the runner's zone cannot shift a wall clock that
// was never an instant to begin with.
export function formatArrivalTime(value: string): string {
  const [hour, minute] = value.split(':').map(Number)
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', timeStyle: 'short' }).format(
    new Date(Date.UTC(1970, 0, 1, hour, minute)),
  )
}
