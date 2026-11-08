// CK-82 — the frame's rules. The value under test: the sections are Groups,
// Gatherings, Calendar and You, in that order — Calendar since the calendar
// was built (CK-91); a page's section is Groups for /groups…, Gatherings for
// /gatherings…, Calendar for /calendar, You for /you, /settings and /plan,
// and none elsewhere; and
// the menu's gatherings coming up are the full-view items whose next date
// is still ahead, soonest first, at most five — never a photos-only item,
// whose view `viewOf` decides.
import { expect, test } from 'vitest'
import {
  groupPanelGatherings,
  homePanelSections,
  MENU_UPCOMING_LIMIT,
  PANEL_COMING_UP_LIMIT,
  panelGatheringLine,
  panelOf,
  SECTIONS,
  sectionOf,
  upcomingGatherings,
} from './frame'
import type { GatheringListItem } from './gatherings'
import type { Group } from './groups'

// MOVED AT CK-91: the pin was "Groups, Gatherings and You, and no Calendar"
// until the calendar was built; it joins third, the merge record's §1.3 order,
// and goes to /calendar with no day, so it always opens at today.
test('the sections: Groups, Gatherings, Calendar and You', () => {
  expect(SECTIONS.map((section) => [section.label, section.to, section.icon])).toEqual([
    ['Groups', '/groups', 'groups'],
    ['Gatherings', '/gatherings', 'gatherings'],
    ['Calendar', '/calendar', 'calendar'],
    ['You', '/you', 'you'],
  ])
})

test("a page's section", () => {
  const cases: [string, string | null][] = [
    ['/groups', 'groups'],
    ['/groups/new', 'groups'],
    ['/groups/g-1', 'groups'],
    ['/groups/g-1/gatherings/new', 'groups'],
    ['/gatherings', 'gatherings'],
    ['/gatherings/new', 'gatherings'],
    ['/gatherings/x-1', 'gatherings'],
    ['/you', 'you'],
    ['/settings', 'you'],
    ['/plan', 'you'],
    // CK-91: the calendar, a group's included — its group is in the query.
    ['/calendar', 'calendar'],
    ['/calendar/', 'calendar'],
    ['/calendarx', null],
    ['/', null],
    ['/home', null],
    ['/groupsx', null],
    ['/planning', null],
    ['/tos', null],
  ]
  for (const [path, section] of cases) expect(sectionOf(path), path).toBe(section)
})

const NOW = Date.parse('2026-10-31T12:00:00Z')

function item(id: string, startsAt: string | null, over: Partial<GatheringListItem> = {}): GatheringListItem {
  return {
    id,
    gathering_type: 'potluck',
    title: id,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    caller_role: null,
    group: null,
    caller_view: 'full',
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
    ...over,
  }
}

test('gatherings coming up: full view, still ahead, soonest first, at most five', () => {
  expect(MENU_UPCOMING_LIMIT).toBe(5)
  const items = [
    item('d', '2026-11-20T18:00:00Z'),
    item('past', '2026-10-30T18:00:00Z'),
    item('a', '2026-11-01T18:00:00Z'),
    item('f', '2026-12-24T18:00:00Z'),
    item('c', '2026-11-12T18:00:00Z'),
    item('now', '2026-10-31T12:00:00Z'),
    item('b', '2026-11-05T18:00:00Z'),
    item('e', '2026-12-01T18:00:00Z'),
  ]
  expect(upcomingGatherings(items, NOW).map((x) => x.id)).toEqual(['now', 'a', 'b', 'c', 'd'])
})

test('gatherings coming up: never a photos-only item, whatever it carries', () => {
  const items = [
    item('memory', '2026-11-01T18:00:00Z', { caller_view: 'memory' }),
    // A body this build does not understand shows less (`viewOf`).
    item('unknown', '2026-11-01T18:00:00Z', { caller_view: 'later' as never }),
    item('missing', '2026-11-01T18:00:00Z', { caller_view: undefined as never }),
    item('withheld', null, { caller_view: 'memory' }),
    item('full', '2026-11-02T18:00:00Z'),
  ]
  expect(upcomingGatherings(items, NOW).map((x) => x.id)).toEqual(['full'])
})

// ---------------------------------------------------------------------------
// CK-89 — what the panel shows, from the address and the held lists alone.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const dayAt = (days: number) => new Date(Date.now() + days * DAY).toISOString()

