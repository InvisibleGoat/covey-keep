// CK-88.1b pins: a group's photos in sections on its page, each gathering's
// preview, opened in the photo viewer for viewing only (the merge record §3
// item 8; the mockup's screen 03; Steven's six answers of 2026-11-03). Through
// the app's REAL route table with the REAL AuthProvider over the real session
// store (the CK-76.1 Gotcha), so the frame, the guard and the history are the
// app's own. The values under test:
// - THE HEAD: *Photos* and the sum of `published_count` over the sections
//   drawn; the sections in the server's order, never re-sorted; a section whose
//   gathering is not in the list neither drawn nor counted.
// - A SECTION'S HEAD: a banner where a cover is set, at the web layer, once, and
//   as it nears the viewport; the plain head where none is; the empty cover
//   never drawn; the ground alone while the picture is held back. The count
//   line as literals, in a zone forced to differ from the runner's.
// - THE PREVIEW: 6 on a phone and 8 from 640px, a tile not rendered minting
//   nothing, and See all on every section.
// - THE VIEWER: no gathering list read on load, one per opening; the set
//   replaced, the photo kept by id; the total reading `published_count` until
//   the list lands; a failed read, a photo gone and a late answer; no act for
//   anyone; one history entry.
// - THE STATES: the empty line, the failed read, and no false empty line
//   between two groups' pages.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import appCss from '../App.css?raw'
import { AuthProvider } from '../auth/AuthContext'
import groupPhotosSource from '../components/GroupPhotos.tsx?raw'
import { clearCoverPictures } from '../lib/covers'
import { formatDayWithYear } from '../lib/datetime'
import { setToken } from '../lib/session'
import tokensCss from '../styles/tokens.css?raw'

// A profile zone forced to differ from the runner's. 10:30 UTC on 4 July 2026
// is already the 5th in Kiritimati (UTC+14), and still the 4th in Honolulu and
// everywhere west of Kiritimati, so the day says which zone it was read in.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONE = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
const PAST = '2026-07-04T10:30:00+00:00'
const PAST_DAY = ZONE === 'Pacific/Kiritimati' ? 'Jul 5, 2026' : 'Jul 4, 2026'
const FUTURE = '2035-03-10T03:30:00+00:00'
const COVER = { source: 'photo', media_id: 'm-cover', set_at: '2026-10-01T00:00:00+00:00' }

const EMPTY_LINE = 'No photos yet. Photos added to its gatherings show up here.'
const FAILED_LINE = "⚠ Some photos couldn't be loaded just now."
const ACTS = [
  /edit caption/i,
  /send to bin/i,
  /delete permanently/i,
  /remove from gathering/i,
  /use as cover/i,
  /use as the group/i,
  /publish/i,
  /decline/i,
  /put back/i,
  /dismiss/i,
]

type Row = Record<string, unknown> & { id: string }
type Responder = (init: RequestInit | undefined, path: string) => Response | Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    name: 'The Lees',
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada-7777',
    member_count: 4,
    caller_role: 'member',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    ...over,
  }
}

// The list item `GET /groups/{id}/gatherings` sends.
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
    created_by_account_id: 'acct-a',
    host_account_id: 'acct-a',
    group: { id: 'g-1', name: 'The Lees' },
    caller_role: null,
    caller_view: 'full',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
    ...over,
  }
}

// The photos-only item: the summary withheld — null, never 0 or a date.
function photosOnly(id: string, title: string, over: Record<string, unknown> = {}) {
  return item(id, title, null, { rsvp_list_visibility: null, caller_view: 'memory', ...over })
}

function photo(gathering: string, n: number, over: Record<string, unknown> = {}): Row {
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
    ...over,
  }
}

const rows = (gathering: string, count: number, over: (n: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: count }, (_, i) => photo(gathering, i + 1, over(i + 1)))

// A section as the route answers it: the count, and the newest eight at most.
function section(gathering: string, total: number, over: (n: number) => Record<string, unknown> = () => ({})) {
  return { gathering_id: gathering, published_count: total, media: rows(gathering, Math.min(total, 8), over) }
}

interface World {
  group?: Record<string, unknown>
  gatherings: unknown[]
  sections: { gathering_id: string; published_count: number; media: Row[] }[]
}

function stubServer(world: World, over: Record<string, Responder> = {}) {
  let minted = 0
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const raw = String(url)
    if (raw.startsWith('https://r2.invalid/')) {
      return Promise.resolve(new Response(new Uint8Array(raw.includes('/web?') ? 100 : 3), { status: 200 }))
    }
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    const own = over[`${method} ${path}`]
    if (own) return Promise.resolve(own(init, path))
    if (method === 'GET') {
      if (path === '/health') return Promise.resolve(json(200, { status: 'ok' }))
      if (path === '/auth/me') {
        return Promise.resolve(
          json(200, { id: 'person-bea', display_name: 'Bea', email: 'bea@example.com', timezone: ZONE, account_id: 'acct-bea' }),
        )
      }
      if (path === '/groups') return Promise.resolve(json(200, { groups: [] }))
      if (path === '/gatherings') return Promise.resolve(json(200, { gatherings: [] }))
      if (path === '/groups/g-1') return Promise.resolve(json(200, world.group ?? group()))
      if (path === '/groups/g-1/gatherings') return Promise.resolve(json(200, { gatherings: world.gatherings }))
      if (path === '/groups/g-1/media') return Promise.resolve(json(200, { sections: world.sections }))
      const list = path.match(/^\/gatherings\/([\w-]+)\/media$/)
      if (list) {
        const found = world.sections.find((candidate) => candidate.gathering_id === list[1])
        return Promise.resolve(json(200, { media: rows(list[1], found?.published_count ?? 0) }))
      }
      const layer = path.match(/^\/media\/([\w-]+)\/url\?layer=(\w+)$/)
      if (layer) {
        minted += 1
        return Promise.resolve(
          json(200, { url: `https://r2.invalid/media/${layer[1]}/${layer[2]}?X-Amz-Signature=sig-${minted}`, method: 'GET' }),
        )
      }
      const cover = path.match(/^\/gatherings\/([\w-]+)\/cover\/url\?layer=(\w+)$/)
      if (cover) {
        minted += 1
        return Promise.resolve(
          json(200, { url: `https://r2.invalid/covers/${cover[1]}/${cover[2]}?X-Amz-Signature=sig-${minted}`, method: 'GET' }),
        )
      }
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function paths(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => !url.startsWith('https://r2.invalid/'))
    .map((url) => url.replace(/^https?:\/\/[^/]+/, ''))
}

const readsOf = (mock: ReturnType<typeof vi.fn>, path: string) => paths(mock).filter((p) => p === path).length
const listReads = (mock: ReturnType<typeof vi.fn>) => paths(mock).filter((p) => /^\/gatherings\/[\w-]+\/media/.test(p))
const thumbMints = (mock: ReturnType<typeof vi.fn>) => paths(mock).filter((p) => /^\/media\/.*layer=thumbnail$/.test(p))
const bannerMints = (mock: ReturnType<typeof vi.fn>) => paths(mock).filter((p) => /\/cover\/url\?layer=web$/.test(p))

// Every location the router lands on, and its navigate (the browser's Back).
const seen: { key: string; state: unknown; pathname: string; hash: string }[] = []
const nav: { current: NavigateFunction | null } = { current: null }
function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    nav.current = navigate
  }, [navigate])
  useEffect(() => {
    seen.push({ key: location.key, state: location.state, pathname: location.pathname, hash: location.hash })
  }, [location.key, location.state, location.pathname, location.hash])
  return null
}

