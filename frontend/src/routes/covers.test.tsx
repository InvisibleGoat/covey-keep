// CK-84 — covers on the surface, through the pages. The value under test:
// every row of the three lists starts with its cover at the thumbnail layer,
// and both pages open on a cover card at the web layer with the page's <h1>
// inside it — the photos-only view too; Change cover is offered exactly to
// the people who may set a cover (a gathering's host and co-host, a group's
// admin and co-admin) and to nobody else, over an inline panel whose
// `aria-expanded` follows it, with Remove cover only while a cover is set;
// the upload runs intent → PUT → confirm under *Uploading your picture…*,
// then reads the cover image every POLL_INTERVAL_MS under *Getting it
// ready…*, keeps the old cover on the card until `ready`, then re-reads the
// subject and tells the menu — and every way it can end says its approved
// line; the polling stops on unmount while the confirm still goes out;
// Remove cover takes a second step whose sentence follows the source and
// the page, Keep it does nothing, and a 204 re-reads the subject and tells
// the menu; and in the opened photo Use as cover is the organisers' one
// click on a published photograph that is not already the cover, Use as the
// group's cover is the group's admin's and co-admins' — the group read once,
// only on a group's gathering — behind a step naming both, and neither is
// offered on a photograph that is not published. Refusals read the house
// line and re-read nothing.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { PageCover } from '../components/PageCover'
import { clearCoverPictures, onCoverChange, type CoverBody } from '../lib/covers'
import { PICKER_ACCEPT, POLL_INTERVAL_MS } from '../lib/media'
import { GatheringDetail } from './GatheringDetail'
import { Gatherings } from './Gatherings'
import { GroupDetail } from './GroupDetail'
import { Groups } from './Groups'

const person: Person = {
  id: 'person-ada',
  display_name: 'Ada Test',
  email: 'ada@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-ada',
}

const auth: AuthState = { status: 'signedIn', person, signIn: () => {}, signOut: async () => {}, updatePerson: () => {} }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const T1 = '2026-11-01T10:00:00+00:00'
const T2 = '2026-11-01T12:00:00+00:00'

const PUT_URL =
  'https://r2.invalid/coveykeep-dev-quarantine/covers/ci-1?X-Amz-Credential=UPLOADKEYID%2F20261101&X-Amz-Signature=putsig77'
const signed = (n: number) =>
  `https://r2.invalid/coveykeep-dev/covers/ci-${n}/web?X-Amz-Credential=SERVEKEYID%2F20261101&X-Amz-Signature=getsig${n}`

const GROUP_REF = { id: 'grp-1', name: 'The Lees' }
const DAY = 24 * 60 * 60 * 1000
const AHEAD = new Date(Date.now() + 10 * DAY).toISOString()

function gathering(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'The Party',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-ada',
    host_account_id: 'acct-ada',
    caller_role: 'host',
    caller_view: 'full',
    group: null,
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    occurrences: [
      { id: 'occ-1', gathering_id: 'g-1', starts_at: AHEAD, ends_at: null, location: null, map_url: null },
    ],
    ...over,
  }
}

function memoryGathering(over: Record<string, unknown> = {}) {
  return gathering({
    caller_role: null,
    caller_view: 'memory',
    rsvp_list_visibility: null,
    occurrences: null,
    group: GROUP_REF,
    ...over,
  })
}

function listItem(over: Record<string, unknown> = {}) {
  const { occurrences: _dates, ...body } = gathering(over)
  return {
    ...body,
    next_occurrence: body.caller_view === 'full' ? { id: 'occ-1', starts_at: AHEAD } : null,
    occurrence_count: body.caller_view === 'full' ? 1 : null,
  }
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'grp-1',
    name: 'The Lees',
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: 3,
    caller_role: 'admin',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    ...over,
  }
}

const MEMBERS = [
  { membership_id: 'mem-ada', display_name: 'Ada Test', role: 'admin', is_self: true },
  { membership_id: 'mem-bea', display_name: 'Bea Test', role: 'co_admin', is_self: false },
  { membership_id: 'mem-cal', display_name: 'Cal Test', role: 'member', is_self: false },
]

function photo(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: '2026-10-28T12:00:00+00:00',
    created_at: '2026-10-28T12:00:00+00:00',
    uploader_display_name: 'Bea Test',
    is_own: false,
    removed_at: null,
    filename: 'party.jpg',
    caption: null,
    tags: [],
    published_at: '2026-10-28T12:00:05+00:00',
    failure_reason: null,
    ...over,
  }
}

type Responder = (init: RequestInit | undefined, path: string) => Response | Promise<Response>

