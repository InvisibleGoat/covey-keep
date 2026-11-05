// CK-88.2 pins: a page keeps its place. Through the app's REAL route table with
// the REAL AuthProvider over the real session store (the CK-76.1 Gotcha), so the
// frame, the guard and the history are the app's own. jsdom has no layout, so
// both scrollers are a stub that clamps to a settable height (`max`), and the
// browser's own part — the clamp when a page goes, the event that follows — is
// played by the test where it matters. The timing itself is measured in a real
// browser (the CK-88.2 report); these pin the rule. The values under test:
// - THREE KINDS OF PAGE, decided once per pathname change: a key seen before is a
//   return by history; a new key, no hash, at the path of the page just left is a
//   return by a link; anything else is a new page, at the top of whichever
//   scroller is active.
// - THE PLACE HELD: re-applied on every DOM change until the person acts, the
//   window closes, the pathname changes or the frame goes, never stopping on
//   reaching y.
// - THE VIEWER moves nothing: its entries share a pathname.
// - THE ARRIVAL: a link with a hash always arrives; Back to it never does.
// - THE LISTS THAT OPENED stay open on a return, and fold on a new visit.
// - FOCUS back to a link pressed from the keyboard, once the place is reached, and
//   never for a mouse, or over anything that has focus.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import type { AuthState } from '../auth/context'
import { useAuth } from '../auth/useAuth'
import { clearCoverPictures } from '../lib/covers'
import { setToken } from '../lib/session'

// The restore's window, as a literal: the rule says 5 seconds.
const WINDOW_MS = 5000

const PAST = '2026-07-04T10:30:00+00:00'
const REF = { id: 'g-1', name: 'The Lees' }
const GROUP = {
  id: 'g-1',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-ada-7777',
  member_count: 4,
  caller_role: 'member',
  cover: null,
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
}

type Row = Record<string, unknown>

function item(id: string, title: string, group: unknown = REF): Row {
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
    group,
    caller_role: null,
    caller_view: 'full',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    next_occurrence: { id: `o-${id}`, starts_at: PAST },
    occurrence_count: 1,
  }
}

function photo(gathering: string, n: number): Row {
  return {
    id: `${gathering}-m${n}`,
    gathering_id: gathering,
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: PAST,
    created_at: PAST,
    uploader_display_name: 'Nate Okafor',
    is_own: false,
    removed_at: null,
    filename: `IMG_${n}.jpg`,
    caption: null,
    tags: [],
    published_at: PAST,
    failure_reason: null,
  }
}

const rows = (gathering: string, count: number) => Array.from({ length: count }, (_, i) => photo(gathering, i + 1))

function detail(id: string, title: string, group: unknown): Row {
  const { next_occurrence: _next, occurrence_count: _count, ...rest } = item(id, title, group)
  return {
    ...rest,
    occurrences: [
      { id: `o-${id}`, gathering_id: id, starts_at: PAST, ends_at: null, location: 'The dock', map_url: 'https://maps.example/dock', caller_response: null },
    ],
  }
}

// Eleven photos on the Lake, three on the Supper; a standalone gathering; and ten
// past gatherings on Your gatherings, for its Show all.
const COUNTS: Record<string, number> = { 'g-lake': 11, 'g-supper': 3, 'g-solo': 3 }
const TITLES: Record<string, string> = { 'g-lake': 'The Lake', 'g-supper': 'Sunday Supper', 'g-solo': 'Standalone Supper' }
const PAST_IDS = Array.from({ length: 10 }, (_, i) => `p-${i + 1}`)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function answer(method: string, path: string, world: World): Response {
  if (method === 'POST' && path === '/auth/logout') return new Response(null, { status: 204 })
  if (method !== 'GET') return json(404, { detail: 'Not Found' })
  if (path === '/health') return json(200, { status: 'ok' })
  if (path === '/auth/me') {
    return json(200, { id: 'person-bea', display_name: 'Bea', email: 'bea@example.com', timezone: 'America/Chicago', account_id: 'acct-bea' })
  }
  if (path === '/groups') return json(200, { groups: [GROUP] })
  if (path === '/gatherings') {
    return json(200, { gatherings: [item('g-solo', TITLES['g-solo'], null), ...PAST_IDS.map((id) => item(id, `Past ${id}`, null))] })
  }
  if (path === '/groups/g-1') return json(200, GROUP)
  if (path === '/groups/g-1/gatherings') {
    return json(200, { gatherings: world.groupGatherings.map((id) => item(id, TITLES[id])) })
  }
  if (path === '/groups/g-1/media') {
    return json(200, {
      sections: world.groupGatherings.map((id) => ({ gathering_id: id, published_count: COUNTS[id], media: rows(id, Math.min(COUNTS[id], 8)) })),
    })
  }
  const media = path.match(/^\/gatherings\/([\w-]+)\/media$/)
  if (media) return json(200, { media: rows(media[1], COUNTS[media[1]] ?? 3) })
  const one = path.match(/^\/gatherings\/([\w-]+)$/)
  if (one) {
    const id = one[1]
    const inGroup = id === 'g-lake' || id === 'g-supper'
    return json(200, detail(id, TITLES[id] ?? `Past ${id}`, inGroup ? REF : null))
  }
  const layer = path.match(/^\/media\/([\w-]+)\/url\?layer=(\w+)$/)
  if (layer) return json(200, { url: `https://r2.invalid/media/${layer[1]}/${layer[2]}?X-Amz-Signature=sig`, method: 'GET' })
  if (/^\/occurrences\/[\w-]+\/rsvps$/.test(path)) return json(200, { visibility: 'INVITEES', own: null, rsvps: [] })
  if (path === '/billing') return json(500, {})
  return json(404, { detail: 'Not Found' })
}

interface World {
  groupGatherings: string[]
}

