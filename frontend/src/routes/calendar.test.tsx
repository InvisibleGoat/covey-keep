// CK-91 — the calendar on the surface: its tab, a group's calendar and the
// Calendar view on Your gatherings, through the app's REAL route table with the
// REAL AuthProvider over the real session store (the CK-76.1 Gotcha). The
// values under test:
// - EVERY DAY IS THE PROFILE'S: the person's zone is America/Chicago (the
//   runner's is not — the guard below), today is November 8, 2026 there, and
//   the month's read runs from its first midnight to the next month's, both in
//   that zone, sent as Z instants;
// - THE READ: one request per shown month, an answer for a month no longer
//   shown ignored, nothing read but the calendar route (and, for a group's
//   calendar, the group and — with no day — its gatherings);
// - THE GRID: each day a button with its label and `aria-pressed`, marks on a
//   phone and chips from 640px, each cover at the thumbnail layer through the
//   one cache; one tab stop and the arrows;
// - THE MOVES write `day` by replace, so moving adds no history entry and Back
//   from a gathering lands on the same day;
// - THE DAY'S LIST: each row's parts as literals, the answer chip while the
//   date is not over and the photo count once it is, and *Nothing on this day.*
//   only once the month's answer has landed;
// - A GROUP'S CALENDAR: reached from the panel's row and the group page's
//   button, opening at the group's next date, *Showing {name} only*, Show all
//   groups keeping the day, and the group page's not-found screen;
// - YOUR GATHERINGS' SWITCH: Cards unchanged, Calendar reading no list, the
//   choice stored by its one module.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate, useNavigationType, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { chooseGatheringsView, GATHERINGS_VIEW_KEY } from '../lib/gatheringsView'
import { chooseMenuLayout } from '../lib/menuLayout'
import { setToken } from '../lib/session'

const ZONE = 'America/Chicago'
// Noon on Sunday, November 8, 2026 in Chicago.
const NOW = '2026-11-08T18:00:00Z'

// The month reads, as literals: November in Chicago runs from its first
// midnight in CDT to December's in CST.
const NOV = 'from=2026-11-01T05%3A00%3A00.000Z&to=2026-12-01T06%3A00%3A00.000Z'
const OCT = 'from=2026-10-01T05%3A00%3A00.000Z&to=2026-11-01T05%3A00%3A00.000Z'
const DEC = 'from=2026-12-01T06%3A00%3A00.000Z&to=2027-01-01T06%3A00%3A00.000Z'

const LEES = { id: 'g-1', name: 'The Lees' }
const COVER = { source: 'photo', media_id: 'm-1', set_at: '2026-11-01T00:00:00+00:00' }

type Row = Record<string, unknown>

function gathering(id: string, title: string, extra: Row = {}): Row {
  return { id, title, gathering_type: 'potluck', cover: null, group: null, date_count: 1, published_count: 0, ...extra }
}

function date(id: string, gatheringId: string, startsAt: string, extra: Row = {}): Row {
  return {
    id,
    gathering_id: gatheringId,
    starts_at: startsAt,
    ends_at: null,
    location: null,
    map_url: null,
    caller_response: null,
    position: 1,
    ...extra,
  }
}

// November, in the route's order. Nov 14 holds four dates; Nov 2 three that
// are over; Nov 8 (today) one still ahead; a weekend spans Nov 20–22.
const NOVEMBER = {
  dates: [
    date('o-picnic', 'g-picnic', '2026-11-02T17:00:00Z', { ends_at: '2026-11-02T21:00:00Z' }),
    date('o-hike', 'g-hike', '2026-11-02T19:00:00Z'),
    date('o-supper', 'g-supper', '2026-11-02T23:00:00Z', { ends_at: '2026-11-03T02:00:00Z' }),
    date('o-brunch', 'g-brunch', '2026-11-08T20:00:00Z', { ends_at: '2026-11-08T22:00:00Z', caller_response: 'maybe' }),
    date('o-recital', 'g-recital', '2026-11-14T15:00:00Z'),
    date('o-season-3', 'g-season', '2026-11-14T18:00:00Z', { ends_at: '2026-11-14T20:00:00Z', caller_response: 'maybe', position: 3 }),
    date('o-thanks', 'g-thanks', '2026-11-14T22:00:00Z', { ends_at: '2026-11-15T03:00:00Z', caller_response: 'yes' }),
    date('o-game', 'g-game', '2026-11-15T01:00:00Z'),
    date('o-cabin', 'g-cabin', '2026-11-20T22:00:00Z', { ends_at: '2026-11-22T18:00:00Z', caller_response: 'no' }),
    date('o-season-4', 'g-season', '2026-11-21T18:00:00Z', { position: 4 }),
  ],
  gatherings: [
    gathering('g-picnic', 'Fall picnic', { group: LEES, published_count: 12 }),
    gathering('g-hike', 'Morning hike', { published_count: 1 }),
    gathering('g-supper', 'Sunday supper', { group: LEES }),
    gathering('g-brunch', 'Brunch'),
    gathering('g-recital', "Ruby's Recital"),
    gathering('g-season', 'Soccer season', { group: LEES, cover: COVER, date_count: 6 }),
    gathering('g-thanks', 'Thanksgiving', { group: LEES, cover: COVER }),
    gathering('g-game', 'Game night'),
    gathering('g-cabin', 'Cabin weekend', { group: LEES }),
  ],
}

const OCTOBER = {
  dates: [date('o-oct', 'g-oct', '2026-10-10T17:00:00Z')],
  gatherings: [gathering('g-oct', 'Apple picking', { group: LEES })],
}

