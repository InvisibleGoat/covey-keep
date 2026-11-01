// CK-82 — the menu, One list. The value under test: the brand and the
// three sections; Your groups in the server's order, each a link to its page
// with its cover and its count in people (CK-85); Gatherings coming up — at
// most five, soonest first, none past and none from a photos-only item,
// each a link with its date in the profile's zone as the mockup draws it;
// no chevron, no pin and no activity line; an empty list leaves its heading
// out; a failed read is one quiet line whose Try again re-reads once per
// press, never blocking anything; both lists are re-read when the page
// changes; and the footer carries the initials, the name, the way to
// Settings and the maker's line — the way to Settings even with no profile.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { MAKER_LINE } from '../brand'
import { Menu } from './Menu'
import menuSource from './Menu.tsx?raw'

const person: Person = {
  id: 'person-1',
  display_name: 'Ada Lee',
  email: 'ada@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

function authWith(who: Person | null): AuthState {
  return { status: 'signedIn', person: who, signIn: () => {}, signOut: async () => {}, updatePerson: () => {} }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function group(id: string, name: string, count: number) {
  return {
    id,
    name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-1',
    member_count: count,
    caller_role: 'member',
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function gathering(id: string, title: string, startsAt: string | null, view: string = 'full') {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: view === 'full' ? 'INVITEES' : null,
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    caller_role: null,
    group: null,
    caller_view: view,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
  }
}

const GROUPS = [group('g-new', 'The Lees', 3), group('g-mid', 'Hawkins Family', 1), group('g-old', 'Cousins', 12)]

// Relative to now, so the fixture never ages into the past.
const DAY = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString()

const GATHERINGS = [
  gathering('x-4', 'Fourth', at(20)),
  gathering('x-past', 'Last spring', at(-40)),
  gathering('x-1', 'First', at(1)),
  gathering('x-6', 'Sixth', at(60)),
  gathering('x-3', 'Third', at(10)),
  // A photos-only item: the server withholds its date, and even a date it
  // carried would never list it here.
  gathering('x-memory', 'Grandpa’s birthday', at(2), 'memory'),
  gathering('x-withheld', 'Kept from me', null, 'memory'),
  gathering('x-2', 'Second', at(5)),
  gathering('x-5', 'Fifth', at(30)),
]

type Server = { groups?: () => Response; gatherings?: () => Response }

function stubServer(server: Server = {}) {
  const mock = vi.fn((url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (path === '/groups') return Promise.resolve((server.groups ?? (() => json(200, { groups: GROUPS })))())
    if (path === '/gatherings')
      return Promise.resolve((server.gatherings ?? (() => json(200, { gatherings: GATHERINGS })))())
    return Promise.resolve(json(404, {}))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function reads(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
}

function renderMenu(who: Person | null = person, at = '/groups') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AuthContext.Provider value={authWith(who)}>
        <Menu />
        <Routes>
          <Route path="*" element={<Link to="/somewhere-else">elsewhere</Link>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

test('the brand, the three sections with the current one marked, and no Calendar', async () => {
  stubServer()
  renderMenu(person, '/groups/g-1')
  const menu = screen.getByRole('navigation', { name: 'Menu' })
  const brand = within(menu).getByRole('link', { name: 'CoveyKeep' })
  expect(brand.getAttribute('href')).toBe('/groups')
  expect(brand.querySelector('img')?.getAttribute('alt')).toBe('')
  for (const [name, href, current] of [
    ['Groups', '/groups', 'page'],
    ['Gatherings', '/gatherings', null],
    ['You', '/you', null],
  ] as const) {
    const link = within(menu).getByRole('link', { name })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('aria-current')).toBe(current)
  }
  expect(menu.textContent).not.toMatch(/calendar/i)
  await screen.findByRole('heading', { name: 'Your groups' })
})

test("Your groups: the server's order, each a link to its page with the empty cover and its member line", async () => {
  stubServer()
  renderMenu()
  const heading = await screen.findByRole('heading', { name: 'Your groups' })
  const list = screen.getByRole('list', { name: 'Your groups' })
  expect(list.getAttribute('aria-labelledby')).toBe(heading.id)
  const links = within(list).getAllByRole('link')
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/groups/g-new', '/groups/g-mid', '/groups/g-old'])
  // MOVED AT CK-85, with its reason: the count says people — *1 person*,
  // *{N} people* (Steven, 2026-11-01) — as on the Groups list's cards and a
  // group page's header, through the one helper.
  expect(links.map((link) => link.textContent)).toEqual(['The Lees3 people', 'Hawkins Family1 person', 'Cousins12 people'])
  for (const link of links) {
    const cover = link.querySelector('.noimg.nthumb')
    expect(cover?.getAttribute('aria-hidden')).toBe('true')
    expect(cover?.querySelector('img')?.getAttribute('alt')).toBe('')
  }
})

test('Gatherings coming up: at most five, soonest first, none past, none photos-only — each a link with its day', async () => {
  stubServer()
  renderMenu()
  const list = await screen.findByRole('list', { name: 'Gatherings coming up' })
  const links = within(list).getAllByRole('link')
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/gatherings/x-1',
    '/gatherings/x-2',
    '/gatherings/x-3',
    '/gatherings/x-4',
    '/gatherings/x-5',
  ])
  expect(list.textContent).not.toMatch(/Sixth|Last spring|Grandpa|Kept from me/)
  for (const link of links) {
    expect(link.querySelector('.noimg.nthumb')).toBeTruthy()
    // "Thu, Oct 15": a weekday, a month and a day.
    expect(link.querySelector('.t span')?.textContent).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2}$/)
  }
})

test("a gathering's day is read in the profile's zone, as the mockup draws it", async () => {
  // 03:00 UTC on Friday the 13th is 9 PM on Thursday the 12th in Chicago.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  stubServer({
    gatherings: () => json(200, { gatherings: [gathering('x-1', 'Supper', '2026-11-13T03:00:00Z')] }),
  })
  renderMenu()
  const list = await screen.findByRole('list', { name: 'Gatherings coming up' })
  expect(within(list).getByRole('link').textContent).toBe('SupperThu, Nov 12')
})

