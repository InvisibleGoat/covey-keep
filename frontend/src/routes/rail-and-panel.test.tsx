// CK-89 — Rail and panel, through the app's real route table. The value under
// test: One list untouched with nothing stored or `list`, and the menu
// following You at once; the rail (Home, a tile per group in the server's
// order, `+`, the chosen tile alone `aria-current="true"`); the panel read from
// the address, Back and Forward agreeing; the menu's two reads and no other;
// Home's panel and a group's panel word for word; the drawer's one exception —
// the Home tile, a group's tile and the back row keep it open, every other
// press closes it, a ctrl-click leaves nothing stale, under StrictMode too,
// never in navigation state; focus; the arrival of the *Photos* row on a
// group's page; and the styles.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import App from '../App'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import appCss from '../App.css?raw'
import { clearCoverPictures } from '../lib/covers'
import { chooseMenuLayout } from '../lib/menuLayout'

// A profile zone forced to differ from the runner's. 03:30 UTC on 10 March 2035
// is already that Saturday afternoon in Kiritimati (UTC+14), and still Friday
// the 9th in Honolulu; 10:30 UTC on 4 July 2026 is the 5th there and the 4th here.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONE = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
const FUTURE = '2035-03-10T03:30:00+00:00'
const FUTURE_DAY = ZONE === 'Pacific/Kiritimati' ? 'Sat, Mar 10' : 'Fri, Mar 9'
const PAST = '2026-07-04T10:30:00+00:00'
const PAST_DAY = ZONE === 'Pacific/Kiritimati' ? 'Jul 5, 2026' : 'Jul 4, 2026'

