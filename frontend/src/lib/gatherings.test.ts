// CK-69 pins on the role flags every gated control on the gathering page
// reads. The value under test: `caller_role` is the one source of the role
// — the host is both flags, a co-host organises and is not the host, and
// anything else (null, a missing field, a value this build does not know,
// any near-miss spelling) gates CLOSED on both, in one place.
import { expect, test } from 'vitest'
import { formatInstant } from './datetime'
import {
  cardDateLine,
  cardPlaceLine,
  featuredLine,
  gatheringSections,
  isComingUp,
  listItemLine,
  NOT_IN_A_GROUP,
  PHOTOS_ONLY_ITEM,
  PHOTOS_ONLY_LINE,
  roleFlags,
  viewOf,
  type GatheringListItem,
} from './gatherings'

test('roleFlags: the host is both flags, a co-host organises only, and anything else gates closed', () => {
  expect(roleFlags('host')).toEqual({ isHost: true, organises: true })
  expect(roleFlags('co_host')).toEqual({ isHost: false, organises: true })
  // An invitee, a keeper, a former host — and every value that is not one
  // of the two known roles, including the spellings a hand-written check
  // might have accepted.
  for (const other of [null, undefined, '', 'HOST', 'Host', 'cohost', 'co-host', 'admin', 'keeper', 0, 1, true, {}, []]) {
    expect(roleFlags(other)).toEqual({ isHost: false, organises: false })
  }
})

// CK-80 pins on the view: `caller_view` is read in one place, and only
// exactly 'full' is the full view — 'memory', null, a missing field and any
// value this build does not know are the PHOTOS-ONLY view, so an unknown
// view shows less and never the dates.
test('viewOf: exactly "full" is the full view; "memory", null, a missing field and an unknown string are the photos-only view', () => {
  expect(viewOf('full')).toEqual({ full: true, photosOnly: false })
  const body: { caller_view?: unknown } = {}
  for (const other of ['memory', null, undefined, body.caller_view, 'FULL', 'Full', 'full ', 'everything', '', 0, true, {}]) {
    expect(viewOf(other)).toEqual({ full: false, photosOnly: true })
  }
})

// The list item's line: the type, the next date or — photos-only — the
// line in place of it, and the group's name where asked. A withheld summary
// is never read: the photos-only item's null summary yields no date.
test('listItemLine: the date in the full view, "You can see its photos" and no date in the photos-only view, the group name where asked', () => {
  const base = {
    id: 'g-9',
    gathering_type: 'potluck',
    title: 'The Party',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    caller_role: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  } as const
  const full = {
    ...base,
    rsvp_list_visibility: 'INVITEES',
    caller_view: 'full' as const,
    group: { id: 'grp-1', name: 'The Lees' },
    next_occurrence: { id: 'occ-1', starts_at: '2035-01-01T18:00:00+00:00' },
    occurrence_count: 1,
  }
  const date = formatInstant('2035-01-01T18:00:00+00:00', 'America/Chicago')
  expect(listItemLine(full, 'America/Chicago', true)).toBe(`Potluck · ${date} · The Lees`)
  expect(listItemLine(full, 'America/Chicago', false)).toBe(`Potluck · ${date}`)
  expect(listItemLine({ ...full, group: null }, 'America/Chicago', true)).toBe(`Potluck · ${date}`)
  const memory = {
    ...base,
    rsvp_list_visibility: null,
    caller_view: 'memory' as const,
    group: { id: 'grp-1', name: 'The Lees' },
    next_occurrence: null,
    occurrence_count: null,
  }
  expect(listItemLine(memory, 'America/Chicago', true)).toBe(`Potluck · ${PHOTOS_ONLY_ITEM} · The Lees`)
  expect(listItemLine(memory, 'America/Chicago', false)).toBe(`Potluck · ${PHOTOS_ONLY_ITEM}`)
  expect(PHOTOS_ONLY_ITEM).toBe('You can see its photos')
  expect(PHOTOS_ONLY_LINE).toBe(
    "You can see this gathering's photos. Its dates and plans are for the people invited.",
  )
})

// CK-85 pins on Your gatherings' sections and card lines. The value under
// test: ONE rule decides "coming up" — a full-view item whose next date
// starts at or after now — and the sections are read from it: Coming up
// soonest first, Past most recent first (a date that has started is past),
// and every photos-only item, whatever it carries, in the server's order and
// never read for a date. The lines are the mockup's words, every date and
// time in the given zone.
const NOW = Date.parse('2026-11-01T12:00:00Z')
const ZONE = 'America/Chicago'

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

test('isComingUp: a full-view item whose next date starts at or after now — never one that has started, never a photos-only one', () => {
  expect(isComingUp(item('ahead', '2026-11-02T12:00:00Z'), NOW)).toBe(true)
  expect(isComingUp(item('now', '2026-11-01T12:00:00Z'), NOW)).toBe(true)
  // A date in progress — started a minute ago, not over — is not coming up.
  expect(isComingUp(item('started', '2026-11-01T11:59:00Z'), NOW)).toBe(false)
  expect(isComingUp(item('past', '2026-10-01T12:00:00Z'), NOW)).toBe(false)
  expect(isComingUp(item('dateless', null), NOW)).toBe(false)
  for (const view of ['memory', null, undefined, 'later']) {
    expect(isComingUp(item('photos', '2026-11-02T12:00:00Z', { caller_view: view as never }), NOW)).toBe(false)
  }
})

