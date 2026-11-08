// CK-91 — the calendar's helpers. The value under test: every day is a day in
// the PROFILE'S ZONE, never the runner's — the month's read from its first
// day's midnight to the next month's, across a daylight-saving change and east
// of UTC; the days a date covers, by the route's half-open rule; the time line
// in all its forms; the selection's default; and the over-or-not rule at its
// boundary, an instant and never a day.
//
// The zones: every expectation below is written for America/Chicago or for a
// zone east of UTC (Asia/Kolkata, Australia/Sydney), and the runner can be at
// most one of them — so a helper that read the runner's zone fails at least
// one test whatever zone the suite runs in. ZONE is Chicago unless the runner
// is Chicago, as the other date tests do.
import { expect, test, vi } from 'vitest'
import {
  calendarLede,
  calendarPath,
  dayHeading,
  dayLabel,
  dayLine,
  dayOf,
  daysCovered,
  datesByDay,
  dayStart,
  groupOpeningDay,
  isOver,
  monthDays,
  monthDefaultDay,
  monthRange,
  monthTitle,
  parseDay,
  parseGroupId,
  readCalendar,
  shiftDay,
  shiftMonth,
  spanLabel,
  timeLine,
  todayIn,
  whereText,
  type CalendarAnswer,
  type CalendarDate,
  type CalendarEntry,
  type CalendarGathering,
} from './calendar'
import type { GatheringListItem } from './gatherings'
import { setToken } from './session'

const CHICAGO = 'America/Chicago'
const KOLKATA = 'Asia/Kolkata'
const SYDNEY = 'Australia/Sydney'
const runner = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONE = runner === CHICAGO ? KOLKATA : CHICAGO

function date(overrides: Partial<CalendarDate> = {}): CalendarDate {
  return {
    id: 'o-1',
    gathering_id: 'g-1',
    starts_at: '2026-11-14T22:00:00Z',
    ends_at: null,
    location: null,
    map_url: null,
    caller_response: null,
    position: 1,
    ...overrides,
  }
}

function gathering(overrides: Partial<CalendarGathering> = {}): CalendarGathering {
  return {
    id: 'g-1',
    title: 'Thanksgiving',
    gathering_type: 'HOLIDAY',
    cover: null,
    group: null,
    date_count: 1,
    published_count: 0,
    ...overrides,
  }
}

function entry(d: Partial<CalendarDate> = {}, g: Partial<CalendarGathering> = {}): CalendarEntry {
  return { date: date(d), gathering: gathering(g) }
}

// ---------------------------------------------------------------- the month's read

test("THE MONTH'S READ, America/Chicago: November runs from its first midnight in CDT to December's in CST — 30 days and the hour the clocks went back", () => {
  expect(monthRange('2026-11', CHICAGO)).toEqual({
    from: '2026-11-01T05:00:00.000Z',
    to: '2026-12-01T06:00:00.000Z',
  })
})

test("THE MONTH'S READ, America/Chicago: March runs from its first midnight in CST to April's in CDT — the hour the clocks went forward missing", () => {
  expect(monthRange('2026-03', CHICAGO)).toEqual({
    from: '2026-03-01T06:00:00.000Z',
    to: '2026-04-01T05:00:00.000Z',
  })
})

test("THE MONTH'S READ: `to` is the NEXT month's first midnight, never the month's last day — October's `to` is November's `from`", () => {
  const october = monthRange('2026-10', CHICAGO)
  expect(october).toEqual({ from: '2026-10-01T05:00:00.000Z', to: '2026-11-01T05:00:00.000Z' })
  expect(october.to).toBe(monthRange('2026-11', CHICAGO).from)
  // December's runs into the next year.
  expect(monthRange('2026-12', CHICAGO)).toEqual({ from: '2026-12-01T06:00:00.000Z', to: '2027-01-01T06:00:00.000Z' })
})

test("THE MONTH'S READ east of UTC: Asia/Kolkata's November starts on October 31 in UTC; Australia/Sydney's October crosses its own clock change", () => {
  expect(monthRange('2026-11', KOLKATA)).toEqual({
    from: '2026-10-31T18:30:00.000Z',
    to: '2026-11-30T18:30:00.000Z',
  })
  // Sydney's clocks go forward on October 4, 2026: +10 at the 1st, +11 at November's.
  expect(monthRange('2026-10', SYDNEY)).toEqual({
    from: '2026-09-30T14:00:00.000Z',
    to: '2026-10-31T13:00:00.000Z',
  })
})