const person: Person = {
  id: 'person-1',
  display_name: 'Ada Lee',
  email: 'ada@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const DAY = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString()

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function groupBody(id: string, name: string, count: number, withCover = false) {
  return {
    id,
    name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-1',
    member_count: count,
    caller_role: 'admin',
    cover: withCover ? { source: 'upload', set_at: '2026-11-01T00:00:00+00:00' } : null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function item(id: string, title: string, groupId: string | null, startsAt: string | null, view = 'full') {
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
    group: groupId === null ? null : { id: groupId, name: groupId === 'g-1' ? 'The Lees' : 'Cousins' },
    caller_view: view,
    cover: null,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
  }
}

const GROUPS = [groupBody('g-1', 'The Lees', 3, true), groupBody('g-2', 'Cousins', 1)]
const NEW_GROUP = groupBody('g-9', 'New Folk', 1)
const GATHERINGS = [
  item('lees-up-1', 'Lees Picnic', 'g-1', at(2)),
  item('lees-up-2', 'Lees Dinner', 'g-1', at(6)),
  item('lees-past', 'Lees Reunion', 'g-1', at(-20)),
  item('lees-memory', 'Lees Surprise', 'g-1', null, 'memory'),
  item('cousins-up', 'Cousins Brunch', 'g-2', at(3)),
  item('alone-up', 'Book Club', null, at(4)),
  item('alone-past', 'Old Club', null, at(-9)),
]

function photo(gathering: string, n: number) {
  return {
    id: `${gathering}-m${n}`,
    gathering_id: gathering,
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: '2026-07-04T10:30:00+00:00',
    created_at: '2026-07-04T10:30:00+00:00',
    uploader_display_name: 'Nate Okafor',
    is_own: false,
    removed_at: null,
    filename: `IMG_${n}.jpg`,
    caption: null,
    tags: [],
    published_at: '2026-07-04T10:30:00+00:00',
    failure_reason: null,
  }
}

const ONE_SECTION = [{ gathering_id: 'lees-past', published_count: 1, media: [photo('lees-past', 1)] }]

type Server = { lists?: () => Promise<Response> | Response; gather?: () => Response; sections?: unknown[] }
let server: Server = {}
let mock: ReturnType<typeof vi.fn>

function path(url: unknown) {
  return String(url).replace(/^https?:\/\/[^/]+/, '')
}

function reads() {
  // The API's own requests: the presigned bucket fetch is the cover cache's, not the menu's.
  return mock.mock.calls.filter(([url]) => !String(url).startsWith('https://r2.invalid/')).map(([url]) => path(url))
}

function stubServer() {
  mock = vi.fn(async (url: string) => {
    const p = path(url)
    if (String(url).startsWith('https://r2.invalid/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    if (p === '/groups') return (await server.lists?.()) ?? json(200, { groups: GROUPS })
    if (p === '/gatherings') return server.gather ? server.gather() : json(200, { gatherings: GATHERINGS })
    if (p.includes('/cover/url?layer='))
      return json(200, { layer: 'web', content_type: 'image/webp', size_bytes: 3, url: `https://r2.invalid/${p}`, method: 'GET', expires_in: 300 })
    if (/^\/groups\/g-[129]$/.test(p)) return json(200, [...GROUPS, NEW_GROUP].find((g) => p.endsWith(g.id)))
    if (p === '/groups/g-1/gatherings') return json(200, { gatherings: GATHERINGS.filter((g) => g.group?.id === 'g-1') })
    if (p === '/groups/g-1/media') return json(200, { sections: server.sections ?? [] })
    if (p === '/billing') return json(404, {})
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', mock)
}

// matchMedia as the frame reads it: a phone (drawer) or from 900px (column).
function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: wide,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <div>
      <span data-testid="at">{location.pathname + location.hash}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        history forward
      </button>
      <button type="button" onClick={() => navigate('/groups/g-9')}>
        to the new group
      </button>
    </div>
  )
}

function renderAt(address: string | string[], options: { strict?: boolean; index?: number; auth?: AuthState } = {}) {
  const entries = Array.isArray(address) ? address : [address]
  const tree = (
    <MemoryRouter initialEntries={entries} initialIndex={options.index ?? entries.length - 1}>
      <AuthContext.Provider value={options.auth ?? signedIn}>
        <App />
        <Probe />
      </AuthContext.Provider>
    </MemoryRouter>
  )
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
}

const where = () => screen.getByTestId('at').textContent
const side = () => document.getElementById('frame-menu') as HTMLElement
const panel = () => side().querySelector('.panel') as HTMLElement
const rail = () => side().querySelector('.rail') as HTMLElement

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
}

let scrollIntoView: Mock<(...args: unknown[]) => void>

beforeEach(() => {
  // The cover cache is module-wide: a test counting fetches starts with it empty.
  clearCoverPictures()
  chooseMenuLayout('rail')
  server = {}
  stubWidth(false)
  stubServer()
  scrollIntoView = vi.fn()
  // The viewer's strip brings a thumbnail into view on its own: only the page's count.
  Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
    if (this.closest('.viewer') === null) scrollIntoView(...args)
  } as typeof Element.prototype.scrollIntoView
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:cover-${(n += 1)}`, revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  chooseMenuLayout('list')
  localStorage.clear()
  document.body.classList.remove('menu-open')
})

// ---------------------------------------------------------------------------
// One list untouched, and the setting.
// ---------------------------------------------------------------------------

test('One list, stored `list` or nothing: no rail, no panel, no back row, no chevron, every row a link to its page', async () => {
  for (const stored of [null, 'list', 'sepia']) {
    localStorage.clear()
    if (stored !== null) localStorage.setItem('covey-keep:menu-layout', stored)
    stubWidth(true)
    renderAt('/groups/g-1')
    await settle()
    const menu = side().querySelector('nav.menu') as HTMLElement
    expect(menu.getAttribute('aria-label'), String(stored)).toBe('Main')
    expect(side().querySelector('.rail, .panel, .backrow, .chev'), String(stored)).toBeNull()
    expect(within(menu).getByRole('link', { name: /The Lees/ }).getAttribute('href')).toBe('/groups/g-1')
    cleanup()
  }
})

test('the menu follows You at once when the layout is chosen, with no reload — and back again', async () => {
  stubWidth(true)
  chooseMenuLayout('list')
  renderAt('/you')
  await settle()
  expect(rail()).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Rail and panel' }))
  expect(localStorage.getItem('covey-keep:menu-layout')).toBe('rail')
  expect(rail()).toBeTruthy()
  expect(side().classList.contains('frame-side-rail')).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'One list' }))
  expect(rail()).toBeNull()
  expect(side().classList.contains('frame-side-rail')).toBe(false)
})

// ---------------------------------------------------------------------------
// The rail.
// ---------------------------------------------------------------------------

test('the rail: Home, a tile per group in the server\'s order, `+`; the chosen tile alone is current; the thumbnail layer', async () => {
  stubWidth(true)
  renderAt('/groups/g-2')
  await settle()
  const nav = screen.getByRole('navigation', { name: 'Your groups' })
  const links = within(nav).getAllByRole('link')
  expect(links.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])).toEqual([
    ['Home', '/groups'],
    ['The Lees', '/groups/g-1'],
    ['Cousins', '/groups/g-2'],
    ['New group', '/groups/new'],
  ])
  expect(links.map((a) => a.getAttribute('title'))).toEqual(['Home', 'The Lees', 'Cousins', 'New group'])
  expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'true', null])
  expect(nav.querySelectorAll('.rail-sep')).toHaveLength(2)
  const covers = reads().filter((p) => p.includes('/cover/url'))
  expect(covers).toEqual(['/groups/g-1/cover/url?layer=thumbnail'])
})

test('Home is the chosen tile on the lists, You, a standalone gathering and a group the person has left', async () => {
  stubWidth(true)
  for (const address of ['/groups', '/gatherings', '/you', '/gatherings/alone-up', '/groups/not-mine']) {
    renderAt(address)
    await settle()
    const current = within(screen.getByRole('navigation', { name: 'Your groups' }))
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'true')
    expect(current.map((a) => a.getAttribute('aria-label')), address).toEqual(['Home'])
    cleanup()
  }
})

test('the rail is the nav named Your groups and the panel the nav named Main; none is named Menu, Home\'s panel or a group\'s', async () => {
  for (const address of ['/you', '/groups/g-1']) {
    stubWidth(true)
    renderAt(address)
    await settle()
    expect(screen.getByRole('navigation', { name: 'Your groups' }).classList.contains('rail')).toBe(true)
    expect(screen.getByRole('navigation', { name: 'Main' }).classList.contains('panel')).toBe(true)
    expect(screen.queryByRole('navigation', { name: 'Menu' })).toBeNull()
    cleanup()
  }
})

test('with no group the rail has one separator, the Home tile and `+`', async () => {
  server = { lists: () => json(200, { groups: [] }) }
  stubWidth(true)
  renderAt('/you')
  await settle()
  const nav = screen.getByRole('navigation', { name: 'Your groups' })
  expect(nav.querySelectorAll('.rail-sep')).toHaveLength(1)
  expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Home', 'New group'])
})

// ---------------------------------------------------------------------------
// The address decides the panel.
// ---------------------------------------------------------------------------

test('the panel follows the address through navigation, and Back and Forward agree at each step', async () => {
  stubWidth(true)
  renderAt('/you')
  await settle()
  const shows = () => (panel().querySelector('.dcover h2')?.textContent ?? 'Home')
  expect(shows()).toBe('Home')
  fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
  await settle()
  expect(shows()).toBe('The Lees')
  fireEvent.click(within(rail()).getByRole('link', { name: 'Cousins' }))
  await settle()
  expect(shows()).toBe('Cousins')
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(where()).toBe('/groups/g-1')
  expect(shows()).toBe('The Lees')
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(where()).toBe('/you')
  expect(shows()).toBe('Home')
  fireEvent.click(screen.getByRole('button', { name: 'history forward' }))
  await settle()
  expect(shows()).toBe('The Lees')
})

test('a gathering of a group shows that group\'s panel with the gathering current; a standalone one shows Home\'s', async () => {
  stubWidth(true)
  renderAt('/gatherings/lees-up-2')
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
  const current = panel().querySelectorAll('.nrows:not(.d) [aria-current="page"]')
  expect(current).toHaveLength(1)
  expect(current[0].textContent).toContain('Lees Dinner')
  expect(panel().querySelector('.nrows.d [aria-current]')).toBeNull()
  cleanup()
  renderAt('/gatherings/alone-up')
  await settle()
  expect(panel().querySelector('.dcover')).toBeNull()
  expect(within(panel()).getByText('Not in a group')).toBeTruthy()
})

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

test('before the first read lands the panel is the foot alone and the rail the Home tile and `+`', async () => {
  let release: (response: Response) => void = () => {}
  server = { lists: () => new Promise<Response>((resolve) => (release = resolve)) }
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  expect(panel().querySelector('.nav-head, .nrows, .dcover, .backrow')).toBeNull()
  expect(panel().querySelector('.nav-foot')).toBeTruthy()
  expect(within(rail()).getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Home', 'New group'])
  await act(async () => release(json(200, { groups: GROUPS })))
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
})

test('a group just created keeps Home\'s panel until the re-read lands: a delay, not a flash', async () => {
  let release: (response: Response) => void = () => {}
  let gated = false
  server = {
    lists: () => (gated ? new Promise<Response>((resolve) => (release = resolve)) : json(200, { groups: GROUPS })),
  }
  stubWidth(true)
  renderAt('/groups/new')
  await settle()
  expect(panel().querySelector('.nav-head')).toBeTruthy()
  gated = true
  fireEvent.click(screen.getByRole('button', { name: 'to the new group' }))
  await settle()
  // The address names a group the held lists do not hold yet: Home's panel, whole,
  // and never the foot alone, because the lists are not dropped for the re-read.
  expect(where()).toBe('/groups/g-9')
  expect(panel().querySelector('.dcover, .backrow')).toBeNull()
  expect(panel().querySelector('.nav-head')).toBeTruthy()
  expect(within(panel()).getByRole('link', { name: 'Groups' })).toBeTruthy()
  await act(async () => release(json(200, { groups: [...GROUPS, NEW_GROUP] })))
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('New Folk')
  expect(within(rail()).getByRole('link', { name: 'New Folk' }).getAttribute('aria-current')).toBe('true')
})

test('a failed read: Home\'s brand, sections and foot with the failed line and Try again, the rail the Home tile and `+`', async () => {
  let fail = true
  server = { lists: () => (fail ? json(500, {}) : json(200, { groups: GROUPS })) }
  stubWidth(true)
  renderAt('/groups/g-1')
  await screen.findByText("Your groups and gatherings couldn't be loaded just now.")
  expect(within(panel()).getByRole('link', { name: 'CoveyKeep' })).toBeTruthy()
  expect(within(panel()).getByRole('link', { name: 'Groups' })).toBeTruthy()
  expect(panel().querySelector('.nav-foot')).toBeTruthy()
  expect(within(rail()).getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Home', 'New group'])
  fail = false
  const before = reads().filter((p) => p === '/groups').length
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await settle()
  expect(reads().filter((p) => p === '/groups').length).toBe(before + 1)
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
})

test('the menu reads /groups and /gatherings and nothing else — never a group\'s gatherings or members', async () => {
  stubWidth(true)
  renderAt('/you')
  await settle()
  expect(reads().filter((p) => p !== '/billing').sort()).toEqual(['/gatherings', '/groups', '/groups/g-1/cover/url?layer=thumbnail'])
  expect(reads().some((p) => /\/members|\/groups\/[^/]+\/gatherings/.test(p))).toBe(false)
})

// ---------------------------------------------------------------------------
// The panels' contents.
// ---------------------------------------------------------------------------

test('Home\'s panel: Coming up with a group (four at most), Not in a group, never past or photos-only, no Your groups; the day in the profile\'s zone', async () => {
  const many = Array.from({ length: 6 }, (_, n) => item(`up-${n}`, `Soon ${n}`, 'g-1', at(n + 1)))
  server = { gather: () => json(200, { gatherings: [...GATHERINGS, ...many] }) }
  stubWidth(true)
  renderAt('/you')
  await settle()
  const coming = within(panel()).getByRole('list', { name: 'Coming up' })
  expect(within(coming).getAllByRole('link')).toHaveLength(4)
  const lone = within(panel()).getByRole('list', { name: 'Not in a group' })
  expect(within(lone).getAllByRole('link').map((a) => a.textContent)).toEqual([expect.stringContaining('Book Club')])
  expect(panel().textContent).not.toMatch(/Old Club|Lees Reunion|Lees Surprise|Your groups|Gatherings coming up/)
  expect(panel().querySelector('.chev')).toBeNull()
  expect(within(lone).getByRole('link').textContent).toMatch(/[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}/)
})

test('Home\'s panel: a standalone gathering is never in Coming up, a group\'s never in Not in a group, soonest first', async () => {
  stubWidth(true)
  renderAt('/you')
  await settle()
  const titles = (name: string) =>
    within(within(panel()).getByRole('list', { name }))
      .getAllByRole('link')
      .map((a) => a.querySelector('b')?.textContent)
  expect(titles('Coming up')).toEqual(['Lees Picnic', 'Cousins Brunch', 'Lees Dinner'])
  expect(titles('Not in a group')).toEqual(['Book Club'])
})

test('a panel\'s days are in the profile\'s zone, forced to differ from the runner\'s', async () => {
  server = {
    gather: () =>
      json(200, {
        gatherings: [item('lees-later', 'Lees Later', 'g-1', FUTURE), item('lees-then', 'Lees Then', 'g-1', PAST), item('alone-later', 'Later Alone', null, FUTURE)],
      }),
  }
  stubWidth(true)
  const auth = { ...signedIn, person: { ...person, timezone: ZONE } }
  renderAt('/you', { auth })
  await settle()
  const lineOf = (title: RegExp) => within(panel()).getByRole('link', { name: title }).querySelector('.t span')?.textContent
  expect(lineOf(/Later Alone/)).toBe(FUTURE_DAY)
  expect(lineOf(/Lees Later/)).toBe(FUTURE_DAY)
  cleanup()
  renderAt('/groups/g-1/people', { auth })
  await settle()
  expect(lineOf(/Lees Later/)).toBe(FUTURE_DAY)
  expect(lineOf(/Lees Then/)).toBe(PAST_DAY)
})

test('Home\'s panel leaves an empty heading out, either one', async () => {
  server = { gather: () => json(200, { gatherings: [item('alone-up', 'Book Club', null, at(4))] }) }
  stubWidth(true)
  renderAt('/you')
  await settle()
  expect(within(panel()).queryByText('Coming up')).toBeNull()
  expect(within(panel()).getByText('Not in a group')).toBeTruthy()
  cleanup()
  server = { gather: () => json(200, { gatherings: [item('lees-up-1', 'Lees Picnic', 'g-1', at(2))] }) }
  renderAt('/you')
  await settle()
  expect(within(panel()).getByText('Coming up')).toBeTruthy()
  expect(within(panel()).queryByText('Not in a group')).toBeNull()
})

test('a group\'s panel: the back row, the cover, the facts, three rows with chevrons, this group\'s gatherings in order with their lines', async () => {
  stubWidth(true)
  renderAt('/groups/g-1/people')
  await settle()
  const back = panel().querySelector('.backrow a') as HTMLAnchorElement
  expect(back.getAttribute('href')).toBe('/groups')
  expect(back.textContent).toBe('Home')
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
  expect(panel().querySelector('.facts')?.textContent).toBe('3 people')
  const rows = Array.from(panel().querySelectorAll('.nrows.d a'))
  expect(rows.map((a) => [a.querySelector('b')?.textContent, a.querySelector('.t span')?.textContent, a.getAttribute('href')])).toEqual([
    ['Group page', 'Cover, gatherings and photos', '/groups/g-1'],
    ['Photos', 'By gathering', '/groups/g-1#photos'],
    ['People', '3 people', '/groups/g-1/people'],
  ])
  expect(rows.every((a) => a.querySelector('.chev'))).toBe(true)
  expect(rows.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'page'])
  const list = within(panel()).getByRole('list', { name: 'Gatherings' })
  const lines = within(list).getAllByRole('link').map((a) => [a.querySelector('b')?.textContent, a.querySelector('.t span')?.textContent ?? null])
  expect(lines.map(([title]) => title)).toEqual(['Lees Picnic', 'Lees Dinner', 'Lees Reunion', 'Lees Surprise'])
  expect(lines[0][1]).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/)
  expect(lines[2][1]).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)
  expect(lines[3][1]).toBe('You can see its photos')
  expect(list.querySelector('.chev')).toBeNull()
  expect(panel().textContent).not.toMatch(/Cousins Brunch|Book Club|Chat|Calendar|Kept by|Active|Cover, chat and photos/)
  expect(side().querySelector('.rail-pin, .pinmark, .pin')).toBeNull()
})

test('a photos-only row reads no date, even where the body carries one, and never reaches Home\'s panel', async () => {
  server = { gather: () => json(200, { gatherings: [item('lees-memory', 'Lees Surprise', 'g-1', at(2), 'memory')] }) }
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  const row = within(panel()).getByRole('link', { name: /Lees Surprise/ })
  expect(row.querySelector('.t span')?.textContent).toBe('You can see its photos')
  cleanup()
  renderAt('/you')
  await settle()
  expect(panel().textContent).not.toContain('Lees Surprise')
})

test('a group with no gatherings says so', async () => {
  server = { gather: () => json(200, { gatherings: [] }) }
  stubWidth(true)
  renderAt('/groups/g-2')
  await settle()
  expect(within(panel()).getByText('No gatherings yet.')).toBeTruthy()
})

test('the panel\'s cover shares one web fetch with the page\'s card, and another group\'s fetches none', async () => {
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  expect(reads().filter((p) => p === '/groups/g-1/cover/url?layer=web')).toHaveLength(1)
  expect(reads().filter((p) => p.startsWith('/groups/g-2/cover'))).toEqual([])
})

test('the panel\'s cover is the web layer and the rail\'s tile the thumbnail, read on a page that draws no cover of its own', async () => {
  stubWidth(true)
  renderAt('/groups/g-1/people')
  await settle()
  expect(reads().filter((p) => p.startsWith('/groups/g-1/cover')).sort()).toEqual([
    '/groups/g-1/cover/url?layer=thumbnail',
    '/groups/g-1/cover/url?layer=web',
  ])
  expect(panel().querySelector('.dcover img')?.getAttribute('src')).toMatch(/^blob:/)
  expect(rail().querySelector('.rail-item[aria-current] img')?.getAttribute('src')).toMatch(/^blob:/)
})

// ---------------------------------------------------------------------------
// The drawer.
// ---------------------------------------------------------------------------

async function openDrawer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
  await screen.findByRole('dialog', { name: 'Menu' })
}

for (const strict of [false, true]) {
  const how = strict ? ' (under StrictMode)' : ''

  test(`the Home tile, a group's tile and the back row keep the drawer open; every other press closes it${how}`, async () => {
    renderAt('/you', { strict })
    await settle()
    await openDrawer()
    // The Home tile: the page moves behind it.
    fireEvent.click(within(rail()).getByRole('link', { name: 'Home' }))
    await settle()
    expect(where()).toBe('/groups')
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeTruthy()
    // A group's tile.
    fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
    await settle()
    expect(where()).toBe('/groups/g-1')
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeTruthy()
    expect(screen.getByTestId('state').textContent).toBe('null')
    // The back row.
    fireEvent.click(panel().querySelector('.backrow a') as HTMLElement)
    await settle()
    expect(where()).toBe('/groups')
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeTruthy()
    // Every other press: a section row, a brand press, `+`, a group's panel row, a gathering row, Settings.
    const others: [string, () => HTMLElement][] = [
      ['section row', () => within(panel()).getByRole('link', { name: 'Gatherings' })],
      ['brand', () => within(panel()).getByRole('link', { name: 'CoveyKeep' })],
      ['plus', () => within(rail()).getByRole('link', { name: 'New group' })],
      ['settings', () => within(side()).getByRole('link', { name: 'Settings' })],
      ['gathering row', () => within(panel()).getByRole('link', { name: /Book Club/ })],
      // Last, because it takes Home's panel away: a Coming up row moves to its group's.
      ['coming up row', () => within(panel()).getByRole('link', { name: /Lees Picnic/ })],
    ]
    for (const [label, find] of others) {
      await openDrawerIfClosed()
      fireEvent.click(find())
      await settle()
      expect(screen.queryByRole('dialog', { name: 'Menu' }), label).toBeNull()
    }
    // A group panel's rows.
    await openDrawerIfClosed()
    fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
    await settle()
    fireEvent.click(within(panel()).getByRole('link', { name: /^People/ }))
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  })

  test(`a ctrl-click on a tile leaves nothing stale: the next row closes the drawer${how}`, async () => {
    renderAt('/you', { strict })
    await settle()
    await openDrawer()
    fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }), { ctrlKey: true })
    // The modified press opens a tab: no navigation here, and the drawer stays.
    fireEvent.click(within(panel()).getByRole('link', { name: 'Gatherings' }))
    await settle()
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  })
}