// One fake for every page here: routes by "METHOD /path"; the cover URL
// routes mint a fresh presigned GET each time unless a route says otherwise;
// a photograph's own layer is never ready (the viewer's picture is not what
// is under test); the bucket answers bytes; anything else is refused loudly.
function stubServer(routes: Record<string, Responder>) {
  let mints = 0
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const full = String(url)
    if (full.startsWith('https://r2.invalid/')) {
      const bucket = routes[`${method} bucket`]
      return bucket ? bucket(init, full) : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }
    const path = full.replace(/^https?:\/\/[^/]+/, '')
    const route = routes[`${method} ${path}`]
    if (route) return route(init, path)
    if (method === 'GET' && path.includes('/cover/url?layer=')) {
      mints += 1
      return json(200, { layer: 'web', content_type: 'image/webp', size_bytes: 3, url: signed(mints), method: 'GET', expires_in: 300 })
    }
    if (method === 'GET' && /^\/media\/[^/]+\/url/.test(path)) {
      return json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } })
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function requests(mock: ReturnType<typeof vi.fn>, method: string, match: RegExp | string) {
  return mock.mock.calls.filter(([url, init]) => {
    const m = (init as RequestInit | undefined)?.method ?? 'GET'
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    return m === method && (typeof match === 'string' ? p === match : match.test(p))
  }) as unknown as [string, RequestInit | undefined][]
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/groups" element={<Groups />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          <Route path="/gatherings" element={<Gatherings />} />
          <Route path="/gatherings/:id" element={<GatheringDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

// The routes a group's page reads beside the group (CK-78 to CK-80): its
// members, its gatherings, the link and — for organisers — the requests and
// the invitations; each answered with nothing.
function groupPageRoutes(body: () => unknown, over: Record<string, Responder> = {}): Record<string, Responder> {
  return {
    'GET /groups/grp-1': () => json(200, body()),
    'GET /groups/grp-1/members': () => json(200, { members: MEMBERS }),
    'GET /groups/grp-1/gatherings': () => json(200, { gatherings: [] }),
    'GET /groups/grp-1/link': () => json(200, { url: null, expires_at: null }),
    'GET /groups/grp-1/join-requests': () => json(200, { join_requests: [] }),
    'GET /groups/grp-1/invitations': () => json(200, { pending: [] }),
    ...over,
  }
}

const created: string[] = []
const revoked: string[] = []
let heard = 0
let stopListening: () => void = () => {}

beforeEach(() => {
  created.length = 0
  revoked.length = 0
  heard = 0
  Object.assign(URL, {
    createObjectURL: () => {
      const objectUrl = `blob:cover-${created.length + 1}`
      created.push(objectUrl)
      return objectUrl
    },
    revokeObjectURL: (objectUrl: string) => {
      revoked.push(objectUrl)
    },
  })
  // The menu's side of the change signal: every announcement counted.
  stopListening = onCoverChange(() => {
    heard += 1
  })
})

afterEach(() => {
  stopListening()
  cleanup()
  clearCoverPictures()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

function coverCard(): HTMLElement {
  const card = document.querySelector('.cover-card')
  if (!(card instanceof HTMLElement)) throw new Error('no cover card')
  return card
}

function cardImageSrc(): string | null {
  return coverCard().querySelector('.cover-photo > img')?.getAttribute('src') ?? null
}

// ---------------------------------------------------------------------------
// Where covers show.
// ---------------------------------------------------------------------------

test('the Groups list: each row starts with its cover at the thumbnail layer — the empty cover where none is set — and its words are unchanged', async () => {
  const mock = stubServer({
    'GET /groups': () =>
      json(200, {
        groups: [group({ cover: { source: 'photo', set_at: T1 } }), group({ id: 'grp-2', name: 'Cousins', caller_role: 'member' })],
      }),
  })
  renderAt('/groups')
  const list = await screen.findByRole('list', { name: 'Your groups' })
  const [lees, cousins] = within(list).getAllByRole('link')
  await waitFor(() => expect(lees.querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/))
  expect(lees.querySelector('img.nthumb')?.getAttribute('alt')).toBe('')
  expect(lees.querySelector('strong')?.textContent).toBe('The Lees')
  expect(lees.querySelector('p')?.textContent).toBe('3 members · Admin')
  expect(lees.textContent).toBe('The Lees3 members · Admin')
  expect(cousins.querySelector('.noimg.nthumb')).toBeTruthy()
  expect(requests(mock, 'GET', /\/cover\/url/).map(([url]) => url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/groups/grp-1/cover/url?layer=thumbnail',
  ])
})

test('the Gatherings list: both views’ rows start with the cover — the memory tier reads a gathering’s cover — at the thumbnail layer', async () => {
  const mock = stubServer({
    'GET /gatherings': () =>
      json(200, {
        gatherings: [
          listItem({ cover: { source: 'upload', set_at: T1 } }),
          listItem({ id: 'g-2', title: 'Kept for photos', caller_view: 'memory', caller_role: null, group: GROUP_REF, cover: { source: 'photo', media_id: 'm-9', set_at: T1 } }),
          listItem({ id: 'g-3', title: 'No cover yet' }),
        ],
      }),
  })
  renderAt('/gatherings')
  await screen.findByRole('heading', { level: 1, name: 'Your gatherings' })
  const links = screen.getAllByRole('link').filter((link) => link.classList.contains('gathering-item'))
  await waitFor(() => expect(links[0].querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/))
  await waitFor(() => expect(links[1].querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/))
  expect(links[1].querySelector('p')?.textContent).toBe('Potluck · You can see its photos · The Lees')
  expect(links[2].querySelector('.noimg.nthumb')).toBeTruthy()
  expect(
    requests(mock, 'GET', /\/cover\/url/)
      .map(([url]) => url.replace(/^https?:\/\/[^/]+/, ''))
      .sort(),
  ).toEqual(['/gatherings/g-1/cover/url?layer=thumbnail', '/gatherings/g-2/cover/url?layer=thumbnail'])
})

test('a group’s page: the cover card at the web layer with the page’s <h1> inside it, still the heading by role and name; the Gatherings section’s rows start with their covers', async () => {
  const mock = stubServer(
    groupPageRoutes(() => group({ caller_role: 'member', cover: { source: 'upload', set_at: T1 } }), {
      'GET /groups/grp-1/gatherings': () =>
        json(200, { gatherings: [listItem({ group: GROUP_REF, cover: { source: 'photo', media_id: 'm-1', set_at: T1 } })] }),
    }),
  )
  renderAt('/groups/grp-1')
  const heading = await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  expect(heading.closest('.cover-over')).toBeTruthy()
  expect(heading.closest('.cover-card')).toBe(coverCard())
  await waitFor(() => expect(cardImageSrc()).toMatch(/^blob:/))
  expect(coverCard().querySelector('.cover-photo > img')?.getAttribute('alt')).toBe('')
  // The count and the rest stay beneath the card.
  expect(screen.getByText('3 members').closest('.cover-card')).toBeNull()
  const list = await screen.findByRole('list', { name: "The group's gatherings" })
  await waitFor(() => expect(within(list).getByRole('link').querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/))
  const mints = requests(mock, 'GET', /\/cover\/url/).map(([url]) => url.replace(/^https?:\/\/[^/]+/, ''))
  expect(mints.sort()).toEqual(['/gatherings/g-1/cover/url?layer=thumbnail', '/groups/grp-1/cover/url?layer=web'])
})

test('a gathering’s page: the cover card at the web layer, the <h1> inside it; the type and the group line beneath', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ caller_role: null, group: GROUP_REF, cover: { source: 'upload', set_at: T1 } })),
  })
  renderAt('/gatherings/g-1')
  const heading = await screen.findByRole('heading', { level: 1, name: 'The Party' })
  expect(heading.closest('.cover-card')).toBe(coverCard())
  await waitFor(() => expect(cardImageSrc()).toMatch(/^blob:/))
  expect(screen.getByText('Potluck').closest('.cover-card')).toBeNull()
  expect(screen.getByRole('link', { name: 'The Lees' }).closest('p')?.textContent).toBe('In The Lees')
  expect(requests(mock, 'GET', /\/cover\/url/).map(([url]) => url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/gatherings/g-1/cover/url?layer=web',
  ])
})

