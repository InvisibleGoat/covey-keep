// CK-88 pins: a gathering's photos as a grid, opened in the photo viewer,
// which carries their actions (the merge record §1.4 and §3 item 8; the
// mockup's screens 08, 09, 11 and 12; Steven's answers of 2026-11-02). The
// values under test:
// - THE SECTION is open on load in both views, with no toggle; its head is
//   the heading and the count of published photos, from the last All-view
//   read made without a search; the All view's order by seat.
// - THE GRID holds the published, ready photos and nothing else, each a
//   button named "Photo {i} of {n} in {gathering}" holding its thumbnail and
//   no control; 6 on a phone and 8 from 640px, then See all, which reveals
//   the rest in place, moves focus and stays (Steven); every match with a
//   search; no URL minted for a tile not rendered.
// - THE VIEWER is a modal dialog portalled into document.body, the root inert
//   while it is open; focus to Close and back to the opener; the bar, the
//   web layer and never archival, "Added by" in the profile's zone and no
//   date in the photos-only view, the arrows and the strip, the keyboard,
//   Escape's three steps, full screen and zoom, only the photo answering a
//   click; one history entry carrying exactly { photoViewer: true }, Back
//   closing it and Close popping it; the frame's scroll unmoved; at most
//   three web layers held, all revoked on close; a re-read keeping the photo
//   by id and closing when it has gone.
// - THE ACTIONS, by seat, exactly where the rows' predicates put them, with
//   each step, sentence, refusal and landing; none on a tile; none in the
//   photos-only view on someone else's photo; a row's thumbnail opening its
//   photo alone with no act.
// - No presigned URL in the markup or a second request; the styles naming no
//   colour and adding no token.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import appCss from '../App.css?raw'
import { AuthContext, type AuthState } from '../auth/context'
import { GatheringMedia } from '../components/GatheringMedia'
import { formatDayWithYear } from '../lib/datetime'
import { DELETE_PERMANENTLY_CONFIRMATION } from '../lib/media'
import tokensCss from '../styles/tokens.css?raw'

const TITLE = '4th of July at the Lake'
// A zone forced to differ from the runner's: the photos below were added at
// 13:00 UTC on 4 July, which is already 5 July here.
const ZONE = 'Pacific/Auckland'
const ADDED_AT = '2026-07-04T13:00:00+00:00'

type Row = Record<string, unknown> & { id: string }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function photo(n: number, over: Record<string, unknown> = {}): Row {
  return {
    id: `m-${n}`,
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: ADDED_AT,
    created_at: ADDED_AT,
    uploader_display_name: 'Nate Okafor',
    is_own: false,
    removed_at: null,
    filename: `IMG_${n}.jpg`,
    caption: null,
    tags: [],
    published_at: ADDED_AT,
    failure_reason: null,
    ...over,
  }
}

const photos = (count: number, over: (n: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: count }, (_, i) => photo(i + 1, over(i + 1)))

type Responder = (init: RequestInit | undefined, path: string) => Response

// The server: the media list from `rows` (mutable between reads), the layer
// mint, the bucket (a web layer is 100 bytes, a thumbnail 3 — so a blob says
// which layer it holds), and the acts, each mutating `rows` as the backend
// would. `over` answers a route first.
function stubServer(rows: Row[], over: Record<string, Responder> = {}) {
  // Each mint signs a fresh URL, as the backend's does.
  let minted = 0
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const raw = String(url)
    if (raw.startsWith('https://r2.invalid/')) {
      return Promise.resolve(new Response(new Uint8Array(raw.includes('/web?') ? 100 : 3), { status: 200 }))
    }
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    const own = over[`${method} ${path.split('?')[0]}`]
    if (own) return Promise.resolve(own(init, path))
    if (method === 'GET' && path.startsWith('/gatherings/g-1/media')) {
      const params = new URLSearchParams(path.split('?')[1] ?? '')
      let listed = rows
      if (params.get('awaiting_review') === 'true') listed = rows.filter((r) => r.status === 'ready' && r.publication_state === 'pending')
      else if (params.get('removed') === 'true') listed = rows.filter((r) => r._bin === true)
      else listed = rows.filter((r) => r._bin !== true)
      const q = (params.get('q') ?? '').toLowerCase()
      if (q) listed = listed.filter((r) => [r.caption, r.filename, ...(r.tags as string[])].some((s) => typeof s === 'string' && s.toLowerCase().includes(q)))
      return Promise.resolve(json(200, { media: listed.map(({ _bin, ...rest }) => rest) }))
    }
    const layer = path.match(/^\/media\/([\w-]+)\/url\?layer=(\w+)$/)
    if (method === 'GET' && layer) {
      if (layer[2] === 'archival') return Promise.resolve(json(422, { detail: 'archival is never served' }))
      return Promise.resolve(
        json(200, { url: `https://r2.invalid/media/${layer[1]}/${layer[2]}?X-Amz-Signature=sig-${(minted += 1)}`, method: 'GET' }),
      )
    }
    const actOn = path.match(/^\/media\/([\w-]+)\/(remove|restore|destroy)$/)
    if (method === 'POST' && actOn) {
      const index = rows.findIndex((r) => r.id === actOn[1])
      if (index === -1) return Promise.resolve(json(404, { detail: 'Not Found' }))
      const row = rows[index]
      if (actOn[2] === 'destroy') rows.splice(index, 1)
      else if (actOn[2] === 'remove') Object.assign(row, { publication_state: 'removed', removed_at: new Date().toISOString(), _bin: !row.is_own })
      else Object.assign(row, { publication_state: 'live', removed_at: null, _bin: false })
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    const patch = path.match(/^\/media\/([\w-]+)$/)
    if (method === 'PATCH' && patch) {
      const row = rows.find((r) => r.id === patch[1]) as Row
      Object.assign(row, JSON.parse(String(init?.body)))
      return Promise.resolve(json(200, row))
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function paths(mock: ReturnType<typeof vi.fn>, method = 'GET'): string[] {
  return mock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
}

// Every location the router lands on, and its navigate (the browser's Back).
const seen: { key: string; state: unknown }[] = []
const nav: { current: NavigateFunction | null } = { current: null }
function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    nav.current = navigate
  }, [navigate])
  useEffect(() => {
    seen.push({ key: location.key, state: location.state })
  }, [location.key, location.state])
  return null
}

