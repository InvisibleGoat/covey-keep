// CK-85 — Your gatherings in the mockup's layout, the menu agreeing with it,
// and the two lists' page and styles. The value under test: from the one list
// read, in the profile's zone (forced to differ from the runner's), the
// featured card is the soonest gathering coming up, its date badge's month
// and day in that zone; *Coming up* holds the rest soonest first; *Past*
// holds the gatherings whose date has passed — a date in progress included —
// most recent first, four and then **Show all {N} past gatherings**, which
// shows the rest in place and goes away; *Photos you can see* holds every
// photos-only item after Past, with *You can see its photos* and no badge
// or date; each card's lines are the mockup's words; an empty section leaves
// its heading out; there is no Cards / Calendar switch; the menu's
// *Gatherings coming up* is the page's *Coming up*, the first five, through
// the one rule; the empty state and the failed read keep their words; and
// the lists' styles name no colour, add no token, and reach only the two
// list pages.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import appCss from '../App.css?raw'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { Menu } from '../components/Menu'
import { formatDay, formatDayWithYear, wallClockToInstant } from '../lib/datetime'
import frameSource from '../lib/frame.ts?raw'
import tokensCss from '../styles/tokens.css?raw'
import { Gatherings } from './Gatherings'
import gatheringsSource from './Gatherings.tsx?raw'

// A profile zone guaranteed to differ from the runner's: the badge, the
// lines and the sections must read the PROFILE zone, which only a mismatch
// can prove. Both are fixed-offset zones (no DST), so the literals hold.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const profileZone = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
const at = (wallClock: string) => wallClockToInstant(wallClock, profileZone)

const person: Person = {
  id: 'person-1',
  display_name: 'Ada Lee',
  email: 'ada@example.com',
  timezone: profileZone,
  account_id: 'acct-1',
}

const auth: AuthState = { status: 'signedIn', person, signIn: () => {}, signOut: async () => {}, updatePerson: () => {} }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const LEES = { id: 'grp-1', name: 'The Lees' }
const OTTERS = { id: 'grp-2', name: 'Otters Softball' }

function item(id: string, title: string, startsAt: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    caller_role: 'host',
    caller_view: 'full',
    group: null,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
    ...over,
  }
}

function photosOnly(id: string, title: string, over: Record<string, unknown> = {}) {
  return item(id, title, null, {
    caller_role: null,
    caller_view: 'memory',
    rsvp_list_visibility: null,
    group: LEES,
    ...over,
  })
}

const DAY = 24 * 60 * 60 * 1000
const startedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

// The server's order (newest first) is not the page's: the page sorts.
const LIST = [
  item('up-season', 'Spring Season', at('2035-05-06T13:00'), { gathering_type: 'season', group: OTTERS, occurrence_count: 12 }),
  item('past-2', 'Sunday Supper', at('2026-09-20T18:00'), { group: LEES }),
  photosOnly('photos-1', 'Grandpa’s birthday'),
  item('up-biscuit', 'Biscuit Turns One', at('2035-04-15T15:00'), { gathering_type: 'simple' }),
  item('past-4', 'Fourth of July', at('2026-07-04T17:00'), { group: LEES }),
  item('in-progress', 'The Long Lunch', startedAnHourAgo, { gathering_type: 'hosted' }),
  item('past-1', 'Fall Camping Trip', at('2026-10-03T09:00'), { gathering_type: 'simple', occurrence_count: 3 }),
  item('up-suppers', 'Fall Suppers', at('2035-03-01T00:30'), { gathering_type: 'season', group: LEES, occurrence_count: 12 }),
  item('past-5', 'Memorial Day', at('2026-05-25T12:00'), { group: LEES }),
  photosOnly('photos-2', 'The Party'),
  item('past-3', 'Beach Week', at('2026-08-09T10:00'), { group: LEES }),
]

