// Time zone helpers. Values are always IANA zone NAMES (America/Chicago),
// never UTC offsets — offsets are wrong twice a year and carry no DST rules.

export function detectTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
  } catch {
    return null
  }
}

export interface TimeZoneGroup {
  region: string
  zones: string[]
}

// The browser's full IANA list, grouped by region for an <optgroup> select.
// `extra` (the person's stored zone) is merged in even when the browser's own
// list doesn't carry it — a value the server accepted must stay selectable.
export function groupedTimeZones(extra?: string | null): TimeZoneGroup[] {
  let zones: string[]
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  if (extra && !zones.includes(extra)) zones = [...zones, extra].sort()

  const byRegion = new Map<string, string[]>()
  for (const zone of zones) {
    const slash = zone.indexOf('/')
    const region = slash === -1 ? 'Other' : zone.slice(0, slash)
    const group = byRegion.get(region)
    if (group) group.push(zone)
    else byRegion.set(region, [zone])
  }
  return [...byRegion.entries()].map(([region, regionZones]) => ({
    region,
    zones: regionZones,
  }))
}

// "America/Argentina/Buenos_Aires" → "Argentina – Buenos Aires"
export function timeZoneLabel(zone: string): string {
  const slash = zone.indexOf('/')
  const rest = slash === -1 ? zone : zone.slice(slash + 1)
  return rest.replaceAll('_', ' ').replaceAll('/', ' – ')
}