const OCCURRENCES = [
  { id: 'occ-1', gathering_id: 'g-1', starts_at: '2026-07-04T21:00:00+00:00', ends_at: null, location: null, map_url: null },
]

function renderSection(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <Routes>
        <Route
          path="/gatherings/:id"
          element={
            <>
              <GatheringMedia
                gatheringId="g-1"
                isHost={false}
                requiresApproval={false}
                occurrences={OCCURRENCES}
                gatheringTitle={TITLE}
                zone={ZONE}
                pollIntervalMs={20}
                searchDebounceMs={20}
                {...over}
              />
              <Probe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const tiles = () => screen.queryAllByRole('button', { name: /^Photo \d+ of \d+ in / })
const tileName = (i: number, n: number) => `Photo ${i} of ${n} in ${TITLE}`

async function openTile(i: number, n: number) {
  const tile = await screen.findByRole('button', { name: tileName(i, n) })
  fireEvent.click(tile)
  return { tile, viewer: screen.getByRole('dialog') }
}

// Object URLs, with the layer each holds (by its size).
const created: { url: string; size: number }[] = []
const revoked: string[] = []
const liveWeb = () => created.filter((c) => c.size === 100 && !revoked.includes(c.url)).length

beforeEach(() => {
  created.length = 0
  revoked.length = 0
  seen.length = 0
  nav.current = null
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      const url = `blob:stub-${created.length + 1}`
      created.push({ url, size: blob.size })
      return url
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url)
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function sleep(ms: number) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

// ---------------------------------------------------------------------------
// The section.
// ---------------------------------------------------------------------------

test('the section is open on load in both views — no toggle, the list read at once with no press', async () => {
  for (const view of [{}, { canUpload: false, occurrences: null }]) {
    const mock = stubServer(photos(2))
    renderSection(view)
    await screen.findByRole('button', { name: tileName(1, 2) })
    expect(screen.queryByRole('button', { name: /^show photos/i })).toBeNull()
    expect(paths(mock).filter((p) => p.startsWith('/gatherings/g-1/media'))).toEqual(['/gatherings/g-1/media'])
    expect(screen.getByRole('heading', { level: 2, name: 'Photos' })).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('the count: nothing before the first read lands, nothing for none, “1 photo”, “{N} photos” — counting published, ready photos alone', async () => {
  const gate: { release?: () => void } = {}
  const rows = [photo(1), photo(2, { publication_state: 'pending', is_own: true }), photo(3, { status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'unreadable' })]
  stubServer(rows, {
    'GET /gatherings/g-1/media': () => json(200, { media: rows }),
  })
  // Hold the first read to see the head before it lands.
  const real = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    String(url).includes('/gatherings/g-1/media') && gate.release === undefined
      ? new Promise<Response>((resolve) => {
          gate.release = () => resolve(json(200, { media: rows }))
        })
      : real(url, init),
  )
  const view = renderSection()
  await waitFor(() => expect(gate.release).toBeDefined())
  expect(view.container.querySelector('.photos-head .meta')).toBeNull()
  await act(async () => gate.release?.())
  await screen.findByRole('button', { name: tileName(1, 1) })
  expect(view.container.querySelector('.photos-head .meta')?.textContent).toBe('1 photo')
  cleanup()
  vi.unstubAllGlobals()

  stubServer(photos(3))
  const three = renderSection()
  await screen.findByRole('button', { name: tileName(1, 3) })
  expect(three.container.querySelector('.photos-head .meta')?.textContent).toBe('3 photos')
  cleanup()
  vi.unstubAllGlobals()

  stubServer([photo(1, { publication_state: 'pending', is_own: true })])
  const none = renderSection()
  await screen.findByRole('list', { name: 'Photos' })
  expect(none.container.querySelector('.photos-head .meta')).toBeNull()
})

test('the count’s source is the last All-view read made without a search: a search, the queue and the bin leave it as it was', async () => {
  const rows = [
    ...photos(3),
    photo(7, { publication_state: 'pending', uploader_display_name: 'June Marlowe', filename: 'waiting.jpg' }),
    photo(8, { publication_state: 'removed', removed_at: new Date().toISOString(), _bin: true, filename: 'binned.jpg' }),
  ]
  const mock = stubServer(rows)
  const view = renderSection({ isHost: true })
  await screen.findByRole('button', { name: tileName(1, 3) })
  const count = () => view.container.querySelector('.photos-head .meta')?.textContent
  expect(count()).toBe('3 photos')
  fireEvent.change(screen.getByLabelText('Find a photo'), { target: { value: 'IMG_2' } })
  await screen.findByRole('button', { name: tileName(1, 1) })
  expect(count()).toBe('3 photos')
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  await screen.findByRole('button', { name: tileName(3, 3) })
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await waitFor(() => expect(paths(mock).some((p) => p.includes('awaiting_review=true'))).toBe(true))
  await screen.findByText(/awaiting your review\./)
  expect(count()).toBe('3 photos')
  fireEvent.click(screen.getByRole('button', { name: 'Removed from this gathering' }))
  await screen.findByText(/removed from this gathering\./)
  expect(count()).toBe('3 photos')
})

// The landmarks of the section, in document order.
function order(container: HTMLElement): string[] {
  const named: [string, Element | null][] = [
    ['switch', container.querySelector('.media-view')],
    ['upload', container.querySelector('#media-files')?.closest('form') ?? null],
    ['rows', container.querySelector('.media-list')],
    ['search', container.querySelector('.media-search')],
    ['grid', container.querySelector('.pgrid')],
    ['see all', container.querySelector('.seeall')],
  ]
  return named
    .filter((entry): entry is [string, Element] => entry[1] !== null)
    .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(([name]) => name)
}

test('the All view’s order by seat — the switch, the upload, the rows (the host’s waiting rows first), Find a photo, the grid, See all', async () => {
  const rows = () => [
    photo(31, { publication_state: 'removed', removed_at: new Date().toISOString(), is_own: true, filename: 'binned.jpg' }),
    ...photos(8),
    photo(30, { publication_state: 'pending', uploader_display_name: 'June Marlowe', filename: 'waiting.jpg' }),
  ]
  stubServer(rows())
  const host = renderSection({ isHost: true })
  await screen.findByRole('button', { name: tileName(1, 8) })
  expect(order(host.container)).toEqual(['switch', 'upload', 'rows', 'search', 'grid', 'see all'])
  const listed = host.container.querySelectorAll('.media-list > li')
  expect(listed[0].textContent).toContain('waiting.jpg')
  expect(listed[1].textContent).toContain('binned.jpg')
  cleanup()
  vi.unstubAllGlobals()

  stubServer(rows())
  const invitee = renderSection()
  await screen.findByRole('button', { name: tileName(1, 8) })
  expect(order(invitee.container)).toEqual(['upload', 'rows', 'search', 'grid', 'see all'])
  cleanup()
  vi.unstubAllGlobals()

  stubServer(photos(3))
  const photosOnly = renderSection({ canUpload: false, occurrences: null })
  await screen.findByRole('button', { name: tileName(1, 3) })
  expect(order(photosOnly.container)).toEqual(['search', 'grid'])
})

// ---------------------------------------------------------------------------
// The grid.
// ---------------------------------------------------------------------------

test('the grid holds the published, ready photos alone, in the list’s order; everything else is a row, as before', async () => {
  stubServer([
    photo(1),
    photo(2, { publication_state: 'pending', is_own: true, filename: 'waiting.jpg' }),
    photo(3),
    photo(4, { publication_state: 'removed', removed_at: new Date().toISOString(), is_own: true, filename: 'binned.jpg' }),
    photo(5, { status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'unreadable', filename: 'broken.jpg' }),
    photo(6, { status: 'processing', publication_state: 'pending', is_own: true, filename: 'busy.jpg' }),
    photo(7),
  ])
  renderSection()
  await screen.findByRole('button', { name: tileName(3, 3) })
  expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual([tileName(1, 3), tileName(2, 3), tileName(3, 3)])
  const rows = Array.from(document.querySelectorAll('.media-list > li')).map((li) => li.querySelector('strong')?.textContent)
  expect(rows).toEqual(['waiting.jpg', 'binned.jpg', 'broken.jpg', 'busy.jpg'])
})

test('a tile is a button holding its thumbnail layer and no control; its viewer opens on the tile pressed', async () => {
  const mock = stubServer(photos(3))
  renderSection()
  const tile = await screen.findByRole('button', { name: tileName(2, 3) })
  expect(tile.closest('ul')?.classList.contains('pgrid')).toBe(true)
  await waitFor(() => expect(tile.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
  expect(tile.querySelector('img')?.getAttribute('alt')).toBe('')
  expect(tile.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0)
  expect(paths(mock)).toContain('/media/m-2/url?layer=thumbnail')
  for (const t of tiles()) expect(t.querySelectorAll('button, a, input').length).toBe(0)
  // The tiles carry no controls: each place in the grid holds its tile and
  // nothing else a person could press.
  const cells = Array.from(document.querySelectorAll('.pgrid > li'))
  expect(cells).toHaveLength(3)
  for (const cell of cells) expect(cell.querySelectorAll('button, a, input, select, textarea, [role="button"]')).toHaveLength(1)
})

test('the preview: 6 tiles on a phone and 8 from 640px (the window), then See all {N} photos', async () => {
  stubServer(photos(20))
  renderSection()
  await screen.findByRole('button', { name: tileName(6, 20) })
  expect(tiles()).toHaveLength(6)
  expect(screen.getByRole('button', { name: 'See all 20 photos' })).toBeTruthy()
  cleanup()
  vi.unstubAllGlobals()

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(min-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} })),
  )
  stubServer(photos(20))
  renderSection()
  await screen.findByRole('button', { name: tileName(8, 20) })
  expect(tiles()).toHaveLength(8)
  expect(screen.getByRole('button', { name: 'See all 20 photos' })).toBeTruthy()
})

test('See all reveals the rest in place, moves focus to the first tile it revealed, and stays through the poll’s re-reads', async () => {
  const rows = [...photos(20), photo(99, { status: 'processing', publication_state: 'pending', is_own: true, filename: 'busy.jpg' })]
  const mock = stubServer(rows)
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: 'See all 20 photos' }))
  await waitFor(() => expect(tiles()).toHaveLength(20))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: tileName(7, 20) }))
  expect(screen.queryByRole('button', { name: /^See all/ })).toBeNull()
  const reads = paths(mock).filter((p) => p === '/gatherings/g-1/media').length
  await sleep(120)
  expect(paths(mock).filter((p) => p === '/gatherings/g-1/media').length).toBeGreaterThan(reads)
  expect(tiles()).toHaveLength(20)
})

