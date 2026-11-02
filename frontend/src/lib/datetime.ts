// Wall-clock ↔ instant conversion in an EXPLICIT IANA zone (CK-17).
//
// The rule (decisions/2026-08-25-occurrence-time-entry.md): a wall-clock time
// entered in a form is interpreted in the person's PROFILE time zone, falling
// back to the browser's zone only when the profile has none. Never
// `new Date(wallClock)` — JavaScript would interpret the zoneless string in
// the browser's zone, which is silently wrong for anyone whose device zone
// differs from their profile zone. The same explicit zone renders times back,
// so a round-trip never appears to change the time.

import { detectTimeZone } from './timezone'

// The zone a person's gathering times are entered and rendered in. The
// browser fallback is rare in practice — CK-7's silent capture fills the
// profile zone on first sign-in — and 'UTC' only guards the pathological
// browser that reports no zone at all.
export function effectiveZone(profileZone: string | null | undefined): string {
  return profileZone ?? detectTimeZone() ?? 'UTC'
}

interface WallClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/

function parseWallClock(wallClock: string): WallClockParts {
  const match = WALL_CLOCK.exec(wallClock)
  if (!match) throw new Error(`not a wall-clock value: ${wallClock}`)
  const [, year, month, day, hour, minute] = match
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  }
}

// hourCycle 'h23' so midnight formats as "00", never "24".
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function partsInZone(zone: string, instant: Date): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const part of zoneFormatter(zone).formatToParts(instant)) {
    parts[part.type] = part.value
  }
  return parts
}

// The zone's UTC offset in milliseconds at `instant` (positive east of UTC),
// derived by formatting the instant in the zone and diffing the wall-clock
// reading against UTC — the only way the platform exposes it without a tz
// library.
function zoneOffsetMs(zone: string, instant: Date): number {
  const parts = partsInZone(zone, instant)
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

// "2026-09-01T18:00" (a datetime-local value) + "America/Chicago" → the ISO
// instant that wall clock names in that zone. Two passes: the first guesses
// the offset at the wall-clock-as-UTC instant, the second re-reads it at the
// corrected instant so a guess that lands across a DST transition settles.
// A wall clock that a spring-forward gap makes nonexistent (or a fall-back
// makes ambiguous) resolves to one of its neighbouring valid instants — fine
// for gathering times; the backend only requires the value be zone-aware.
export function wallClockToInstant(wallClock: string, zone: string): string {
  const p = parseWallClock(wallClock)
  const asUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  let instantMs = asUtcMs - zoneOffsetMs(zone, new Date(asUtcMs))
  instantMs = asUtcMs - zoneOffsetMs(zone, new Date(instantMs))
  return new Date(instantMs).toISOString()
}

// The inverse: an ISO instant → the wall clock it reads as in `zone`, in
// datetime-local form ("2026-09-01T18:00") for rendering back into inputs.
export function instantToWallClock(iso: string, zone: string): string {
  const parts = partsInZone(zone, new Date(iso))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

// Display formatting, always through an explicit zone — never the browser's
// implicit one.
export function formatInstant(iso: string, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))
}

// The DAY an instant falls on in `zone`, short month and day — "Nov 12" —
// for a line that names a date and no time (the plan's renewal, CK-74).
// Through the explicit zone like everything here: 02:10 UTC on Nov 12 is
// the evening of Nov 11 in Pacific time, and a person there reads Nov 11.
export function formatDay(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
}

// The day with its weekday — "Thu, Oct 15" — for the menu's gatherings
// coming up (CK-82), as the mockup draws them. Through the explicit zone,
// like formatDay.
export function formatWeekdayDay(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
}

// The time of day alone — "6:30 PM" — for a gathering card's date line
// (CK-85), as the mockup draws it. Through the explicit zone, like
// formatDay: the clock a person reads is the one in their profile zone.
export function formatTime(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

// The day with its year — "Oct 3, 2026" — for a past gathering's card
// (CK-85), as the mockup draws it. Through the explicit zone, like formatDay.
export function formatDayWithYear(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso))
}

// The two halves of a card's date badge (CK-85; the mockup's `dateBadge()`):
// the short month — "Oct", which the badge's style sets in capitals — and
// the day of the month — "15". One formatter for both, through the explicit
// zone, so the two halves can never name different days.
export function badgeParts(iso: string, zone: string): { month: string; day: string } {
  const parts: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
  }).formatToParts(new Date(iso))) {
    parts[part.type] = part.value
  }
  return { month: parts.month ?? '', day: parts.day ?? '' }
}

// When's date line (CK-87.1; the mockup's `rangeLine()`), naming its
// weekday: the start's day with its weekday and year and its time — "Sat,
// Jul 4, 2026, 4:00 PM" — then, when the end falls on the same day in the
// zone, its time alone — "– 11:00 PM" — or, when it does not, its day with
// its weekday and no year, and its time — "– Sun, Jul 5, 1:00 AM". Through
// the explicit zone, like everything here, in the mockup's words (en-US, as
// formatTime and formatWeekdayDay are). (Until CK-87.1 the line was
// formatInstant's medium date, no weekday, with a cross-day end's year.)
export function formatInstantRange(startIso: string, endIso: string | null, zone: string): string {
  const startDay = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(startIso))
  const start = `${startDay}, ${formatTime(startIso, zone)}`
  if (!endIso) return start
  const sameDay =
    instantToWallClock(startIso, zone).slice(0, 10) === instantToWallClock(endIso, zone).slice(0, 10)
  const end = sameDay
    ? formatTime(endIso, zone)
    : `${formatWeekdayDay(endIso, zone)}, ${formatTime(endIso, zone)}`
  return `${start} – ${end}`
}
