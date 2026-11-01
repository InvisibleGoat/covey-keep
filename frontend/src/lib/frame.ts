// The frame's rules (CK-82; the design handoff §3): the sections, which one
// a page belongs to, and which gatherings the menu lists as coming up.
import type { IconName } from '../components/Icons'
import { authFetch } from './api'
import { viewOf, type GatheringListItem } from './gatherings'
import { listGroups, type Group } from './groups'

export type SectionId = 'groups' | 'gatherings' | 'you'

// The bottom bar's tabs and the menu's sections, in order: Groups,
// Gatherings and You. Calendar joins both when the calendar is built
// (CK-91), and not before — no tab or row leads nowhere.
export const SECTIONS: { id: SectionId; label: string; to: string; icon: IconName }[] = [
  { id: 'groups', label: 'Groups', to: '/groups', icon: 'groups' },
  { id: 'gatherings', label: 'Gatherings', to: '/gatherings', icon: 'gatherings' },
  { id: 'you', label: 'You', to: '/you', icon: 'you' },
]

function within(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`)
}

// The section a page belongs to — the menu's highlighted section and the
// bottom bar's current tab: Groups for `/groups…` (a group's page and its
// gathering form included), Gatherings for `/gatherings…`, You for `/you`,
// `/settings` and `/plan`, which are reached from it. Anything else — a page
// the frame does not carry — belongs to none.
export function sectionOf(pathname: string): SectionId | null {
  if (within(pathname, '/groups')) return 'groups'
  if (within(pathname, '/gatherings')) return 'gatherings'
  if (within(pathname, '/you') || within(pathname, '/settings') || within(pathname, '/plan')) return 'you'
  return null
}

// How many gatherings the menu lists as coming up (the mockup's five).
export const MENU_UPCOMING_LIMIT = 5

// The menu's *Gatherings coming up*: the items in the FULL view whose next
// date is still ahead — the backend's `next_occurrence` is the earliest date
// at or after now, or the latest past one when every date has passed, so a
// date before `now` means nothing is coming — soonest first, at most five.
// An item in the photos-only view carries no date (`viewOf`, the one read of
// the view) and is never listed here.
export function upcomingGatherings(
  items: GatheringListItem[],
  now: number,
  limit = MENU_UPCOMING_LIMIT,
): GatheringListItem[] {
  return items
    .filter((item) => viewOf(item.caller_view).full && item.next_occurrence !== null)
    .map((item) => ({ item, at: Date.parse(item.next_occurrence?.starts_at ?? '') }))
    .filter(({ at }) => Number.isFinite(at) && at >= now)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ item }) => item)
}

export type MenuLists = { ok: true; groups: Group[]; gatherings: GatheringListItem[] } | { ok: false }

// The menu's two reads, the same two the list pages make — `GET /groups`
// and `GET /gatherings` — answered together: the menu shows both lists, or
// one quiet line with Try again when either read fails. No new request and
// no new field (the kickoff's DATA-HANDLING).
export async function readMenuLists(): Promise<MenuLists> {
  const [groups, gatherings] = await Promise.all([listGroups(), listGatherings()])
  if (!groups.ok || !gatherings.ok) return { ok: false }
  return { ok: true, groups: groups.groups, gatherings: gatherings.gatherings }
}

async function listGatherings(): Promise<{ ok: true; gatherings: GatheringListItem[] } | { ok: false }> {
  try {
    const response = await authFetch('/gatherings')
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { gatherings?: GatheringListItem[] }
    return { ok: true, gatherings: body.gatherings ?? [] }
  } catch {
    return { ok: false }
  }
}