test('with a search every match shows and there is no See all', async () => {
  stubServer(photos(20))
  renderSection()
  await screen.findByRole('button', { name: 'See all 20 photos' })
  fireEvent.change(screen.getByLabelText('Find a photo'), { target: { value: 'IMG' } })
  await screen.findByText('Showing 20 photos matching “IMG”.', { exact: false })
  await waitFor(() => expect(tiles()).toHaveLength(20))
  expect(screen.queryByRole('button', { name: /^See all/ })).toBeNull()
})

test('a tile not rendered mints nothing: twenty photos, six thumbnails minted, the first six', async () => {
  const mock = stubServer(photos(20))
  renderSection()
  await screen.findByRole('button', { name: tileName(6, 20) })
  await sleep(40)
  expect(paths(mock).filter((p) => p.includes('layer=thumbnail'))).toEqual(
    [1, 2, 3, 4, 5, 6].map((n) => `/media/m-${n}/url?layer=thumbnail`),
  )
  expect(paths(mock).some((p) => p.includes('layer=web'))).toBe(false)
})

// ---------------------------------------------------------------------------
// The viewer.
// ---------------------------------------------------------------------------

test('a modal dialog in document.body, labelled by the photo’s name; the root inert while it is open and put back after', async () => {
  stubServer(photos(3, (n) => (n === 2 ? { caption: 'Over the lake at 9:40' } : {})))
  const view = renderSection()
  const { viewer } = await openTile(2, 3)
  expect(viewer.parentElement).toBe(document.body)
  expect(view.container.contains(viewer)).toBe(false)
  expect(viewer.getAttribute('aria-modal')).toBe('true')
  expect(screen.getByRole('dialog', { name: 'Over the lake at 9:40' })).toBe(viewer)
  expect(view.container.hasAttribute('inert')).toBe(true)
  expect(document.body.classList.contains('viewer-open')).toBe(true)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(view.container.hasAttribute('inert')).toBe(false)
  expect(document.body.classList.contains('viewer-open')).toBe(false)
})