async function openDrawerIfClosed() {
  if (!screen.queryByRole('dialog', { name: 'Menu' })) await openDrawer()
}

test('Escape and the scrim close it, Back and Forward close it, and a tile\'s press puts nothing in navigation state', async () => {
  renderAt(['/you', '/groups'], { index: 1 })
  await settle()
  await openDrawer()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  await openDrawer()
  fireEvent.click(document.querySelector('.frame-scrim') as HTMLElement)
  expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  await openDrawer()
  fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
  await settle()
  expect(screen.getByTestId('state').textContent).toBe('null')
  // Back is not a press: it closes the drawer. Forward neither.
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(where()).toBe('/groups')
  expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  await openDrawer()
  fireEvent.click(screen.getByRole('button', { name: 'history forward' }))
  await settle()
  expect(where()).toBe('/groups/g-1')
  expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
})

test('opening the drawer focuses its first control, which in Rail and panel is the Home tile', async () => {
  renderAt('/you')
  await settle()
  await openDrawer()
  await waitFor(() => expect(document.activeElement).toBe(within(rail()).getByRole('link', { name: 'Home' })))
})

test('the viewer\'s entry state is still exactly { photoViewer: true }, on a page a tile opened', async () => {
  server = { sections: ONE_SECTION }
  stubWidth(true)
  renderAt('/you')
  await settle()
  fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 1 of 1 in Lees Reunion' }))
  const viewer = await screen.findByRole('dialog')
  expect(screen.getByTestId('state').textContent).toBe('{"photoViewer":true}')
  expect(where()).toBe('/groups/g-1')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('state').textContent).toBe('null')
})