function stubServer() {
  const world: World = { groupGatherings: ['g-lake', 'g-supper'] }
  const held = new Map<string, (() => void)[]>()
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const raw = String(url)
    if (raw.startsWith('https://r2.invalid/')) return Promise.resolve(new Response(new Uint8Array(3), { status: 200 }))
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    const waiting = held.get(path)
    if (waiting) return new Promise<Response>((resolve) => waiting.push(() => resolve(answer(method, path, world))))
    return Promise.resolve(answer(method, path, world))
  })
  vi.stubGlobal('fetch', mock)
  return {
    world,
    // Reads of these paths wait from now on, until their release.
    hold(...paths: string[]) {
      for (const path of paths) held.set(path, [])
    },
    async release(...paths: string[]) {
      await act(async () => {
        for (const path of paths) {
          const waiting = held.get(path) ?? []
          held.delete(path)
          for (const go of waiting) go()
        }
      })
      await act(async () => {
        await Promise.resolve()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The scrollers: a stub on every element, clamping to `max`, recording each write.
// ---------------------------------------------------------------------------

interface Scroller {
  top: number
  max: number
  writes: number[]
}

let scrollers = new WeakMap<Element, Scroller>()
function stubOf(element: Element): Scroller {
  let scroller = scrollers.get(element)
  if (scroller === undefined) {
    scroller = { top: 0, max: 100000, writes: [] }
    scrollers.set(element, scroller)
  }
  return scroller
}

const realScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') as PropertyDescriptor

const columnElement = () => document.querySelector('.frame-col') as HTMLElement
const windowScroller = () => stubOf(document.documentElement)
const columnScroller = () => stubOf(columnElement())

// The two layouts every scroller's rule is pinned on.
interface Layout {
  name: string
  wide: boolean
  scroller: () => Scroller
  other: () => Scroller
  // The person's own scroll: the scroller moves, and its event fires.
  scrollTo: (y: number) => void
  // The browser's clamp event, arriving a frame after the clamp.
  fireScroll: () => void
}

const PHONE: Layout = {
  name: 'a phone, the window',
  wide: false,
  scroller: windowScroller,
  other: columnScroller,
  scrollTo(y) {
    windowScroller().top = y
    fireEvent.scroll(window)
  },
  fireScroll: () => fireEvent.scroll(window),
}

const WIDE: Layout = {
  name: 'a wide screen, the column',
  wide: true,
  scroller: columnScroller,
  other: windowScroller,
  scrollTo(y) {
    columnScroller().top = y
    fireEvent.scroll(columnElement())
  },
  fireScroll: () => fireEvent.scroll(columnElement()),
}

const LAYOUTS = [PHONE, WIDE]

// The window as the frame reads it; `set` crosses 900px.
function stubWidth(wide: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: wide,
    media: '(min-width: 900px)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    async set(next: boolean) {
      query.matches = next
      await act(async () => {
        for (const listener of listeners) listener()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The app, and the person's hands.
// ---------------------------------------------------------------------------

const nav: { current: NavigateFunction | null } = { current: null }
const auth: { current: AuthState | null } = { current: null }
function Probe() {
  const navigate = useNavigate()
  const state = useAuth()
  useEffect(() => {
    nav.current = navigate
    auth.current = state
  })
  return null
}

function LocationProbe() {
  return <span data-testid="at">{useLocation().pathname}</span>
}

function renderApp(address: string) {
  return render(
    <MemoryRouter initialEntries={[address]}>
      <AuthProvider>
        <App />
        <Probe />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function settle(ms = 15) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

const back = async () => {
  await act(async () => nav.current?.(-1))
  await settle()
}
const forward = async () => {
  await act(async () => nav.current?.(1))
  await settle()
}

// A mouse or a finger: the pointer first, and a click whose detail counts it.
function pressWithMouse(link: Element) {
  fireEvent.pointerDown(link)
  fireEvent.click(link, { detail: 1 })
}

// Enter on a focused link: the key first, and a click with detail 0.
function pressWithKeys(link: HTMLElement) {
  link.focus()
  fireEvent.keyDown(link, { key: 'Enter' })
  fireEvent.click(link, { detail: 0 })
}

const inMain = (href: string) => document.querySelector<HTMLAnchorElement>(`main a[href="${href}"]`)
const inMenu = (href: string) => document.querySelector(`.frame-side a[href="${href}"]`) as HTMLAnchorElement
const inTabs = (href: string) => document.querySelector(`.tabbar a[href="${href}"]`) as HTMLAnchorElement
const crumb = () => document.querySelector('.crumb a') as HTMLAnchorElement

async function linkInMain(href: string) {
  await waitFor(() => expect(inMain(href)).not.toBeNull())
  return inMain(href) as HTMLAnchorElement
}

const heading1 = (name: string) => screen.findByRole('heading', { level: 1, name })
const groupPage = () => heading1('The Lees')
const groupsPage = () => heading1('Groups')

async function groupPageLoaded() {
  await groupPage()
  await screen.findByRole('region', { name: 'The Lake' })
}

// A gathering's page once its photos have landed.
async function gatheringLoaded(title: string) {
  await heading1(title)
  await waitFor(() => expect(gridTiles().length).toBeGreaterThan(0))
}

const gridTiles = () => screen.queryAllByRole('button', { name: /^Photo \d+ of \d+ in / })
const pageTiles = () => gridTiles().filter((tile) => tile.closest('.viewer') === null)
const here = () => screen.getByTestId('at').textContent

// The page's own scrolls: the viewer's strip brings a thumbnail into view on its
// own account, and that is not the page moving.
function stubArrivals() {
  const scrolled: Element[] = []
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    if (this.closest('.viewer') === null) scrolled.push(this)
  }
  return scrolled
}

beforeEach(() => {
  localStorage.clear()
  nav.current = null
  auth.current = null
  setToken('session-test')
  let made = 0
  Object.assign(URL, { createObjectURL: () => `blob:stub-${(made += 1)}`, revokeObjectURL: () => {} })
  scrollers = new WeakMap()
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return stubOf(this).top
    },
    set(this: Element, value: number) {
      const scroller = stubOf(this)
      scroller.writes.push(value)
      scroller.top = Math.max(0, Math.min(value, scroller.max))
    },
  })
})

afterEach(() => {
  cleanup()
  clearCoverPictures()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  Object.defineProperty(Element.prototype, 'scrollTop', realScrollTop)
  delete (Element.prototype as Partial<Element>).scrollIntoView
  ;(document.activeElement as HTMLElement | null)?.blur?.()
})

// ---------------------------------------------------------------------------
// Back and Forward.
// ---------------------------------------------------------------------------

for (const layout of LAYOUTS) {
  test(`Back on ${layout.name}: the place re-applied, held as the page's reads land while it grows, and held again when more lands above it`, async () => {
    stubWidth(layout.wide)
    const server = stubServer()
    renderApp('/gatherings/g-lake')
    await gatheringLoaded('The Lake')
    layout.scrollTo(1800)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    const scroller = layout.scroller()
    expect(scroller.top).toBe(0)

    // The page comes back empty: on its loading screen, so the browser clamps.
    server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
    scroller.max = 300
    await back()
    expect(here()).toBe('/gatherings/g-lake')
    expect(scroller.top).toBe(300)
    expect(scroller.writes[scroller.writes.length - 1]).toBe(1800)

    // The detail lands: taller, and it reaches the place.
    scroller.max = 5000
    await server.release('/gatherings/g-lake')
    await heading1('The Lake')
    await waitFor(() => expect(scroller.top).toBe(1800))

    // Then the photos land above the later sections, and the browser has moved:
    // the rule does not stop on reaching y.
    scroller.top = 2100
    await server.release('/gatherings/g-lake/media')
    await waitFor(() => expect(gridTiles().length).toBeGreaterThan(0))
    await waitFor(() => expect(scroller.top).toBe(1800))
    expect(layout.other().writes).toEqual([])
  })

  test(`Forward and Back again on ${layout.name}: each entry at its own place`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    layout.scrollTo(300)
    await back()
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(2400)
    await forward()
    await heading1('You')
    expect(layout.scroller().top).toBe(300)
    await back()
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(2400)
  })

  test(`a new page on ${layout.name}: at the top at once, even one that renders tall at once, and the other scroller untouched`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    const before = layout.scroller().writes.length
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    expect(layout.scroller().top).toBe(0)
    expect(layout.scroller().writes.slice(before)).toEqual([0])
    expect(layout.other().writes).toEqual([])
  })

  test(`the crumb on ${layout.name}: from a gathering to its group's page, at the place left`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    pressWithMouse(await linkInMain('/gatherings/g-lake'))
    await gatheringLoaded('The Lake')
    expect(layout.scroller().top).toBe(0)
    pressWithMouse(crumb())
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(2400)
  })

  test(`a layout change between the leaving and the return on ${layout.name}: the top, because a place saved in one layout means nothing in the other`, async () => {
    const width = stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    await width.set(!layout.wide)
    await back()
    await groupPageLoaded()
    const now = layout.wide ? windowScroller() : columnScroller()
    expect(now.top).toBe(0)
    expect(now.writes).not.toContain(2400)
    expect(layout.scroller().writes).not.toContain(2400)
  })

  test(`the viewer on ${layout.name}: opening and closing writes nothing to the scroller, on a page reached by a return as well`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    await back()
    await groupPageLoaded()
    const scroller = layout.scroller()
    expect(scroller.top).toBe(2400)
    const before = scroller.writes.length
    const tile = within(await screen.findByRole('region', { name: 'The Lake' })).getByRole('button', { name: 'Photo 1 of 11 in The Lake' })
    pressWithMouse(tile)
    await screen.findByRole('dialog')
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await settle()
    expect(scroller.writes.slice(before)).toEqual([])
    expect(scroller.top).toBe(2400)
  })

  for (const [name, fire] of [
    ['wheel', () => fireEvent.wheel(document.body)],
    ['touchstart', () => fireEvent.touchStart(document.body)],
    ['pointerdown', () => fireEvent.pointerDown(document.body)],
    ['keydown', () => fireEvent.keyDown(document.body, { key: 'ArrowDown' })],
  ] as const) {
    test(`the person acting on ${layout.name}: ${name} stops the re-apply, so it never fights a hand`, async () => {
      stubWidth(layout.wide)
      const server = stubServer()
      renderApp('/gatherings/g-lake')
      await gatheringLoaded('The Lake')
      layout.scrollTo(1800)
      fireEvent.click(inMenu('/you'), { detail: 1 })
      await heading1('You')
      const scroller = layout.scroller()
      server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
      scroller.max = 300
      await back()
      expect(scroller.top).toBe(300)
      fire()
      const before = scroller.writes.length
      scroller.max = 5000
      await server.release('/gatherings/g-lake', '/gatherings/g-lake/media')
      await heading1('The Lake')
      await settle()
      expect(scroller.writes.slice(before)).toEqual([])
      expect(scroller.top).toBe(300)
    })
  }

  test(`a pathname change during the wait on ${layout.name} stops it, and the place saved for the page left is the target, not the clamp`, async () => {
    stubWidth(layout.wide)
    const server = stubServer()
    renderApp('/gatherings/g-lake')
    await gatheringLoaded('The Lake')
    layout.scrollTo(1800)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    const scroller = layout.scroller()
    server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
    scroller.max = 300
    await back()
    expect(scroller.top).toBe(300)
    // The clamp's own event, while the restore is running: ignored.
    layout.fireScroll()
    await act(async () => nav.current?.('/groups'))
    await groupsPage()
    const writes = scroller.writes.length
    await server.release('/gatherings/g-lake', '/gatherings/g-lake/media')
    await settle()
    expect(scroller.writes.slice(writes)).toEqual([])
    scroller.max = 5000
    await back()
    await gatheringLoaded('The Lake')
    expect(scroller.top).toBe(1800)
  })

  test(`a real press elsewhere during the wait on ${layout.name}: the press is an act and stops the restore, and the place saved is still the target`, async () => {
    stubWidth(layout.wide)
    const server = stubServer()
    renderApp('/gatherings/g-lake')
    await gatheringLoaded('The Lake')
    layout.scrollTo(1800)
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    const scroller = layout.scroller()
    server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
    scroller.max = 300
    await back()
    expect(scroller.top).toBe(300)
    pressWithMouse(inMenu('/groups'))
    await groupsPage()
    await server.release('/gatherings/g-lake', '/gatherings/g-lake/media')
    scroller.max = 5000
    await back()
    await gatheringLoaded('The Lake')
    expect(scroller.top).toBe(1800)
  })

  test(`the place left on ${layout.name} is what the scroll event last said, never scrollTop at the leaving, when the browser has already clamped`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    // The old page leaving the DOM has already clamped the scroller, and the
    // event for it has not fired yet.
    layout.scroller().top = 40
    fireEvent.click(inMenu('/you'), { detail: 1 })
    await heading1('You')
    await back()
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(2400)
  })

  test(`no markup moved on ${layout.name}: the column's children are the page and the bars, and the page is still the column's own child`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPage()
    const children = Array.from(columnElement().children).map((child) => child.tagName)
    expect(children).toEqual(layout.wide ? ['MAIN'] : ['HEADER', 'MAIN', 'NAV'])
    expect(document.querySelector('.frame-col > .auth-screen')).not.toBeNull()
  })
}