test('the photos-only view shows the card too — the empty cover and its line where none is set, the cover where one is — and no Change cover', async () => {
  stubServer({ 'GET /gatherings/g-1': () => json(200, memoryGathering()) })
  const first = renderAt('/gatherings/g-1')
  const heading = await screen.findByRole('heading', { level: 1, name: 'The Party' })
  expect(within(coverCard()).getByText('No cover photo yet')).toBeTruthy()
  expect(heading.closest('.cover-card')).toBe(coverCard())
  expect(screen.queryByRole('button', { name: 'Change cover' })).toBeNull()
  first.unmount()

  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, memoryGathering({ cover: { source: 'photo', media_id: 'm-1', set_at: T1 } })),
  })
  renderAt('/gatherings/g-1')
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  await waitFor(() => expect(cardImageSrc()).toMatch(/^blob:/))
  expect(requests(mock, 'GET', '/gatherings/g-1/cover/url?layer=web')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Change cover' })).toBeNull()
})

// ---------------------------------------------------------------------------
// Change cover, by seat.
// ---------------------------------------------------------------------------

test('Change cover: a gathering’s host and co-host; never an invitee, an unknown role, or the photos-only view whatever role it carries', async () => {
  for (const [body, offered] of [
    [gathering({ caller_role: 'host' }), true],
    [gathering({ caller_role: 'co_host' }), true],
    [gathering({ caller_role: null }), false],
    [gathering({ caller_role: 'owner' }), false],
    [gathering({ caller_role: 'host', caller_view: 'everything' }), false],
    [memoryGathering({ caller_role: 'co_host' }), false],
  ] as const) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderAt('/gatherings/g-1')
    await screen.findByRole('heading', { level: 1, name: 'The Party' })
    expect(screen.queryByRole('button', { name: 'Change cover' }) !== null).toBe(offered)
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('Change cover: a group’s admin and co-admin; never a member or an unknown role', async () => {
  for (const [role, offered] of [
    ['admin', true],
    ['co_admin', true],
    ['member', false],
    ['owner', false],
  ] as const) {
    stubServer(groupPageRoutes(() => group({ caller_role: role })))
    const view = renderAt('/groups/grp-1')
    await screen.findByRole('heading', { level: 1, name: 'The Lees' })
    expect(screen.queryByRole('button', { name: 'Change cover' }) !== null).toBe(offered)
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('the panel: Change cover’s aria-expanded follows it over an inline panel beneath the card — Upload a picture, the hint, and Remove cover only while a cover is set', async () => {
  stubServer({ 'GET /gatherings/g-1': () => json(200, gathering()) })
  const view = renderAt('/gatherings/g-1')
  const change = await screen.findByRole('button', { name: 'Change cover' })
  expect(change.closest('.cover-card')).toBe(coverCard())
  expect(change.getAttribute('aria-expanded')).toBe('false')
  const panel = document.getElementById(change.getAttribute('aria-controls') ?? '')
  expect(panel?.hidden).toBe(true)
  expect(panel?.closest('.cover-card')).toBeNull()
  fireEvent.click(change)
  expect(change.getAttribute('aria-expanded')).toBe('true')
  expect(panel?.hidden).toBe(false)
  expect(within(panel as HTMLElement).getByRole('button', { name: 'Upload a picture' })).toBeTruthy()
  expect(within(panel as HTMLElement).getByText('Or open one of the photos and choose Use as cover.')).toBeTruthy()
  expect(within(panel as HTMLElement).queryByRole('button', { name: 'Remove cover' })).toBeNull()
  const input = panel?.querySelector('input[type="file"]') as HTMLInputElement
  expect(input.accept).toBe(PICKER_ACCEPT)
  expect(input.multiple).toBe(false)
  fireEvent.click(change)
  expect(change.getAttribute('aria-expanded')).toBe('false')
  expect(panel?.hidden).toBe(true)
  view.unmount()

  stubServer(groupPageRoutes(() => group({ cover: { source: 'photo', set_at: T1 } })))
  renderAt('/groups/grp-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  expect(screen.getByRole('button', { name: 'Remove cover' })).toBeTruthy()
  expect(
    screen.getByText("Or open a photo in one of the group's gatherings and choose Use as the group's cover."),
  ).toBeTruthy()
})

// ---------------------------------------------------------------------------
// Uploading a picture (fake timers, the CK-74 idiom).
// ---------------------------------------------------------------------------

test('THE UPLOAD: the intent body exactly {content_type, size_bytes} (a HEIC by its extension, the size from the File), the PUT with the signed type and no Authorization, the confirm, then a read every POLL_INTERVAL_MS — the old cover on the card until ready, then the gathering re-read and the menu told', async () => {
  vi.useFakeTimers()
  let detailCover: CoverBody = { source: 'photo', media_id: 'm-old', set_at: T1 }
  const statuses = ['processing', 'ready']
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ cover: detailCover })),
    'POST /gatherings/g-1/cover/upload': () =>
      json(201, {
        cover_image: { id: 'ci-1', status: 'pending_upload' },
        upload: { url: PUT_URL, method: 'PUT', headers: { 'Content-Length': '4', 'Content-Type': 'image/heic' }, expires_in: 900 },
      }),
    [`PUT bucket`]: () => new Response(null, { status: 200 }),
    'POST /cover-images/ci-1/confirm': () => json(200, { id: 'ci-1', status: 'uploaded', failure_reason: null }),
    'GET /cover-images/ci-1': () => {
      const status = statuses.shift() ?? 'ready'
      if (status === 'ready') detailCover = { source: 'upload', set_at: T2 }
      return json(200, { id: 'ci-1', status, failure_reason: null })
    },
  })
  const view = renderAt('/gatherings/g-1')
  await flush()
  expect(cardImageSrc()).toBe('blob:cover-1')

  fireEvent.click(screen.getByRole('button', { name: 'Change cover' }))
  const input = view.container.querySelector('.cover-panel input[type="file"]') as HTMLInputElement
  const file = new File(['heic'], 'IMG_2001.HEIC', { type: '' })
  fireEvent.change(input, { target: { files: [file] } })
  const status = within(view.container.querySelector('.cover-panel') as HTMLElement).getByRole('status')
  expect(status.textContent).toBe('Uploading your picture…')
  expect(screen.getByRole('button', { name: 'Upload a picture' })).toHaveProperty('disabled', true)

  await flush()
  const [intent] = requests(mock, 'POST', '/gatherings/g-1/cover/upload')
  expect(JSON.parse(String(intent[1]?.body))).toEqual({ content_type: 'image/heic', size_bytes: 4 })
  const puts = mock.mock.calls.filter(([url]) => String(url) === PUT_URL)
  expect(puts).toHaveLength(1)
  const putInit = puts[0][1] as RequestInit
  expect(putInit.method).toBe('PUT')
  expect(putInit.body).toBe(file)
  expect(new Headers(putInit.headers).get('Content-Type')).toBe('image/heic')
  expect(new Headers(putInit.headers).has('Authorization')).toBe(false)
  expect(requests(mock, 'POST', '/cover-images/ci-1/confirm')).toHaveLength(1)
  expect(status.textContent).toBe('Getting it ready…')
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(0)

  // The poll, at POLL_INTERVAL_MS — and the old cover still on the card.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  await flush()
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(1)
  expect(status.textContent).toBe('Getting it ready…')
  expect(cardImageSrc()).toBe('blob:cover-1')
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(1)
  expect(heard).toBe(0)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  })
  await flush()
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(2)
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(2)
  expect(heard).toBe(1)
  expect(cardImageSrc()).toBe('blob:cover-2')
  expect(revoked).toEqual(['blob:cover-1'])
  expect(status.textContent).toBe('')
  // Nothing more is read once it is ready.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(2)
  // No presigned URL in the markup, ever.
  expect(view.container.innerHTML).not.toMatch(/X-Amz|r2\.invalid/)
})