// ---------------------------------------------------------------------------
// Focus.
// ---------------------------------------------------------------------------

test('a group\'s tile lands focus on the panel\'s back row, never scrolling; the back row lands it on the Home tile; the Home tile keeps it', async () => {
  stubWidth(true)
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  renderAt('/you')
  await settle()
  focus.mockClear()
  fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
  await settle()
  const back = panel().querySelector('.backrow a') as HTMLElement
  expect(document.activeElement).toBe(back)
  expect(focus.mock.calls.some(([options], index) => focus.mock.contexts[index] === back && (options as FocusOptions)?.preventScroll === true)).toBe(true)
  fireEvent.click(back)
  await settle()
  expect(document.activeElement).toBe(within(rail()).getByRole('link', { name: 'Home' }))
  const home = within(rail()).getByRole('link', { name: 'Home' })
  home.focus()
  fireEvent.click(home)
  await settle()
  expect(document.activeElement).toBe(home)
})

test('from 900px a gathering row on Home\'s panel whose gathering is in a group changes the panel, and focus goes to the new back row', async () => {
  stubWidth(true)
  renderAt('/you')
  await settle()
  fireEvent.click(within(panel()).getByRole('link', { name: /Lees Picnic/ }))
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
  expect(document.activeElement).toBe(panel().querySelector('.backrow a'))
})

