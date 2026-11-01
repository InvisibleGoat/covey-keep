// CK-82 — the frame's rules. The value under test: the sections are Groups,
// Gatherings and You, in that order, and no Calendar until the calendar is
// built (CK-91); a page's section is Groups for /groups…, Gatherings for
// /gatherings…, You for /you, /settings and /plan, and none elsewhere; and
// the menu's gatherings coming up are the full-view items whose next date
// is still ahead, soonest first, at most five — never a photos-only item,
// whose view `viewOf` decides.
import { expect, test } from 'vitest'
import type { GatheringListItem } from './gatherings'
import { MENU_UPCOMING_LIMIT, SECTIONS, sectionOf, upcomingGatherings } from './frame'

test('the sections: Groups, Gatherings and You, and no Calendar', () => {
  expect(SECTIONS.map((section) => [section.label, section.to])).toEqual([
    ['Groups', '/groups'],
    ['Gatherings', '/gatherings'],
    ['You', '/you'],
  ])
  expect(JSON.stringify(SECTIONS)).not.toMatch(/calendar/i)
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
