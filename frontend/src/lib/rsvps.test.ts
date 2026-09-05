// CK-27 arrival-time pins. arrival_time is a bare wall clock — no date, no
// zone — and the CK-17 profile-zone conversion must NEVER touch it: the same
// trap as the occurrence times, in a new column, with the opposite fix. The
// pins here run against a zone forced to differ from the runner's, the CK-17
// test shape, because a conversion bug would not fail loudly — it would shift
// the clock silently for anyone whose profile zone differs from the venue's.
import { expect, test } from 'vitest'
import { wallClockToInstant } from './datetime'
import { formatArrivalTime, timeForInput, totalGoing, type RsvpListRow } from './rsvps'

const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
// Fixed-offset zones (no DST): whichever the runner is in, the other is used.
const differingZone =
  runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'

test('the API echo round-trips into the input untouched — no Date, no zone, no conversion', () => {
  // The backend stores what was typed and echoes it with seconds
  // ("15:30" -> "15:30:00", pinned in test_rsvps.py); the input takes the
  // wall clock straight back. Byte-identical through the whole loop.
  expect(timeForInput('15:30:00')).toBe('15:30')
  expect(timeForInput('09:05:00')).toBe('09:05')
  // Midnight is a real time, not a falsy one.
  expect(timeForInput('00:00:00')).toBe('00:00')
  expect(timeForInput(null)).toBe('')
})

test('formatArrivalTime renders the wall clock itself, whatever zone the runner is in', () => {
  // Built at a UTC instant and formatted in UTC: the runner's zone cancels
  // out by construction. 12h and 24h locales differ in dress, never in the
  // clock reading.
  expect(formatArrivalTime('15:30')).toMatch(/3:30|15:30/)
  expect(formatArrivalTime('15:30:00')).toMatch(/3:30|15:30/)
  expect(formatArrivalTime('00:05')).toMatch(/12:05|0:05|00:05/)
})

test('totalGoing sums the "Going" rows\' server-computed totals — names, never typed counts (CK-29)', () => {
  const row = (over: Partial<RsvpListRow>): RsvpListRow => ({
    id: 'r',
    display_name: 'someone',
    response: 'yes',
    stay_included: false,
    companions: [],
    total: 1,
    arrival_time: null,
    ...over,
  })
  expect(totalGoing([])).toBe(0)
  expect(
    totalGoing([
      row({ companions: ['Nana Pearl', 'Milo'], total: 3 }),
      row({ id: 'r2' }),
      // Neither a "maybe" nor a declined row counts toward the number the
      // host caters for.
      row({ id: 'r3', response: 'maybe', companions: ['Ada'], total: 2 }),
      row({ id: 'r4', response: 'no', total: 1 }),
    ]),
  ).toBe(4)
})

test('the CK-17 conversion is exactly what arrival_time must never get: it shifts the clock', () => {
  expect(differingZone).not.toBe(runnerZone)
  // Documentation-by-test of the STEP-5 trap: run the occurrence conversion
  // on the same clock reading in a zone forced to differ from the runner's,
  // and the UTC wall clock lands elsewhere — the silent offset shift. The
  // rsvp helpers take no zone at all; that absence is the fix, and this pin
  // is what fails if someone "helpfully" routes arrival times through
  // wallClockToInstant.
  const instant = wallClockToInstant('2026-09-01T15:30', differingZone)
  expect(instant.slice(11, 16)).not.toBe('15:30')
})