test('the panel starts at its top when it changes to another group\'s or Home\'s, and a row in the same panel moves nothing', async () => {
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  panel().scrollTop = 120
  fireEvent.click(within(panel()).getByRole('link', { name: /Lees Picnic/ }))
  await settle()
  expect(panel().scrollTop).toBe(120)
  fireEvent.click(within(rail()).getByRole('link', { name: 'Cousins' }))
  await settle()
  expect(panel().scrollTop).toBe(0)
  // Back and Forward too: the panel changes with the address.
  panel().scrollTop = 120
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('The Lees')
  expect(panel().scrollTop).toBe(0)
  panel().scrollTop = 120
  fireEvent.click(screen.getByRole('button', { name: 'history forward' }))
  await settle()
  expect(panel().querySelector('.dcover h2')?.textContent).toBe('Cousins')
  expect(panel().scrollTop).toBe(0)
})

// ---------------------------------------------------------------------------
// The arrival of the Photos row on a group's page.
// ---------------------------------------------------------------------------

test('a direct open of /groups/<id>#photos arrives once the first read has settled, with focus on the heading, not scrolling by focus', async () => {
  stubWidth(true)
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  renderAt('/groups/g-1#photos')
  await screen.findByRole('heading', { name: 'Photos' })
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  const heading = screen.getByRole('heading', { name: 'Photos' })
  expect(document.activeElement).toBe(heading)
  const calls = focus.mock.calls.filter((_, index) => focus.mock.contexts[index] === heading)
  expect(calls).toEqual([[{ preventScroll: true }]])
})