test("gatheringSections: Coming up soonest first, Past most recent first, Photos-only in the server's order", () => {
  const items = [
    item('memory-b', null, { caller_view: 'memory' }),
    item('past-old', '2026-03-01T12:00:00Z'),
    item('up-late', '2027-01-10T12:00:00Z'),
    item('started', '2026-11-01T11:00:00Z'),
    // A body this build does not understand shows less: photos-only, even
    // carrying a date, and never read for it.
    item('unknown-view', '2026-11-20T12:00:00Z', { caller_view: 'later' as never }),
    item('up-soon', '2026-11-05T12:00:00Z'),
    item('memory-a', null, { caller_view: 'memory' }),
    item('past-recent', '2026-10-20T12:00:00Z'),
    item('up-mid', '2026-12-01T12:00:00Z'),
  ]
  const { comingUp, past, photosOnly } = gatheringSections(items, NOW)
  expect(comingUp.map((x) => x.id)).toEqual(['up-soon', 'up-mid', 'up-late'])
  expect(past.map((x) => x.id)).toEqual(['started', 'past-recent', 'past-old'])
  expect(photosOnly.map((x) => x.id)).toEqual(['memory-b', 'unknown-view', 'memory-a'])
  // Every item is in exactly one section.
  expect(comingUp.length + past.length + photosOnly.length).toBe(items.length)
})

test('gatheringSections: equal dates keep the server order, and a full-view item with no date goes last in Past rather than vanishing', () => {
  const same = '2026-12-01T12:00:00Z'
  const { comingUp, past } = gatheringSections(
    [item('dateless', null), item('first', same), item('second', same), item('old', '2026-01-01T12:00:00Z')],
    NOW,
  )
  expect(comingUp.map((x) => x.id)).toEqual(['first', 'second'])
  expect(past.map((x) => x.id)).toEqual(['old', 'dateless'])
})

test('the card lines, as literals: the group or Not in a group with the type; N dates · next day; day · time; the past day with its year; the photos line', () => {
  const lees = { id: 'grp-1', name: 'The Lees' }
  expect(NOT_IN_A_GROUP).toBe('Not in a group')
  // 00:30 UTC on Nov 12 is 6:30 PM on Wed, Nov 11 in Chicago.
  const one = item('one', '2026-11-12T00:30:00Z', { gathering_type: 'hosted' })
  expect(cardPlaceLine(one)).toBe('Not in a group · Hosted')
  expect(cardDateLine(one, ZONE, NOW)).toBe('Wed, Nov 11 · 6:30 PM')
  expect(featuredLine(one, ZONE)).toBe('Not in a group · Hosted · Wed, Nov 11 · 6:30 PM')

  const season = item('season', '2026-11-12T00:30:00Z', { gathering_type: 'season', group: lees, occurrence_count: 12 })
  expect(cardPlaceLine(season)).toBe('The Lees · Season')
  expect(cardDateLine(season, ZONE, NOW)).toBe('12 dates · next Wed, Nov 11')
  // The featured card's line names the next date and its time, whatever the count.
  expect(featuredLine(season, ZONE)).toBe('The Lees · Season · Wed, Nov 11 · 6:30 PM')

  const past = item('past', '2026-10-03T17:00:00Z', { gathering_type: 'simple', occurrence_count: 3 })
  expect(cardDateLine(past, ZONE, NOW)).toBe('Oct 3, 2026')

  const photos = item('photos', null, { caller_view: 'memory', group: lees, rsvp_list_visibility: null })
  expect(cardPlaceLine(photos)).toBe('The Lees · Potluck')
  expect(cardDateLine(photos, ZONE, NOW)).toBe(PHOTOS_ONLY_ITEM)
  // Even a photos-only body that carried a date never shows one.
  const carried = item('carried', '2026-11-12T00:30:00Z', { caller_view: 'memory', group: lees })
  expect(cardDateLine(carried, ZONE, NOW)).toBe('You can see its photos')
})

test("the card lines read every date in the given zone, never the runner's", () => {
  // 02:10 UTC on Nov 12 is the evening of Nov 11 in Los Angeles.
  const late = item('late', '2026-11-12T02:10:00Z')
  expect(cardDateLine(late, 'America/Los_Angeles', NOW)).toBe('Wed, Nov 11 · 6:10 PM')
  expect(cardDateLine(late, 'UTC', NOW)).toBe('Thu, Nov 12 · 2:10 AM')
  const gone = item('gone', '2026-01-01T05:00:00Z')
  expect(cardDateLine(gone, 'America/Los_Angeles', NOW)).toBe('Dec 31, 2025')
  expect(cardDateLine(gone, 'UTC', NOW)).toBe('Jan 1, 2026')
})