test('focus moves to Close on opening and back to the tile that opened it on closing', async () => {
  stubServer(photos(3))
  renderSection()
  const { tile, viewer } = await openTile(3, 3)
  await waitFor(() => expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Close' })))
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(tile))
})

test('the bar: Close, the photo’s name over “{gathering} · {i} of {n}”, and Full screen', async () => {
  stubServer(photos(20, (n) => (n === 2 ? { caption: 'Grandpa at the grill' } : {})))
  renderSection()
  const { viewer } = await openTile(2, 20)
  expect(viewer.querySelector('.vtitle b')?.textContent).toBe('Grandpa at the grill')
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 2 of 20`)
  expect(within(viewer).getByRole('button', { name: 'Close' })).toBeTruthy()
  expect(within(viewer).getByRole('button', { name: 'Full screen' })).toBeTruthy()
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  expect(viewer.querySelector('.vtitle b')?.textContent).toBe('IMG_3.jpg')
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 3 of 20`)
})

test('the stage: the web layer as a blob: URL — the current photo and its two neighbours, never archival — its alt the caption or “A photo”', async () => {
  const mock = stubServer(photos(5, (n) => (n === 3 ? { caption: 'The pie table' } : {})))
  renderSection()
  const { viewer } = await openTile(2, 5)
  await waitFor(() => expect(viewer.querySelector('img.vphoto')?.getAttribute('src')).toMatch(/^blob:/))
  expect(viewer.querySelector('img.vphoto')?.getAttribute('alt')).toBe('A photo')
  await waitFor(() =>
    expect(paths(mock).filter((p) => p.includes('layer=web')).sort()).toEqual(
      ['/media/m-1/url?layer=web', '/media/m-2/url?layer=web', '/media/m-3/url?layer=web'],
    ),
  )
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  await waitFor(() => expect(viewer.querySelector('img.vphoto')?.getAttribute('alt')).toBe('The pie table'))
  expect(paths(mock).some((p) => p.includes('archival'))).toBe(false)
})

test('“Added by” with the day in the profile’s zone — forced to differ from the runner’s — “You” on one’s own; no date in the photos-only view', async () => {
  const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  expect(formatDayWithYear(ADDED_AT, ZONE)).toBe('Jul 5, 2026')
  expect(formatDayWithYear(ADDED_AT, runnerZone === ZONE ? 'UTC' : runnerZone)).not.toBe('Jul 5, 2026')
  stubServer(photos(2, (n) => (n === 2 ? { is_own: true } : {})))
  renderSection()
  const { viewer } = await openTile(1, 2)
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by Nate Okafor · Jul 5, 2026')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by You · Jul 5, 2026')
  cleanup()
  vi.unstubAllGlobals()

  stubServer(photos(2))
  renderSection({ canUpload: false, occurrences: null })
  const photosOnly = (await openTile(1, 2)).viewer
  expect(photosOnly.querySelector('.vline')?.textContent).toBe('Added by Nate Okafor')
  expect(photosOnly.textContent).not.toMatch(/20\d\d|Jul \d|\b\d{1,2}:\d\d\b/)
})