const DECEMBER = {
  dates: [date('o-feast', 'g-feast', '2026-12-12T18:00:00Z')],
  gatherings: [gathering('g-feast', 'Winter feast', { group: LEES })],
}

const BY_MONTH: Record<string, unknown> = { [NOV]: NOVEMBER, [OCT]: OCTOBER, [DEC]: DECEMBER }

function groupBody(id: string, name: string) {
  return {
    id,
    name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: 4,
    caller_role: 'member',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function listItem(id: string, title: string, startsAt: string | null, view = 'full'): Row {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-a',
    host_account_id: 'acct-a',
    group: LEES,
    caller_role: null,
    caller_view: view,
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? 0 : 1,
  }
}

// The group's gatherings: a coming-up one in December, a past one in October.
const GROUP_GATHERINGS = [
  listItem('g-oct', 'Apple picking', '2026-10-10T17:00:00Z'),
  listItem('g-feast', 'Winter feast', '2026-12-12T18:00:00Z'),
  listItem('g-photos', 'Old reunion', null, 'memory'),
]

interface World {
  zone: string
  // The calendar route's answer for a query, or a status.
  calendar: (query: string, group: string | null) => Response
  groupGatherings: Row[]
  // Reads of these exact paths wait until released.
  held: Map<string, Array<() => void>>
}

let world: World
let mock: ReturnType<typeof vi.fn>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function answer(path: string): Response {
  if (path === '/auth/me') {
    return json(200, { id: 'person-bea', display_name: 'Bea', email: 'bea@example.com', timezone: world.zone, account_id: 'acct-bea' })
  }
  if (path === '/groups') return json(200, { groups: [groupBody('g-1', 'The Lees')] })
  if (path === '/gatherings') {
    return json(200, { gatherings: [listItem('g-feast', 'Winter feast', '2026-12-12T18:00:00Z')] })
  }
  if (path === '/groups/g-1') return json(200, groupBody('g-1', 'The Lees'))
  // A group the person is in but that the menu does not hold (a stale list).
  if (path === '/groups/g-2') return json(200, groupBody('g-2', 'The Okafors'))
  if (path === '/groups/g-1/gatherings') return json(200, { gatherings: world.groupGatherings })
  if (path === '/groups/g-2/gatherings') return json(200, { gatherings: [] })
  if (/^\/groups\/g-1\/media$/.test(path)) return json(200, { sections: [] })
  const tab = path.match(/^\/calendar\?(.*)$/)
  if (tab) return world.calendar(tab[1], null)
  const group = path.match(/^\/groups\/([\w-]+)\/calendar\?(.*)$/)
  if (group) return world.calendar(group[2], group[1])
  if (path.includes('/cover/url?layer=')) {
    return json(200, { layer: 'thumbnail', content_type: 'image/webp', size_bytes: 3, url: `https://r2.invalid${path}&X-Amz-Signature=sig`, method: 'GET', expires_in: 300 })
  }
  const detail = path.match(/^\/gatherings\/([\w-]+)$/)
  if (detail) {
    const { next_occurrence: _n, occurrence_count: _c, ...rest } = listItem(detail[1], 'A gathering', null)
    return json(200, { ...rest, occurrences: [] })
  }
  if (/^\/gatherings\/[\w-]+\/media/.test(path)) return json(200, { media: [] })
  if (path === '/billing') return json(500, {})
  return json(404, { detail: 'Not Found' })
}

function defaultCalendar(query: string, group: string | null): Response {
  if (group === 'g-1' || group === null) return json(200, BY_MONTH[query] ?? { dates: [], gatherings: [] })
  if (group === 'g-2') return json(404, { detail: 'Not Found' })
  return json(404, { detail: 'Not Found' })
}

function stubServer() {
  world = { zone: ZONE, calendar: defaultCalendar, groupGatherings: GROUP_GATHERINGS, held: new Map() }
  mock = vi.fn((url: string, init?: RequestInit) => {
    const raw = String(url)
    if (raw.startsWith('https://r2.invalid/')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    if ((init?.method ?? 'GET') !== 'GET') return Promise.resolve(json(404, {}))
    const waiting = world.held.get(path)
    if (waiting) return new Promise<Response>((resolve) => waiting.push(() => resolve(answer(path))))
    return Promise.resolve(answer(path))
  })
  vi.stubGlobal('fetch', mock)
}

function hold(path: string) {
  world.held.set(path, [])
}

async function release(path: string) {
  await act(async () => {
    const waiting = world.held.get(path) ?? []
    world.held.delete(path)
    for (const go of waiting) go()
  })
  await settle()
}

// The API's own requests, in order: never the presigned bucket fetch.
function reads(): string[] {
  return mock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => !url.startsWith('https://r2.invalid/'))
    .map((url) => url.replace(/^https?:\/\/[^/]+/, ''))
}

const calendarReads = () => reads().filter((path) => /^(\/groups\/[\w-]+)?\/calendar\?/.test(path))

// matchMedia as the frame and the grid read it: a phone, or wide (from 900px,
// so from 640px too).
function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: wide, media: '', addEventListener: () => {}, removeEventListener: () => {} })),
  )
}

const nav: { current: NavigateFunction | null } = { current: null }
function Probe() {
  const location = useLocation()
  const type = useNavigationType()
  const navigate = useNavigate()
  useEffect(() => {
    nav.current = navigate
  })
  return (
    <>
      <span data-testid="at">{location.pathname + location.search}</span>
      <span data-testid="how">{type}</span>
    </>
  )
}