function renderGroupPage(address = '/groups/g-1') {
  return render(
    <MemoryRouter initialEntries={[address]}>
      <AuthProvider>
        <App />
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const photosRegion = () => screen.findByRole('region', { name: 'Photos' })
const sectionOf = (title: string) => screen.findByRole('region', { name: title })
const tilesIn = (region: HTMLElement) => within(region).queryAllByRole('button', { name: /^Photo \d+ of \d+ in / })
const headLine = (region: HTMLElement) => region.querySelector('.photos-head .meta')?.textContent ?? null
const titleLine = () => document.querySelector('.vtitle span')?.textContent
const photoName = () => document.querySelector('.vtitle b')?.textContent
const stripButtons = () => Array.from(document.querySelectorAll('.vstrip button'))

const stubWide = () =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(min-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} })),
  )

// An IntersectionObserver that says nothing until it is told: `near` fires it
// for one element, as the browser would when that box nears the viewport.
function stubObserver() {
  const live = new Map<Element, (entries: { isIntersecting: boolean; target: Element }[]) => void>()
  class FakeObserver {
    callback: (entries: { isIntersecting: boolean; target: Element }[]) => void
    observed: Element[] = []
    constructor(callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
      this.callback = callback
    }
    observe(element: Element) {
      this.observed.push(element)
      live.set(element, this.callback)
    }
    disconnect() {
      for (const element of this.observed) live.delete(element)
      this.observed = []
    }
    unobserve() {}
    takeRecords() {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  return {
    near: async (element: Element) => {
      // A box subscribes in an effect, which can still be pending when it is on
      // the page. The browser only calls back after observe(), so wait for that.
      await waitFor(() => expect(live.has(element)).toBe(true))
      await act(async () => live.get(element)?.([{ isIntersecting: true, target: element }]))
    },
  }
}

async function sleep(ms: number) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

function gated() {
  const gate: { release?: (response: Response) => void } = {}
  const responder: Responder = () =>
    new Promise<Response>((resolve) => {
      gate.release = resolve
    })
  return { gate, responder }
}

// The World the tests start from: a section with a cover and eleven photos, one
// with none and three.
const TWO: World = {
  gatherings: [item('g-lake', 'The Lake', PAST, { cover: COVER }), item('g-supper', 'Sunday Supper', PAST)],
  sections: [section('g-lake', 11), section('g-supper', 3)],
}

beforeEach(() => {
  localStorage.clear()
  seen.length = 0
  nav.current = null
  setToken('session-test')
  let made = 0
  Object.assign(URL, {
    createObjectURL: () => `blob:stub-${(made += 1)}`,
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  cleanup()
  clearCoverPictures()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// The head and the order.
// ---------------------------------------------------------------------------

test('the head: Photos, focusable, and the sum of published_count over the sections drawn, newest first', async () => {
  stubServer(TWO)
  renderGroupPage()
  const region = await photosRegion()
  await sectionOf('The Lake')
  expect(headLine(region)).toBe('14 photos · newest first')
  const heading = within(region).getByRole('heading', { level: 2, name: 'Photos' })
  expect(heading.getAttribute('tabindex')).toBe('-1')
})

test('the head: 1 photo in the singular, and no line with none', async () => {
  stubServer({ gatherings: [item('g-one', 'One Photo', PAST)], sections: [section('g-one', 1)] })
  const one = renderGroupPage()
  await sectionOf('One Photo')
  expect(headLine(await photosRegion())).toBe('1 photo · newest first')
  one.unmount()
  vi.unstubAllGlobals()

  stubServer({ gatherings: [item('g-one', 'One Photo', PAST)], sections: [] })
  renderGroupPage()
  await screen.findByText(EMPTY_LINE)
  expect(headLine(await photosRegion())).toBeNull()
})

test('the sections in the server’s order, never re-sorted: against gatherings whose dates and strip order differ', async () => {
  const gatherings = [
    item('g-old', 'Oldest By Date', '2020-01-01T12:00:00+00:00'),
    item('g-new', 'Newest By Date', '2026-09-01T12:00:00+00:00'),
    item('g-up', 'Coming Up', FUTURE),
  ]
  // The server's order: the newest photo first, which is neither of the others.
  stubServer({ gatherings, sections: [section('g-old', 2), section('g-up', 2), section('g-new', 2)] })
  renderGroupPage()
  const region = await photosRegion()
  await sectionOf('Oldest By Date')
  const sections = within(region).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
  expect(sections).toEqual(['Oldest By Date', 'Coming Up', 'Newest By Date'])
  // The strip keeps the one rule's order, its own.
  const strip = screen.getByRole('list', { name: "The group's gatherings" })
  expect(within(strip).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
    'Coming Up',
    'Newest By Date',
    'Oldest By Date',
  ])
})

test('the join: a section whose gathering is not in the list is not drawn and not in the sum', async () => {
  stubServer({ gatherings: [item('g-supper', 'Sunday Supper', PAST)], sections: [section('g-gone', 40), section('g-supper', 3)] })
  renderGroupPage()
  const region = await photosRegion()
  await sectionOf('Sunday Supper')
  expect(within(region).getAllByRole('heading', { level: 3 })).toHaveLength(1)
  expect(headLine(region)).toBe('3 photos · newest first')
  expect(region.textContent).not.toContain('40')
})

test('every section unmatched is the empty line, not an empty head', async () => {
  stubServer({ gatherings: [item('g-supper', 'Sunday Supper', PAST)], sections: [section('g-gone', 40)] })
  renderGroupPage()
  expect(await screen.findByText(EMPTY_LINE)).toBeTruthy()
  expect(headLine(await photosRegion())).toBeNull()
})

// ---------------------------------------------------------------------------
// The head of a section.
// ---------------------------------------------------------------------------

test('a cover set: the banner at the web layer, once, from a blob: URL with alt="", the name an <h3> link, the rule and the count', async () => {
  const mock = stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const banner = lake.querySelector('.pbanner') as HTMLElement
  expect(banner).toBeTruthy()
  await waitFor(() => expect(banner.querySelector('img')).toBeTruthy())
  const picture = banner.querySelector('img') as HTMLImageElement
  expect(picture.getAttribute('alt')).toBe('')
  expect(picture.getAttribute('src')).toMatch(/^blob:/)
  expect(bannerMints(mock)).toEqual(['/gatherings/g-lake/cover/url?layer=web'])
  const heading = within(banner).getByRole('heading', { level: 3, name: 'The Lake' })
  expect(within(heading).getByRole('link').getAttribute('href')).toBe('/gatherings/g-lake')
  expect(banner.querySelector('.over .rule')?.getAttribute('aria-hidden')).toBe('true')
  expect(banner.querySelector('.over .count')?.textContent).toBe(`11 photos · ${PAST_DAY}`)
  expect(lake.querySelector('.plainhead')).toBeNull()
})

test('no cover: the plain head — the name an <h3> link and the count line — reading no picture', async () => {
  const mock = stubServer(TWO)
  renderGroupPage()
  const supper = await sectionOf('Sunday Supper')
  const head = supper.querySelector('.plainhead') as HTMLElement
  expect(head).toBeTruthy()
  expect(supper.querySelector('.pbanner')).toBeNull()
  expect(head.querySelector('img')).toBeNull()
  const heading = within(head).getByRole('heading', { level: 3, name: 'Sunday Supper' })
  expect(within(heading).getByRole('link').getAttribute('href')).toBe('/gatherings/g-supper')
  expect(head.querySelector('p.meta')?.textContent).toBe(`3 photos · ${PAST_DAY}`)
  expect(bannerMints(mock).some((p) => p.includes('g-supper'))).toBe(false)
})

test('no quail and no No cover photo yet anywhere in the Photos section, whatever the gatherings’ covers', async () => {
  stubServer(TWO)
  renderGroupPage()
  const region = await photosRegion()
  await sectionOf('Sunday Supper')
  expect(region.textContent).not.toContain('No cover photo yet')
  expect(region.querySelector('.cover-empty')).toBeNull()
  expect(region.querySelector('img[src*="quail"]')).toBeNull()
})

test('the banner’s ground alone while its picture is held back, and on a 409 no_cover and a failed mint: the words and no quail', async () => {
  const held = gated()
  stubServer(TWO, { 'GET /gatherings/g-lake/cover/url?layer=web': held.responder })
  const first = renderGroupPage()
  const lake = await sectionOf('The Lake')
  const banner = lake.querySelector('.pbanner') as HTMLElement
  await waitFor(() => expect(held.gate.release).toBeDefined())
  expect(banner.querySelector('img')).toBeNull()
  expect(banner.querySelector('.over .count')?.textContent).toBe(`11 photos · ${PAST_DAY}`)
  expect(banner.textContent).not.toContain('No cover photo yet')
  first.unmount()
  clearCoverPictures()
  vi.unstubAllGlobals()

  for (const answer of [json(409, { detail: { code: 'no_cover' } }), json(500, {})]) {
    stubServer(TWO, { 'GET /gatherings/g-lake/cover/url?layer=web': () => answer.clone() })
    const view = renderGroupPage()
    const again = await sectionOf('The Lake')
    await sleep(20)
    const shown = again.querySelector('.pbanner') as HTMLElement
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.textContent).not.toContain('No cover photo yet')
    expect(shown.querySelector('.cover-empty')).toBeNull()
    expect(within(shown).getByRole('link', { name: 'The Lake' })).toBeTruthy()
    view.unmount()
    clearCoverPictures()
    vi.unstubAllGlobals()
  }
})

// ---------------------------------------------------------------------------
// The count line, as literals, in the profile's zone.
// ---------------------------------------------------------------------------

test('the count line: a past date in the profile’s zone; none on coming up, on no date and on photos-only; in progress reads as past; singular', async () => {
  const startedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  stubServer({
    gatherings: [
      item('g-past', 'Past One', PAST),
      item('g-up', 'Coming Up', FUTURE),
      item('g-now', 'In Progress', startedAnHourAgo),
      item('g-none', 'No Date', null),
      photosOnly('g-photos', 'Photos Only'),
      // A photos-only body carrying a date it should not: nothing reads it.
      photosOnly('g-leak', 'Photos Leak', { next_occurrence: { id: 'o-leak', starts_at: PAST } }),
      item('g-single', 'Single Past', PAST),
      item('g-single-up', 'Single Up', FUTURE),
      photosOnly('g-single-photos', 'Single Photos'),
    ],
    sections: [
      section('g-past', 12),
      section('g-up', 3),
      section('g-now', 5),
      section('g-none', 4),
      section('g-photos', 6),
      section('g-leak', 7),
      section('g-single', 1),
      section('g-single-up', 1),
      section('g-single-photos', 1),
    ],
  })
  renderGroupPage()
  await sectionOf('Past One')
  const line = async (title: string) => (await sectionOf(title)).querySelector('.plainhead .meta')?.textContent
  expect(await line('Past One')).toBe(`12 photos · ${PAST_DAY}`)
  expect(await line('Coming Up')).toBe('3 photos')
  expect(await line('In Progress')).toBe(`5 photos · ${formatDayWithYear(startedAnHourAgo, ZONE)}`)
  expect(await line('No Date')).toBe('4 photos')
  expect(await line('Photos Only')).toBe('6 photos')
  expect(await line('Photos Leak')).toBe('7 photos')
  expect(await line('Single Past')).toBe(`1 photo · ${PAST_DAY}`)
  expect(await line('Single Up')).toBe('1 photo')
  expect(await line('Single Photos')).toBe('1 photo')
})

test('the date is kept whole, in a no-wrap element, on a banner and on a plain head; the capitals are CSS and the text stays as written', async () => {
  stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const supper = await sectionOf('Sunday Supper')
  expect(lake.querySelector('.count .nowrap')?.textContent).toBe(PAST_DAY)
  expect(supper.querySelector('.meta .nowrap')?.textContent).toBe(PAST_DAY)
  expect(lake.querySelector('.count')?.textContent).toBe(`11 photos · ${PAST_DAY}`)
})

// ---------------------------------------------------------------------------
// The preview, lazy minting, See all.
// ---------------------------------------------------------------------------

test('the preview on a phone: the first 6, the seventh and eighth not rendered and not minted, each tile named in the gathering', async () => {
  const mock = stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const tiles = tilesIn(lake)
  expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([1, 2, 3, 4, 5, 6].map((i) => `Photo ${i} of 11 in The Lake`))
  expect(lake.querySelectorAll('.pgrid > li')).toHaveLength(6)
  await waitFor(() => expect(thumbMints(mock).filter((p) => p.includes('g-lake'))).toHaveLength(6))
  expect(thumbMints(mock).some((p) => p.includes('g-lake-m7') || p.includes('g-lake-m8'))).toBe(false)
  // A tile holds its thumbnail and no control.
  expect(tiles[0].querySelector('.lazy-thumb')).toBeTruthy()
  expect(tiles[0].classList.contains('ph')).toBe(true)
})

test('the preview from 640px: all 8, and a section of three its three', async () => {
  stubWide()
  const mock = stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  expect(tilesIn(lake)).toHaveLength(8)
  expect(tilesIn(await sectionOf('Sunday Supper'))).toHaveLength(3)
  await waitFor(() => expect(thumbMints(mock).filter((p) => p.includes('g-lake'))).toHaveLength(8))
})

test('lazy: nothing minted for a banner or a tile until it nears the viewport, and then that one alone', async () => {
  const observer = stubObserver()
  const mock = stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  await sleep(20)
  expect(bannerMints(mock)).toEqual([])
  expect(thumbMints(mock)).toEqual([])
  await observer.near(lake.querySelector('.pbanner') as Element)
  await waitFor(() => expect(bannerMints(mock)).toEqual(['/gatherings/g-lake/cover/url?layer=web']))
  expect(thumbMints(mock)).toEqual([])
  await observer.near(lake.querySelector('.lazy-thumb') as Element)
  await waitFor(() => expect(thumbMints(mock)).toEqual(['/media/g-lake-m1/url?layer=thumbnail']))
  expect(bannerMints(mock)).toHaveLength(1)
})

test('See all on every section, three photos included: its words and its href to the gathering’s Photos', async () => {
  stubWide()
  stubServer({ ...TWO, gatherings: [...TWO.gatherings, item('g-one', 'One Photo', PAST)], sections: [...TWO.sections, section('g-one', 1)] })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const supper = await sectionOf('Sunday Supper')
  const one = await sectionOf('One Photo')
  const link = (region: HTMLElement, name: string) => within(region).getByRole('link', { name })
  expect(link(lake, 'See all 11 photos').getAttribute('href')).toBe('/gatherings/g-lake#photos')
  // Every photo already showing, and See all still there.
  expect(tilesIn(supper)).toHaveLength(3)
  expect(link(supper, 'See all 3 photos').getAttribute('href')).toBe('/gatherings/g-supper#photos')
  expect(link(supper, 'See all 3 photos').closest('.seeall')).toBeTruthy()
  expect(link(supper, 'See all 3 photos').classList.contains('btn-small')).toBe(true)
  expect(link(one, 'See all 1 photo').getAttribute('href')).toBe('/gatherings/g-one#photos')
})

// ---------------------------------------------------------------------------
// The viewer.
// ---------------------------------------------------------------------------

test('no gathering list read on load; one on a press; it opens at once at the tile pressed, on the section’s eight even where a phone shows six', async () => {
  const held = gated()
  const mock = stubServer(TWO, { 'GET /gatherings/g-lake/media': held.responder })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  await sleep(20)
  expect(listReads(mock)).toEqual([])
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 3 of 11 in The Lake' }))
  const viewer = screen.getByRole('dialog')
  expect(photoName()).toBe('IMG_3.jpg')
  expect(viewer.getAttribute('aria-modal')).toBe('true')
  expect(stripButtons()).toHaveLength(8)
  expect(tilesIn(lake)).toHaveLength(6)
  await waitFor(() => expect(listReads(mock)).toEqual(['/gatherings/g-lake/media']))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  await sleep(10)
  expect(listReads(mock)).toEqual(['/gatherings/g-lake/media'])
})

test('the total reads published_count until the list lands, then the list’s length — on the line and the strip’s labels', async () => {
  const held = gated()
  stubServer({ gatherings: TWO.gatherings, sections: [section('g-lake', 47)] }, { 'GET /gatherings/g-lake/media': held.responder })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 3 of 47 in The Lake' }))
  expect(titleLine()).toBe('The Lake · 3 of 47')
  expect(stripButtons()[2].getAttribute('aria-label')).toBe('3 of 47: IMG_3.jpg')
  await waitFor(() => expect(held.gate.release).toBeDefined())
  expect(stripButtons()).toHaveLength(8)
  // One was removed between the two reads: the list's length is the truth.
  await act(async () => held.gate.release?.(json(200, { media: rows('g-lake', 46) })))
  await waitFor(() => expect(stripButtons()).toHaveLength(46))
  expect(titleLine()).toBe('The Lake · 3 of 46')
  expect(stripButtons()[2].getAttribute('aria-label')).toBe('3 of 46: IMG_3.jpg')
})

test('Next reaches a photo beyond the eighth once the list has landed', async () => {
  const mock = stubServer({ gatherings: TWO.gatherings, sections: [section('g-lake', 47)] })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 6 of 47 in The Lake' }))
  const viewer = screen.getByRole('dialog')
  await waitFor(() => expect(stripButtons()).toHaveLength(47))
  expect(listReads(mock)).toEqual(['/gatherings/g-lake/media'])
  const next = within(viewer).getByRole('button', { name: 'Next photo' })
  for (const expected of [7, 8, 9]) {
    fireEvent.click(next)
    await waitFor(() => expect(photoName()).toBe(`IMG_${expected}.jpg`))
  }
  expect(titleLine()).toBe('The Lake · 9 of 47')
})

test('the current photo is kept by id when the set is replaced: a newer photo above it moves its place, not the photo', async () => {
  const held = gated()
  stubServer(TWO, { 'GET /gatherings/g-lake/media': held.responder })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 3 of 11 in The Lake' }))
  await waitFor(() => expect(held.gate.release).toBeDefined())
  expect(titleLine()).toBe('The Lake · 3 of 11')
  const newest = photo('g-lake', 99, { filename: 'NEWEST.jpg' })
  await act(async () => held.gate.release?.(json(200, { media: [newest, ...rows('g-lake', 11)] })))
  await waitFor(() => expect(stripButtons()).toHaveLength(12))
  expect(photoName()).toBe('IMG_3.jpg')
  expect(titleLine()).toBe('The Lake · 4 of 12')
})

test('a waiting row and a binned row in the list stay out of the set, in the list’s order', async () => {
  const media = [
    photo('g-lake', 1),
    photo('g-lake', 50, { publication_state: 'pending', is_own: true, filename: 'WAITING.jpg' }),
    photo('g-lake', 2),
    photo('g-lake', 51, { publication_state: 'removed', removed_at: new Date().toISOString(), is_own: true, filename: 'BINNED.jpg' }),
    photo('g-lake', 52, { status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'unreadable', filename: 'FAILED.jpg' }),
    photo('g-lake', 3),
  ]
  stubServer(
    { gatherings: TWO.gatherings, sections: [section('g-lake', 3)] },
    { 'GET /gatherings/g-lake/media': () => json(200, { media }) },
  )
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 1 of 3 in The Lake' }))
  await sleep(20)
  expect(stripButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
    '1 of 3: IMG_1.jpg',
    '2 of 3: IMG_2.jpg',
    '3 of 3: IMG_3.jpg',
  ])
  expect(titleLine()).toBe('The Lake · 1 of 3')
})

test('a failed list read stays on the eight, Next disabled at the eighth, with no new words; the next opening reads again', async () => {
  let fail = true
  const mock = stubServer(
    { gatherings: TWO.gatherings, sections: [section('g-lake', 47)] },
    {
      'GET /gatherings/g-lake/media': () => (fail ? json(500, {}) : json(200, { media: rows('g-lake', 47) })),
    },
  )
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const tile = within(lake).getByRole('button', { name: 'Photo 6 of 47 in The Lake' })
  fireEvent.click(tile)
  const viewer = screen.getByRole('dialog')
  const wordsBefore = viewer.querySelector('.vinfo')?.textContent
  await waitFor(() => expect(listReads(mock)).toHaveLength(1))
  await sleep(20)
  expect(stripButtons()).toHaveLength(8)
  const next = within(viewer).getByRole('button', { name: 'Next photo' }) as HTMLButtonElement
  fireEvent.click(next)
  fireEvent.click(next)
  await waitFor(() => expect(photoName()).toBe('IMG_8.jpg'))
  expect(next.disabled).toBe(true)
  expect(titleLine()).toBe('The Lake · 8 of 47')
  expect(within(viewer).queryByRole('alert')).toBeNull()
  expect(viewer.querySelector('.vinfo')?.textContent).toBe(wordsBefore)
  expect(viewer.textContent).not.toMatch(/couldn.t|try again|wrong/i)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fail = false
  await waitFor(() => expect(document.activeElement).toBe(tile))
  fireEvent.click(tile)
  await waitFor(() => expect(stripButtons()).toHaveLength(47))
  expect(listReads(mock)).toHaveLength(2)
})

test('the pressed photo gone from the list closes the viewer, moves focus to the heading and re-reads the sections once', async () => {
  const mock = stubServer(TWO, {
    'GET /gatherings/g-lake/media': () => json(200, { media: rows('g-lake', 11).filter((row) => row.id !== 'g-lake-m3') }),
  })
  renderGroupPage()
  const region = await photosRegion()
  const lake = await sectionOf('The Lake')
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 3 of 11 in The Lake' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(within(region).getByRole('heading', { level: 2, name: 'Photos' })))
  await waitFor(() => expect(readsOf(mock, '/groups/g-1/media')).toBe(2))
  await sleep(20)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(2)
})

test('a close before the list lands ignores the answer: nothing reopens, no re-read, and focus stays on the tile — even for an answer that would have closed it', async () => {
  const held = gated()
  const mock = stubServer(TWO, { 'GET /gatherings/g-lake/media': held.responder })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const tile = within(lake).getByRole('button', { name: 'Photo 3 of 11 in The Lake' })
  fireEvent.click(tile)
  await waitFor(() => expect(held.gate.release).toBeDefined())
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(tile))
  await act(async () => held.gate.release?.(json(200, { media: [] })))
  await sleep(20)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(tile)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
})

test('an answer for another opening is ignored: the first opening’s list never reaches the second', async () => {
  const answers: ((response: Response) => void)[] = []
  stubServer(TWO, {
    'GET /gatherings/g-lake/media': () =>
      new Promise<Response>((resolve) => {
        answers.push(resolve)
      }),
  })
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 1 of 11 in The Lake' }))
  await waitFor(() => expect(answers).toHaveLength(1))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 2 of 11 in The Lake' }))
  await waitFor(() => expect(answers).toHaveLength(2))
  // The first opening's answer, without the second's photo: it would close it.
  await act(async () => answers[0](json(200, { media: rows('g-lake', 1) })))
  await sleep(20)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(photoName()).toBe('IMG_2.jpg')
  expect(stripButtons()).toHaveLength(8)
  await act(async () => answers[1](json(200, { media: rows('g-lake', 11) })))
  await waitFor(() => expect(stripButtons()).toHaveLength(11))
})

test('another section’s tile reads that gathering’s list, and that gathering’s words', async () => {
  const mock = stubServer(TWO)
  renderGroupPage()
  const supper = await sectionOf('Sunday Supper')
  fireEvent.click(within(supper).getByRole('button', { name: 'Photo 2 of 3 in Sunday Supper' }))
  expect(titleLine()).toBe('Sunday Supper · 2 of 3')
  await waitFor(() => expect(listReads(mock)).toEqual(['/gatherings/g-supper/media']))
})

test('viewing only: no act by any name on the host’s own photo for the group’s admin, and no read of the group’s seat', async () => {
  const own = () => ({ is_own: true, uploader_display_name: 'Bea' })
  const mock = stubServer(
    {
      group: group({ caller_role: 'admin' }),
      gatherings: [item('g-lake', 'The Lake', PAST, { cover: COVER, caller_role: 'host' })],
      sections: [section('g-lake', 3, own)],
    },
    { 'GET /gatherings/g-lake/media': () => json(200, { media: rows('g-lake', 3, own) }) },
  )
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 1 of 3 in The Lake' }))
  const viewer = screen.getByRole('dialog')
  const check = () => {
    for (const name of ACTS) expect(within(viewer).queryByRole('button', { name })).toBeNull()
    expect(viewer.querySelector('.vacts')).toBeNull()
  }
  check()
  await waitFor(() => expect(listReads(mock)).toHaveLength(1))
  await sleep(20)
  check()
  // The group's body is the page's one read of it: the viewer asks nothing more.
  expect(readsOf(mock, '/groups/g-1')).toBe(1)
})

test('the words: Added by with its day in the profile’s zone, You on your own, and the state line', async () => {
  const media = [photo('g-supper', 1), photo('g-supper', 2, { is_own: true, uploader_display_name: 'Bea' })]
  stubServer(
    { gatherings: TWO.gatherings, sections: [{ gathering_id: 'g-supper', published_count: 2, media }] },
    { 'GET /gatherings/g-supper/media': () => json(200, { media }) },
  )
  renderGroupPage()
  const supper = await sectionOf('Sunday Supper')
  fireEvent.click(within(supper).getByRole('button', { name: 'Photo 1 of 2 in Sunday Supper' }))
  const viewer = screen.getByRole('dialog')
  expect(viewer.querySelector('.vline')?.textContent).toBe(`Added by Nate Okafor · ${PAST_DAY}`)
  expect(viewer.querySelector('.vstate')?.textContent).toBe('Everyone in this gathering can see it.')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  await waitFor(() => expect(viewer.querySelector('.vline')?.textContent).toBe(`Added by You · ${PAST_DAY}`))
})

test('the words in the photos-only view: Added by with no day, on a body carrying a date or not', async () => {
  stubServer({
    gatherings: [photosOnly('g-photos', 'Photos Only', { next_occurrence: { id: 'o-1', starts_at: PAST } })],
    sections: [section('g-photos', 2)],
  })
  renderGroupPage()
  const photos = await sectionOf('Photos Only')
  fireEvent.click(within(photos).getByRole('button', { name: 'Photo 1 of 2 in Photos Only' }))
  const viewer = screen.getByRole('dialog')
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by Nate Okafor')
  expect(viewer.textContent).not.toContain(PAST_DAY)
})

// ---------------------------------------------------------------------------
// The history.
// ---------------------------------------------------------------------------

test('one history entry of exactly { photoViewer: true }: moving adds nothing, Back closes it, Close pops it, focus back on the tile', async () => {
  stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  const start = seen[seen.length - 1]
  const tile = within(lake).getByRole('button', { name: 'Photo 1 of 11 in The Lake' })
  fireEvent.click(tile)
  const viewer = screen.getByRole('dialog')
  await waitFor(() => expect(seen[seen.length - 1].key).not.toBe(start.key))
  const entry = seen[seen.length - 1]
  expect(entry.state).toEqual({ photoViewer: true })
  expect(entry.pathname).toBe('/groups/g-1')
  expect(entry.hash).toBe('')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  await sleep(20)
  expect(seen[seen.length - 1].key).toBe(entry.key)
  // Back: the viewer closes, and the page is where it was.
  await act(async () => nav.current?.(-1))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(seen[seen.length - 1].key).toBe(start.key)
  await waitFor(() => expect(document.activeElement).toBe(tile))
  // Close pops the entry it pushed: the history ends where it began.
  fireEvent.click(tile)
  const reopened = screen.getByRole('dialog')
  await waitFor(() => expect(seen[seen.length - 1].state).toEqual({ photoViewer: true }))
  fireEvent.click(within(reopened).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(seen[seen.length - 1].key).toBe(start.key))
  expect(seen[seen.length - 1].state).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(tile))
})

test('a reload on the marker opens nothing', async () => {
  stubServer(TWO)
  render(
    <MemoryRouter initialEntries={[{ pathname: '/groups/g-1', state: { photoViewer: true } }]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await sectionOf('The Lake')
  await sleep(20)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the column’s scroll is unmoved by the viewer’s entry: the same pathname, no reset', async () => {
  stubServer(TWO)
  renderGroupPage()
  const lake = await sectionOf('The Lake')
  // CK-89's rider: this pin watched the column alone, and jsdom with no matchMedia
  // is a phone, whose scroller is the window, so it stayed green with the rule
  // broken (CK-88.2's finding). It watches both scrollers now.
  const root = document.scrollingElement ?? document.documentElement
  const writes: [string, number][] = []
  const scrollers: [string, Element][] = [['column', document.querySelector('.frame-col') as HTMLElement], ['window', root]]
  for (const [name, scroller] of scrollers) {
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 480, set: (value: number) => writes.push([name, value]) })
  }
  try {
    fireEvent.click(within(lake).getByRole('button', { name: 'Photo 1 of 11 in The Lake' }))
    await sleep(20)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await sleep(20)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes).toEqual([])
  } finally {
    // The document outlives the test.
    delete (root as unknown as { scrollTop?: number }).scrollTop
  }
})