test('the arrows are disabled at the ends; the strip names every photo and marks the current one', async () => {
  stubServer(photos(3, (n) => (n === 2 ? { caption: 'The dock' } : {})))
  renderSection()
  const { viewer } = await openTile(1, 3)
  expect((within(viewer).getByRole('button', { name: 'Previous photo' }) as HTMLButtonElement).disabled).toBe(true)
  expect((within(viewer).getByRole('button', { name: 'Next photo' }) as HTMLButtonElement).disabled).toBe(false)
  const strip = within(viewer).getByRole('group', { name: 'Photos here' })
  const thumbs = within(strip).getAllByRole('button')
  expect(thumbs.map((b) => b.getAttribute('aria-label'))).toEqual(['1 of 3: IMG_1.jpg', '2 of 3: The dock', '3 of 3: IMG_3.jpg'])
  expect(thumbs.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null])
  fireEvent.click(thumbs[2])
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 3 of 3`)
  expect(within(strip).getAllByRole('button').map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'true'])
  expect((within(viewer).getByRole('button', { name: 'Next photo' }) as HTMLButtonElement).disabled).toBe(true)
  expect((within(viewer).getByRole('button', { name: 'Previous photo' }) as HTMLButtonElement).disabled).toBe(false)
})

test('ArrowRight and ArrowLeft move between photos — never from inside a text field', async () => {
  stubServer(photos(3, (n) => (n === 2 ? { is_own: true } : {})))
  renderSection()
  const { viewer } = await openTile(1, 3)
  const where = () => viewer.querySelector('.vtitle span')?.textContent
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  expect(where()).toBe(`${TITLE} · 2 of 3`)
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  expect(where()).toBe(`${TITLE} · 3 of 3`)
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  expect(where()).toBe(`${TITLE} · 3 of 3`)
  fireEvent.keyDown(document, { key: 'ArrowLeft' })
  expect(where()).toBe(`${TITLE} · 2 of 3`)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Edit caption and tags' }))
  const caption = within(viewer).getByLabelText('Caption')
  fireEvent.keyDown(caption, { key: 'ArrowRight' })
  fireEvent.keyDown(caption, { key: 'ArrowLeft' })
  expect(where()).toBe(`${TITLE} · 2 of 3`)
})

test('Full screen and Leave full screen; Zoom in and Zoom out; Escape zooms out, then leaves full screen, then closes', async () => {
  stubServer(photos(3))
  renderSection()
  const { viewer } = await openTile(2, 3)
  await waitFor(() => expect(viewer.querySelector('img.vphoto')).toBeTruthy())
  expect(within(viewer).queryByRole('button', { name: 'Leave full screen' })).toBeNull()
  fireEvent.click(within(viewer).getByRole('button', { name: 'Full screen' }))
  expect(viewer.classList.contains('immersive')).toBe(true)
  await waitFor(() => expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Leave full screen' })))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Zoom in' }))
  expect(viewer.classList.contains('zoomed')).toBe(true)
  expect(within(viewer).getByRole('button', { name: 'Zoom out' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(viewer.classList.contains('zoomed')).toBe(false)
  expect(viewer.classList.contains('immersive')).toBe(true)
  expect(within(viewer).getByRole('button', { name: 'Zoom in' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(viewer.classList.contains('immersive')).toBe(false)
  expect(screen.getByRole('dialog')).toBe(viewer)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()

  const again = (await openTile(1, 3)).viewer
  fireEvent.click(within(again).getByRole('button', { name: 'Full screen' }))
  fireEvent.click(within(again).getByRole('button', { name: 'Leave full screen' }))
  expect(again.classList.contains('immersive')).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(within(again).getByRole('button', { name: 'Full screen' })))
})

test('only the photo answers a click: one beside it does nothing; one on it opens full screen; a double-click on it zooms', async () => {
  stubServer(photos(3))
  renderSection()
  const { viewer } = await openTile(2, 3)
  await waitFor(() => expect(viewer.querySelector('img.vphoto')).toBeTruthy())
  const stage = viewer.querySelector('.vstage') as HTMLElement
  fireEvent.click(stage)
  fireEvent.doubleClick(stage)
  await sleep(400)
  expect(viewer.classList.contains('immersive')).toBe(false)
  expect(viewer.classList.contains('zoomed')).toBe(false)
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 2 of 3`)
  fireEvent.click(viewer.querySelector('img.vphoto') as HTMLElement)
  await waitFor(() => expect(viewer.classList.contains('immersive')).toBe(true))
  fireEvent.doubleClick(viewer.querySelector('img.vphoto') as HTMLElement)
  expect(viewer.classList.contains('zoomed')).toBe(true)
})

test('the arrows are the stage’s own, never the photo’s: placed on the stage, so they stand in one place for every photo', async () => {
  stubServer(photos(3))
  renderSection()
  const { viewer } = await openTile(2, 3)
  await waitFor(() => expect(viewer.querySelector('img.vphoto')).toBeTruthy())
  const stage = viewer.querySelector('.vstage') as HTMLElement
  for (const name of ['Previous photo', 'Next photo']) {
    expect(within(viewer).getByRole('button', { name }).parentElement).toBe(stage)
  }
  expect((viewer.querySelector('img.vphoto') as HTMLElement).parentElement).toBe(stage)
  const rule = (selector: string) => {
    const start = appCss.indexOf(`\n${selector} {`)
    return appCss.slice(start, appCss.indexOf('}', start))
  }
  expect(rule('.vstage')).toContain('position: relative')
  expect(rule('.varrow')).toContain('position: absolute')
  expect(rule('.varrow')).toContain('top: 50%')
})

test('ONE history entry, its state exactly { photoViewer: true } and nothing in the address; moving adds nothing; Back closes it; Close pops it', async () => {
  stubServer(photos(3))
  renderSection()
  await screen.findByRole('button', { name: tileName(1, 3) })
  const start = seen[seen.length - 1]
  const { tile, viewer } = await openTile(1, 3)
  await waitFor(() => expect(seen[seen.length - 1].key).not.toBe(start.key))
  const entry = seen[seen.length - 1]
  expect(entry.state).toEqual({ photoViewer: true })
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  await sleep(20)
  expect(seen[seen.length - 1].key).toBe(entry.key)
  // Back: the viewer closes, and the page is where it was.
  await act(async () => nav.current?.(-1))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(seen[seen.length - 1].key).toBe(start.key)
  await waitFor(() => expect(document.activeElement).toBe(tile))
  // Close pops the entry it pushed: the history ends where it began.
  const reopened = (await openTile(2, 3)).viewer
  await waitFor(() => expect(seen[seen.length - 1].state).toEqual({ photoViewer: true }))
  fireEvent.click(within(reopened).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(seen[seen.length - 1].key).toBe(start.key))
  expect(seen[seen.length - 1].state).toBeNull()
})

test('the frame’s scroll is unmoved by the viewer’s history entry: the same pathname, no reset', async () => {
  const auth: AuthState = {
    status: 'signedIn',
    person: { id: 'person-1', display_name: 'Sam Marlowe', email: 'sam@example.com', timezone: 'America/Chicago', account_id: 'acct-1' },
    signIn: () => {},
    signOut: async () => {},
    updatePerson: () => {},
  }
  const detail = {
    id: 'g-1',
    gathering_type: 'potluck',
    title: TITLE,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-2',
    host_account_id: 'acct-2',
    caller_role: null,
    caller_view: 'full',
    group: null,
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    occurrences: [{ ...OCCURRENCES[0], caller_response: null }],
  }
  stubServer(photos(3), {
    'GET /gatherings/g-1': () => json(200, detail),
    'GET /groups': () => json(200, { groups: [] }),
    'GET /gatherings': () => json(200, { gatherings: [] }),
    'GET /health': () => json(200, { status: 'ok' }),
  })
  render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthContext.Provider value={auth}>
        <App />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  await screen.findByRole('button', { name: tileName(1, 3) })
  // CK-89's rider: this pin watched the column alone, and jsdom with no matchMedia
  // is a phone, whose scroller is the window, so it stayed green with the rule
  // broken (CK-88.2's finding). It watches both scrollers now.
  const root = document.scrollingElement ?? document.documentElement
  const writes: [string, number][] = []
  const scrollers: [string, Element][] = [['column', document.querySelector('.frame-col') as HTMLElement], ['window', root]]
  for (const [name, scroller] of scrollers) {
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 480,
      set: (value: number) => writes.push([name, value]),
    })
  }
  try {
    const { viewer } = await openTile(1, 3)
    await sleep(20)
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
    await sleep(20)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes).toEqual([])
  } finally {
    // The document outlives the test.
    delete (root as unknown as { scrollTop?: number }).scrollTop
  }
})

