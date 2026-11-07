// The frame's rules (CK-82; the design handoff §3): the sections, which one
// a page belongs to, and which gatherings the menu lists as coming up.
import type { IconName } from '../components/Icons'
import { authFetch } from './api'
import { formatDayWithYear, formatWeekdayDay } from './datetime'
import { gatheringSections, isComingUp, PHOTOS_ONLY_ITEM, viewOf, type GatheringListItem } from './gatherings'
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

// THE MENU'S SIGNAL (CK-89.1): a page that lands an act changing something the
// menu draws, with no page change to re-read it, announces it, and the menu
// reads its two lists again at once — the same two reads, once per act, and
// nothing new. The acts: on a People page a rename, an approval and a removal
// (a group's name or its people count); on a gathering's page Edit gathering's
// save and a date added, edited or removed (a title or a next date). It
// carries nothing: the lists' own bodies say what changed. A failed or refused
// act announces nothing, and an act that navigates needs none, because the
// page change re-reads. It stands beside lib/covers.ts's cover signal, which a
// cover act still announces, rather than widening it: that one is a cover
// act's and is pinned as one.
const menuListeners = new Set<() => void>()

export function announceMenuChange(): void {
  for (const listener of menuListeners) listener()
}

export function onMenuChange(listener: () => void): () => void {
  menuListeners.add(listener)
  return () => {
    menuListeners.delete(listener)
  }
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

// WHAT THE PANEL SHOWS (CK-89, Rail and panel): read from the address and the
// two held lists, never from a second state, so Back and Forward always agree
// with it. A group's page, its People page and its gathering form show that
// group's panel; a gathering's page shows it, with that gathering current,
// when the gathering belongs to a group the person holds; everything else
// shows Home's — the lists, You, Settings, Your plan, a standalone gathering,
// a gathering of a group the person has left or the list does not hold, and
// an id nobody holds (`/groups/new` included, because `new` is never an id).
export type Panel = { kind: 'home' } | { kind: 'group'; group: Group; gatheringId: string | null }

const GROUP_ADDRESS = /^\/groups\/([^/]+)(?:\/people|\/gatherings\/new)?\/?$/
const GATHERING_ADDRESS = /^\/gatherings\/([^/]+)\/?$/

export function panelOf(
  pathname: string,
  lists: { groups: Group[]; gatherings: GatheringListItem[] } | null,
): Panel {
  if (lists === null) return { kind: 'home' }
  const groupMatch = GROUP_ADDRESS.exec(pathname)
  if (groupMatch) {
    const group = lists.groups.find((candidate) => candidate.id === groupMatch[1])
    if (group) return { kind: 'group', group, gatheringId: null }
    return { kind: 'home' }
  }
  const gatheringMatch = GATHERING_ADDRESS.exec(pathname)
  if (gatheringMatch) {
    const item = lists.gatherings.find((candidate) => candidate.id === gatheringMatch[1])
    const group = item?.group ? lists.groups.find((candidate) => candidate.id === item.group?.id) : undefined
    if (item && group) return { kind: 'group', group, gatheringId: item.id }
  }
  return { kind: 'home' }
}

// Home's panel: *Coming up* (the coming-up gatherings that have a group, the
// first four) and *Not in a group* (the standalone ones, no limit), both from
// the one rule — never a past or a photos-only item.
export const PANEL_COMING_UP_LIMIT = 4

export function homePanelSections(items: GatheringListItem[], now: number) {
  const comingUp = gatheringSections(items, now).comingUp
  return {
    withGroup: comingUp.filter((item) => item.group).slice(0, PANEL_COMING_UP_LIMIT),
    standalone: comingUp.filter((item) => !item.group),
  }
}

// A group's panel *Gatherings*: this group's items, in `gatheringSections`
// order (coming up, past, photos-only).
export function groupPanelGatherings(items: GatheringListItem[], groupId: string, now: number): GatheringListItem[] {
  const sections = gatheringSections(
    items.filter((item) => item.group?.id === groupId),
    now,
  )
  return [...sections.comingUp, ...sections.past, ...sections.photosOnly]
}

// A gathering row's second line in a group's panel: its day when coming up
// (*Thu, Oct 15*), its day with the year when past (*Oct 3, 2026*), *You can
// see its photos* when photos-only — nothing read from `next_occurrence`
// there (the CK-80 Gotcha) — and nothing for a full-view item with no date.
export function panelGatheringLine(item: GatheringListItem, zone: string, now: number): string | null {
  if (viewOf(item.caller_view).photosOnly) return PHOTOS_ONLY_ITEM
  if (item.next_occurrence === null) return null
  return isComingUp(item, now)
    ? formatWeekdayDay(item.next_occurrence.starts_at, zone)
    : formatDayWithYear(item.next_occurrence.starts_at, zone)
}