function renderApp(entries: string[], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <AuthProvider>
        <App />
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function settle(ms = 20) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

const where = () => screen.getByTestId('at').textContent
const how = () => screen.getByTestId('how').textContent
const page = () => document.querySelector('main') as HTMLElement
const grid = () => document.querySelector('.days') as HTMLElement
const agenda = () => document.querySelector('.agenda') as HTMLElement
const dayButton = (day: string) => grid().querySelector(`button[data-day="${day}"]`) as HTMLButtonElement
const pressed = () => [...grid().querySelectorAll('button[aria-pressed="true"]')].map((b) => b.getAttribute('data-day'))
const monthHeading = () => document.querySelector('.cal-title')?.textContent

async function back() {
  await act(async () => nav.current?.(-1))
  await settle()
}

async function openCalendar(address = '/calendar') {
  renderApp([address])
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
}

let objectUrls = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  clearCoverPictures()
  localStorage.clear()
  setToken('token-bea')
  stubServer()
  objectUrls = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:cover-${(objectUrls += 1)}`, revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  chooseMenuLayout('list')
  chooseGatheringsView('cards')
  localStorage.clear()
  document.body.classList.remove('menu-open')
})

test('the guard: the runner is not in the profile zone, so a day read in the runner\'s zone would fail these tests', () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(ZONE)
})

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

test('THE TAB: the heading, the lede naming the zone, New gathering, four tabs with Calendar current, and November with today selected', async () => {
  await openCalendar()
  expect(page().classList.contains('page-column')).toBe(true)
  expect(screen.getByText(`Every date of every gathering you're invited to. Times in ${ZONE}.`)).toBeTruthy()
  expect(within(page()).getByRole('link', { name: 'New gathering' }).getAttribute('href')).toBe('/gatherings/new')
  const tabs = within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Groups', 'Gatherings', 'Calendar', 'You'])
  expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, null, 'page', null])
  expect(monthHeading()).toBe('November 2026')
  expect(document.querySelector('.cal-title')?.getAttribute('aria-live')).toBe('polite')
  expect(pressed()).toEqual(['2026-11-08'])
  expect(dayButton('2026-11-08').classList.contains('today')).toBe(true)
  expect(document.querySelectorAll('button.day.today')).toHaveLength(1)
  // The weekday row, hidden from a reader: the days' labels name the weekday.
  const week = document.querySelector('.wk') as HTMLElement
  expect(week.getAttribute('aria-hidden')).toBe('true')
  expect([...week.children].map((cell) => cell.textContent)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  // No day is in the address: the tab opens at today.
  expect(where()).toBe('/calendar')
})

test("THE GRID: November's thirty days as buttons, Sunday first — no blank before the 1st and five after the 30th, each blank hidden", async () => {
  await openCalendar()
  const cells = [...grid().children]
  expect(cells).toHaveLength(35)
  expect(grid().querySelectorAll('button.day')).toHaveLength(30)
  expect((cells[0] as HTMLElement).getAttribute('data-day')).toBe('2026-11-01')
  const blanks = cells.filter((cell) => cell.classList.contains('blank'))
  expect(blanks).toHaveLength(5)
  for (const blank of blanks) expect(blank.getAttribute('aria-hidden')).toBe('true')
  expect(dayButton('2026-11-14').querySelector('.num')?.textContent).toBe('14')
})

test("THE READ: one request for the shown month, from its first midnight to the next month's in the zone, each a Z instant with no `+`", async () => {
  await openCalendar()
  expect(calendarReads()).toEqual([`/calendar?${NOV}`])
  expect(calendarReads()[0]).not.toContain('+')
})

test("THE READ east of UTC: a person in Asia/Kolkata reads November from October 31, 18:30 UTC", async () => {
  world.zone = 'Asia/Kolkata'
  await openCalendar()
  expect(calendarReads()).toEqual(['/calendar?from=2026-10-31T18%3A30%3A00.000Z&to=2026-11-30T18%3A30%3A00.000Z'])
})

test("THE READ: one request per month moved to, and no month kept — Next then Previous reads November, December and November again", async () => {
  await openCalendar()
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await settle()
  expect(monthHeading()).toBe('December 2026')
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
  await settle()
  expect(monthHeading()).toBe('November 2026')
  expect(calendarReads()).toEqual([`/calendar?${NOV}`, `/calendar?${DEC}`, `/calendar?${NOV}`])
})