test('the layers: never more than three web layers held as the viewer moves, every one revoked on close', async () => {
  stubServer(photos(8))
  renderSection()
  const { viewer } = await openTile(1, 8)
  await waitFor(() => expect(liveWeb()).toBe(2))
  for (let step = 0; step < 6; step++) {
    fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
    await sleep(15)
    expect(liveWeb()).toBeLessThanOrEqual(3)
  }
  await waitFor(() => expect(liveWeb()).toBe(3))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  expect(liveWeb()).toBe(0)
  const webs = created.filter((c) => c.size === 100).map((c) => c.url)
  expect(webs.length).toBeGreaterThan(3)
  expect(webs.every((url) => revoked.includes(url))).toBe(true)
})

test('a re-read keeps the open photo by its id, and the viewer closes — focus on the Photos heading — when the photo has gone', async () => {
  const rows = [...photos(3), photo(99, { status: 'processing', publication_state: 'pending', is_own: true, filename: 'busy.jpg' })]
  stubServer(rows)
  renderSection()
  const { viewer } = await openTile(2, 3)
  rows.unshift(photo(0, { filename: 'IMG_0.jpg' }))
  await waitFor(() => expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 3 of 4`))
  expect(viewer.querySelector('.vtitle b')?.textContent).toBe('IMG_2.jpg')
  rows.splice(rows.findIndex((r) => r.id === 'm-2'), 1)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Photos' })))
})

// ---------------------------------------------------------------------------
// The actions.
// ---------------------------------------------------------------------------

test('on one’s own photo: Edit caption and tags opens today’s editor in the viewer, its save sends the WHOLE tag list, and the viewer shows the saved words', async () => {
  const mock = stubServer(photos(2, (n) => (n === 2 ? { is_own: true, caption: 'Old words', tags: ['Dock', 'Lake'] } : {})))
  renderSection()
  const { viewer } = await openTile(2, 2)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Edit caption and tags' }))
  const form = within(viewer).getByRole('form', { name: 'Edit Old words' })
  fireEvent.change(within(form).getByLabelText('Caption'), { target: { value: 'Everyone on the dock' } })
  fireEvent.change(within(form).getByLabelText('Add a tag'), { target: { value: 'Cousins' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Add tag' }))
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(paths(mock, 'PATCH')).toEqual(['/media/m-2']))
  const body = JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))
  expect(body).toEqual({ caption: 'Everyone on the dock', tags: ['Dock', 'Lake', 'Cousins'] })
  await waitFor(() => expect(viewer.querySelector('.vtitle b')?.textContent).toBe('Everyone on the dock'))
  expect(within(viewer).queryByRole('form')).toBeNull()
  expect(within(within(viewer).getByRole('list', { name: 'Tags on Everyone on the dock' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Dock',
    'Lake',
    'Cousins',
  ])
})

test('Send to bin: one click, one post; the viewer closes and focus lands on the photo’s new row’s Put back', async () => {
  const mock = stubServer(photos(2, (n) => (n === 2 ? { is_own: true } : {})))
  renderSection()
  const { viewer } = await openTile(2, 2)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Send to bin' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(paths(mock, 'POST')).toEqual(['/media/m-2/remove'])
  const row = (await screen.findByText('IMG_2.jpg')).closest('li') as HTMLElement
  expect(row.textContent).toContain('In your bin. Only you can see it')
  await waitFor(() => expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Put back' })))
  expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual([tileName(1, 1)])
})

test('Delete permanently takes today’s second step — the sentence, Keep it doing nothing — and its landing closes the viewer with “Photo deleted.” and focus on the heading', async () => {
  const mock = stubServer(photos(2, (n) => (n === 2 ? { is_own: true } : {})))
  renderSection()
  const { viewer } = await openTile(2, 2)
  // CK-95: pressed as a person presses it, with focus on it — the step takes
  // focus only from the body or from inside the viewer's words, so focus left
  // on Close, where opening the viewer put it, stays there.
  within(viewer).getByRole('button', { name: 'Delete permanently' }).focus()
  fireEvent.click(within(viewer).getByRole('button', { name: 'Delete permanently' }))
  expect(paths(mock, 'POST')).toEqual([])
  // CK-95 (the components doc's Focus after an answer): the step is named by its
  // sentence, where until then an aria-label named it "Delete IMG_2.jpg"; and it
  // takes focus as it opens on ITSELF, the group its sentence labels — never on
  // its Delete permanently, as it did from CK-88, where a second Enter destroyed
  // the photo — and gives it back to the button that opened it when it closes
  // without acting.
  let step = within(viewer).getByRole('group', { name: DELETE_PERMANENTLY_CONFIRMATION })
  expect(within(step).getByText(DELETE_PERMANENTLY_CONFIRMATION)).toBeTruthy()
  expect(document.activeElement).toBe(step)
  fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
  expect(within(viewer).queryByRole('group', { name: DELETE_PERMANENTLY_CONFIRMATION })).toBeNull()
  expect(paths(mock, 'POST')).toEqual([])
  await waitFor(() => expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Delete permanently' })))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Delete permanently' }))
  step = within(viewer).getByRole('group', { name: DELETE_PERMANENTLY_CONFIRMATION })
  fireEvent.click(within(step).getByRole('button', { name: 'Delete permanently' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(paths(mock, 'POST')).toEqual(['/media/m-2/destroy'])
  expect(await screen.findByText('Photo deleted.')).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Photos' })))
})

test('Remove from gathering: an organiser’s, on someone else’s photo, behind today’s step — the sentence by seat and gate, Leave it inert — landing in the Removed view’s button', async () => {
  for (const [seat, requiresApproval, sentence] of [
    [{ isHost: true }, false, 'Only you and any co-hosts will be able to see this photo. You can put it back for 30 days.'],
    [{ isHost: false, organises: true }, false, 'Only the host and co-hosts will be able to see this photo. You can put it back for 30 days.'],
    [
      { isHost: false, organises: true },
      true,
      'Only the host and co-hosts will be able to see this photo. If you put it back within 30 days, the host will look at it again before anyone else sees it.',
    ],
  ] as [{ isHost: boolean; organises?: boolean }, boolean, string][]) {
    const mock = stubServer(photos(2))
    renderSection({ ...seat, requiresApproval })
    const { viewer } = await openTile(1, 2)
    // CK-95: pressed with focus on it, as a person presses it (the step takes
    // focus only from the body or from inside the viewer's words).
    within(viewer).getByRole('button', { name: 'Remove from gathering' }).focus()
    fireEvent.click(within(viewer).getByRole('button', { name: 'Remove from gathering' }))
    // CK-95: the step is named by its sentence, where until then an aria-label
    // named it "Remove IMG_1.jpg from this gathering", and it takes focus as it
    // opens on itself — never on its Remove it, as it did from CK-88.
    const step = within(viewer).getByRole('group', { name: sentence })
    expect(within(step).getByText(sentence)).toBeTruthy()
    expect(document.activeElement).toBe(step)
    fireEvent.click(within(step).getByRole('button', { name: 'Leave it' }))
    expect(paths(mock, 'POST')).toEqual([])
    await waitFor(() => expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Remove from gathering' })))
    fireEvent.click(within(viewer).getByRole('button', { name: 'Remove from gathering' }))
    fireEvent.click(within(within(viewer).getByRole('group', { name: sentence })).getByRole('button', { name: 'Remove it' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(paths(mock, 'POST')).toEqual(['/media/m-1/remove'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Removed from this gathering' })))
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('the acts by seat, where the rows put them and nowhere else: one’s own photo its three, an organiser’s someone else’s Remove from gathering, an invitee nothing on another’s, never an organiser’s takedown on their own', async () => {
  const OWN = ['Edit caption and tags', 'Send to bin', 'Delete permanently']
  const all = [...OWN, 'Remove from gathering', 'Use as cover']
  const acts = (viewer: HTMLElement) =>
    all.filter((name) => within(viewer).queryByRole('button', { name }) !== null)
  for (const [seat, expectOther, expectOwn] of [
    [{ isHost: true }, ['Remove from gathering', 'Use as cover'], [...OWN, 'Use as cover']],
    [{ isHost: false, organises: true }, ['Remove from gathering', 'Use as cover'], [...OWN, 'Use as cover']],
    [{ isHost: false }, [], OWN],
    [{ isHost: false, canUpload: false, occurrences: null }, [], OWN],
  ] as [Partial<Parameters<typeof GatheringMedia>[0]>, string[], string[]][]) {
    stubServer(photos(2, (n) => (n === 2 ? { is_own: true } : {})))
    renderSection(seat)
    const { viewer } = await openTile(1, 2)
    expect(acts(viewer)).toEqual(expectOther)
    fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
    expect(acts(viewer)).toEqual(expectOwn)
    for (const t of tiles()) expect(t.querySelectorAll('button, a, input').length).toBe(0)
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('a refusal in the viewer renders from its code — never the server’s words — with Refresh the list, and nothing is re-read', async () => {
  const mock = stubServer(photos(2, (n) => (n === 2 ? { is_own: true } : {})), {
    'POST /media/m-2/remove': () =>
      json(409, { detail: { code: 'already_removed', publication_state: 'removed', message: 'server wording here' } }),
    'POST /media/m-1/remove': () =>
      json(409, { detail: { code: 'already_removed', publication_state: 'removed', message: 'server wording here' } }),
  })
  renderSection({ isHost: true })
  const { viewer } = await openTile(2, 2)
  const reads = () => paths(mock).filter((p) => p.startsWith('/gatherings/g-1/media')).length
  const before = reads()
  fireEvent.click(within(viewer).getByRole('button', { name: 'Send to bin' }))
  expect(await within(viewer).findByText('This photo is already in your bin.')).toBeTruthy()
  expect(within(viewer).getByRole('button', { name: 'Refresh the list' })).toBeTruthy()
  expect(viewer.textContent).not.toContain('server wording here')
  expect(screen.getByRole('dialog')).toBe(viewer)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Previous photo' }))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Remove from gathering' }))
  // CK-95: the step is named by its sentence (the host's), not "Remove IMG_1.jpg …".
  fireEvent.click(
    within(
      within(viewer).getByRole('group', {
        name: 'Only you and any co-hosts will be able to see this photo. You can put it back for 30 days.',
      }),
    ).getByRole('button', { name: 'Remove it' }),
  )
  expect(await within(viewer).findByText('This photo has already been removed — refresh the list to see where it is.')).toBeTruthy()
  expect(reads()).toBe(before)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Refresh the list' }))
  await waitFor(() => expect(reads()).toBe(before + 1))
  expect(screen.getByRole('dialog')).toBe(viewer)
})

test('a row’s thumbnail opens its photo alone: the words and the state line, no arrows, no strip, and no act — the row keeps its own', async () => {
  const mock = stubServer([photo(1), photo(2, { publication_state: 'pending', uploader_display_name: 'June Marlowe', filename: 'waiting.jpg' })])
  renderSection({ isHost: true, requiresApproval: true })
  const row = (await screen.findByText('waiting.jpg')).closest('li') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Open photo added by June Marlowe' }))
  const viewer = screen.getByRole('dialog')
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 1 of 1`)
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by June Marlowe · Jul 5, 2026')
  expect(viewer.querySelector('.vstate')?.textContent).toBe('Only June Marlowe and you can see this. Waiting for you to publish or decline it.')
  expect(within(viewer).queryByRole('button', { name: /photo$/ })).toBeNull()
  expect(within(viewer).queryByRole('group', { name: 'Photos here' })).toBeNull()
  for (const name of ['Publish', 'Decline', 'Remove from gathering', 'Use as cover', 'Send to bin', 'Edit caption and tags']) {
    expect(within(viewer).queryByRole('button', { name })).toBeNull()
  }
  await waitFor(() => expect(paths(mock).filter((p) => p.includes('layer=web'))).toEqual(['/media/m-2/url?layer=web']))
  expect(within(row).getByRole('button', { name: 'Publish' })).toBeTruthy()
})