// The panel alone, for the matrix of endings: a page around it is not what
// these pins are about.
function renderPanel(over: { cover?: CoverBody | null } = {}) {
  const onChanged = vi.fn()
  const view = render(
    <main className="auth-screen">
      <PageCover
        subject="group"
        id="grp-1"
        cover={over.cover === undefined ? null : over.cover}
        organises
        hint="hint"
        photoRemovalSentence="The photo stays in its gathering. It just won't be the cover."
        onChanged={onChanged}
      >
        <h1>The Lees</h1>
      </PageCover>
    </main>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change cover' }))
  return { view, onChanged }
}

function choose(view: ReturnType<typeof render>, file = new File(['jpeg'], 'cover.jpg', { type: 'image/jpeg' })) {
  fireEvent.change(view.container.querySelector('.cover-panel input[type="file"]') as HTMLInputElement, {
    target: { files: [file] },
  })
}

function uploadRoutes(over: Record<string, Responder> = {}): Record<string, Responder> {
  return {
    'POST /groups/grp-1/cover/upload': () =>
      json(201, {
        cover_image: { id: 'ci-1', status: 'pending_upload' },
        upload: { url: PUT_URL, method: 'PUT', headers: { 'Content-Length': '4', 'Content-Type': 'image/jpeg' }, expires_in: 900 },
      }),
    'PUT bucket': () => new Response(null, { status: 200 }),
    'POST /cover-images/ci-1/confirm': () => json(200, { id: 'ci-1', status: 'uploaded', failure_reason: null }),
    ...over,
  }
}

const SUPERSEDED = "A newer cover was chosen while this one was uploading, so it won't be used."
const UNREADABLE = "That picture couldn't be opened. Try a different one."
const TOO_LARGE = 'That picture is too large. Try a smaller one.'
const DIDNT_FINISH = "The upload didn't finish. Try again."

test.each([
  ['the worker’s unreadable', { status: 'failed', failure_reason: 'unreadable' }, UNREADABLE],
  ['the worker’s too_large', { status: 'failed', failure_reason: 'too_large' }, TOO_LARGE],
  ['any other failure', { status: 'failed', failure_reason: 'interrupted' }, DIDNT_FINISH],
  ['destroying — a later act superseded it', { status: 'destroying', failure_reason: null }, SUPERSEDED],
  ['destroyed', { status: 'destroyed', failure_reason: null }, SUPERSEDED],
  ['a status this build does not know', { status: 'pending_upload', failure_reason: null }, DIDNT_FINISH],
])('an upload that ends %s reads its line, and the cover is untouched', async (_label, read, line) => {
  vi.useFakeTimers()
  const mock = stubServer(uploadRoutes({ 'GET /cover-images/ci-1': () => json(200, { id: 'ci-1', ...read }) }))
  const { view, onChanged } = renderPanel()
  choose(view)
  await flush()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  })
  await flush()
  expect(screen.getByRole('alert').textContent).toBe(line)
  expect(within(view.container.querySelector('.cover-panel') as HTMLElement).getByRole('status').textContent).toBe('')
  expect(onChanged).not.toHaveBeenCalled()
  expect(heard).toBe(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(1)
  // The button is live again: another picture can be chosen.
  expect(screen.getByRole('button', { name: 'Upload a picture' })).toHaveProperty('disabled', false)
})

