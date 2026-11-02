// CK-17 timezone-conversion pins. The trap under test: `new Date(wallClock)`
// interprets a zoneless string in the RUNNER's zone, so a conversion that is
// only exercised against the runner's own zone proves nothing. Every
// assertion here runs against a zone guaranteed to differ from the runner's.
import { expect, test } from 'vitest'
import {
  badgeParts,
  effectiveZone,
  formatDay,
  formatDayWithYear,
  formatInstantRange,
  formatTime,
  instantToWallClock,
  wallClockToInstant,
} from './datetime'

// Two fixed-offset zones (neither observes DST, so expected values are
// stable), chosen so whichever the runner is in, the other is used.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zone = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
// Kiritimati is UTC+14 year-round; Honolulu UTC-10 year-round.
const expectedInstant =
  zone === 'Pacific/Kiritimati' ? '2026-09-01T04:00:00.000Z' : '2026-09-02T04:00:00.000Z'

test('wall clock converts in the given zone, not the runner zone', () => {
  expect(zone).not.toBe(runnerZone)
  expect(wallClockToInstant('2026-09-01T18:00', zone)).toBe(expectedInstant)
})

test('instant renders back as the wall clock of the given zone', () => {
  expect(instantToWallClock(expectedInstant, zone)).toBe('2026-09-01T18:00')
})

test('round trip never changes the time', () => {
  for (const wallClock of ['2026-09-01T18:00', '2026-01-15T00:00', '2026-06-30T23:45']) {
    expect(instantToWallClock(wallClockToInstant(wallClock, zone), zone)).toBe(wallClock)
  }
})

test('load → render → save without editing returns the byte-identical instant, three times over', () => {
  // The CK-18 hazard: the detail page renders a stored instant into the form
  // (instantToWallClock) and every save converts the form value back
  // (wallClockToInstant). A zone bug here does not fail loudly — it shifts
  // the time by the offset, and shifts it AGAIN on the next save; three
  // unedited saves would compound it. Both directions run in a zone forced to
  // differ from the runner's, and in a DST-observing zone.
  for (const testZone of [zone, 'America/Chicago']) {
    for (const start of ['2026-07-04T23:30:00.000Z', '2026-01-15T06:00:00.000Z']) {
      let instant = start
      for (let i = 0; i < 3; i++) {
        const rendered = instantToWallClock(instant, testZone)
        instant = wallClockToInstant(rendered, testZone)
        expect(instant).toBe(start)
      }
    }
  }
})

test('DST-observing zone gets the offset of the date, not of today', () => {
  // America/Chicago: CDT (UTC-5) in July, CST (UTC-6) in January.
  expect(wallClockToInstant('2026-07-01T12:00', 'America/Chicago')).toBe(
    '2026-07-01T17:00:00.000Z',
  )
  expect(wallClockToInstant('2026-01-15T12:00', 'America/Chicago')).toBe(
    '2026-01-15T18:00:00.000Z',
  )
  expect(instantToWallClock('2026-07-01T17:00:00.000Z', 'America/Chicago')).toBe(
    '2026-07-01T12:00',
  )
})

test('midnight survives the hour-cycle edge', () => {
  const iso = wallClockToInstant('2026-03-03T00:00', zone)
  expect(instantToWallClock(iso, zone)).toBe('2026-03-03T00:00')
})

test('effectiveZone prefers the profile zone over the browser zone', () => {
  expect(effectiveZone('Pacific/Kiritimati')).toBe('Pacific/Kiritimati')
  // No profile zone → the browser's (the CK-7 capture makes this rare).
  expect(effectiveZone(null)).toBe(runnerZone)
})