// A waiting photo stays a row, so its thumbnail can fail in the row. `failures`
// is how many thumbnail mints fail before one lands; the web layer always mints.
function stubFailingThumbnail(status: number, failures = Number.POSITIVE_INFINITY) {
  let minted = 0
  const thumbnailMints = () => minted
  const mock = stubServer([photo(2, { publication_state: 'pending', uploader_display_name: 'June Marlowe', filename: 'waiting.jpg' })], {
    'GET /media/m-2/url': (_init, path) => {
      if (path.endsWith('layer=web')) return json(200, { url: 'https://r2.invalid/media/m-2/web?X-Amz-Signature=sig', method: 'GET' })
      minted += 1
      if (minted <= failures) return json(status, { detail: 'no' })
      return json(200, { url: `https://r2.invalid/media/m-2/thumbnail?X-Amz-Signature=sig-${minted}`, method: 'GET' })
    },
  })
  return { mock, thumbnailMints }
}

async function failedRow() {
  const row = (await screen.findByText('waiting.jpg')).closest('li') as HTMLElement
  const retry = await within(row).findByRole('button', { name: 'Retry' })
  const opener = within(row).getByRole('button', { name: 'Open photo added by June Marlowe' })
  return { row, retry, opener }
}

for (const [status, line] of [
  [409, 'Not ready to show yet.'],
  [500, "Couldn't show this photo just now."],
] as const) {
  test(`a row’s thumbnail that can’t be shown (${status}): the ground alone in the button that opens it, its line and Retry beside it, no button inside a button`, async () => {
    const consoleError = vi.spyOn(console, 'error')
    stubFailingThumbnail(status)
    renderSection({ isHost: true, requiresApproval: true })
    const { row, retry, opener } = await failedRow()
    expect(opener.contains(retry)).toBe(false)
    expect(document.querySelector('button button')).toBeNull()
    expect(opener.contains(within(row).getByText(line))).toBe(false)
    expect(opener.textContent).toBe('')
    expect(opener.querySelector('img')).toBeNull()
    expect(opener.querySelector('.media-thumb')).not.toBeNull()
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/descendant of <button>|nested <button>/)
    consoleError.mockRestore()
  })
}