test('THE READ: an answer for a month no longer shown is ignored — November arriving after December is never drawn', async () => {
  hold(`/calendar?${NOV}`)
  renderApp(['/calendar'])
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await settle()
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  await release(`/calendar?${NOV}`)
  expect(monthHeading()).toBe('December 2026')
  expect(dayButton('2026-12-12').getAttribute('aria-label')).toBe('Saturday, December 12: Winter feast')
  // Nothing of November's lands on December's grid or its list.
  expect(document.body.textContent).not.toMatch(/Thanksgiving|Recital|Brunch/)
  expect(within(agenda()).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/gatherings/g-feast'])
})

test('THE READ: the calendar reads nothing but the calendar route — never /members, a gathering list or a gathering\'s detail', async () => {
  await openCalendar()
  fireEvent.click(dayButton('2026-11-14'))
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await settle()
  // The menu's two reads are the frame's (the list once, on mount); the calendar adds its own alone.
  expect(reads().filter((path) => path === '/gatherings')).toHaveLength(1)
  expect(reads().some((path) => path.includes('/members'))).toBe(false)
  expect(reads().some((path) => /^\/gatherings\/[\w-]+$/.test(path))).toBe(false)
  expect(reads().some((path) => /^\/groups\/[\w-]+/.test(path))).toBe(false)
})

// ---------------------------------------------------------------------------
// The days
// ---------------------------------------------------------------------------

test("each day's label names it, its dates' titles in order and today; `aria-pressed` on the selected day alone", async () => {
  await openCalendar()
  expect(dayButton('2026-11-14').getAttribute('aria-label')).toBe(
    "Saturday, November 14: Ruby's Recital, Soccer season, Thanksgiving, Game night",
  )
  expect(dayButton('2026-11-08').getAttribute('aria-label')).toBe('Sunday, November 8: Brunch, today')
  expect(dayButton('2026-11-09').getAttribute('aria-label')).toBe('Monday, November 9')
  // The weekend: on every day it covers.
  expect(dayButton('2026-11-20').getAttribute('aria-label')).toBe('Friday, November 20: Cabin weekend')
  expect(dayButton('2026-11-21').getAttribute('aria-label')).toBe('Saturday, November 21: Cabin weekend, Soccer season')
  expect(dayButton('2026-11-22').getAttribute('aria-label')).toBe('Sunday, November 22: Cabin weekend')
  expect(dayButton('2026-11-23').getAttribute('aria-label')).toBe('Monday, November 23')
  // Game night starts at 7 PM on the 14th in Chicago (01:00 UTC on the 15th): the 14th's, not the 15th's.
  expect(dayButton('2026-11-15').getAttribute('aria-label')).toBe('Sunday, November 15')
  expect(grid().querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1)
  expect(grid().querySelectorAll('button[aria-pressed="false"]')).toHaveLength(29)
  fireEvent.click(dayButton('2026-11-14'))
  expect(pressed()).toEqual(['2026-11-14'])
})

test('ON A PHONE: at most two covers, then +N, hidden from a reader; no chips', async () => {
  await openCalendar()
  const day = dayButton('2026-11-14')
  const marks = day.querySelector('.marks') as HTMLElement
  expect(marks.getAttribute('aria-hidden')).toBe('true')
  expect(marks.querySelectorAll('.mk')).toHaveLength(2)
  expect(marks.querySelector('.more')?.textContent).toBe('+2')
  expect(day.querySelector('.chips')).toBeNull()
  // Two dates: two covers and no count.
  const saturday = dayButton('2026-11-21').querySelector('.marks') as HTMLElement
  expect(saturday.querySelectorAll('.mk')).toHaveLength(2)
  expect(saturday.querySelector('.more')).toBeNull()
  // No date: nothing.
  expect(dayButton('2026-11-09').querySelectorAll('.mk')).toHaveLength(0)
})

test('FROM 640px: at most three chips — a cover and the title — then N more, hidden from a reader; no marks', async () => {
  stubWidth(true)
  await openCalendar()
  const day = dayButton('2026-11-14')
  const chips = day.querySelector('.chips') as HTMLElement
  expect(chips.getAttribute('aria-hidden')).toBe('true')
  const each = [...chips.querySelectorAll('.ev')]
  expect(each).toHaveLength(3)
  expect(each.map((chip) => chip.textContent)).toEqual(["Ruby's Recital", 'Soccer season', 'Thanksgiving'])
  for (const chip of each) expect(chip.querySelector('.mk')).not.toBeNull()
  expect(chips.querySelector('.more')?.textContent).toBe('1 more')
  expect(day.querySelector('.marks')).toBeNull()
})

test('THE COVERS: the thumbnail layer through the one cache — one fetch per gathering however many days and rows show it, every picture a blob: URL', async () => {
  stubWidth(true)
  await openCalendar()
  fireEvent.click(dayButton('2026-11-14'))
  await settle()
  const coverReads = reads().filter((path) => path.includes('/cover/url'))
  expect(coverReads.filter((path) => path.startsWith('/gatherings/g-season/'))).toEqual(['/gatherings/g-season/cover/url?layer=thumbnail'])
  expect(coverReads.filter((path) => path.startsWith('/gatherings/g-thanks/'))).toEqual(['/gatherings/g-thanks/cover/url?layer=thumbnail'])
  expect(coverReads.every((path) => path.endsWith('layer=thumbnail'))).toBe(true)
  // A gathering with no cover asks for none: the empty cover is drawn.
  expect(coverReads.some((path) => path.includes('g-recital'))).toBe(false)
  for (const image of document.querySelectorAll('.days img.mk, .agenda img.nthumb')) {
    expect(image.getAttribute('src')).toMatch(/^blob:cover-/)
  }
  expect(document.body.innerHTML).not.toContain('X-Amz')
})

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

test('THE KEYBOARD: the grid is one tab stop — the selected day — and the arrows move a day or a week, focus following', async () => {
  await openCalendar()
  const stops = () => [...grid().querySelectorAll('button')].filter((button) => button.tabIndex === 0)
  expect(stops().map((button) => button.getAttribute('data-day'))).toEqual(['2026-11-08'])
  expect(grid().querySelectorAll('button[tabindex="-1"]')).toHaveLength(29)
  dayButton('2026-11-08').focus()
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
  await settle()
  expect(pressed()).toEqual(['2026-11-09'])
  expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-09')
  expect(stops().map((button) => button.getAttribute('data-day'))).toEqual(['2026-11-09'])
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
  await settle()
  expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-16')
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' })
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' })
  await settle()
  expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-08')
  expect(where()).toBe('/calendar?day=2026-11-08')
  expect(how()).toBe('REPLACE')
})

test("THE KEYBOARD: at the month's edge nothing moves", async () => {
  await openCalendar('/calendar?day=2026-11-30')
  dayButton('2026-11-30').focus()
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
  await settle()
  expect(pressed()).toEqual(['2026-11-30'])
  expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-30')
  expect(monthHeading()).toBe('November 2026')
  fireEvent.click(dayButton('2026-11-02'))
  dayButton('2026-11-02').focus()
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' })
  await settle()
  expect(pressed()).toEqual(['2026-11-02'])
  fireEvent.click(dayButton('2026-11-01'))
  dayButton('2026-11-01').focus()
  fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' })
  await settle()
  expect(pressed()).toEqual(['2026-11-01'])
  expect(calendarReads()).toEqual([`/calendar?${NOV}`])
})

// ---------------------------------------------------------------------------
// The moves
// ---------------------------------------------------------------------------

test('PREVIOUS, NEXT AND TODAY each keep focus and write the day by replace: moving around the calendar adds no history entry', async () => {
  renderApp(['/groups', '/calendar'])
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  const next = screen.getByRole('button', { name: 'Next month' })
  next.focus()
  fireEvent.click(next)
  await settle()
  expect(document.activeElement).toBe(next)
  // December holds no today: once its answer lands, its first day with a date.
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  expect(where()).toBe('/calendar?day=2026-12-12')
  expect(how()).toBe('REPLACE')
  const previous = screen.getByRole('button', { name: 'Previous month' })
  previous.focus()
  fireEvent.click(previous)
  await settle()
  expect(document.activeElement).toBe(previous)
  // November holds today.
  expect(pressed()).toEqual(['2026-11-08'])
  fireEvent.click(previous)
  await settle()
  // October: its first day with a date.
  expect(monthHeading()).toBe('October 2026')
  expect(pressed()).toEqual(['2026-10-10'])
  expect(where()).toBe('/calendar?day=2026-10-10')
  fireEvent.click(previous)
  await settle()
  // September has none: the 1st.
  expect(pressed()).toEqual(['2026-09-01'])
  const today = screen.getByRole('button', { name: 'Today' })
  today.focus()
  fireEvent.click(today)
  await settle()
  expect(document.activeElement).toBe(today)
  expect(monthHeading()).toBe('November 2026')
  expect(pressed()).toEqual(['2026-11-08'])
  expect(where()).toBe('/calendar?day=2026-11-08')
  expect(how()).toBe('REPLACE')
  // Every move replaced the one entry: Back leaves the calendar.
  await back()
  expect(where()).toBe('/groups')
})

test('MOVING TO A MONTH: nothing is selected while its answer is out, then its first day with a date', async () => {
  await openCalendar()
  hold(`/calendar?${DEC}`)
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await settle()
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual([])
  expect(where()).toBe('/calendar')
  // The grid stays one tab stop: its 1st.
  expect([...grid().querySelectorAll('button')].filter((b) => b.tabIndex === 0).map((b) => b.getAttribute('data-day'))).toEqual(['2026-12-01'])
  expect(agenda().textContent).not.toContain('Nothing on this day.')
  await release(`/calendar?${DEC}`)
  expect(pressed()).toEqual(['2026-12-12'])
  expect(where()).toBe('/calendar?day=2026-12-12')
})

test('A DAY IN THE ADDRESS is the selection and its month the shown month; a day that is no real date reads as none', async () => {
  await openCalendar('/calendar?day=2026-12-12')
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  expect(calendarReads()).toEqual([`/calendar?${DEC}`])
  cleanup()
  await openCalendar('/calendar?day=2026-02-30')
  expect(monthHeading()).toBe('November 2026')
  expect(pressed()).toEqual(['2026-11-08'])
})

test('BACK FROM A GATHERING lands on the same month and day', async () => {
  renderApp(['/groups', '/calendar'])
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await settle()
  expect(where()).toBe('/calendar?day=2026-12-12')
  fireEvent.click(within(agenda()).getByRole('link', { name: /Winter feast/ }))
  await settle()
  expect(where()).toBe('/gatherings/g-feast')
  await back()
  expect(where()).toBe('/calendar?day=2026-12-12')
  await screen.findByRole('heading', { level: 3, name: 'Saturday, December 12, 2026' })
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  // And Back once more leaves the calendar: the moves made no entry of their own.
  await back()
  expect(where()).toBe('/groups')
})

test('THE CALENDAR TAB AND THE MENU\'S CALENDAR ROW go to /calendar with no day: always today', async () => {
  await openCalendar('/calendar?day=2026-12-12')
  const tab = within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: 'Calendar' })
  expect(tab.getAttribute('href')).toBe('/calendar')
  fireEvent.click(tab)
  await settle()
  expect(where()).toBe('/calendar')
  expect(monthHeading()).toBe('November 2026')
  expect(pressed()).toEqual(['2026-11-08'])
})