// MOVED AT CK-87.1, with its reason: When's date line takes the mockup's
// form, naming its weekday (`rangeLine()`; Steven, 2026-11-02) — so a
// cross-day end carries its day and weekday and NOT its year, where the
// CK-17 pin required the year there. The rules this test held stay held: a
// same-day end is a time alone, a cross-day end carries its day, and "the
// same day" is read in the given zone, never the runner's.
test("When's date line names its weekday, as literals: the same day, across two days and with no end — in the given zone, never the runner's (CK-87.1)", () => {
  const start = wallClockToInstant('2026-07-04T16:00', zone)
  expect(formatInstantRange(start, wallClockToInstant('2026-07-04T23:00', zone), zone)).toBe(
    'Sat, Jul 4, 2026, 4:00 PM – 11:00 PM',
  )
  expect(
    formatInstantRange(wallClockToInstant('2026-07-04T22:00', zone), wallClockToInstant('2026-07-05T01:00', zone), zone),
  ).toBe('Sat, Jul 4, 2026, 10:00 PM – Sun, Jul 5, 1:00 AM')
  expect(formatInstantRange(start, null, zone)).toBe('Sat, Jul 4, 2026, 4:00 PM')
  // The same day in the zone though the two instants fall on different days
  // in UTC (in either zone) — the day is the zone's, so the end is a time.
  expect(
    formatInstantRange(wallClockToInstant('2026-07-04T10:00', zone), wallClockToInstant('2026-07-04T16:00', zone), zone),
  ).toBe('Sat, Jul 4, 2026, 10:00 AM – 4:00 PM')
  // The runner's zone reads another clock for the same instant.
  expect(formatInstantRange(start, null, runnerZone)).not.toBe('Sat, Jul 4, 2026, 4:00 PM')
})

test('formatDay names the day an instant falls on in the given zone — short month and day (CK-74)', () => {
  // A renewal at 02:10 UTC on Nov 12 is the evening of Nov 11 in Pacific
  // time, and the plan screen must say Nov 11 there — the profile zone,
  // never the browser's.
  expect(formatDay('2026-11-12T02:10:00+00:00', 'America/Los_Angeles')).toBe('Nov 11')
  expect(formatDay('2026-11-12T02:10:00+00:00', 'UTC')).toBe('Nov 12')
  expect(formatDay('2026-11-12T02:10:00+00:00', 'Pacific/Kiritimati')).toBe('Nov 12')
  expect(formatDay('2026-11-12T23:30:00+00:00', 'Pacific/Kiritimati')).toBe('Nov 13')
})

// CK-85: the gathering cards' time alone, day with its year, and the date
// badge's two halves — each through the given zone, never the runner's.
test('formatTime is the time of day alone in the given zone, as the cards draw it (CK-85)', () => {
  expect(formatTime(wallClockToInstant('2026-09-01T18:30', zone), zone)).toBe('6:30 PM')
  expect(formatTime(wallClockToInstant('2026-09-01T00:05', zone), zone)).toBe('12:05 AM')
  // The same instant reads another clock in another zone.
  expect(formatTime('2026-11-12T02:10:00+00:00', 'America/Los_Angeles')).toBe('6:10 PM')
  expect(formatTime('2026-11-12T02:10:00+00:00', 'UTC')).toBe('2:10 AM')
})

test('formatDayWithYear is the day with its year in the given zone, for a past card (CK-85)', () => {
  expect(formatDayWithYear(wallClockToInstant('2026-10-03T12:00', zone), zone)).toBe('Oct 3, 2026')
  // The evening of Dec 31 in Pacific time is already the new year in UTC.
  expect(formatDayWithYear('2027-01-01T05:00:00+00:00', 'America/Los_Angeles')).toBe('Dec 31, 2026')
  expect(formatDayWithYear('2027-01-01T05:00:00+00:00', 'UTC')).toBe('Jan 1, 2027')
})

test("badgeParts: the badge's month and day name the same day, in the given zone and never the runner's (CK-85)", () => {
  // Half past midnight on Mar 1 in the profile zone is still Feb 28 — or
  // already Mar 2 — in the runner's.
  const instant = wallClockToInstant('2035-03-01T00:30', zone)
  expect(badgeParts(instant, zone)).toEqual({ month: 'Mar', day: '1' })
  expect(formatDay(instant, runnerZone)).not.toBe('Mar 1')
  expect(badgeParts('2026-11-12T23:30:00+00:00', 'Pacific/Kiritimati')).toEqual({ month: 'Nov', day: '13' })
  expect(badgeParts('2026-11-12T23:30:00+00:00', 'UTC')).toEqual({ month: 'Nov', day: '12' })
})