// ---------------------------------------------------------------------------
// The states.
// ---------------------------------------------------------------------------

test('both reads answered and no section: the empty line as a literal with the quail and no posting clause, in the app’s card', async () => {
  stubServer({ gatherings: [item('g-supper', 'Sunday Supper', PAST)], sections: [] })
  renderGroupPage()
  const line = await screen.findByText(EMPTY_LINE)
  const card = line.closest('.nophotos') as HTMLElement
  expect(card.classList.contains('auth-card')).toBe(true)
  expect(card.querySelector('img')?.getAttribute('alt')).toBe('')
  expect((await photosRegion()).textContent).not.toMatch(/post/i)
})

test('loading: Loading… in the section’s place and no empty line, before either read lands', async () => {
  const held = gated()
  stubServer(TWO, { 'GET /groups/g-1/media': held.responder })
  renderGroupPage()
  const region = await photosRegion()
  await waitFor(() => expect(held.gate.release).toBeDefined())
  expect(within(region).getByText('Loading…')).toBeTruthy()
  expect(region.textContent).not.toContain(EMPTY_LINE)
  expect(headLine(region)).toBeNull()
})

test('the media read failing: the line and Try again, no line in the head, one request per press and only of the read that failed', async () => {
  let fail = true
  const mock = stubServer(TWO, {
    'GET /groups/g-1/media': () => (fail ? json(500, {}) : json(200, { sections: TWO.sections })),
  })
  renderGroupPage()
  const region = await photosRegion()
  const alert = await within(region).findByRole('alert')
  expect(alert.textContent).toBe(FAILED_LINE)
  expect(headLine(region)).toBeNull()
  expect(region.textContent).not.toContain(EMPTY_LINE)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(readsOf(mock, '/groups/g-1/media')).toBe(2))
  await within(region).findByRole('alert')
  fail = false
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await sectionOf('The Lake')
  expect(readsOf(mock, '/groups/g-1/media')).toBe(3)
  expect(readsOf(mock, '/groups/g-1/gatherings')).toBe(1)
  expect(within(region).queryByRole('alert')).toBeNull()
})