test.each([
  ['the confirm’s 409 superseded', { 'POST /cover-images/ci-1/confirm': () => json(409, { detail: { code: 'superseded', message: "a newer cover was chosen after this upload started, so it won't be used" } }) }, SUPERSEDED],
  ['the intent’s 422 on size_bytes', { 'POST /groups/grp-1/cover/upload': () => json(422, { detail: [{ loc: ['body', 'size_bytes'], msg: 'each photo is limited to 25 MB', type: 'value_error' }] }) }, TOO_LARGE],
  ['the intent’s 422 on content_type', { 'POST /groups/grp-1/cover/upload': () => json(422, { detail: [{ loc: ['body', 'content_type'], msg: 'only photos can be uploaded', type: 'value_error' }] }) }, UNREADABLE],
  ['a refused PUT', { 'PUT bucket': () => new Response(null, { status: 403 }) }, DIDNT_FINISH],
  ['the confirm’s not_uploaded', { 'POST /cover-images/ci-1/confirm': () => json(409, { detail: { code: 'not_uploaded', message: "the upload hasn't arrived — send the picture to the upload URL first" } }) }, DIDNT_FINISH],
] as [string, Record<string, Responder>, string][])('an upload refused at %s reads its line — never the server’s words — and nothing is polled', async (_label, over, line) => {
  vi.useFakeTimers()
  const mock = stubServer(uploadRoutes(over))
  const { view } = renderPanel()
  choose(view)
  await flush()
  expect(screen.getByRole('alert').textContent).toBe(line)
  expect(view.container.textContent).not.toMatch(/limited to 25 MB|only photos can be uploaded|after this upload started|hasn't arrived/)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(0)
})

test('THE UPLOAD OUTLIVES ITS PAGE: unmounted mid-upload, the PUT and the confirm still go out — and nothing is polled', async () => {
  vi.useFakeTimers()
  const gate: { release?: () => void } = {}
  const mock = stubServer(
    uploadRoutes({
      'PUT bucket': async () => {
        await new Promise<void>((resolve) => (gate.release = resolve))
        return new Response(null, { status: 200 })
      },
      'GET /cover-images/ci-1': () => json(200, { id: 'ci-1', status: 'processing', failure_reason: null }),
    }),
  )
  const { view } = renderPanel()
  choose(view)
  await flush()
  expect(mock.mock.calls.filter(([url]) => String(url) === PUT_URL)).toHaveLength(1)
  view.unmount()
  await act(async () => {
    gate.release?.()
    await vi.advanceTimersByTimeAsync(0)
  })
  await flush()
  expect(requests(mock, 'POST', '/cover-images/ci-1/confirm')).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(0)
})

test('the polling stops on unmount', async () => {
  vi.useFakeTimers()
  const mock = stubServer(
    uploadRoutes({ 'GET /cover-images/ci-1': () => json(200, { id: 'ci-1', status: 'processing', failure_reason: null }) }),
  )
  const { view } = renderPanel()
  choose(view)
  await flush()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  })
  await flush()
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(1)
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
  })
  expect(requests(mock, 'GET', '/cover-images/ci-1')).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Remove cover.