test('Retry asks again and opens nothing: the photo lands in the same button, the line and Retry gone, and focus on that button, which stayed', async () => {
  const { thumbnailMints } = stubFailingThumbnail(500, 1)
  renderSection({ isHost: true, requiresApproval: true })
  const { row, retry, opener } = await failedRow()
  expect(thumbnailMints()).toBe(1)
  retry.focus()
  fireEvent.click(retry)
  expect(screen.queryByRole('dialog')).toBeNull()
  // Retry goes as it is pressed, so a keyboard is left on the button and not the page.
  expect(document.activeElement).toBe(opener)
  expect(opener.textContent).toBe('Loading…')
  expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull()
  await waitFor(() => expect(opener.querySelector('img')).not.toBeNull())
  expect(thumbnailMints()).toBe(2)
  expect(within(row).getByRole('button', { name: 'Open photo added by June Marlowe' })).toBe(opener)
  expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(within(row).queryByText("Couldn't show this photo just now.")).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a Retry that fails again brings the line and Retry back, and the thumbnail’s button still opens its photo, focus back on it after', async () => {
  const { thumbnailMints } = stubFailingThumbnail(500)
  renderSection({ isHost: true, requiresApproval: true })
  const { row, retry, opener } = await failedRow()
  fireEvent.click(retry)
  const again = await within(row).findByRole('button', { name: 'Retry' })
  expect(thumbnailMints()).toBe(2)
  expect(within(row).getByText("Couldn't show this photo just now.")).toBeTruthy()
  expect(within(row).getByRole('button', { name: 'Open photo added by June Marlowe' })).toBe(opener)
  expect(opener.contains(again)).toBe(false)
  fireEvent.click(opener)
  const viewer = screen.getByRole('dialog')
  expect(viewer.querySelector('.vtitle span')?.textContent).toBe(`${TITLE} · 1 of 1`)
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(opener)
  expect(thumbnailMints()).toBe(2)
})

test('no presigned URL in the markup, and none sent twice: every bucket URL fetched once, the page holding blob: URLs alone', async () => {
  const mock = stubServer(photos(5))
  renderSection()
  const { viewer } = await openTile(2, 5)
  await waitFor(() => expect(viewer.querySelector('img.vphoto')?.getAttribute('src')).toMatch(/^blob:/))
  fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }))
  await sleep(40)
  expect(document.body.innerHTML).not.toMatch(/X-Amz|r2\.invalid|Signature=/)
  for (const img of Array.from(document.querySelectorAll('img'))) expect(img.getAttribute('src')).toMatch(/^blob:/)
  const bucket = mock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('https://r2.invalid/'))
  expect(bucket.length).toBeGreaterThan(0)
  expect(new Set(bucket).size).toBe(bucket.length)
})

// ---------------------------------------------------------------------------
// The styles.
// ---------------------------------------------------------------------------

test('the grid’s and the viewer’s styles name no colour and add no token: every var() they read is defined in tokens.css', () => {
  const start = appCss.indexOf('/* ---------- the photo grid and the photo viewer')
  const end = appCss.indexOf('/* Tags are chips of text', start)
  const block = appCss.slice(start, end)
  expect(block.length).toBeGreaterThan(1000)
  expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  const defined = new Set(Array.from(tokensCss.matchAll(/(--[\w-]+)\s*:/g)).map((m) => m[1]))
  const used = Array.from(block.matchAll(/var\((--[\w-]+)/g)).map((m) => m[1])
  for (const token of ['--ck-stage', '--ck-frost', '--ck-frost-ink', '--ck-empty', '--pg-surface', '--pg-hairline', '--ck-lift', '--pg-events-accent']) {
    expect(used).toContain(token)
  }
  for (const token of used) expect(defined.has(token)).toBe(true)
})