test('the gatherings read failing: the line and Try again here, which re-reads the gatherings once per press and not the media', async () => {
  let fail = true
  const mock = stubServer(TWO, {
    'GET /groups/g-1/gatherings': () => (fail ? json(500, {}) : json(200, { gatherings: TWO.gatherings })),
  })
  renderGroupPage()
  const region = await photosRegion()
  expect((await within(region).findByRole('alert')).textContent).toBe(FAILED_LINE)
  fail = false
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await sectionOf('The Lake')
  expect(readsOf(mock, '/groups/g-1/gatherings')).toBe(2)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
})

test('the strip’s own Try again brings the sections back too', async () => {
  let fail = true
  const mock = stubServer(TWO, {
    'GET /groups/g-1/gatherings': () => (fail ? json(500, {}) : json(200, { gatherings: TWO.gatherings })),
  })
  renderGroupPage()
  const region = await photosRegion()
  await within(region).findByRole('alert')
  const strip = screen.getByRole('region', { name: 'Gatherings' })
  fail = false
  fireEvent.click(within(strip).getByRole('button', { name: 'Try again' }))
  await sectionOf('The Lake')
  expect(within(region).queryByRole('alert')).toBeNull()
  expect(readsOf(mock, '/groups/g-1/gatherings')).toBe(2)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
})

