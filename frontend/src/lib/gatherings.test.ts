// CK-69 pins on the role flags every gated control on the gathering page
// reads. The value under test: `caller_role` is the one source of the role
// — the host is both flags, a co-host organises and is not the host, and
// anything else (null, a missing field, a value this build does not know,
// any near-miss spelling) gates CLOSED on both, in one place.
import { expect, test } from 'vitest'
import { formatInstant } from './datetime'
import { listItemLine, PHOTOS_ONLY_ITEM, PHOTOS_ONLY_LINE, roleFlags, viewOf } from './gatherings'

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
