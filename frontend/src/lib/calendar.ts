// The calendar's types, helpers, read and words (CK-91;
// decisions/2026-10-04-calendars-and-alerts-by-scope.md §1, §2; the merge
// record's §3 item 11; the mockup's `eachDay`, `dayIndex`, `monthDefaultSel`,
// `evLine`, `span` and `whereText`).
//
// EVERY DAY HERE IS A DAY IN THE PROFILE'S ZONE. A day is `YYYY-MM-DD` and a
// month `YYYY-MM`, both plain strings — a label on the zone's calendar, never
// a `Date` — and the only bridges between an instant and a day are `dayOf`
// (an instant's day in the zone) and `dayStart` (a day's first instant in the
// zone). Nothing reads the runner's zone: a person in Chicago reading on a
// laptop set to Tokyo sees Chicago's days.
//
// WHO SEES A DATE IS THE ROUTE'S, never this module's: the calendar draws
// every date CK-90's route answers and decides nothing about who may see it.
//
// THE READ is one request per shown month — `GET /calendar` or `GET
// /groups/{id}/calendar` — from the month's first day at 00:00 in the zone to
// the next month's first day at 00:00 in the zone, each sent as its `Z`
// instant through URLSearchParams (a `+` in a query string reads as a space).
// At most 31 days and a daylight-saving hour, inside the route's 62.
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { authFetch } from './api'
import type { CoverBody } from './covers'
import { formatTime, instantToWallClock, wallClockToInstant } from './datetime'
import { gatheringSections, NOT_IN_A_GROUP } from './gatherings'
import type { GatheringGroup, GatheringListItem } from './gatherings'

// One date, as the route answers it: the gathering detail's date, the caller's
// own answer on it, and its place among ALL its gathering's dates.
export interface CalendarDate {
  id: string
  gathering_id: string
  starts_at: string
  ends_at: string | null
  location: string | null
  map_url: string | null
  caller_response: 'yes' | 'maybe' | 'no' | null
  position: number
}

// One gathering, once, beside its dates: the list item's facts, how many dates
// it has in all, and how many published photos the caller can see.
export interface CalendarGathering {
  id: string
  title: string
  gathering_type: string
  cover?: CoverBody | null
  group: GatheringGroup | null
  date_count: number
  published_count: number
}

export interface CalendarAnswer {
  dates: CalendarDate[]
  gatherings: CalendarGathering[]
}

// A date with its gathering beside it — a row of the day's list, a mark, a chip.
export interface CalendarEntry {
  date: CalendarDate
  gathering: CalendarGathering
}

export type CalendarRead =
  | { status: 'loaded'; answer: CalendarAnswer }
  // A 404 (or a path 422) on a group's calendar: the group page's one
  // not-found screen. The tab's own read has no 404.
  | { status: 'notFound' }
  | { status: 'failed' }

// ---------------------------------------------------------------- the words

export const CALENDAR = 'Calendar'
export const TODAY = 'Today'
export const PREVIOUS_MONTH = 'Previous month'
export const NEXT_MONTH = 'Next month'
export const NOTHING_ON_THIS_DAY = 'Nothing on this day.'
export const MONTH_FAILED = "This month's dates couldn't be loaded just now."
export const SHOW_ALL_GROUPS = 'Show all groups'
// The Calendar row's line in a group's panel (Rail and panel).
export const GROUP_DATES_LINE = "This group's dates"
// The switch on Your gatherings.
export const VIEW_SWITCH_LABEL = 'Show gatherings as'
export const CARDS = 'Cards'
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function calendarLede(zone: string): string {
  return `Every date of every gathering you're invited to. Times in ${zone}.`
}

// Where a gathering is: its group's name, or *Not in a group* (the list's own
// words, lib/gatherings.ts).
export function whereText(gathering: Pick<CalendarGathering, 'group'>): string {
  return gathering.group ? gathering.group.name : NOT_IN_A_GROUP
}

// ------------------------------------------------------------- days, months

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function dayParts(day: string): { year: number; month: number; date: number } {
  const match = DAY.exec(day)
  if (!match) throw new Error(`not a day: ${day}`)
  return { year: Number(match[1]), month: Number(match[2]), date: Number(match[3]) }
}

// A UTC date standing for a calendar day — arithmetic only, never read in a zone.
function utcOf(day: string): Date {
  const { year, month, date } = dayParts(day)
  return new Date(Date.UTC(year, month - 1, date))
}

function dayFromUtc(value: Date): string {
  return value.toISOString().slice(0, 10)
}

// The address's `day`, or null when it is missing or not a real calendar date
// (`2026-02-30`, `2026-13-01`, `tomorrow`) — which reads as no day.
export function parseDay(value: string | null | undefined): string | null {
  if (!value || !DAY.test(value)) return null
  const { year } = dayParts(value)
  if (year < 1000) return null
  return dayFromUtc(utcOf(value)) === value ? value : null
}