// ---------------------------------------------------------------------------
// After a return: the person moves on, and the breakpoint. A scrollTop written
// during a hold is no person's act, so the page rightly ignores it: each journey
// here closes the hold first, as a real wheel or the window does.
// ---------------------------------------------------------------------------

const CLOSINGS = [
  {
    name: 'the person’s wheel',
    before: () => {},
    close: async () => {
      fireEvent.wheel(document.body)
    },
  },
  {
    name: 'the window',
    before: () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    },
    close: async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WINDOW_MS)
      })
      vi.useRealTimers()
    },
  },
]

for (const layout of LAYOUTS) {
  const other = layout.wide ? PHONE : WIDE

  for (const closing of CLOSINGS) {
    test(`moving on after a return on ${layout.name}, the hold closed by ${closing.name}: a leaving saves where the person moved, and a later page keeps its own place`, async () => {
      stubWidth(layout.wide)
      stubServer()
      renderApp('/gatherings/g-lake')
      await gatheringLoaded('The Lake')
      layout.scrollTo(1800)
      pressWithMouse(inMenu('/you'))
      await heading1('You')

      closing.before()
      await act(async () => nav.current?.(-1))
      expect(layout.scroller().top).toBe(1800)
      await closing.close()
      await gatheringLoaded('The Lake')

      // The person moves on from the place they were returned to.
      layout.scrollTo(2600)
      pressWithMouse(inMenu('/groups'))
      await groupsPage()
      expect(layout.scroller().top).toBe(0)
      layout.scrollTo(900)

      await back()
      await gatheringLoaded('The Lake')
      expect(layout.scroller().top).toBe(2600)
      await forward()
      await groupsPage()
      expect(layout.scroller().top).toBe(900)
      await back()
      await gatheringLoaded('The Lake')
      expect(layout.scroller().top).toBe(2600)
    })
  }

  test(`moving on after a return by a link on ${layout.name}: back and forth between two pages, each keeps where the person last moved it`, async () => {
    stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    pressWithMouse(await linkInMain('/gatherings/g-lake'))
    await gatheringLoaded('The Lake')
    layout.scrollTo(700)

    pressWithMouse(crumb())
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(2400)
    fireEvent.wheel(document.body)
    layout.scrollTo(3100)

    pressWithMouse(await linkInMain('/gatherings/g-lake'))
    await gatheringLoaded('The Lake')
    expect(layout.scroller().top).toBe(700)
    fireEvent.wheel(document.body)
    layout.scrollTo(900)

    pressWithMouse(crumb())
    await groupPageLoaded()
    expect(layout.scroller().top).toBe(3100)
    pressWithMouse(await linkInMain('/gatherings/g-lake'))
    await gatheringLoaded('The Lake')
    expect(layout.scroller().top).toBe(900)
  })

  test(`crossing the breakpoint from ${layout.name}: the place from then on is the new scroller’s, before any scroll of it`, async () => {
    const width = stubWidth(layout.wide)
    stubServer()
    renderApp('/groups/g-1')
    await groupPageLoaded()
    layout.scrollTo(2400)
    // Where the browser has the new scroller as the layouts change: no event says so.
    other.scroller().top = 640
    await width.set(other.wide)
    pressWithMouse(inMenu('/you'))
    await heading1('You')
    await back()
    await groupPageLoaded()
    expect(other.scroller().top).toBe(640)
    expect(other.scroller().writes).not.toContain(2400)
  })

  test(`crossing the breakpoint during a return from ${layout.name}: the hold ends, so nothing more is written to the old scroller and the new one’s scroll counts`, async () => {
    const width = stubWidth(layout.wide)
    const server = stubServer()
    renderApp('/gatherings/g-lake')
    await gatheringLoaded('The Lake')
    layout.scrollTo(1800)
    pressWithMouse(inMenu('/you'))
    await heading1('You')
    const old = layout.scroller()
    server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
    old.max = 300
    await back()
    expect(old.top).toBe(300)

    await width.set(other.wide)
    const before = old.writes.length
    old.max = 5000
    await server.release('/gatherings/g-lake', '/gatherings/g-lake/media')
    await gatheringLoaded('The Lake')
    await settle()
    expect(old.writes.slice(before)).toEqual([])
    expect(other.scroller().writes).toEqual([])

    other.scrollTo(500)
    pressWithMouse(inMenu('/you'))
    await heading1('You')
    await back()
    await gatheringLoaded('The Lake')
    expect(other.scroller().top).toBe(500)
  })
}

