// The frame's rules (CK-82; the design handoff §3): the sections, which one
// a page belongs to, and which gatherings the menu lists as coming up.
import type { IconName } from '../components/Icons'
import { authFetch } from './api'
import { gatheringSections, type GatheringListItem } from './gatherings'
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

// The menu's *Gatherings coming up*: the first five of Your gatherings'
// *Coming up* (CK-85) — the same section, from `gatheringSections`, so the
// menu and the page can never disagree: the items in the FULL view whose
// next date is still ahead (`isComingUp`, the one rule), soonest first. An
// item in the photos-only view carries no date (`viewOf`, the one read of the
// view) and is never listed here.
export function upcomingGatherings(
  items: GatheringListItem[],
  now: number,
  limit = MENU_UPCOMING_LIMIT,
): GatheringListItem[] {
  return gatheringSections(items, now).comingUp.slice(0, limit)
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