test('both reads failing: Try again re-reads each once per press', async () => {
  const mock = stubServer(TWO, {
    'GET /groups/g-1/gatherings': () => json(500, {}),
    'GET /groups/g-1/media': () => json(500, {}),
  })
  renderGroupPage()
  const region = await photosRegion()
  await within(region).findByRole('alert')
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Gatherings' })).queryByRole('alert')).toBeTruthy())
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(readsOf(mock, '/groups/g-1/media')).toBe(2))
  expect(readsOf(mock, '/groups/g-1/gatherings')).toBe(2)
})

const SECOND_GROUP = group({ id: 'g-2', name: 'The Marlowes' })
const SECOND_GATHERINGS = [item('g-two', 'Second Gathering', PAST, { group: { id: 'g-2', name: 'The Marlowes' } })]
const SECOND_SECTIONS = [section('g-two', 2)]

test('moving between two groups’ pages: the old list never joins the new sections, so no false empty line while the gatherings wait', async () => {
  const held = gated()
  stubServer(TWO, {
    'GET /groups/g-2': () => json(200, SECOND_GROUP),
    'GET /groups/g-2/gatherings': held.responder,
    'GET /groups/g-2/media': () => json(200, { sections: SECOND_SECTIONS }),
  })
  renderGroupPage()
  await sectionOf('The Lake')
  await act(async () => nav.current?.('/groups/g-2'))
  await screen.findByRole('heading', { level: 1, name: 'The Marlowes' })
  await waitFor(() => expect(held.gate.release).toBeDefined())
  await sleep(20)
  expect(document.body.textContent).not.toContain(EMPTY_LINE)
  expect(screen.queryByRole('region', { name: 'The Lake' })).toBeNull()
  await act(async () => held.gate.release?.(json(200, { gatherings: SECOND_GATHERINGS })))
  await sectionOf('Second Gathering')
  expect(document.body.textContent).not.toContain(EMPTY_LINE)
})