// ---------------------------------------------------------------------------
// A return by a link.
// ---------------------------------------------------------------------------

test('the crumb from a standalone gathering to Your gatherings, at the place left', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  PHONE.scrollTo(1500)
  pressWithMouse(await linkInMain('/gatherings/g-solo'))
  await gatheringLoaded('Standalone Supper')
  expect(windowScroller().top).toBe(0)
  pressWithMouse(crumb())
  await heading1('Your gatherings')
  expect(windowScroller().top).toBe(1500)
})

test('a tab to the page just left: at the place, both ways round', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups')
  await groupsPage()
  PHONE.scrollTo(1000)
  pressWithMouse(inTabs('/gatherings'))
  await heading1('Your gatherings')
  expect(windowScroller().top).toBe(0)
  PHONE.scrollTo(700)
  pressWithMouse(inTabs('/groups'))
  await groupsPage()
  expect(windowScroller().top).toBe(1000)
  pressWithMouse(inTabs('/gatherings'))
  await heading1('Your gatherings')
  expect(windowScroller().top).toBe(700)
})

test('a menu row to the page just left: at the place', async () => {
  stubWidth(true)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  WIDE.scrollTo(2400)
  pressWithMouse(inMenu('/you'))
  await heading1('You')
  await waitFor(() => expect(inMenu('/groups/g-1')).not.toBeNull())
  pressWithMouse(inMenu('/groups/g-1'))
  await groupPageLoaded()
  expect(columnScroller().top).toBe(2400)
})

