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

// "Sep 1, 2026, 6:00 PM – 9:00 PM" when the end falls on the same day in the
// zone; the end gets its own full date otherwise.
export function formatInstantRange(startIso: string, endIso: string | null, zone: string): string {
  const start = formatInstant(startIso, zone)
  if (!endIso) return start
  const sameDay =
    instantToWallClock(startIso, zone).slice(0, 10) === instantToWallClock(endIso, zone).slice(0, 10)
  const end = sameDay
    ? new Intl.DateTimeFormat(undefined, { timeZone: zone, timeStyle: 'short' }).format(
        new Date(endIso),
      )
    : formatInstant(endIso, zone)
  return `${start} – ${end}`
}