function heldGroup(id: string): Group {
  return {
    id,
    name: `Group ${id}`,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'p',
    member_count: 2,
    caller_role: 'member',
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function panelItem(id: string, groupId: string | null, days: number | null, view = 'full'): GatheringListItem {
  return {
    id,
    title: id,
    gathering_type: 'potluck',
    caller_view: view,
    group: groupId === null ? null : { id: groupId, name: `Group ${groupId}` },
    next_occurrence: days === null ? null : { id: `o-${id}`, starts_at: dayAt(days) },
    occurrence_count: days === null ? null : 1,
  } as unknown as GatheringListItem
}

const HELD = {
  groups: [heldGroup('g-1'), heldGroup('g-2')],
  gatherings: [
    panelItem('in-g1', 'g-1', 3),
    panelItem('in-left', 'g-left', 4),
    panelItem('alone', null, 5),
  ],
}

test("the panel's table, row by row: a group's page, People and its gathering form show that group's", () => {
  for (const address of ['/groups/g-1', '/groups/g-1/people', '/groups/g-1/gatherings/new', '/groups/g-1/']) {
    expect(panelOf(address, HELD), address).toEqual({ kind: 'group', group: HELD.groups[0], gatheringId: null })
  }
  expect(panelOf('/groups/g-2', HELD)).toEqual({ kind: 'group', group: HELD.groups[1], gatheringId: null })
})

test("a gathering of a held group shows that group's panel with the gathering current; every other gathering shows Home's", () => {
  expect(panelOf('/gatherings/in-g1', HELD)).toEqual({ kind: 'group', group: HELD.groups[0], gatheringId: 'in-g1' })
  for (const address of ['/gatherings/alone', '/gatherings/in-left', '/gatherings/not-held', '/gatherings/new']) {
    expect(panelOf(address, HELD), address).toEqual({ kind: 'home' })
  }
})

test("everything else shows Home's — and so does an address nobody holds, /groups/new included", () => {
  for (const address of [
    '/groups',
    '/groups/new',
    '/groups/join',
    '/groups/not-held',
    '/groups/not-held/people',
    '/gatherings',
    '/you',
    '/settings',
    '/plan',
    '/groups/g-1/something-else',
  ]) {
    expect(panelOf(address, HELD), address).toEqual({ kind: 'home' })
  }
  expect(panelOf('/groups/g-1', null)).toEqual({ kind: 'home' })
})

test("a group's calendar shows that group's panel, read from the address's query; the tab's calendar and a group nobody holds show Home's (CK-91)", () => {
  expect(panelOf('/calendar', HELD, '?group=g-1')).toEqual({ kind: 'group', group: HELD.groups[0], gatheringId: null })
  expect(panelOf('/calendar', HELD, '?day=2026-11-14&group=g-2')).toEqual({
    kind: 'group',
    group: HELD.groups[1],
    gatheringId: null,
  })
  for (const search of ['', '?day=2026-11-14', '?group=not-held', '?group=', '?groups=g-1']) {
    expect(panelOf('/calendar', HELD, search), search).toEqual({ kind: 'home' })
  }
  // The query is read on the calendar alone: elsewhere it moves nothing.
  expect(panelOf('/you', HELD, '?group=g-1')).toEqual({ kind: 'home' })
  expect(panelOf('/gatherings', HELD, '?group=g-1')).toEqual({ kind: 'home' })
  expect(panelOf('/calendar', null, '?group=g-1')).toEqual({ kind: 'home' })
})

test("Home's panel: the first four coming-up gatherings with a group, every coming-up standalone one, never a past or photos-only item", () => {
  const items = [
    ...[1, 2, 3, 4, 5].map((n) => panelItem(`g-up-${n}`, 'g-1', n)),
    panelItem('lone-1', null, 9),
    panelItem('lone-2', null, 1),
    panelItem('past', 'g-1', -10),
    panelItem('past-lone', null, -10),
    panelItem('memory', 'g-1', 2, 'memory'),
  ]
  const sections = homePanelSections(items, Date.now())
  expect(PANEL_COMING_UP_LIMIT).toBe(4)
  expect(sections.withGroup.map((item) => item.id)).toEqual(['g-up-1', 'g-up-2', 'g-up-3', 'g-up-4'])
  expect(sections.standalone.map((item) => item.id)).toEqual(['lone-2', 'lone-1'])
})

test("a group's panel Gatherings: this group's only, coming up then past then photos-only", () => {
  const items = [
    panelItem('past-old', 'g-1', -30),
    panelItem('other', 'g-2', 1),
    panelItem('memory', 'g-1', null, 'memory'),
    panelItem('up-late', 'g-1', 20),
    panelItem('past-new', 'g-1', -2),
    panelItem('up-soon', 'g-1', 2),
  ]
  expect(groupPanelGatherings(items, 'g-1', Date.now()).map((item) => item.id)).toEqual([
    'up-soon',
    'up-late',
    'past-new',
    'past-old',
    'memory',
  ])
})

test('a panel row\'s line: the day when coming up, the day with its year when past, the photos-only words and no date there, nothing with no date', () => {
  const now = Date.now()
  const up = panelItem('u', 'g-1', 3)
  const past = panelItem('p', 'g-1', -3)
  expect(panelGatheringLine(up, 'UTC', now)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/)
  expect(panelGatheringLine(past, 'UTC', now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)
  // A photos-only item reads no date, even one a hand-built body carries.
  expect(panelGatheringLine(panelItem('m', 'g-1', 3, 'memory'), 'UTC', now)).toBe('You can see its photos')
  expect(panelGatheringLine(panelItem('n', 'g-1', null), 'UTC', now)).toBeNull()
})