test('a link to a page visited earlier but not just left: at the top', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  pressWithMouse(inTabs('/gatherings'))
  await heading1('Your gatherings')
  await waitFor(() => expect(inMenu('/groups/g-1')).not.toBeNull())
  pressWithMouse(inMenu('/groups/g-1'))
  await groupPageLoaded()
  expect(windowScroller().top).toBe(0)
})

test('the same gathering’s card straight after its crumb: at the place in it, and going back and forth keeps both places', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  pressWithMouse(await linkInMain('/gatherings/g-lake'))
  await gatheringLoaded('The Lake')
  PHONE.scrollTo(700)
  pressWithMouse(crumb())
  await groupPageLoaded()
  expect(windowScroller().top).toBe(2400)
  pressWithMouse(await linkInMain('/gatherings/g-lake'))
  await gatheringLoaded('The Lake')
  expect(windowScroller().top).toBe(700)
  pressWithMouse(crumb())
  await groupPageLoaded()
  expect(windowScroller().top).toBe(2400)
})

test('a change of search alone does nothing, as today: the same pathname writes to no scroller', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/you')
  await heading1('You')
  PHONE.scrollTo(50)
  const before = windowScroller().writes.length
  await act(async () => nav.current?.('/you?checkout=cancelled'))
  await settle()
  expect(windowScroller().writes.slice(before)).toEqual([])
  expect(windowScroller().top).toBe(50)
})

for (const [from, to, returns] of [
  ['/you?from=a', '/you', false],
  ['/you', '/you?from=a', false],
  ['/you?from=a', '/you?from=b', false],
  ['/you?from=a', '/you?from=a', true],
] as const) {
  test(`a link to ${to} straight after leaving ${from}: ${returns ? 'a return, at the place' : 'a new page, at the top'}, because a path is its pathname and its search`, async () => {
    stubWidth(false)
    stubServer()
    renderApp(from)
    await heading1('You')
    PHONE.scrollTo(300)
    pressWithMouse(inTabs('/groups'))
    await groupsPage()
    await act(async () => nav.current?.(to))
    await heading1('You')
    expect(windowScroller().top).toBe(returns ? 300 : 0)
  })
}

test('Checkout’s return left during its wait, then Your plan’s row on You: the plain page, at the top, because the one search the app carries is part of the path', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/plan?checkout=complete')
  await heading1('Your plan')
  PHONE.scrollTo(300)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  pressWithMouse(await linkInMain('/plan'))
  await heading1('Your plan')
  expect(windowScroller().top).toBe(0)
})