test('the read sends each instant in its Z form through URLSearchParams — no `+`, which a query string reads as a space — and a group\'s calendar its own path', () => {
  const tab = calendarPath('2026-11', KOLKATA, null)
  expect(tab).toBe('/calendar?from=2026-10-31T18%3A30%3A00.000Z&to=2026-11-30T18%3A30%3A00.000Z')
  expect(tab).not.toContain('+')
  expect(calendarPath('2026-11', CHICAGO, 'grp-1')).toBe(
    '/groups/grp-1/calendar?from=2026-11-01T05%3A00%3A00.000Z&to=2026-12-01T06%3A00%3A00.000Z',
  )
})

test('a day whose clocks jump at midnight starts at its first real instant, never on the day before (America/Havana, March 8, 2026)', () => {
  const start = dayStart('2026-03-08', 'America/Havana')
  expect(dayOf(start, 'America/Havana')).toBe('2026-03-08')
  expect(start).toBe('2026-03-08T05:00:00.000Z')
})

// ---------------------------------------------------------------- days

test("a day is the zone's: the same instant is November 14 in Chicago and November 15 in Kolkata, and today follows the zone", () => {
  expect(dayOf('2026-11-14T22:00:00Z', CHICAGO)).toBe('2026-11-14')
  expect(dayOf('2026-11-14T22:00:00Z', KOLKATA)).toBe('2026-11-15')
  const now = Date.parse('2026-11-15T03:00:00Z')
  expect(todayIn(CHICAGO, now)).toBe('2026-11-14')
  expect(todayIn(KOLKATA, now)).toBe('2026-11-15')
})

test('the address\'s day: a real calendar date, or nothing', () => {
  expect(parseDay('2026-11-14')).toBe('2026-11-14')
  expect(parseDay('2028-02-29')).toBe('2028-02-29')
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-11-1', '2026-11-14T00:00', 'tomorrow', '', ' 2026-11-14', '0099-01-01']) {
    expect(parseDay(value), JSON.stringify(value)).toBeNull()
  }
  expect(parseDay(null)).toBeNull()
  expect(parseDay(undefined)).toBeNull()
})

test("a group id from the address names a group or nothing; nothing is the not-found screen with nothing asked", () => {
  expect(parseGroupId('grp-1')).toBe('grp-1')
  expect(parseGroupId('3f2b9c1e-0000-4000-8000-000000000001')).toBe('3f2b9c1e-0000-4000-8000-000000000001')
  for (const value of ['', '../members', 'a/b', 'a b', '%2F', 'x'.repeat(65)]) {
    expect(parseGroupId(value), JSON.stringify(value)).toBeNull()
  }
  expect(parseGroupId(null)).toBeNull()
})

test('the month\'s grid: its blank lead (the 1st\'s weekday, Sunday first) and each of its days', () => {
  const november = monthDays('2026-11')
  expect(november.lead).toBe(0)
  expect(november.days).toHaveLength(30)
  expect(november.days[0]).toBe('2026-11-01')
  expect(november.days[29]).toBe('2026-11-30')
  const october = monthDays('2026-10')
  expect(october.lead).toBe(4)
  expect(october.days).toHaveLength(31)
  expect(monthDays('2028-02').days).toHaveLength(29)
  expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01')
  expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
})

// ---------------------------------------------------------------- the days a date covers

test('THE DAYS A DATE COVERS: one day — 4 PM to 9 PM — is that day alone', () => {
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T03:00:00Z' }), CHICAGO)).toEqual([
    '2026-11-14',
  ])
})

test('THE DAYS A DATE COVERS: across midnight — 4 PM to 1 AM — is both days', () => {
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T07:00:00Z' }), CHICAGO)).toEqual([
    '2026-11-14',
    '2026-11-15',
  ])
})