test('moving between two groups’ pages: the old sections never join the new list, so no false empty line while the media waits', async () => {
  const held = gated()
  stubServer(TWO, {
    'GET /groups/g-2': () => json(200, SECOND_GROUP),
    'GET /groups/g-2/gatherings': () => json(200, { gatherings: SECOND_GATHERINGS }),
    'GET /groups/g-2/media': held.responder,
  })
  renderGroupPage()
  await sectionOf('The Lake')
  await act(async () => nav.current?.('/groups/g-2'))
  await screen.findByRole('heading', { level: 1, name: 'The Marlowes' })
  await waitFor(() => expect(held.gate.release).toBeDefined())
  await sleep(20)
  expect(document.body.textContent).not.toContain(EMPTY_LINE)
  expect(within(await photosRegion()).getByText('Loading…')).toBeTruthy()
  await act(async () => held.gate.release?.(json(200, { sections: SECOND_SECTIONS })))
  await sectionOf('Second Gathering')
})

// ---------------------------------------------------------------------------
// The page's reads, the handling, the styles.
// ---------------------------------------------------------------------------

test('the page’s reads: the group, its gatherings and its media once each, never the member list or a gathering’s list', async () => {
  const mock = stubServer(TWO)
  renderGroupPage()
  await sectionOf('The Lake')
  await sleep(20)
  expect(readsOf(mock, '/groups/g-1')).toBe(1)
  expect(readsOf(mock, '/groups/g-1/gatherings')).toBe(1)
  expect(readsOf(mock, '/groups/g-1/media')).toBe(1)
  expect(paths(mock).some((p) => p.endsWith('/members'))).toBe(false)
  expect(listReads(mock)).toEqual([])
})