test('the decision is held for the whole visit: a page that mounts its list late, after the frame has re-rendered, still reads a return', async () => {
  stubWidth(false)
  const server = stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  pressWithMouse(await linkInMain('/gatherings/g-lake'))
  await gatheringLoaded('The Lake')
  fireEvent.click(screen.getByRole('button', { name: 'See all 11 photos' }))
  await waitFor(() => expect(pageTiles()).toHaveLength(11))
  pressWithMouse(crumb())
  await groupPageLoaded()
  // The card again: a return by a link, whose Photos section mounts only once the
  // detail lands. The frame re-renders before that, with the drawer.
  server.hold('/gatherings/g-lake')
  pressWithMouse(await linkInMain('/gatherings/g-lake'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await settle()
  await server.release('/gatherings/g-lake')
  await gatheringLoaded('The Lake')
  expect(pageTiles()).toHaveLength(11)
})

// ---------------------------------------------------------------------------
// The viewer's entries, and the current key.
// ---------------------------------------------------------------------------

test('a link pressed from an entry the viewer left behind saves its place under the right key', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  const tile = within(await screen.findByRole('region', { name: 'The Lake' })).getByRole('button', { name: 'Photo 1 of 11 in The Lake' })
  pressWithMouse(tile)
  await screen.findByRole('dialog')
  await settle()
  // Back closes it, and Forward lands on the entry it left, with nothing open.
  await back()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await forward()
  expect(screen.queryByRole('dialog')).toBeNull()
  PHONE.scrollTo(1300)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  // One page further, so the page just left cannot answer for it: only the record
  // at the entry the viewer left behind can bring this place back.
  pressWithMouse(inTabs('/gatherings'))
  await heading1('Your gatherings')
  await back()
  await heading1('You')
  await back()
  await groupPageLoaded()
  expect(windowScroller().top).toBe(1300)
})

// ---------------------------------------------------------------------------
// A hash: the arrival.
// ---------------------------------------------------------------------------

test('a direct open at #photos through the frame still arrives: an initial load is no return', async () => {
  stubWidth(false)
  const arrivals = stubArrivals()
  stubServer()
  renderApp('/gatherings/g-lake#photos')
  await gatheringLoaded('The Lake')
  const heading = screen.getByRole('heading', { level: 2, name: 'Photos' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(arrivals).toHaveLength(1)
  expect(pageTiles()).toHaveLength(11)
})

test('See all always arrives — one scroll and focus on the heading — including straight after the crumb, and its crumb returns to the group page’s place', async () => {
  stubWidth(false)
  const arrivals = stubArrivals()
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  pressWithMouse(await linkInMain('/gatherings/g-lake#photos'))
  await gatheringLoaded('The Lake')
  const heading = screen.getByRole('heading', { level: 2, name: 'Photos' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(arrivals).toHaveLength(1)
  expect(pageTiles()).toHaveLength(11)

  pressWithMouse(crumb())
  await groupPageLoaded()
  expect(windowScroller().top).toBe(2400)

  // Straight after the crumb the gathering IS the page just left, and a link
  // with a hash is never a return.
  pressWithMouse(await linkInMain('/gatherings/g-lake#photos'))
  await gatheringLoaded('The Lake')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Photos' })))
  expect(arrivals).toHaveLength(2)
  expect(windowScroller().top).toBe(0)
})

test('Back to a #photos entry: no scroll into view, no focus on the heading, every photo still a tile, and the place re-applied', async () => {
  stubWidth(false)
  const arrivals = stubArrivals()
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  pressWithMouse(await linkInMain('/gatherings/g-lake#photos'))
  await gatheringLoaded('The Lake')
  await waitFor(() => expect(arrivals).toHaveLength(1))
  PHONE.scrollTo(3000)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await back()
  await gatheringLoaded('The Lake')
  await settle()
  expect(arrivals).toHaveLength(1)
  expect(document.activeElement).not.toBe(screen.getByRole('heading', { level: 2, name: 'Photos' }))
  expect(pageTiles()).toHaveLength(11)
  expect(windowScroller().top).toBe(3000)
})

test('the card straight after an arrival’s crumb: the grid still out, so the place in it can be reached, and no second arrival', async () => {
  stubWidth(false)
  const arrivals = stubArrivals()
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  pressWithMouse(await linkInMain('/gatherings/g-lake#photos'))
  await gatheringLoaded('The Lake')
  await waitFor(() => expect(arrivals).toHaveLength(1))
  PHONE.scrollTo(3000)
  pressWithMouse(crumb())
  await groupPageLoaded()
  pressWithMouse(await linkInMain('/gatherings/g-lake'))
  await gatheringLoaded('The Lake')
  await settle()
  expect(pageTiles()).toHaveLength(11)
  expect(arrivals).toHaveLength(1)
  expect(windowScroller().top).toBe(3000)
})

// ---------------------------------------------------------------------------
// The window.
// ---------------------------------------------------------------------------

test('the window closing stops the re-apply, at 5 seconds and not before; the page stays where it clamped, and that is the place from then on', async () => {
  stubWidth(false)
  const server = stubServer()
  renderApp('/gatherings/g-lake')
  await gatheringLoaded('The Lake')
  PHONE.scrollTo(1800)
  fireEvent.click(inMenu('/you'), { detail: 1 })
  await heading1('You')
  const scroller = windowScroller()
  server.hold('/gatherings/g-lake', '/gatherings/g-lake/media')
  scroller.max = 300

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => nav.current?.(-1))
  expect(scroller.top).toBe(300)

  // Just before the window closes the detail lands, and the place is re-applied.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
  })
  scroller.max = 1000
  await server.release('/gatherings/g-lake')
  expect(scroller.top).toBe(1000)

  // Just after, the photos land, and nothing moves it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2)
  })
  const before = scroller.writes.length
  scroller.max = 5000
  await server.release('/gatherings/g-lake/media')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(scroller.writes.slice(before)).toEqual([])
  expect(scroller.top).toBe(1000)
  vi.useRealTimers()

  // Leaving now keeps where it clamped: the restore read it as it closed.
  fireEvent.click(inMenu('/you'), { detail: 1 })
  await heading1('You')
  await back()
  await gatheringLoaded('The Lake')
  expect(scroller.top).toBe(1000)
})

test('history.scrollRestoration: manual while the frame is mounted, and the previous value put back on unmount', async () => {
  stubWidth(false)
  stubServer()
  window.history.scrollRestoration = 'auto'
  const view = renderApp('/groups/g-1')
  await groupPage()
  await waitFor(() => expect(window.history.scrollRestoration).toBe('manual'))
  view.unmount()
  expect(window.history.scrollRestoration).toBe('auto')
})