function stubList(gatherings: unknown[]) {
  const mock = vi.fn((url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (path === '/gatherings') return Promise.resolve(json(200, { gatherings }))
    if (path === '/groups') return Promise.resolve(json(200, { groups: [] }))
    return Promise.resolve(json(404, {}))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/gatherings']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/gatherings" element={<Gatherings />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'Your gatherings' })
}

function featured(): HTMLElement {
  const card = document.querySelector('article.cover-hero')
  if (!(card instanceof HTMLElement)) throw new Error('no featured card')
  return card
}

const titles = (list: HTMLElement) => within(list).getAllByRole('link').map((link) => link.textContent)
const linesOf = (card: Element) => [...card.querySelectorAll('p')].map((line) => line.textContent)
const cardOf = (title: string) => screen.getByRole('link', { name: title }).closest('article') as HTMLElement

test('the page head: Your gatherings, Times in {zone}. while a date is on screen, and New gathering — no Cards / Calendar switch', async () => {
  const mock = stubList(LIST)
  renderPage()
  const heading = await loaded()
  expect(mock).toHaveBeenCalledTimes(1)
  const head = heading.closest('.page-head') as HTMLElement
  expect(head.querySelector('.lede')?.textContent).toBe(`Times in ${profileZone}.`)
  const newGathering = within(head).getByRole('link', { name: 'New gathering' })
  expect(newGathering.getAttribute('href')).toBe('/gatherings/new')
  expect(newGathering.classList.contains('btn-primary')).toBe(true)
  // The calendar is CK-91's: no switch, no view to choose.
  expect(screen.queryByRole('group', { name: /show gatherings as/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /cards|calendar/i })).toBeNull()
  expect(document.body.textContent).not.toMatch(/calendar/i)
  // Nothing the list body does not carry: no photo count, no answer.
  expect(document.body.textContent).not.toMatch(/\d+ photos|Not answered|Going|Maybe/)
})

test('the featured card is the soonest coming up, its badge the month and day in the profile zone — forced to differ from the runner’s', async () => {
  stubList(LIST)
  renderPage()
  await loaded()
  const card = featured()
  const title = within(card).getByRole('heading', { level: 2 })
  expect(title.textContent).toBe('Fall Suppers')
  const links = within(card).getAllByRole('link')
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('/gatherings/up-suppers')
  expect(links[0].closest('h2')).toBe(title)
  // Half past midnight on Mar 1 in the profile zone: the runner's own zone
  // reads another day, and the badge must not.
  const badge = card.querySelector('.cover-date') as HTMLElement
  expect(badge.getAttribute('aria-hidden')).toBe('true')
  expect(badge.querySelector('.cover-date-m')?.textContent).toBe('Mar')
  expect(badge.querySelector('.cover-date-d')?.textContent).toBe('1')
  expect(formatDay(at('2035-03-01T00:30'), runnerZone)).not.toBe('Mar 1')
  // Its one line: the group, the type, the day and the time.
  expect(card.querySelector('.cover-hero-meta')?.textContent).toBe('The Lees · Season · Thu, Mar 1 · 12:30 AM')
  const open = within(card).getByText('Open gathering')
  expect(open.getAttribute('aria-hidden')).toBe('true')
  expect(within(card).queryByRole('button')).toBeNull()
})

test('Coming up: the rest of the gatherings still ahead, soonest first, without the featured one, each with its badge and the mockup’s lines', async () => {
  stubList(LIST)
  renderPage()
  await loaded()
  const list = screen.getByRole('list', { name: 'Coming up' })
  expect(titles(list)).toEqual(['Biscuit Turns One', 'Spring Season'])
  expect(within(list).queryByText('Fall Suppers')).toBeNull()
  expect(linesOf(cardOf('Biscuit Turns One'))).toEqual(['Not in a group · Simple', 'Sun, Apr 15 · 3:00 PM'])
  expect(linesOf(cardOf('Spring Season'))).toEqual(['Otters Softball · Season', '12 dates · next Sun, May 6'])
  for (const [title, month, day] of [
    ['Biscuit Turns One', 'Apr', '15'],
    ['Spring Season', 'May', '6'],
  ]) {
    const badge = cardOf(title).querySelector('.cover-date') as HTMLElement
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    expect([badge.querySelector('.cover-date-m')?.textContent, badge.querySelector('.cover-date-d')?.textContent]).toEqual([month, day])
  }
})

test('Past: most recent first — a date in progress included — four, then Show all {N} past gatherings, which shows the rest in place and goes away', async () => {
  stubList(LIST)
  renderPage()
  await loaded()
  const list = screen.getByRole('list', { name: 'Past' })
  expect(titles(list)).toEqual(['The Long Lunch', 'Fall Camping Trip', 'Sunday Supper', 'Beach Week'])
  // A past card carries no badge, and its line is the day with its year.
  expect(list.querySelector('.cover-date')).toBeNull()
  expect(linesOf(cardOf('Fall Camping Trip'))).toEqual(['Not in a group · Simple', 'Oct 3, 2026'])
  expect(linesOf(cardOf('Sunday Supper'))).toEqual(['The Lees · Potluck', 'Sep 20, 2026'])
  // A date that started an hour ago is past by the backend's rule, not coming up.
  expect(linesOf(cardOf('The Long Lunch'))).toEqual(['Not in a group · Hosted', formatDayWithYear(startedAnHourAgo, profileZone)])
  expect(within(screen.getByRole('list', { name: 'Coming up' })).queryByText('The Long Lunch')).toBeNull()

  const showAll = screen.getByRole('button', { name: 'Show all 6 past gatherings' })
  fireEvent.click(showAll)
  expect(titles(list)).toEqual([
    'The Long Lunch',
    'Fall Camping Trip',
    'Sunday Supper',
    'Beach Week',
    'Fourth of July',
    'Memorial Day',
  ])
  expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  // In place: the same list, on the same page — and the keyboard lands on the
  // first card it revealed, never on a button that has gone.
  expect(screen.getByRole('list', { name: 'Past' })).toBe(list)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Fourth of July' })))
})

test('four past gatherings or fewer: no Show all', async () => {
  stubList([LIST[1], LIST[4], LIST[6], LIST[8]])
  renderPage()
  await loaded()
  expect(titles(screen.getByRole('list', { name: 'Past' }))).toHaveLength(4)
  expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
})

test('Photos you can see: every photos-only item after Past, in the server’s order, with You can see its photos and no badge or date', async () => {
  // One of them carries a date it should not (a view this build does not
  // know reads as photos-only): it is never read.
  const carried = item('photos-3', 'Kept a surprise', at('2035-04-01T12:00'), { caller_view: 'later', group: LEES })
  stubList([...LIST, carried])
  renderPage()
  await loaded()
  const heading = screen.getByRole('heading', { level: 2, name: 'Photos you can see' })
  const list = screen.getByRole('list', { name: 'Photos you can see' })
  const past = screen.getByRole('list', { name: 'Past' })
  expect(past.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(titles(list)).toEqual(['Grandpa’s birthday', 'The Party', 'Kept a surprise'])
  expect(list.querySelector('.cover-date')).toBeNull()
  for (const title of ['Grandpa’s birthday', 'The Party', 'Kept a surprise']) {
    expect(linesOf(cardOf(title))).toEqual(['The Lees · Potluck', 'You can see its photos'])
  }
  expect(list.textContent).not.toMatch(/\b20\d\d\b|\bApr\b|\d:\d\d/)
  expect(within(screen.getByRole('list', { name: 'Coming up' })).queryByText('Kept a surprise')).toBeNull()
})

test('an empty section leaves its heading out: nothing coming up, no featured card and no Coming up; only photos-only items, no Past and no Times in', async () => {
  stubList([LIST[1], LIST[4], LIST[2]])
  renderPage()
  await loaded()
  expect(document.querySelector('article.cover-hero')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull()
  expect(screen.getByRole('heading', { level: 2, name: 'Past' })).toBeTruthy()
  cleanup()

  // One gathering coming up: the featured card alone, and no Coming up heading.
  stubList([LIST[7], LIST[1]])
  renderPage()
  await loaded()
  expect(within(featured()).getByRole('heading', { level: 2, name: 'Fall Suppers' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Photos you can see' })).toBeNull()
  cleanup()

  stubList([LIST[2], LIST[9]])
  renderPage()
  const heading = await loaded()
  expect(screen.queryByRole('heading', { name: 'Past' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull()
  expect(document.querySelector('article.cover-hero')).toBeNull()
  // No date on screen, so the zone goes unnamed (as before CK-85).
  expect((heading.closest('.page-head') as HTMLElement).querySelector('.lede')).toBeNull()
  expect(document.body.textContent).not.toMatch(/Times in/)
  expect(titles(screen.getByRole('list', { name: 'Photos you can see' }))).toEqual(['Grandpa’s birthday', 'The Party'])
})

test('every card is one whole-card link to its gathering', async () => {
  stubList(LIST)
  renderPage()
  await loaded()
  const cards = document.querySelectorAll<HTMLElement>('article.cover-hero, article.cover-tile')
  expect(cards).toHaveLength(9)
  for (const card of cards) {
    const links = within(card).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].classList.contains('cover-link')).toBe(true)
    expect(links[0].getAttribute('href')).toMatch(/^\/gatherings\/[\w-]+$/)
  }
})

// ---------------------------------------------------------------------------
// The menu and the page agree.
// ---------------------------------------------------------------------------

test("the menu's Gatherings coming up and the page's Coming up agree on one list: the menu is the page's first five, through the one rule", async () => {
  const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString()
  const list = [
    item('u-7', 'Seventh', ahead(70)),
    item('u-2', 'Second', ahead(5)),
    item('started', 'Started', startedAnHourAgo),
    item('u-5', 'Fifth', ahead(40)),
    photosOnly('p-1', 'Photos only', { next_occurrence: { id: 'o-x', starts_at: ahead(3) } }),
    item('u-1', 'First', ahead(1)),
    item('u-6', 'Sixth', ahead(60)),
    item('gone', 'Gone', ahead(-30)),
    item('u-3', 'Third', ahead(10)),
    item('u-4', 'Fourth', ahead(20)),
  ]
  stubList(list)
  render(
    <MemoryRouter initialEntries={['/gatherings']}>
      <AuthContext.Provider value={auth}>
        <Menu />
        <Routes>
          <Route path="/gatherings" element={<Gatherings />} />
          <Route path="*" element={<Link to="/gatherings">back</Link>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  await loaded()
  const menuList = await screen.findByRole('list', { name: 'Gatherings coming up' })
  const page = [
    within(featured()).getByRole('link').textContent,
    ...titles(screen.getByRole('list', { name: 'Coming up' })),
  ]
  expect(page).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'])
  // A menu row is the title in bold and its day beneath it.
  expect(within(menuList).getAllByRole('link').map((link) => link.querySelector('b')?.textContent)).toEqual(
    page.slice(0, 5),
  )
  // One rule, read by both: the menu's helper is the page's section.
  expect(frameSource).toMatch(/gatheringSections\(items, now\)\.comingUp\.slice\(0, limit\)/)
  expect(frameSource).not.toMatch(/Date\.parse/)
  expect(gatheringsSource).toMatch(/gatheringSections\(gatherings, readAt\)/)
})

// ---------------------------------------------------------------------------
// The empty state and the failed read keep their words.
// ---------------------------------------------------------------------------

test('the empty state keeps its words, as literals, in the page column', async () => {
  stubList([])
  renderPage()
  const heading = await screen.findByRole('heading', { level: 1, name: 'No gatherings yet' })
  expect(screen.getByText('Gatherings you start or are invited to will be listed here.')).toBeTruthy()
  const cta = screen.getByRole('link', { name: 'Create your first gathering' })
  expect(cta.getAttribute('href')).toBe('/gatherings/new')
  expect(heading.closest('main')?.classList.contains('list-screen')).toBe(true)
  expect(screen.getAllByRole('link')).toHaveLength(1)
})

test("the failed read: the heading follows the page's, the line is today's, and Try again re-reads once per press", async () => {
  let fail = true
  const mock = vi.fn(() => Promise.resolve(fail ? json(500, {}) : json(200, { gatherings: LIST })))
  vi.stubGlobal('fetch', mock)
  renderPage()
  const line = await screen.findByRole('alert')
  expect(line.textContent).toBe('Something went wrong loading your gatherings.')
  expect(screen.getByRole('heading', { level: 1, name: 'Your gatherings' })).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'New gathering' })).toBeNull()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('heading', { level: 2, name: 'Fall Suppers' })
  expect(mock).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

// ---------------------------------------------------------------------------
// The lists' styles.
// ---------------------------------------------------------------------------

const routeSources = import.meta.glob(['./*.tsx', '!./*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

test('the list page class is on the two list pages and no other route: every other page keeps its column', () => {
  expect(Object.keys(routeSources).length).toBeGreaterThan(15)
  const using = Object.entries(routeSources)
    .filter(([, source]) => /\blist-screen\b/.test(source))
    .map(([path]) => path)
    .sort()
  expect(using).toEqual(['./Gatherings.tsx', './Groups.tsx'])
  // And .auth-screen itself is unchanged: still the centred column.
  const authScreen = appCss.slice(appCss.indexOf('.auth-screen {'), appCss.indexOf('}', appCss.indexOf('.auth-screen {')))
  expect(authScreen).toMatch(/align-items: center;/)
  expect(authScreen).toMatch(/text-align: center;/)
})

test('the lists’ styles name no colour and add no token: every var() they read is one the token file already defines', () => {
  const start = appCss.indexOf('/* ---------- the two lists (CK-85')
  expect(start).toBeGreaterThan(-1)
  const end = appCss.indexOf('/* ----------', start + 10)
  const section = appCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const selector of ['.list-screen', '.page-head', '.cover-go', '.cover-hero', '.cover-tile', '.cover-tiles', '.cover-date', '.cover-link::after', '.btn.btn-photo']) {
    expect(section).toContain(selector)
  }
  expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  const used = [...new Set([...section.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  expect(used).toEqual(
    expect.arrayContaining(['--ck-lift', '--ck-lift-hover', '--ck-frost', '--ck-on-photo', '--ck-scrim', '--ck-empty', '--mat', '--r-card']),
  )
  for (const name of used) expect(tokensCss, name).toMatch(new RegExp(`${name}\\s*:`))
  // The mockup's measures: the grid's two columns and its 220px cards, the
  // featured picture's three shapes, the 1180px column.
  expect(section).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  expect(section).toMatch(/grid-template-columns: repeat\(auto-fill, minmax\(220px, 1fr\)\)/)
  expect(section).toMatch(/aspect-ratio: 4 \/ 3/)
  expect(section).toMatch(/aspect-ratio: 16 \/ 9/)
  expect(section).toMatch(/aspect-ratio: 2\.25 \/ 1/)
  expect(section).toMatch(/max-width: 1180px/)
})