test('THE DAYS A DATE COVERS: ending EXACTLY at midnight does not spill onto the next day (the route\'s half-open rule)', () => {
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T06:00:00Z' }), CHICAGO)).toEqual([
    '2026-11-14',
  ])
  // A millisecond later, it does.
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T06:00:00.001Z' }), CHICAGO)).toEqual([
    '2026-11-14',
    '2026-11-15',
  ])
})

test('THE DAYS A DATE COVERS: a date with no end covers its start\'s day alone, and an end not after its start the same', () => {
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: null }), CHICAGO)).toEqual(['2026-11-14'])
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-14T22:00:00Z' }), CHICAGO)).toEqual([
    '2026-11-14',
  ])
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-12T22:00:00Z' }), CHICAGO)).toEqual([
    '2026-11-14',
  ])
})

test("THE DAYS A DATE COVERS are the zone's: the same date is November 15 alone in Kolkata", () => {
  expect(daysCovered(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T03:00:00Z' }), KOLKATA)).toEqual([
    '2026-11-15',
  ])
})

const ACROSS_MONTHS = { starts_at: '2026-10-30T21:00:00Z', ends_at: '2026-11-02T18:00:00Z' } // Oct 30 4 PM CDT – Nov 2 noon CST

test("THE DAYS A DATE COVERS across a month's edge, drawn only on the shown month's days", () => {
  expect(daysCovered(date(ACROSS_MONTHS), CHICAGO)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  const answer: CalendarAnswer = { dates: [date(ACROSS_MONTHS)], gatherings: [gathering()] }
  expect([...datesByDay(answer, '2026-11', CHICAGO).keys()]).toEqual(['2026-11-01', '2026-11-02'])
  expect([...datesByDay(answer, '2026-10', CHICAGO).keys()]).toEqual(['2026-10-30', '2026-10-31'])
})

test("within a day the dates keep the route's order, each with its gathering; a date whose gathering the answer lacks is left out", () => {
  const answer: CalendarAnswer = {
    dates: [
      date({ id: 'o-1', gathering_id: 'g-2', starts_at: '2026-11-14T15:00:00Z' }),
      date({ id: 'o-2', gathering_id: 'g-1', starts_at: '2026-11-14T22:00:00Z' }),
      date({ id: 'o-3', gathering_id: 'g-gone', starts_at: '2026-11-14T23:00:00Z' }),
    ],
    gatherings: [gathering({ id: 'g-1', title: 'Thanksgiving' }), gathering({ id: 'g-2', title: "Ruby's Recital" })],
  }
  const day = datesByDay(answer, '2026-11', CHICAGO).get('2026-11-14') ?? []
  expect(day.map((item) => [item.date.id, item.gathering.title])).toEqual([
    ['o-1', "Ruby's Recital"],
    ['o-2', 'Thanksgiving'],
  ])
})

// ---------------------------------------------------------------- the time line

test('THE TIME LINE: a date on one day reads its start time', () => {
  expect(timeLine(entry({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T03:00:00Z' }), '2026-11-14', CHICAGO)).toBe(
    '4:00 PM',
  )
  expect(timeLine(entry({ starts_at: '2026-11-14T22:00:00Z' }), '2026-11-14', CHICAGO)).toBe('4:00 PM')
})

test('THE TIME LINE: then · date N of M where the gathering has more than one date, from the date\'s position', () => {
  expect(timeLine(entry({ starts_at: '2026-11-14T22:00:00Z', position: 2 }, { date_count: 6 }), '2026-11-14', CHICAGO)).toBe(
    '4:00 PM · date 2 of 6',
  )
})

const SPAN = { starts_at: '2026-10-03T21:00:00Z', ends_at: '2026-10-05T16:00:00Z' } // Oct 3 4 PM – Oct 5 11 AM CDT

test('THE TIME LINE: a date covering days reads its span — with · starts on its first day, alone on the others', () => {
  expect(spanLabel(date(SPAN), CHICAGO)).toBe('Oct 3 – 5')
  expect(timeLine(entry(SPAN), '2026-10-03', CHICAGO)).toBe('Oct 3 – 5 · starts 4:00 PM')
  expect(timeLine(entry(SPAN), '2026-10-04', CHICAGO)).toBe('Oct 3 – 5')
  expect(timeLine(entry(SPAN), '2026-10-05', CHICAGO)).toBe('Oct 3 – 5')
  expect(timeLine(entry(SPAN, { date_count: 3 }), '2026-10-03', CHICAGO)).toBe('Oct 3 – 5 · starts 4:00 PM · date 1 of 3')
})

test('THE TIME LINE: across months the end names its month; the end day is the day of the instant before the end', () => {
  expect(timeLine(entry(ACROSS_MONTHS), '2026-10-30', CHICAGO)).toBe('Oct 30 – Nov 2 · starts 4:00 PM')
  expect(timeLine(entry(ACROSS_MONTHS), '2026-11-01', CHICAGO)).toBe('Oct 30 – Nov 2')
  // Ending at midnight on the 5th, it spans the 3rd to the 4th.
  expect(spanLabel(date({ starts_at: '2026-10-03T21:00:00Z', ends_at: '2026-10-05T05:00:00Z' }), CHICAGO)).toBe('Oct 3 – 4')
  // A date on one day has no span.
  expect(spanLabel(date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T06:00:00Z' }), CHICAGO)).toBeNull()
})

test('THE TIME LINE is read in the zone: the same date is 3:30 AM on November 15 in Kolkata', () => {
  expect(timeLine(entry({ starts_at: '2026-11-14T22:00:00Z' }), '2026-11-15', KOLKATA)).toBe('3:30 AM')
})

// ---------------------------------------------------------------- the lines

test("the month's name, a day's label, the day's heading and its line, as literals", () => {
  expect(monthTitle('2026-11')).toBe('November 2026')
  expect(monthTitle('2027-01')).toBe('January 2027')
  expect(dayLabel('2026-11-14', [], false)).toBe('Saturday, November 14')
  expect(dayLabel('2026-11-14', ['Thanksgiving', "Ruby's Recital"], true)).toBe(
    "Saturday, November 14: Thanksgiving, Ruby's Recital, today",
  )
  expect(dayLabel('2026-11-15', [], true)).toBe('Sunday, November 15, today')
  expect(dayHeading('2026-11-14')).toBe('Saturday, November 14, 2026')
  expect(dayLine(true, 0)).toBe('Today')
  expect(dayLine(true, 2)).toBe('Today · 2 gatherings')
  expect(dayLine(false, 1)).toBe('1 gathering')
  expect(dayLine(false, 0)).toBeNull()
  expect(calendarLede(ZONE)).toBe(`Every date of every gathering you're invited to. Times in ${ZONE}.`)
  expect(whereText(gathering({ group: { id: 'grp-1', name: 'The Marlowe Family' } }))).toBe('The Marlowe Family')
  expect(whereText(gathering({ group: null }))).toBe('Not in a group')
})

// ---------------------------------------------------------------- the selection

test("THE SELECTION'S DEFAULT on moving to a month: today if it is in the month, else its first day with a date, else the 1st", () => {
  const answer: CalendarAnswer = {
    dates: [
      date({ id: 'o-2', starts_at: '2026-12-20T22:00:00Z' }),
      date({ id: 'o-1', starts_at: '2026-12-05T22:00:00Z' }),
    ],
    gatherings: [gathering()],
  }
  const december = datesByDay(answer, '2026-12', CHICAGO)
  expect(monthDefaultDay('2026-11', '2026-11-08', datesByDay(answer, '2026-11', CHICAGO))).toBe('2026-11-08')
  expect(monthDefaultDay('2026-12', '2026-11-08', december)).toBe('2026-12-05')
  expect(monthDefaultDay('2026-12', '2026-12-30', december)).toBe('2026-12-30')
  expect(monthDefaultDay('2027-01', '2026-11-08', new Map())).toBe('2027-01-01')
})

function listItem(id: string, next: string | null, view: 'full' | 'memory' = 'full'): GatheringListItem {
  return {
    id,
    title: id,
    gathering_type: 'HOLIDAY',
    group: { id: 'grp-1', name: 'The Marlowe Family' },
    caller_view: view,
    caller_role: null,
    next_occurrence: next === null ? null : { id: `o-${id}`, starts_at: next },
    occurrence_count: next === null ? 0 : 1,
  } as unknown as GatheringListItem
}

test("A GROUP'S CALENDAR OPENS at its first coming-up gathering's next date, else its most recent past one's, in the zone; with neither, nothing", () => {
  const now = Date.parse('2026-11-08T18:00:00Z')
  const items = [
    listItem('past-old', '2026-06-01T22:00:00Z'),
    listItem('later', '2027-01-10T22:00:00Z'),
    listItem('soonest', '2026-12-04T20:00:00Z'),
    listItem('past-recent', '2026-10-01T22:00:00Z'),
    listItem('photos', null, 'memory'),
  ]
  // 2 PM CST on December 4 — and 1:30 AM on December 5 in Kolkata.
  expect(groupOpeningDay(items, now, CHICAGO)).toBe('2026-12-04')
  expect(groupOpeningDay(items, now, KOLKATA)).toBe('2026-12-05')
  const pastOnly = items.filter((item) => item.id.startsWith('past') || item.id === 'photos')
  expect(groupOpeningDay(pastOnly, now, CHICAGO)).toBe('2026-10-01')
  expect(groupOpeningDay([listItem('photos', null, 'memory')], now, CHICAGO)).toBeNull()
  expect(groupOpeningDay([], now, CHICAGO)).toBeNull()
})

// ---------------------------------------------------------------- over or not

test('OVER OR NOT, at the boundary: a date is over once its end is not ahead of now — the instant, never the day', () => {
  const withEnd = date({ starts_at: '2026-11-14T22:00:00Z', ends_at: '2026-11-15T03:00:00Z' })
  expect(isOver(withEnd, Date.parse('2026-11-14T21:59:59.999Z'))).toBe(false)
  // In progress: still ahead.
  expect(isOver(withEnd, Date.parse('2026-11-15T00:00:00Z'))).toBe(false)
  expect(isOver(withEnd, Date.parse('2026-11-15T02:59:59.999Z'))).toBe(false)
  expect(isOver(withEnd, Date.parse('2026-11-15T03:00:00Z'))).toBe(true)
  // An hour after it ended, on the same day, it is over.
  expect(isOver(withEnd, Date.parse('2026-11-15T04:00:00Z'))).toBe(true)
})

test('OVER OR NOT, at the boundary: a date with no end is over once its start is not ahead of now', () => {
  const noEnd = date({ starts_at: '2026-11-14T22:00:00Z', ends_at: null })
  expect(isOver(noEnd, Date.parse('2026-11-14T21:59:59.999Z'))).toBe(false)
  expect(isOver(noEnd, Date.parse('2026-11-14T22:00:00Z'))).toBe(true)
})

// ---------------------------------------------------------------- the read

test('the read: a loaded answer, a group\'s 404 or 422 the not-found screen, anything else a failure — and the tab\'s own 404 a failure', async () => {
  setToken('token-1')
  const answers: Array<() => Response | Promise<Response>> = [
    () => Response.json({ dates: [date()], gatherings: [gathering()] }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 422 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 404 }),
    () => Promise.reject(new TypeError('offline')),
  ]
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    asked.push(String(input))
    const next = answers.shift()
    if (!next) throw new Error('no answer left')
    return next()
  }))
  try {
    const loaded = await readCalendar('2026-11', CHICAGO, null)
    expect(loaded.status).toBe('loaded')
    expect(loaded.status === 'loaded' && loaded.answer.dates.map((item) => item.id)).toEqual(['o-1'])
    expect(await readCalendar('2026-11', CHICAGO, 'grp-1')).toEqual({ status: 'notFound' })
    expect(await readCalendar('2026-11', CHICAGO, 'grp-1')).toEqual({ status: 'notFound' })
    expect(await readCalendar('2026-11', CHICAGO, 'grp-1')).toEqual({ status: 'failed' })
    expect(await readCalendar('2026-11', CHICAGO, null)).toEqual({ status: 'failed' })
    expect(await readCalendar('2026-11', CHICAGO, null)).toEqual({ status: 'failed' })
    expect(asked[0]).toMatch(/\/calendar\?from=2026-11-01T05%3A00%3A00\.000Z&to=2026-12-01T06%3A00%3A00\.000Z$/)
    expect(asked[1]).toMatch(/\/groups\/grp-1\/calendar\?from=/)
  } finally {
    vi.unstubAllGlobals()
  }
})