test('a sign-out empties the memory: signing in again mounts a new frame, so Back to a page from the earlier session lands at the top', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(auth.current?.status).toBe('signedOut'))
  await waitFor(() => expect(here()).toBe('/'))
  await act(async () => auth.current?.signIn('session-next'))
  await waitFor(() => expect(here()).toBe('/groups'))
  await groupsPage()
  await back()
  expect(here()).toBe('/groups/g-1')
  await groupPageLoaded()
  expect(windowScroller().top).toBe(0)
  expect(windowScroller().writes.filter((write) => write === 2400)).toEqual([])
})

// ---------------------------------------------------------------------------
// The lists that opened.
// ---------------------------------------------------------------------------

const pastCards = () => {
  const heading = screen.getByRole('heading', { level: 2, name: 'Past' })
  return within(heading.nextElementSibling as HTMLElement).getAllByRole('link')
}

async function openPast() {
  fireEvent.click(await screen.findByRole('button', { name: /^Show all \d+ past gatherings$/ }))
  await waitFor(() => expect(pastCards()).toHaveLength(11))
}

test('Show all after Back: the list open, at the place, and focus not moved to the first card it revealed', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  await openPast()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  PHONE.scrollTo(1600)
  pressWithMouse(pastCards()[9])
  await heading1('Past p-9')
  await back()
  await heading1('Your gatherings')
  await waitFor(() => expect(pastCards()).toHaveLength(11))
  expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  expect(windowScroller().top).toBe(1600)
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('the record stays in memory: leaving, a list opened and a return write nothing to storage', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  const written = vi.spyOn(Storage.prototype, 'setItem')
  await openPast()
  PHONE.scrollTo(1600)
  fireEvent.click(pastCards()[9], { detail: 0 })
  await heading1('Past p-9')
  await back()
  await heading1('Your gatherings')
  await waitFor(() => expect(windowScroller().top).toBe(1600))
  expect(written).not.toHaveBeenCalled()
})

test('Show all after the crumb: the list open and at the place', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  await openPast()
  PHONE.scrollTo(1600)
  pressWithMouse(pastCards()[9])
  await heading1('Past p-9')
  pressWithMouse(crumb())
  await heading1('Your gatherings')
  await waitFor(() => expect(pastCards()).toHaveLength(11))
  expect(windowScroller().top).toBe(1600)
})

test('Show all stays remembered through a second return', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  await openPast()
  pressWithMouse(pastCards()[9])
  await heading1('Past p-9')
  await back()
  await heading1('Your gatherings')
  await waitFor(() => expect(pastCards()).toHaveLength(11))
  pressWithMouse(pastCards()[8])
  await heading1('Past p-8')
  await back()
  await heading1('Your gatherings')
  await waitFor(() => expect(pastCards()).toHaveLength(11))
})

test('a new visit to Your gatherings starts folded and at the top', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings')
  await heading1('Your gatherings')
  await openPast()
  PHONE.scrollTo(1600)
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  pressWithMouse(inTabs('/groups'))
  await groupsPage()
  pressWithMouse(inTabs('/gatherings'))
  await heading1('Your gatherings')
  await waitFor(() => expect(pastCards()).toHaveLength(4))
  expect(screen.getByRole('button', { name: 'Show all 11 past gatherings' })).toBeTruthy()
  expect(windowScroller().top).toBe(0)
})

test('a gathering’s See all is still out after leaving and Back, and a new visit starts at the preview', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings/g-lake')
  await gatheringLoaded('The Lake')
  expect(pageTiles()).toHaveLength(6)
  fireEvent.click(screen.getByRole('button', { name: 'See all 11 photos' }))
  await waitFor(() => expect(pageTiles()).toHaveLength(11))
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  await back()
  await gatheringLoaded('The Lake')
  expect(pageTiles()).toHaveLength(11)
  expect(screen.queryByRole('button', { name: /^See all/ })).toBeNull()

  // A new visit: not the page just left, so the preview again.
  pressWithMouse(inTabs('/you'))
  await heading1('You')
  pressWithMouse(inTabs('/groups'))
  await groupsPage()
  await act(async () => nav.current?.('/gatherings/g-lake'))
  await gatheringLoaded('The Lake')
  expect(pageTiles()).toHaveLength(6)
})

// ---------------------------------------------------------------------------
// Focus back to the link.
// ---------------------------------------------------------------------------

// Every call to focus, with its options.
function spyFocus() {
  return vi.spyOn(HTMLElement.prototype, 'focus')
}

// The group page left from a card, pressed as `press` does, and on the way back
// its reads held: the gathering's page is up, and the page is coming back.
async function leftByCard(press: (link: HTMLElement) => void, href = '/gatherings/g-lake') {
  const server = stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  press(await linkInMain(href))
  await gatheringLoaded('The Lake')
  expect(document.activeElement).toBe(document.body)
  return server
}

const GROUP_READS = ['/groups/g-1', '/groups/g-1/gatherings', '/groups/g-1/media']