// ---------------------------------------------------------------------------

test('Remove cover on a gathering’s page: the first click posts nothing, the uploaded picture’s sentence, Keep it does nothing; the confirm’s 204 re-reads the gathering, tells the menu and brings back the empty cover', async () => {
  let detailCover: CoverBody | null = { source: 'upload', set_at: T1 }
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ cover: detailCover })),
    'DELETE /gatherings/g-1/cover': () => {
      detailCover = null
      return new Response(null, { status: 204 })
    },
  })
  renderAt('/gatherings/g-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  await waitFor(() => expect(cardImageSrc()).toBe('blob:cover-1'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  expect(requests(mock, 'DELETE', /cover/)).toHaveLength(0)
  const step = screen.getByRole('group', { name: 'Remove cover' })
  expect(within(step).getByText('The picture will be deleted. The empty cover shows until someone chooses another.')).toBeTruthy()
  fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
  expect(screen.queryByRole('group', { name: 'Remove cover' })).toBeNull()
  expect(requests(mock, 'DELETE', /cover/)).toHaveLength(0)
  expect(cardImageSrc()).toBe('blob:cover-1')

  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Remove cover' })).getByRole('button', { name: 'Remove cover' }))
  await waitFor(() => expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(2))
  expect(requests(mock, 'DELETE', '/gatherings/g-1/cover')).toHaveLength(1)
  expect(await within(coverCard()).findByText('No cover photo yet')).toBeTruthy()
  expect(heard).toBe(1)
  expect(revoked).toEqual(['blob:cover-1'])
  // No cover now: no Remove cover.
  expect(screen.queryByRole('button', { name: 'Remove cover' })).toBeNull()
})