test('a failed first read still arrives, at the heading', async () => {
  const original = mock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
  mock.mockImplementation(async (url: string, init?: RequestInit) =>
    path(url) === '/groups/g-1/media' ? json(500, {}) : original(url, init),
  )
  stubWidth(true)
  renderAt('/groups/g-1#photos')
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Photos' }))
})

test('no arrival before the first read settles', async () => {
  let release: (response: Response) => void = () => {}
  const original = mock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
  mock.mockImplementation(async (url: string, init?: RequestInit) =>
    path(url) === '/groups/g-1/media' ? new Promise<Response>((resolve) => (release = resolve)) : original(url, init),
  )
  stubWidth(true)
  renderAt('/groups/g-1#photos')
  await settle()
  expect(scrollIntoView).not.toHaveBeenCalled()
  await act(async () => release(json(200, { sections: [] })))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
})

test('the Photos row arrives from another page, from the same page, and again on a second press', async () => {
  stubWidth(true)
  renderAt('/you')
  await settle()
  fireEvent.click(within(rail()).getByRole('link', { name: 'The Lees' }))
  await screen.findByRole('heading', { name: 'Photos' })
  await settle()
  expect(scrollIntoView).not.toHaveBeenCalled()
  const photosRow = () => within(panel()).getByRole('link', { name: /^Photos/ })
  fireEvent.click(photosRow())
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  expect(where()).toBe('/groups/g-1#photos')
  fireEvent.click(photosRow())
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
})