// ---------------------------------------------------------------------------
// The day's list
// ---------------------------------------------------------------------------

function rows(): Array<{ href: string | null; parts: string[]; right: string; dashed: boolean }> {
  return [...agenda().querySelectorAll('li')].map((row) => {
    const link = row.querySelector('a') as HTMLAnchorElement
    const words = link.querySelector('.t') as HTMLElement
    const right = link.querySelector('.right') as HTMLElement
    return {
      href: link.getAttribute('href'),
      parts: [...words.children].map((part) => part.textContent ?? ''),
      right: right.textContent ?? '',
      dashed: right.querySelector('.answer-none') !== null,
    }
  })
}

test("THE DAY'S LIST: the day in full, its line, and each row a link with its title, time line, where and the caller's own answer as the chip", async () => {
  await openCalendar()
  fireEvent.click(dayButton('2026-11-14'))
  await settle()
  expect(agenda().getAttribute('aria-live')).toBe('polite')
  expect(within(agenda()).getByRole('heading', { level: 3 }).textContent).toBe('Saturday, November 14, 2026')
  expect(agenda().querySelector('.sub')?.textContent).toBe('4 gatherings')
  expect(rows()).toEqual([
    { href: '/gatherings/g-recital', parts: ["Ruby's Recital", '9:00 AM', 'Not in a group'], right: 'Not answered', dashed: true },
    { href: '/gatherings/g-season', parts: ['Soccer season', '12:00 PM · date 3 of 6', 'The Lees'], right: 'Maybe', dashed: false },
    { href: '/gatherings/g-thanks', parts: ['Thanksgiving', '4:00 PM', 'The Lees'], right: 'Going', dashed: false },
    { href: '/gatherings/g-game', parts: ['Game night', '7:00 PM', 'Not in a group'], right: 'Not answered', dashed: true },
  ])
  // The chip is CK-87's.
  expect(agenda().querySelectorAll('.right .answer')).toHaveLength(4)
  // Each row's cover is the thumbnail mark, 48px by the list's own rule.
  expect(agenda().querySelectorAll('.nrow .nthumb')).toHaveLength(4)
})