// The day an instant falls on in `zone`.
export function dayOf(iso: string, zone: string): string {
  return instantToWallClock(iso, zone).slice(0, 10)
}

// Today in `zone`.
export function todayIn(zone: string, now: number = Date.now()): string {
  return dayOf(new Date(now).toISOString(), zone)
}

export function monthOf(day: string): string {
  return day.slice(0, 7)
}

export function shiftDay(day: string, delta: number): string {
  const value = utcOf(day)
  value.setUTCDate(value.getUTCDate() + delta)
  return dayFromUtc(value)
}

export function shiftMonth(month: string, delta: number): string {
  const { year, month: m } = dayParts(`${month}-01`)
  return dayFromUtc(new Date(Date.UTC(year, m - 1 + delta, 1))).slice(0, 7)
}

// A day's first instant in `zone`, as its `Z` form. A zone whose clocks jump
// at midnight (a few do) has no 00:00 on that day; the conversion then lands
// beside it, and a landing on the day before is moved on into the day.
export function dayStart(day: string, zone: string): string {
  let instant = wallClockToInstant(`${day}T00:00`, zone)
  for (let step = 0; step < 3 && dayOf(instant, zone) < day; step += 1) {
    instant = new Date(Date.parse(instant) + 60 * 60 * 1000).toISOString()
  }
  return instant
}

// The month's read: its first day at 00:00 in the zone, up to — not including
// — the next month's first day at 00:00 in the zone.
export function monthRange(month: string, zone: string): { from: string; to: string } {
  return { from: dayStart(`${month}-01`, zone), to: dayStart(`${shiftMonth(month, 1)}-01`, zone) }
}

// The month's grid: how many blank cells lead (the 1st's weekday, Sunday
// first) and each of its days.
export function monthDays(month: string): { lead: number; days: string[] } {
  const first = utcOf(`${month}-01`)
  const days: string[] = []
  for (let value = new Date(first); value.getUTCMonth() === first.getUTCMonth(); value.setUTCDate(value.getUTCDate() + 1)) {
    days.push(dayFromUtc(value))
  }
  return { lead: first.getUTCDay(), days }
}

// The days a date covers in `zone` (the mockup's `eachDay`, with the route's
// half-open rule): from its start's day to the day of the instant JUST BEFORE
// its end, so a date ending exactly at midnight does not spill onto the next
// day. A date with no end — or an end not after its start — covers its
// start's day alone.
export function daysCovered(date: Pick<CalendarDate, 'starts_at' | 'ends_at'>, zone: string): string[] {
  const first = dayOf(date.starts_at, zone)
  const start = Date.parse(date.starts_at)
  const end = date.ends_at === null ? null : Date.parse(date.ends_at)
  const last = end !== null && end > start ? dayOf(new Date(end - 1).toISOString(), zone) : first
  const days: string[] = []
  for (let day = first; day <= last; day = shiftDay(day, 1)) days.push(day)
  return days
}

// Each of the shown month's days with its dates, in the route's order (by
// `starts_at`, then the gathering, then the date). A date is drawn only on the
// shown month's days, and one whose gathering the answer does not carry is
// left out rather than drawn without a name.
export function datesByDay(answer: CalendarAnswer, month: string, zone: string): Map<string, CalendarEntry[]> {
  const gatherings = new Map(answer.gatherings.map((gathering) => [gathering.id, gathering]))
  const byDay = new Map<string, CalendarEntry[]>()
  for (const date of answer.dates) {
    const gathering = gatherings.get(date.gathering_id)
    if (gathering === undefined) continue
    for (const day of daysCovered(date, zone)) {
      if (monthOf(day) !== month) continue
      const entries = byDay.get(day)
      if (entries) entries.push({ date, gathering })
      else byDay.set(day, [{ date, gathering }])
    }
  }
  return byDay
}

// ------------------------------------------------------------- the selection

// On moving to a month (the mockup's `monthDefaultSel`): today if it is in the
// month, else its first day with a date, else the 1st.
export function monthDefaultDay(month: string, today: string, byDay: Map<string, CalendarEntry[]>): string {
  if (monthOf(today) === month) return today
  const hit = [...byDay.keys()].filter((day) => monthOf(day) === month).sort()[0]
  return hit ?? `${month}-01`
}

// Where a group's calendar opens with no day in the address (the mockup's
// `calfor`): the group's first coming-up gathering's next date, else its first
// past one's (most recent first) — the photos-only ones carry none — as a day
// in `zone`; with neither, null (the caller then opens at today).
export function groupOpeningDay(items: GatheringListItem[], now: number, zone: string): string | null {
  const { comingUp, past } = gatheringSections(items, now)
  const item = comingUp[0] ?? past.find((candidate) => candidate.next_occurrence !== null)
  if (!item || item.next_occurrence === null) return null
  return dayOf(item.next_occurrence.starts_at, zone)
}