test('Back to a remounted #photos entry does not arrive again, and a press after that return does', async () => {
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  fireEvent.click(within(panel()).getByRole('link', { name: /^Photos/ }))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  fireEvent.click(within(panel()).getByRole('link', { name: /^People/ }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(where()).toBe('/groups/g-1#photos')
  await screen.findByRole('heading', { name: 'Photos' })
  await settle()
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  fireEvent.click(within(panel()).getByRole('link', { name: /^Photos/ }))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
})

test('Forward to a handled #photos entry on the same page does not arrive again', async () => {
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  fireEvent.click(within(panel()).getByRole('link', { name: /^Photos/ }))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'history back' }))
  await settle()
  expect(where()).toBe('/groups/g-1')
  fireEvent.click(screen.getByRole('button', { name: 'history forward' }))
  await settle()
  expect(where()).toBe('/groups/g-1#photos')
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})

test('closing the viewer back to a #photos entry does not arrive again', async () => {
  server = { sections: ONE_SECTION }
  stubWidth(true)
  renderAt('/groups/g-1#photos')
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 1 of 1 in Lees Reunion' }))
  const viewer = await screen.findByRole('dialog')
  // The viewer pushes without the hash, and its close pops back to the #photos key.
  expect(where()).toBe('/groups/g-1')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await settle()
  expect(where()).toBe('/groups/g-1#photos')
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})