test("THE DAY'S LIST: a date covering days reads its span, with · starts on its first day; Can't make it", async () => {
  await openCalendar()
  fireEvent.click(dayButton('2026-11-20'))
  await settle()
  expect(rows()).toEqual([
    { href: '/gatherings/g-cabin', parts: ['Cabin weekend', 'Nov 20 – 22 · starts 4:00 PM', 'The Lees'], right: "Can't make it", dashed: false },
  ])
  fireEvent.click(dayButton('2026-11-21'))
  await settle()
  expect(rows().map((row) => row.parts[1])).toEqual(['Nov 20 – 22', '12:00 PM · date 4 of 6'])
})

test("THE DAY'S LIST: once a date is over, the published photo count — 1 photo, N photos, and nothing for none", async () => {
  await openCalendar()
  fireEvent.click(dayButton('2026-11-02'))
  await settle()
  expect(rows()).toEqual([
    { href: '/gatherings/g-picnic', parts: ['Fall picnic', '11:00 AM', 'The Lees'], right: '12 photos', dashed: false },
    { href: '/gatherings/g-hike', parts: ['Morning hike', '1:00 PM', 'Not in a group'], right: '1 photo', dashed: false },
    { href: '/gatherings/g-supper', parts: ['Sunday supper', '5:00 PM', 'The Lees'], right: '', dashed: false },
  ])
  expect(agenda().querySelectorAll('.answer')).toHaveLength(0)
})

test("THE DAY'S LIST on today: the line names it, and a date later today still takes an answer", async () => {
  await openCalendar()
  expect(within(agenda()).getByRole('heading', { level: 3 }).textContent).toBe('Sunday, November 8, 2026')
  expect(agenda().querySelector('.sub')?.textContent).toBe('Today · 1 gathering')
  expect(rows()).toEqual([{ href: '/gatherings/g-brunch', parts: ['Brunch', '2:00 PM', 'Not in a group'], right: 'Maybe', dashed: false }])
  // The date ends at 4 PM: at 4 PM it is over, and its count (none) replaces the answer.
  vi.setSystemTime(new Date('2026-11-08T22:00:00Z'))
  fireEvent.click(dayButton('2026-11-09'))
  fireEvent.click(dayButton('2026-11-08'))
  await settle()
  expect(rows()[0].right).toBe('')
})

test("THE ROW'S END FOLLOWS THE DATE, NOT ITS GATHERING: a past date the person answered reads its count, and a date still to come of a gathering holding photos reads the answer", async () => {
  // Found by the mutation run: November's past dates carry no answer and its
  // coming dates' gatherings no photos, so a row that read the answer on a past
  // date, or the count on a coming one, passed every test above.
  world.calendar = (query, group) =>
    query === NOV
      ? json(200, {
          dates: NOVEMBER.dates.map((d) => (d.id === 'o-picnic' ? { ...d, caller_response: 'yes' } : d)),
          gatherings: NOVEMBER.gatherings.map((g) => (g.id === 'g-season' ? { ...g, published_count: 7 } : g)),
        })
      : defaultCalendar(query, group)
  await openCalendar()
  fireEvent.click(dayButton('2026-11-02'))
  await settle()
  expect(rows()[0]).toEqual({ href: '/gatherings/g-picnic', parts: ['Fall picnic', '11:00 AM', 'The Lees'], right: '12 photos', dashed: false })
  expect(agenda().querySelectorAll('.answer')).toHaveLength(0)
  fireEvent.click(dayButton('2026-11-21'))
  await settle()
  expect(rows()[1]).toEqual({ href: '/gatherings/g-season', parts: ['Soccer season', '12:00 PM · date 4 of 6', 'The Lees'], right: 'Not answered', dashed: true })
  expect(agenda().querySelectorAll('.count')).toHaveLength(0)
})

test("NOTHING ON THIS DAY only once the month's answer has landed — never while it is out", async () => {
  hold(`/calendar?${NOV}`)
  renderApp(['/calendar'])
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  expect(within(agenda()).getByRole('heading', { level: 3 }).textContent).toBe('Sunday, November 8, 2026')
  expect(agenda().querySelector('.sub')?.textContent).toBe('Today')
  fireEvent.click(dayButton('2026-11-09'))
  await settle()
  expect(agenda().textContent).not.toContain('Nothing on this day.')
  expect(agenda().querySelector('.sub')).toBeNull()
  expect(agenda().querySelectorAll('li')).toHaveLength(0)
  await release(`/calendar?${NOV}`)
  expect(agenda().querySelector('.empty-day')?.textContent).toBe('Nothing on this day.')
})