test('no chevron, no pin and no activity line on any row', async () => {
  stubServer()
  const { container } = renderMenu()
  await screen.findByRole('list', { name: 'Gatherings coming up' })
  expect(container.querySelector('.chev')).toBeNull()
  expect(container.querySelector('.pinmark')).toBeNull()
  // MOVED AT CK-85, with its reason: `people` was banned here as half of the
  // mockup's activity line (*14 people · Active … ago*); since CK-85 it is the
  // count's word (Steven, 2026-11-01), so the ban keeps the activity line's
  // other words and the pin, and the count is pinned in the test above.
  expect(container.textContent).not.toMatch(/\bActive\b|\bago\b|Pinned/)
  expect(menuSource).not.toMatch(/name="chevron"/)
})

test('an empty list leaves its heading out', async () => {
  const mock = stubServer({
    groups: () => json(200, { groups: [] }),
    gatherings: () => json(200, { gatherings: [gathering('x-past', 'Last spring', at(-3))] }),
  })
  renderMenu()
  await waitFor(() => expect(reads(mock)).toEqual(['/groups', '/gatherings']))
  // Settle the two reads, then: the sections and the footer, and no list.
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  expect(screen.getByText(MAKER_LINE)).toBeTruthy()
  expect(screen.queryByRole('heading')).toBeNull()
  expect(screen.queryByRole('list', { name: /your groups|gatherings coming up/i })).toBeNull()
  expect(screen.queryByText(/couldn't be loaded/)).toBeNull()
})

test('a failed read: one quiet line inside the menu, and Try again re-reads once per press', async () => {
  let fail = true
  const mock = stubServer({ groups: () => (fail ? json(500, {}) : json(200, { groups: GROUPS })) })
  renderMenu()
  const line = await screen.findByText("Your groups and gatherings couldn't be loaded just now.")
  expect(line.closest('nav')?.getAttribute('aria-label')).toBe('Menu')
  expect(screen.queryByRole('heading')).toBeNull()
  expect(reads(mock)).toEqual(['/groups', '/gatherings'])

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(reads(mock)).toHaveLength(4))
  expect(await screen.findByText("Your groups and gatherings couldn't be loaded just now.")).toBeTruthy()
  expect(reads(mock)).toEqual(['/groups', '/gatherings', '/groups', '/gatherings'])

  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('list', { name: 'Your groups' })).toBeTruthy()
  expect(reads(mock)).toHaveLength(6)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

test('freshness: both lists are re-read when the page changes', async () => {
  let name = 'The Lees'
  const mock = stubServer({ groups: () => json(200, { groups: [group('g-1', name, 2)] }) })
  renderMenu()
  await screen.findByText('The Lees')
  expect(reads(mock)).toEqual(['/groups', '/gatherings'])
  name = 'The Lee Family'
  fireEvent.click(screen.getByRole('link', { name: 'elsewhere' }))
  expect(await screen.findByText('The Lee Family')).toBeTruthy()
  expect(reads(mock)).toEqual(['/groups', '/gatherings', '/groups', '/gatherings'])
})

test("the footer: the initials, the name, the way to Settings and the maker's line", async () => {
  stubServer()
  renderMenu()
  const menu = screen.getByRole('navigation', { name: 'Menu' })
  const avatar = menu.querySelector('.avatar')
  expect(avatar?.textContent).toBe('AL')
  expect(avatar?.getAttribute('aria-hidden')).toBe('true')
  expect(within(menu).getByText('Ada Lee')).toBeTruthy()
  expect(within(menu).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
  expect(within(menu).getByText('a Paper Goose product')).toBeTruthy()
  expect(MAKER_LINE).toBe('a Paper Goose product')
  await screen.findByRole('heading', { name: 'Your groups' })
})

test('with no profile, the footer shows no name, and the way to Settings still works', async () => {
  stubServer()
  renderMenu(null)
  const menu = screen.getByRole('navigation', { name: 'Menu' })
  expect(menu.querySelector('.avatar')).toBeNull()
  expect(menu.querySelector('.me-name')).toBeNull()
  expect(within(menu).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
  await screen.findByRole('heading', { name: 'Your groups' })
})

test('the menu spells no product name of its own — it flows from brand.ts', () => {
  expect(menuSource).not.toMatch(/covey ?keep|paper goose/i)
})