test('from the drawer on a phone a same-page Photos press closes it with focus on the heading, not stolen by the menu button', async () => {
  renderAt('/groups/g-1')
  await screen.findByRole('heading', { name: 'Photos' })
  await settle()
  await openDrawer()
  fireEvent.click(within(panel()).getByRole('link', { name: /^Photos/ }))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  await settle()
  expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Photos' }))
})

test('closing the drawer still returns focus to the menu button when the column holds no focus', async () => {
  renderAt('/you')
  await settle()
  await openDrawer()
  fireEvent.keyDown(document, { key: 'Escape' })
  await settle()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }))
})

test('the strip stays on a group\'s page in Rail and panel', async () => {
  stubWidth(true)
  renderAt('/groups/g-1')
  await settle()
  expect(document.querySelector('.group-strip')).toBeTruthy()
  // And no stylesheet hides it, at any width, in either layout.
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]*\.group-strip[^{}]*)\{([^{}]*)\}/g)]
  expect(rules.length).toBeGreaterThan(0)
  for (const [, selector, body] of rules) expect(body, selector).not.toMatch(/display:\s*none|visibility:\s*hidden/)
})

// ---------------------------------------------------------------------------
// The styles.
// ---------------------------------------------------------------------------

test('the styles: 358px from 900 on the rail\'s class and 304 unchanged, no colour named, the gutter under :root:has(.tabbar) alone', () => {
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const wide = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}\n/.exec(css.slice(css.indexOf('.frame {\n    display: grid') - 40))?.[1] ?? ''
  expect(wide).toMatch(/\.frame-side\.frame-side-rail \{\s*width: 358px;/)
  expect(wide).toMatch(/\.frame-side \{[^}]*width: 304px;/)
  const railCss = css.slice(css.indexOf('.rail {'), css.indexOf('.you-who'))
  expect(railCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i)
  const gutter = /([^{}]*)\{\s*scrollbar-gutter: stable;\s*\}/.exec(css)
  expect(gutter?.[1].trim()).toBe(':root:has(.tabbar)')
  expect(css.match(/scrollbar-gutter/g)).toHaveLength(1)
  // Not inside any media query: a top-level rule starts in column 0.
  expect(css).toMatch(/^:root:has\(\.tabbar\) \{\n {2}scrollbar-gutter: stable;/m)
})

test('a tile or a row brought into view by the keyboard keeps its ring inside its scroller: 5px of ring, 8px of margin', () => {
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
  expect(css).toMatch(/\.rail-item \{[^}]*scroll-margin-block: 8px;/)
  expect(css).toMatch(/\.panel \.nrow \{[^}]*scroll-margin-block: 8px;/)
})