test('A FAILED READ: the grid stays with no marks, the list says so with Try again — one request per press — and never Nothing on this day.', async () => {
  let failing = true
  world.calendar = (query, group) => (failing ? json(503, {}) : defaultCalendar(query, group))
  await openCalendar()
  expect(grid().querySelectorAll('button.day')).toHaveLength(30)
  expect(grid().querySelectorAll('.mk')).toHaveLength(0)
  expect(within(agenda()).getByText("This month's dates couldn't be loaded just now.")).toBeTruthy()
  fireEvent.click(dayButton('2026-11-09'))
  await settle()
  expect(agenda().textContent).not.toContain('Nothing on this day.')
  expect(within(agenda()).getByText("This month's dates couldn't be loaded just now.")).toBeTruthy()
  fireEvent.click(within(agenda()).getByRole('button', { name: 'Try again' }))
  await settle()
  expect(calendarReads()).toEqual([`/calendar?${NOV}`, `/calendar?${NOV}`])
  failing = false
  fireEvent.click(within(agenda()).getByRole('button', { name: 'Try again' }))
  await settle()
  expect(calendarReads()).toHaveLength(3)
  expect(agenda().querySelector('.empty-day')?.textContent).toBe('Nothing on this day.')
  expect(dayButton('2026-11-14').querySelectorAll('.mk')).toHaveLength(2)
})

// ---------------------------------------------------------------------------
// A group's calendar
// ---------------------------------------------------------------------------

test("A GROUP'S CALENDAR from the group page's Calendar button: the group's next date's month, Showing The Lees only, and its reads in order", async () => {
  renderApp(['/groups/g-1'])
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  await settle()
  mock.mockClear()
  const button = within(document.querySelector('.group-actions') as HTMLElement).getByRole('link', { name: 'Calendar' })
  expect(button.getAttribute('href')).toBe('/calendar?group=g-1')
  fireEvent.click(button)
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  expect(where()).toBe('/calendar?group=g-1')
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  const filter = document.querySelector('.filter') as HTMLElement
  expect(filter.textContent).toBe('Showing The Lees only Show all groups')
  expect(filter.querySelector('b')?.textContent).toBe('The Lees')
  expect(within(filter).getByRole('link', { name: 'Show all groups' }).getAttribute('href')).toBe('/calendar?day=2026-12-12')
  // New gathering opens the group's form.
  expect(within(page()).getByRole('link', { name: 'New gathering' }).getAttribute('href')).toBe('/groups/g-1/gatherings/new')
  // The group, then its gatherings (no day), then one calendar read for the opening month.
  expect(reads().filter((path) => !['/groups', '/gatherings'].includes(path))).toEqual([
    '/groups/g-1',
    '/groups/g-1/gatherings',
    `/groups/g-1/calendar?${DEC}`,
  ])
})

test("A GROUP'S CALENDAR with a day in the address skips the gatherings read", async () => {
  await openCalendar('/calendar?group=g-1&day=2026-11-14')
  expect(monthHeading()).toBe('November 2026')
  expect(pressed()).toEqual(['2026-11-14'])
  expect(reads().filter((path) => path.startsWith('/groups/g-1'))).toEqual(['/groups/g-1', `/groups/g-1/calendar?${NOV}`])
})

test("A GROUP'S CALENDAR opens at its next date, else its most recent past one, else today", async () => {
  world.groupGatherings = [GROUP_GATHERINGS[0], GROUP_GATHERINGS[2]]
  await openCalendar('/calendar?group=g-1')
  expect(monthHeading()).toBe('October 2026')
  expect(pressed()).toEqual(['2026-10-10'])
  cleanup()
  world.groupGatherings = [GROUP_GATHERINGS[2]]
  await openCalendar('/calendar?group=g-1')
  expect(monthHeading()).toBe('November 2026')
  expect(pressed()).toEqual(['2026-11-08'])
  // The opening day is not written to the address: only a move writes it.
  expect(where()).toBe('/calendar?group=g-1')
})

test('SHOW ALL GROUPS keeps the day and is a push: Back returns to the group\'s calendar', async () => {
  await openCalendar('/calendar?group=g-1')
  fireEvent.click(within(document.querySelector('.filter') as HTMLElement).getByRole('link', { name: 'Show all groups' }))
  await settle()
  expect(where()).toBe('/calendar?day=2026-12-12')
  expect(how()).toBe('PUSH')
  expect(document.querySelector('.filter')).toBeNull()
  expect(monthHeading()).toBe('December 2026')
  expect(pressed()).toEqual(['2026-12-12'])
  await back()
  expect(where()).toBe('/calendar?group=g-1')
  await waitFor(() => expect(document.querySelector('.filter')).not.toBeNull())
})