test('Remove cover’s sentence for a photograph: the gathering’s title on its page, “its gathering” on a group’s — whose page names no photograph', async () => {
  stubServer({ 'GET /gatherings/g-1': () => json(200, gathering({ cover: { source: 'photo', media_id: 'm-1', set_at: T1 } })) })
  const first = renderAt('/gatherings/g-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  expect(screen.getByText("The photo stays in The Party. It just won't be the cover.")).toBeTruthy()
  first.unmount()

  stubServer(groupPageRoutes(() => group({ cover: { source: 'photo', set_at: T1 } })))
  const second = renderAt('/groups/grp-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  expect(screen.getByText("The photo stays in its gathering. It just won't be the cover.")).toBeTruthy()
  expect(second.container.innerHTML).not.toMatch(/m-1|media/)
})

test('on a group’s page Remove cover’s step is one of the page’s steps: opening it closes a member’s step, and opening a member’s step closes it', async () => {
  const mock = stubServer(groupPageRoutes(() => group({ cover: { source: 'upload', set_at: T1 } })))
  renderAt('/groups/grp-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  const calRow = (await screen.findAllByRole('listitem')).find((li) => li.querySelector('.member-name')?.textContent === 'Cal Test') as HTMLElement
  fireEvent.click(within(calRow).getByRole('button', { name: 'Remove from group' }))
  expect(screen.getByRole('group', { name: 'Remove Cal Test from the group' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  expect(screen.getByRole('group', { name: 'Remove cover' })).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Remove Cal Test from the group' })).toBeNull()
  fireEvent.click(within(calRow).getByRole('button', { name: 'Remove from group' }))
  expect(screen.queryByRole('group', { name: 'Remove cover' })).toBeNull()
  expect(requests(mock, 'DELETE', /./)).toHaveLength(0)
})

test('a refused Remove cover reads the house line, and nothing is re-read', async () => {
  const mock = stubServer(
    groupPageRoutes(() => group({ cover: { source: 'upload', set_at: T1 } }), {
      'DELETE /groups/grp-1/cover': () => json(404, { detail: 'Not found.' }),
    }),
  )
  renderAt('/groups/grp-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Change cover' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Remove cover' })).getByRole('button', { name: 'Remove cover' }))
  expect(await screen.findByText('Something went wrong. Nothing changed — try again.')).toBeTruthy()
  expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(1)
  expect(heard).toBe(0)
})

// ---------------------------------------------------------------------------
// The opened photo.
// ---------------------------------------------------------------------------

async function openPhotos() {
  fireEvent.click(await screen.findByRole('button', { name: /^Show photos/ }))
  await screen.findByRole('list', { name: 'Photos' })
}

function openPhoto(name: RegExp | string) {
  const buttons = screen.getAllByRole('button', { name: typeof name === 'string' ? `Open photo added by ${name}` : name })
  fireEvent.click(buttons[0])
  return screen.getByRole('dialog')
}

test('Use as cover: the organisers’ ONE click on a published photo — the PUT names the photo alone, the card draws the answer, the menu is told, and the button goes on the photo that is now the cover', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ caller_role: 'co_host' })),
    'GET /gatherings/g-1/media': () => json(200, { media: [photo()] }),
    'PUT /gatherings/g-1/cover': () => json(200, { cover: { source: 'photo', media_id: 'm-1', set_at: T2 } }),
  })
  renderAt('/gatherings/g-1')
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  expect(within(coverCard()).getByText('No cover photo yet')).toBeTruthy()
  await openPhotos()
  const viewer = openPhoto('Bea Test')
  fireEvent.click(within(viewer).getByRole('button', { name: 'Use as cover' }))
  await waitFor(() => expect(requests(mock, 'PUT', '/gatherings/g-1/cover')).toHaveLength(1))
  expect(JSON.parse(String(requests(mock, 'PUT', '/gatherings/g-1/cover')[0][1]?.body))).toEqual({ media_id: 'm-1' })
  await waitFor(() => expect(cardImageSrc()).toMatch(/^blob:/))
  expect(requests(mock, 'GET', '/gatherings/g-1/cover/url?layer=web')).toHaveLength(1)
  expect(heard).toBe(1)
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Use as cover' })).toBeNull()
  // From the PUT's answer, not a re-read; and no group on a standalone gathering.
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(1)
  expect(requests(mock, 'GET', /^\/groups\//)).toHaveLength(0)
})

test('Use as cover is hidden on the photo that already is the cover, and offered on another; never to a gathering’s invitee', async () => {
  stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ cover: { source: 'photo', media_id: 'm-1', set_at: T1 } })),
    'GET /gatherings/g-1/media': () =>
      json(200, { media: [photo(), photo({ id: 'm-5', uploader_display_name: 'Cal Test', filename: 'cake.jpg' })] }),
  })
  const view = renderAt('/gatherings/g-1')
  await openPhotos()
  expect(within(openPhoto('Bea Test')).queryByRole('button', { name: 'Use as cover' })).toBeNull()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  expect(within(openPhoto('Cal Test')).getByRole('button', { name: 'Use as cover' })).toBeTruthy()
  view.unmount()

  stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ caller_role: null })),
    'GET /gatherings/g-1/media': () => json(200, { media: [photo()] }),
  })
  renderAt('/gatherings/g-1')
  await openPhotos()
  expect(within(openPhoto('Bea Test')).queryByRole('button', { name: 'Use as cover' })).toBeNull()
})

test('neither button on a photo that is not published — waiting, in a bin — and none on a failed one, which never opens', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ group: GROUP_REF })),
    'GET /gatherings/g-1/places': () => json(500, {}),
    'GET /groups/grp-1': () => json(200, group({ caller_role: 'admin' })),
    'GET /gatherings/g-1/media': () =>
      json(200, {
        media: [
          photo({ id: 'm-p', publication_state: 'pending', uploader_display_name: 'Pat Test', published_at: null }),
          photo({ id: 'm-r', publication_state: 'removed', is_own: true, removed_at: new Date().toISOString() }),
          photo({ id: 'm-f', status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'unreadable', uploader_display_name: 'Ada Test' }),
        ],
      }),
  })
  renderAt('/gatherings/g-1')
  await openPhotos()
  await waitFor(() => expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(1))
  for (const who of ['Pat Test', 'You']) {
    const viewer = openPhoto(who)
    expect(within(viewer).queryByRole('button', { name: 'Use as cover' })).toBeNull()
    expect(within(viewer).queryByRole('button', { name: "Use as the group's cover" })).toBeNull()
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  }
  // The failed row offers no way to open it at all.
  expect(screen.getAllByRole('button', { name: /^Open photo added by/ })).toHaveLength(2)
})