// ------------------------------------------------------------- the lines

function labelInUtc(day: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(utcOf(day))
}

// *November 2026* — the month card's heading.
export function monthTitle(month: string): string {
  return labelInUtc(`${month}-01`, { month: 'long', year: 'numeric' })
}

// A day's name: *Saturday, November 14*, and *: {titles}* when it has dates,
// and *, today* on today.
export function dayLabel(day: string, titles: string[], isToday: boolean): string {
  const long = labelInUtc(day, { weekday: 'long', month: 'long', day: 'numeric' })
  return `${long}${titles.length > 0 ? `: ${titles.join(', ')}` : ''}${isToday ? ', today' : ''}`
}

// The day's list's heading: *Saturday, November 14, 2026*.
export function dayHeading(day: string): string {
  return labelInUtc(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

// The line beneath it: *Today*, then *{N} gathering(s)*, joined by *·*, each
// only where true — null when neither is. N counts gatherings, not dates: a
// gathering with two dates on one day is one gathering.
export function dayLine(isToday: boolean, gatheringCount: number): string | null {
  const parts: string[] = []
  if (isToday) parts.push(TODAY)
  if (gatheringCount > 0) parts.push(`${gatheringCount} ${gatheringCount === 1 ? 'gathering' : 'gatherings'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function monthDayLabel(day: string, withMonth: boolean): string {
  return withMonth ? labelInUtc(day, { month: 'short', day: 'numeric' }) : labelInUtc(day, { day: 'numeric' })
}

// A date covering more than one day reads its span (the mockup's `span`): *Oct
// 3 – 5*, and across months *Oct 30 – Nov 2*, the end day being the day of the
// instant before its end. Null for a date on one day.
export function spanLabel(date: Pick<CalendarDate, 'starts_at' | 'ends_at'>, zone: string): string | null {
  const days = daysCovered(date, zone)
  if (days.length < 2) return null
  const first = days[0]
  const last = days[days.length - 1]
  return `${monthDayLabel(first, true)} – ${monthDayLabel(last, monthOf(first) !== monthOf(last))}`
}

// A row's time line (the mockup's `evLine`): the span — with *· starts 4:00 PM*
// on its first day — or the start time; then *· date 2 of 6* where the
// gathering has more than one date.
export function timeLine(entry: CalendarEntry, day: string, zone: string): string {
  const { date, gathering } = entry
  const span = spanLabel(date, zone)
  const start = formatTime(date.starts_at, zone)
  const time = span === null ? start : day === dayOf(date.starts_at, zone) ? `${span} · starts ${start}` : span
  return gathering.date_count > 1 ? `${time} · date ${date.position} of ${gathering.date_count}` : time
}

// Whether a date is over: its end — or its start, where it has none — is not
// ahead of now. An instant, never a day: a date that ended an hour ago has
// photos to show, not an answer to give.
export function isOver(date: Pick<CalendarDate, 'starts_at' | 'ends_at'>, now: number): boolean {
  return Date.parse(date.ends_at ?? date.starts_at) <= now
}

// ---------------------------------------------------------------- the read

const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/

// A group id read from the address, or null when it cannot name a group (it
// is then the not-found screen, with nothing asked).
export function parseGroupId(value: string | null): string | null {
  return value !== null && GROUP_ID.test(value) ? value : null
}

// The address's day, and the one way to write it: `?day=` set by REPLACE,
// the rest of the query kept, so moving around the calendar adds no history
// entry (the tab, a group's calendar and Your gatherings' Calendar view).
export function useCalendarDay(): [string | null, (day: string) => void] {
  const [params, setParams] = useSearchParams()
  const day = parseDay(params.get('day'))
  const onDay = useCallback(
    (next: string) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current)
          updated.set('day', next)
          return updated
        },
        { replace: true },
      ),
    [setParams],
  )
  return [day, onDay]
}

export function calendarPath(month: string, zone: string, groupId: string | null): string {
  const { from, to } = monthRange(month, zone)
  const query = new URLSearchParams({ from, to }).toString()
  return groupId === null ? `/calendar?${query}` : `/groups/${groupId}/calendar?${query}`
}

export async function readCalendar(month: string, zone: string, groupId: string | null): Promise<CalendarRead> {
  try {
    const response = await authFetch(calendarPath(month, zone, groupId))
    if (groupId !== null && (response.status === 404 || response.status === 422)) return { status: 'notFound' }
    if (!response.ok) return { status: 'failed' }
    const body = (await response.json()) as Partial<CalendarAnswer>
    return { status: 'loaded', answer: { dates: body.dates ?? [], gatherings: body.gatherings ?? [] } }
  } catch {
    return { status: 'failed' }
  }
}