test("A GROUP'S CALENDAR from the panel's Calendar row in Rail and panel: that group's panel, its Calendar row current", async () => {
  chooseMenuLayout('rail')
  stubWidth(true)
  renderApp(['/groups/g-1'])
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  await settle()
  const panel = document.querySelector('#frame-menu .panel') as HTMLElement
  const row = within(panel).getByRole('link', { name: /^Calendar/ })
  expect(row.getAttribute('href')).toBe('/calendar?group=g-1')
  expect(row.textContent).toBe("CalendarThis group's dates")
  fireEvent.click(row)
  await screen.findByRole('heading', { level: 1, name: 'Calendar' })
  await settle()
  const after = document.querySelector('#frame-menu .panel') as HTMLElement
  expect(after.querySelector('.dcover h2')?.textContent).toBe('The Lees')
  expect(within(after).getByRole('link', { name: /^Calendar/ }).getAttribute('aria-current')).toBe('page')
  // Nothing else in the panel is current.
  expect(after.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
})

test("THE PANEL for a group the menu does not hold is Home's, and the tab's is Home's", async () => {
  chooseMenuLayout('rail')
  stubWidth(true)
  world.calendar = (query, group) => (group === 'g-2' ? json(200, { dates: [], gatherings: [] }) : defaultCalendar(query, group))
  await openCalendar('/calendar?group=g-2&day=2026-11-14')
  const panel = document.querySelector('#frame-menu .panel') as HTMLElement
  expect(panel.querySelector('.backrow')).toBeNull()
  expect(within(panel).getByRole('link', { name: 'Calendar' }).getAttribute('aria-current')).toBe('page')
  cleanup()
  await openCalendar('/calendar')
  const home = document.querySelector('#frame-menu .panel') as HTMLElement
  expect(within(home).getByRole('link', { name: 'Calendar' }).getAttribute('aria-current')).toBe('page')
})

test("THE NOT-FOUND SCREEN for a 404 on the group's read or on its calendar read is the group page's, byte for byte", async () => {
  renderApp(['/groups/g-x'])
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  const groupPage = page().outerHTML
  cleanup()
  renderApp(['/calendar?group=g-x'])
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(page().outerHTML).toBe(groupPage)
  expect(reads().some((path) => path.includes('/calendar?'))).toBe(false)
  cleanup()
  // The group reads, but its calendar is the 404 (a member who has just left).
  renderApp(['/calendar?group=g-2&day=2026-11-14'])
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(page().outerHTML).toBe(groupPage)
  cleanup()
  // An id that cannot name a group asks for nothing.
  mock.mockClear()
  renderApp(['/calendar?group=..%2Fmembers'])
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(page().outerHTML).toBe(groupPage)
  expect(reads().filter((path) => !['/auth/me', '/groups', '/gatherings'].includes(path))).toEqual([])
})

// ---------------------------------------------------------------------------
// Your gatherings: the switch
// ---------------------------------------------------------------------------

async function openGatherings(address = '/gatherings') {
  renderApp([address])
  await screen.findByRole('heading', { level: 1, name: 'Your gatherings' })
  await settle()
}

const switchGroup = () => screen.getByRole('group', { name: 'Show gatherings as' })

test('THE SWITCH: a group named Show gatherings as, Cards and Calendar each a button with aria-pressed; Cards by default, the page unchanged', async () => {
  await openGatherings()
  const buttons = within(switchGroup()).getAllByRole('button')
  expect(buttons.map((button) => button.textContent)).toEqual(['Cards', 'Calendar'])
  expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(switchGroup().closest('.toolbar')).not.toBeNull()
  // Cards is today's page: the featured card, and the list read by the page beside the menu.
  expect(screen.getByRole('link', { name: 'Winter feast' })).toBeTruthy()
  expect(document.querySelector('.cal')).toBeNull()
  expect(reads().filter((path) => path === '/gatherings')).toHaveLength(2)
  expect(calendarReads()).toEqual([])
})

test('THE SWITCH: Calendar draws the calendar in place of the cards, reads no list, keeps focus and is stored by the one module', async () => {
  await openGatherings()
  const calendar = within(switchGroup()).getByRole('button', { name: 'Calendar' })
  calendar.focus()
  fireEvent.click(calendar)
  await settle()
  expect(localStorage.getItem(GATHERINGS_VIEW_KEY)).toBe('calendar')
  const now = within(switchGroup()).getByRole('button', { name: 'Calendar' })
  expect(now.getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(now)
  expect(monthHeading()).toBe('November 2026')
  expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull()
  expect(document.querySelector('.cover-card')).toBeNull()
  expect(screen.getByText(`Times in ${ZONE}.`)).toBeTruthy()
  // The page's own list read is not made again; the calendar's month is.
  expect(reads().filter((path) => path === '/gatherings')).toHaveLength(2)
  expect(calendarReads()).toEqual([`/calendar?${NOV}`])
  // Cards again: the list is read as today, focus kept.
  const cards = within(switchGroup()).getByRole('button', { name: 'Cards' })
  cards.focus()
  fireEvent.click(cards)
  await screen.findByRole('link', { name: 'Winter feast' })
  expect(document.activeElement?.textContent).toBe('Cards')
  expect(reads().filter((path) => path === '/gatherings')).toHaveLength(3)
})

test('THE SWITCH: the choice survives a remount, read from the one module, and the Calendar view reads no list at all', async () => {
  chooseGatheringsView('calendar')
  await openGatherings()
  expect(within(switchGroup()).getByRole('button', { name: 'Calendar' }).getAttribute('aria-pressed')).toBe('true')
  expect(monthHeading()).toBe('November 2026')
  // The menu's read alone.
  expect(reads().filter((path) => path === '/gatherings')).toHaveLength(1)
  cleanup()
  await openGatherings('/gatherings?day=2026-11-14')
  expect(pressed()).toEqual(['2026-11-14'])
  fireEvent.click(dayButton('2026-11-20'))
  await settle()
  expect(where()).toBe('/gatherings?day=2026-11-20')
  expect(how()).toBe('REPLACE')
})

test('THE SWITCH: in the Cards view a day in the address is not read', async () => {
  await openGatherings('/gatherings?day=2026-11-14')
  expect(document.querySelector('.cal')).toBeNull()
  expect(calendarReads()).toEqual([])
})