test('a press with detail 0: focus back to that link once it lands, with preventScroll, once', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.hold(...GROUP_READS)
  windowScroller().max = 300
  await back()
  expect(document.activeElement).toBe(document.body)
  const focus = spyFocus()
  windowScroller().max = 5000
  await server.release('/groups/g-1', '/groups/g-1/gatherings')
  await groupPage()
  const link = inMain('/gatherings/g-lake') as HTMLAnchorElement
  await waitFor(() => expect(document.activeElement).toBe(link))
  expect(windowScroller().top).toBe(2400)
  expect(focus.mock.calls.filter(([options]) => options?.preventScroll === true)).toHaveLength(1)
  expect(focus.mock.calls.filter(([options]) => options?.preventScroll !== true)).toEqual([])

  // Once: a later landing does not take focus back.
  link.blur()
  await server.release('/groups/g-1/media')
  await screen.findByRole('region', { name: 'The Lake' })
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('a press with detail 0, then the crumb: focus back to that link there too', async () => {
  stubWidth(false)
  await leftByCard(pressWithKeys)
  pressWithMouse(crumb())
  await groupPageLoaded()
  await waitFor(() => expect(document.activeElement?.getAttribute('href')).toBe('/gatherings/g-lake'))
  expect(windowScroller().top).toBe(2400)
})

test('a press with detail 1: focus stays on the body', async () => {
  stubWidth(false)
  await leftByCard(pressWithMouse)
  await back()
  await groupPageLoaded()
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('nothing moves if something else has focus', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.hold(...GROUP_READS)
  await back()
  const menuButton = screen.getByRole('button', { name: 'Open menu' })
  menuButton.focus()
  await server.release(...GROUP_READS)
  await groupPageLoaded()
  await settle()
  expect(document.activeElement).toBe(menuButton)
})

test('a link that has gone does nothing', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.world.groupGatherings = ['g-supper']
  await back()
  await screen.findByRole('region', { name: 'Sunday Supper' })
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('two links with one href: the one nearer the viewport’s middle, whichever comes first', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  const middle = window.innerHeight / 2
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
    // The strip's card, first in the document, is far above; the section's head is
    // on the viewport's middle.
    const top = this.closest('.group-strip') !== null ? -900 : middle - 10
    return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  // The strip's card lands first; the place is reached only as the sections land.
  server.hold('/groups/g-1/media')
  windowScroller().max = 300
  await back()
  await linkInMain('/gatherings/g-lake')
  expect(document.activeElement).toBe(document.body)
  windowScroller().max = 5000
  await server.release('/groups/g-1/media')
  await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  const links = Array.from(document.querySelectorAll('main a[href="/gatherings/g-lake"]'))
  expect(links.length).toBeGreaterThan(1)
  expect(links[0].closest('.group-strip')).not.toBeNull()
  expect(document.activeElement).toBe(links.find((link) => link.closest('.group-strip') === null))
})

test('a Map link opened from the keyboard and a later press elsewhere leave nothing stale', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/gatherings/g-solo')
  await gatheringLoaded('Standalone Supper')
  const map = document.querySelector('main a[href^="https://maps.example"]') as HTMLAnchorElement
  map.addEventListener('click', (event) => event.preventDefault())
  pressWithKeys(map)
  map.blur()
  // On the wide layout the menu sits outside the column, so this press is not seen.
  fireEvent.click(inMenu('/you'), { detail: 1 })
  await heading1('You')
  await back()
  await gatheringLoaded('Standalone Supper')
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('a keyboard press that went nowhere and a later mouse press to the same page leave nothing stale', async () => {
  stubWidth(false)
  stubServer()
  renderApp('/groups/g-1')
  await groupPageLoaded()
  PHONE.scrollTo(2400)
  // Opened in a new tab: the app stays where it is, and the press is remembered.
  const card = await linkInMain('/gatherings/g-lake')
  card.addEventListener('click', (event) => event.preventDefault(), { once: true })
  pressWithKeys(card)
  expect(here()).toBe('/groups/g-1')
  card.blur()
  // Then a mouse press on a link to that same page.
  pressWithMouse(await linkInMain('/gatherings/g-lake#photos'))
  await gatheringLoaded('The Lake')
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await back()
  await groupPageLoaded()
  await settle()
  expect(windowScroller().top).toBe(2400)
  expect(document.activeElement).toBe(document.body)
})

test('focus waits for the place to be reached, though the link is already there', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.hold('/groups/g-1/media')
  windowScroller().max = 300
  await back()
  await groupPage()
  const link = await linkInMain('/gatherings/g-lake')
  await settle()
  expect(windowScroller().top).toBe(300)
  expect(document.activeElement).toBe(document.body)
  windowScroller().max = 5000
  await server.release('/groups/g-1/media')
  await waitFor(() => expect(windowScroller().top).toBe(2400))
  await waitFor(() => expect(document.activeElement?.getAttribute('href')).toBe(link.getAttribute('href')))
})

test('at the window’s close focus goes to the link though the page is shorter now', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.hold('/groups/g-1/media')
  windowScroller().max = 300
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => nav.current?.(-1))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
  })
  expect(windowScroller().top).toBe(300)
  expect(document.activeElement).toBe(document.body)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2)
  })
  expect(document.activeElement?.getAttribute('href')).toBe('/gatherings/g-lake')
  vi.useRealTimers()
  await server.release('/groups/g-1/media')
})

test('a person’s act cancels it: the link there, the place not yet reached, and neither the act nor what lands after it moves focus', async () => {
  stubWidth(false)
  const server = await leftByCard(pressWithKeys)
  server.hold('/groups/g-1/media')
  windowScroller().max = 300
  await back()
  await linkInMain('/gatherings/g-lake')
  expect(windowScroller().top).toBe(300)
  fireEvent.pointerDown(document.body)
  expect(document.activeElement).toBe(document.body)
  windowScroller().max = 5000
  await server.release('/groups/g-1/media')
  await screen.findByRole('region', { name: 'The Lake' })
  await settle()
  expect(document.activeElement).toBe(document.body)
})

test('a link in the bars with the same href is never taken: the crumb’s, while the page is on its way, and the page’s own once it lands', async () => {
  stubWidth(false)
  const server = stubServer()
  renderApp('/gatherings/g-solo')
  await gatheringLoaded('Standalone Supper')
  // The crumb to /gatherings, pressed from the keyboard: the tab has that href too.
  pressWithKeys(crumb())
  await heading1('Your gatherings')
  server.hold('/gatherings/g-solo', '/gatherings/g-solo/media')
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await back()
  await settle()
  expect(document.activeElement).toBe(document.body)
  await server.release('/gatherings/g-solo', '/gatherings/g-solo/media')
  await gatheringLoaded('Standalone Supper')
  await waitFor(() => expect(document.activeElement).toBe(crumb()))
})