test('Use as the group’s cover: the group read ONCE, when the photos open, on a group’s gathering; for its admin — the step naming the group and the gathering, its first click posting nothing, Not now inert, the confirm’s PUT, “{group}’s cover is set.” and the menu told', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ caller_role: null, group: GROUP_REF })),
    'GET /groups/grp-1': () => json(200, group({ caller_role: 'admin' })),
    'GET /gatherings/g-1/media': () => json(200, { media: [photo(), photo({ id: 'm-5', uploader_display_name: 'Cal Test' })] }),
    'PUT /groups/grp-1/cover': () => json(200, { cover: { source: 'photo', set_at: T2 } }),
  })
  renderAt('/gatherings/g-1')
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(0)
  await openPhotos()
  const viewer = openPhoto('Bea Test')
  // An invitee of the gathering: no Use as cover — the group's button alone.
  expect(within(viewer).queryByRole('button', { name: 'Use as cover' })).toBeNull()
  const ask = await within(viewer).findByRole('button', { name: "Use as the group's cover" })
  fireEvent.click(ask)
  const step = within(viewer).getByRole('group', { name: "Use as the group's cover" })
  expect(
    within(step).getByText(
      "Everyone in The Lees will see this photo as the group's cover, including people who can't see The Party.",
    ),
  ).toBeTruthy()
  expect(requests(mock, 'PUT', /cover/)).toHaveLength(0)
  fireEvent.click(within(step).getByRole('button', { name: 'Not now' }))
  expect(within(viewer).queryByRole('group', { name: "Use as the group's cover" })).toBeNull()
  expect(requests(mock, 'PUT', /cover/)).toHaveLength(0)

  fireEvent.click(within(viewer).getByRole('button', { name: "Use as the group's cover" }))
  fireEvent.click(
    within(within(viewer).getByRole('group', { name: "Use as the group's cover" })).getByRole('button', {
      name: "Use as the group's cover",
    }),
  )
  expect(await within(viewer).findByText("The Lees's cover is set.")).toBeTruthy()
  expect(within(viewer).getByRole('status').textContent).toBe("The Lees's cover is set.")
  expect(JSON.parse(String(requests(mock, 'PUT', '/groups/grp-1/cover')[0][1]?.body))).toEqual({ media_id: 'm-1' })
  expect(within(viewer).queryByRole('group', { name: "Use as the group's cover" })).toBeNull()
  expect(heard).toBe(1)
  // The gathering's own cover did not move, and nothing was re-read.
  expect(within(coverCard()).getByText('No cover photo yet')).toBeTruthy()
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(1)
  // Another photo opened: the group is not read again.
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
  openPhoto('Cal Test')
  expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(1)
})

test('Use as the group’s cover is the group’s admin’s and co-admins’ alone — a member, an unknown role and a failed read get none — and a photos-only member who runs the group gets it', async () => {
  for (const [groupAnswer, detail, offered] of [
    [() => json(200, group({ caller_role: 'co_admin' })), gathering({ group: GROUP_REF }), true],
    [() => json(200, group({ caller_role: 'member' })), gathering({ group: GROUP_REF }), false],
    [() => json(200, group({ caller_role: 'owner' })), gathering({ group: GROUP_REF }), false],
    [() => json(404, { detail: 'Not found.' }), gathering({ group: GROUP_REF }), false],
    [() => json(200, group({ caller_role: 'admin' })), memoryGathering(), true],
  ] as [() => Response, ReturnType<typeof gathering>, boolean][]) {
    const mock = stubServer({
      'GET /gatherings/g-1': () => json(200, detail),
      'GET /gatherings/g-1/places': () => json(500, {}),
      'GET /groups/grp-1': groupAnswer,
      'GET /gatherings/g-1/media': () => json(200, { media: [photo()] }),
    })
    const view = renderAt('/gatherings/g-1')
    await openPhotos()
    await waitFor(() => expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const viewer = openPhoto('Bea Test')
    expect(within(viewer).queryByRole('button', { name: "Use as the group's cover" }) !== null).toBe(offered)
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('a refused Use as cover, or Use as the group’s cover, reads the house line in the viewer, and nothing is re-read', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, gathering({ group: GROUP_REF })),
    'GET /gatherings/g-1/places': () => json(500, {}),
    'GET /groups/grp-1': () => json(200, group({ caller_role: 'admin' })),
    'GET /gatherings/g-1/media': () => json(200, { media: [photo()] }),
    'PUT /gatherings/g-1/cover': () =>
      json(409, { detail: { code: 'not_published', status: 'ready', publication_state: 'removed', message: 'this photo is not published' } }),
    'PUT /groups/grp-1/cover': () => json(422, { detail: [{ loc: ['body', 'media_id'], msg: 'not in this group', type: 'value_error', code: 'not_in_group' }] }),
  })
  renderAt('/gatherings/g-1')
  await openPhotos()
  await waitFor(() => expect(requests(mock, 'GET', '/groups/grp-1')).toHaveLength(1))
  const viewer = openPhoto('Bea Test')
  const listReads = requests(mock, 'GET', /^\/gatherings\/g-1\/media/).length
  fireEvent.click(within(viewer).getByRole('button', { name: 'Use as cover' }))
  expect(await within(viewer).findByRole('alert')).toHaveProperty('textContent', 'Something went wrong. Nothing changed — try again.')
  expect(viewer.textContent).not.toMatch(/not published|not in this group/)

  fireEvent.click(await within(viewer).findByRole('button', { name: "Use as the group's cover" }))
  expect(within(viewer).queryByRole('alert')).toBeNull()
  fireEvent.click(
    within(within(viewer).getByRole('group', { name: "Use as the group's cover" })).getByRole('button', {
      name: "Use as the group's cover",
    }),
  )
  await waitFor(() => expect(requests(mock, 'PUT', '/groups/grp-1/cover')).toHaveLength(1))
  expect(await within(viewer).findByRole('alert')).toHaveProperty('textContent', 'Something went wrong. Nothing changed — try again.')
  expect(within(viewer).getByRole('status').textContent).toBe('')
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(1)
  expect(requests(mock, 'GET', /^\/gatherings\/g-1\/media/)).toHaveLength(listReads)
  expect(heard).toBe(0)
})
