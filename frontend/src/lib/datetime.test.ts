// CK-17 timezone-conversion pins. The trap under test: `new Date(wallClock)`
// interprets a zoneless string in the RUNNER's zone, so a conversion that is
// only exercised against the runner's own zone proves nothing. Every
// assertion here runs against a zone guaranteed to differ from the runner's.
import { expect, test } from 'vitest'
import {
  effectiveZone,
  formatInstantRange,
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

test('same-day ranges render the end as a time, cross-day ends carry a date', () => {
  const start = wallClockToInstant('2026-09-01T18:00', zone)
  const sameDayEnd = wallClockToInstant('2026-09-01T21:00', zone)
  const sameDay = formatInstantRange(start, sameDayEnd, zone)
  expect(sameDay).toContain(' – ')
  // The end half must not repeat the date when it falls on the same day.
  expect(sameDay.split(' – ')[1]).not.toMatch(/2026/)
  const nextDayEnd = wallClockToInstant('2026-09-02T01:00', zone)
  expect(formatInstantRange(start, nextDayEnd, zone).split(' – ')[1]).toMatch(/2026/)
})