test('no presigned URL or X-Amz in any markup, viewer open or closed, and every image in the section a blob: URL', async () => {
  stubServer(TWO)
  renderGroupPage()
  const region = await photosRegion()
  const lake = await sectionOf('The Lake')
  await waitFor(() => expect(lake.querySelector('.pbanner img')).toBeTruthy())
  await waitFor(() => expect(lake.querySelectorAll('.lazy-thumb img')).toHaveLength(6))
  for (const image of Array.from(region.querySelectorAll('img'))) {
    expect(image.getAttribute('src')).toMatch(/^blob:/)
  }
  expect(document.body.innerHTML).not.toMatch(/X-Amz|r2\.invalid/)
  fireEvent.click(within(lake).getByRole('button', { name: 'Photo 1 of 11 in The Lake' }))
  await waitFor(() => expect(stripButtons()).toHaveLength(11))
  await sleep(20)
  expect(document.body.innerHTML).not.toMatch(/X-Amz|r2\.invalid/)
})

test('the source names no logger, no keeper’s charge, no group seat and no member read', () => {
  expect(groupPhotosSource).not.toMatch(/console\.|photo_count|readGroup\(|readMembers|\/members/)
  // Nothing reads a date but through the one helper, which asks the view.
  expect(groupPhotosSource).not.toMatch(/next_occurrence\b.*starts_at/)
  // The product's name comes from brand.ts, wherever it is drawn.
  expect(groupPhotosSource).not.toMatch(/covey ?keep/i)
})

test('the styles: the banner’s measures, its least height, no position on the words, and no colour or new token', () => {
  const rule = (selector: string) => {
    const start = appCss.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return appCss.slice(start, appCss.indexOf('}', start))
  }
  expect(rule('.pbanner')).toMatch(/aspect-ratio: 2 \/ 1/)
  expect(rule('.pbanner')).toMatch(/overflow: clip/)
  expect(rule('.pbanner')).toMatch(/position: relative/)
  expect(rule('.pbanner > img')).toMatch(/position: absolute/)
  // The link's ::after covers the banner because the words are not positioned
  // (the CK-87.3 lesson): a positioned .over would shrink it to the words' box.
  expect(rule('.pbanner > .over')).not.toMatch(/position:/)
  expect(rule('.pbanner > .over')).toMatch(/--ck-scrim-mid/)
  expect(rule('.pbanner:not(:has(> img)) > .over')).toMatch(/var\(--ck-scrim\)/)
  expect(rule('.pbanner h3')).toMatch(/clamp\(1\.375rem, 1rem \+ 2vw, 2\.25rem\)/)
  expect(appCss).toMatch(/@media \(min-width: 640px\) \{[^@]*\.pbanner \{\s*aspect-ratio: 3\.2 \/ 1;/)
  // The group-level values under the section's own class, the shared rules left alone.
  expect(rule('.group-photos > .photos-head')).toMatch(/margin: 2rem 0 1rem/)
  expect(rule('.psec .pgrid')).toMatch(/padding: 6px 0 0/)
  expect(rule('.psec .seeall')).toMatch(/padding: 12px 0 6px/)
  expect(rule('.seeall')).toMatch(/padding: 6px 0 0/)
  expect(rule('.pgrid')).toMatch(/padding: 0;/)
  expect(rule('.photos-head')).not.toMatch(/margin/)
  // No colour named, and every var() the new rules read is a token that exists.
  const start = appCss.indexOf("a group's photos in sections")
  expect(start).toBeGreaterThan(-1)
  const block = appCss.slice(start, appCss.indexOf('/* ----------', start))
  expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  for (const [, name] of block.matchAll(/var\((--[\w-]+)\)/g)) {
    expect(tokensCss, name).toContain(`${name}:`)
  }
})
