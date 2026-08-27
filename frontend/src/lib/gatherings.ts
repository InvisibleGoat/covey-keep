// Gathering API types and shared helpers (CK-17). Shapes mirror
// backend/app/api/gatherings.py's response bodies exactly — see
// reference/backend/api-reference.md, Gatherings router.

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
  requires_approval: boolean
  publication_state: string
  created_by_account_id: string
  admin_account_id: string | null
  created_at: string
  updated_at: string | null
}

export interface GatheringWithOccurrences extends Gathering {
  occurrences: Occurrence[]
}

// A GET /gatherings item (CK-20): the gathering plus an occurrence summary.
// next_occurrence is the earliest occurrence at or after now, or — when every
// date has passed — the latest past one; the backend owns that rule (it is
// documented in the api-reference), so the list never re-derives it from
// per-gathering detail fetches. Null only defensively: creation requires an
// occurrence and the last one is undeletable.
export interface GatheringListItem extends Gathering {
  next_occurrence: { id: string; starts_at: string } | null
  occurrence_count: number
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
