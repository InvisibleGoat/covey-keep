// CK-87 pins on /gatherings/:id in the mockup's layout (its screens 08 and
// 09, `gatheringPage()`; decisions/2026-10-31-the-design-and-how-it-is-merged.md
// §3 item 7; Steven's four answers of 2026-11-01). The values under test:
// - THE HEAD: the crumb — the group by name to its page, or *Gatherings* to
//   the list — in both views; the wide cover card at the web layer with the
//   <h1>, the type and the decedent line inside it; the date badge on the
//   soonest date still ahead, in the profile's zone, and never once every
//   date has started or in the photos-only view; no group line, no *Back to
//   your gatherings*, no *Hosted by*, no Chat.
// - THE ACTIONS: Add photos for the invited tier — one press clicks the file
//   input SYNCHRONOUSLY, the section closed beforehand; the chosen files in
//   the form; focus to Upload; Upload through today's calls — and Edit
//   gathering for the organisers over today's form; no row in the
//   photos-only view.
// - WHEN: each date's line naming its weekday as literals (CK-87.1); each
//   date's chip from the body's `caller_response` as literals;
//   the chip following an answer saved in the block without the gathering
//   read again; the place and the map on one line, each half alone, an
//   unsafe map as text; the row's order; the organisers' date controls with
//   today's steps; the RSVP block opening beneath the row.
// - The photos-only view reading no date and no answer; the order of the
//   page's cards by seat; the page column; the new styles naming no colour.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import appCss from '../App.css?raw'
import { wallClockToInstant } from '../lib/datetime'
import gatheringsLibSource from '../lib/gatherings.ts?raw'
import tokensCss from '../styles/tokens.css?raw'
import { GatheringDetail } from './GatheringDetail'

// A profile zone guaranteed to differ from the runner's: a date read in the
// wrong zone shows only when the zones differ (the CK-17 rule).
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONE = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'

const person: Person = {
  id: 'person-viewer-0000',
  display_name: 'Ada Test',
  email: 'ada@example.com',
  timezone: ZONE,
  account_id: 'acct-viewer-0000',
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

let objectUrls = 0
beforeEach(() => {
  objectUrls = 0
  Object.assign(URL, { createObjectURL: () => `blob:page-${++objectUrls}`, revokeObjectURL: () => {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const HOUR = 60 * 60 * 1000
const GROUP = { id: 'grp-lees-1', name: 'The Lees' }

// 03:30 UTC on 10 March 2035 is the 10th in Kiritimati (UTC+14) and the 9th
// in Honolulu (UTC-10): the badge's day says which zone it was read in.
const SOONEST = '2035-03-10T03:30:00+00:00'
const SOONEST_DAY = ZONE === 'Pacific/Kiritimati' ? '10' : '9'
const LATER = '2035-04-20T03:30:00+00:00'

function occurrence(over: Record<string, unknown> = {}) {
  return {
    id: 'occ-1',
    gathering_id: 'g-1',
    starts_at: SOONEST,
    ends_at: null,
    location: null,
    map_url: null,
    caller_response: null,
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'The Party',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-a',
    host_account_id: 'acct-a',
    caller_role: 'host',
    caller_view: 'full',
    group: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    occurrences: [occurrence()],
    ...over,
  }
}

// The memory body (CK-77): the dates and the RSVP setting withheld — NULL —
// and no role.
function memoryDetail(over: Record<string, unknown> = {}) {
  return detail({
    caller_role: null,
    caller_view: 'memory',
    rsvp_list_visibility: null,
    occurrences: null,
    group: GROUP,
    ...over,
  })
}

type Responder = (init: RequestInit | undefined, path: string) => Response

function stubServer(routes: Record<string, Responder> = {}) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const raw = String(url)
    if (raw.startsWith('https://r2.invalid/')) {
      return Promise.resolve(new Response(method === 'PUT' ? null : new Uint8Array([1, 2, 3]), { status: 200 }))
    }
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    const own = routes[`${method} ${path}`]
    if (own) return Promise.resolve(own(init, path))
    if (method === 'GET' && path === '/gatherings/g-1') return Promise.resolve(json(200, detail()))
    if (method === 'GET' && path.startsWith('/gatherings/g-1/media')) return Promise.resolve(json(200, { media: [] }))
    if (method === 'GET' && path.startsWith('/occurrences/') && path.endsWith('/rsvps')) {
      return Promise.resolve(json(200, { visibility: 'INVITEES', own: null, rsvps: [] }))
    }
    if (method === 'GET' && path === '/gatherings/g-1/places') {
      return Promise.resolve(json(200, { invitees_chosen: true, members: [] }))
    }
    if (method === 'GET' && path === '/gatherings/g-1/cover/url?layer=web') {
      return Promise.resolve(json(200, { url: 'https://r2.invalid/covers/c-1/web?X-Amz-Signature=sig', method: 'GET' }))
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function requests(mock: ReturnType<typeof vi.fn>, method: string, match: RegExp | string) {
  return mock.mock.calls.filter(([url, init]) => {
    const m = (init as RequestInit | undefined)?.method ?? 'GET'
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    return m === method && (typeof match === 'string' ? path === match : match.test(path))
  }) as unknown as [string, RequestInit | undefined][]
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/gatherings/:id" element={<GatheringDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'The Party' })
}

function coverCard(): HTMLElement {
  const card = document.querySelector('.cover-card')
  if (!(card instanceof HTMLElement)) throw new Error('no cover card')
  return card
}

function whenSection(): HTMLElement {
  return screen.getByRole('region', { name: 'When' })
}

function dateItems(): HTMLElement[] {
  return within(whenSection()).getAllByRole('listitem')
}

function rowOf(item: HTMLElement): HTMLElement {
  const row = item.querySelector('.occurrence-row')
  if (!(row instanceof HTMLElement)) throw new Error('no row')
  return row
}

// ---------------------------------------------------------------------------
// The head.
// ---------------------------------------------------------------------------

test('the crumb: a group’s gathering names its group and goes to its page; a standalone one says Gatherings and goes to the list — in both views', async () => {
  for (const body of [detail({ group: GROUP }), memoryDetail()]) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderPage()
    await loaded()
    const crumb = view.container.querySelector('.crumb') as HTMLElement
    const link = within(crumb).getByRole('link')
    expect(link.textContent).toBe('The Lees')
    expect(link.getAttribute('href')).toBe('/groups/grp-lees-1')
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    // The crumb comes first on the page.
    expect(view.container.querySelector('main')?.firstElementChild).toBe(crumb)
    view.unmount()
  }
  for (const body of [detail(), memoryDetail({ group: null })]) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderPage()
    await loaded()
    const link = within(view.container.querySelector('.crumb') as HTMLElement).getByRole('link')
    expect(link.textContent).toBe('Gatherings')
    expect(link.getAttribute('href')).toBe('/gatherings')
    view.unmount()
  }
})

test('the wide cover card holds the <h1> and the type over the scrim, and for a memorial the decedent line too', async () => {
  stubServer()
  const first = renderPage()
  const heading = await loaded()
  expect(coverCard().classList.contains('cover-card-wide')).toBe(true)
  const over = coverCard().querySelector('.cover-over') as HTMLElement
  expect(over.contains(heading)).toBe(true)
  const meta = within(over).getByText('Potluck')
  expect(meta.classList.contains('cover-card-meta')).toBe(true)
  expect(screen.queryByText(/^In memory of/)).toBeNull()
  first.unmount()

  stubServer({
    'GET /gatherings/g-1': () =>
      json(200, detail({ gathering_type: 'memorial', memorial_decedent_name: 'June Lee' })),
  })
  renderPage()
  await loaded()
  const memorialOver = coverCard().querySelector('.cover-over') as HTMLElement
  expect(within(memorialOver).getByText('Memorial').classList.contains('cover-card-meta')).toBe(true)
  const decedent = within(memorialOver).getByText('In memory of June Lee')
  expect(decedent.classList.contains('cover-card-meta')).toBe(true)
  // Beneath the type, and nowhere outside the card.
  expect(decedent.previousElementSibling?.textContent).toBe('Memorial')
  expect(screen.getAllByText('In memory of June Lee')).toHaveLength(1)
})

test('the wide card asks for the web layer alone, into a blob: URL', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () => json(200, detail({ cover: { source: 'upload', set_at: '2026-11-01T10:00:00+00:00' } })),
  })
  renderPage()
  await loaded()
  await waitFor(() => expect(coverCard().querySelector('.cover-photo > img')?.getAttribute('src')).toMatch(/^blob:/))
  expect(requests(mock, 'GET', /\/cover\/url/).map(([url]) => url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/gatherings/g-1/cover/url?layer=web',
  ])
  expect(document.body.innerHTML).not.toMatch(/X-Amz/)
})

test('THE BADGE: the soonest date still ahead, read in the profile’s zone — never a date that has started, never a later one', async () => {
  stubServer({
    'GET /gatherings/g-1': () =>
      json(
        200,
        detail({
          occurrences: [
            // Started an hour ago and not yet over: a date in progress reads
            // as past (the one rule's meaning).
            occurrence({
              id: 'occ-now',
              starts_at: new Date(Date.now() - HOUR).toISOString(),
              ends_at: new Date(Date.now() + HOUR).toISOString(),
            }),
            occurrence({ id: 'occ-later', starts_at: LATER }),
            occurrence({ id: 'occ-soonest', starts_at: SOONEST }),
          ],
        }),
      ),
  })
  renderPage()
  await loaded()
  // MOVED AT CK-87.1, with its reason: this gathering has no cover, and on
  // an empty cover the badge leads the empty cover's row (`.cover-lead`) in
  // the same corner, where it was the picture's own child laid over the
  // corner. Over a cover it still is (components/cover.test.tsx). What the
  // pin holds is unchanged: one badge, decorative, on the soonest date ahead
  // in the profile's zone.
  const badge = coverCard().querySelector('.cover-photo > .cover-lead > .cover-date') as HTMLElement
  expect(badge.getAttribute('aria-hidden')).toBe('true')
  expect(badge.querySelector('.cover-date-m')?.textContent).toBe('Mar')
  expect(badge.querySelector('.cover-date-d')?.textContent).toBe(SOONEST_DAY)
  expect(document.querySelectorAll('.cover-date')).toHaveLength(1)
})

test('no badge once every date has started — a date in progress included — and none in the photos-only view, which has no dates', async () => {
  stubServer({
    'GET /gatherings/g-1': () =>
      json(
        200,
        detail({
          occurrences: [
            occurrence({ id: 'occ-past', starts_at: '2026-01-01T18:00:00+00:00' }),
            occurrence({
              id: 'occ-now',
              starts_at: new Date(Date.now() - HOUR).toISOString(),
              ends_at: new Date(Date.now() + HOUR).toISOString(),
            }),
          ],
        }),
      ),
  })
  const first = renderPage()
  await loaded()
  expect(document.querySelector('.cover-date')).toBeNull()
  first.unmount()

  stubServer({ 'GET /gatherings/g-1': () => json(200, memoryDetail()) })
  renderPage()
  await loaded()
  expect(document.querySelector('.cover-date')).toBeNull()
})

test('no group line, no Back to your gatherings, no Hosted by and no Chat — in either view', async () => {
  for (const body of [detail({ group: GROUP }), detail(), memoryDetail()]) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderPage()
    await loaded()
    expect(screen.queryByText(/^In The Lees$/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Back to your gatherings' })).toBeNull()
    expect(view.container.textContent).not.toMatch(/Hosted by/)
    expect(screen.queryByRole('button', { name: /^chat$/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /^chat$/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^chat$/i })).toBeNull()
    view.unmount()
  }
})

// ---------------------------------------------------------------------------
// The actions.
// ---------------------------------------------------------------------------

test('Add photos for the invited tier — the host, a co-host, an invitee — and no actions row in the photos-only view', async () => {
  for (const role of ['host', 'co_host', null]) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, detail({ caller_role: role })) })
    const view = renderPage()
    await loaded()
    const actions = view.container.querySelector('.gathering-actions') as HTMLElement
    const add = within(actions).getByRole('button', { name: 'Add photos' })
    expect(add.classList.contains('btn-primary')).toBe(true)
    expect(add.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    // Beneath the cover — Change cover's panel, an organiser's, between them.
    const before = actions.previousElementSibling as HTMLElement
    expect(before.classList.contains('cover-panel') ? before.previousElementSibling : before).toBe(coverCard())
    expect(before.classList.contains('cover-panel')).toBe(role !== null)
    view.unmount()
  }
  stubServer({ 'GET /gatherings/g-1': () => json(200, memoryDetail({ caller_role: 'host' })) })
  const view = renderPage()
  await loaded()
  expect(view.container.querySelector('.gathering-actions')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull()
  expect(screen.queryByRole('button', { name: /edit gathering/i })).toBeNull()
})

test('ONE PRESS: Add photos clicks the file input synchronously — the section open from the start — the chosen files wait in the form, focus moves to Upload, and Upload sends them through today’s calls', async () => {
  let listed: unknown[] = []
  const mock = stubServer({
    'GET /gatherings/g-1/media': () => json(200, { media: listed }),
    'POST /gatherings/g-1/media/intents': () =>
      json(201, {
        intents: [
          {
            media: { id: 'm-new', status: 'pending_upload' },
            upload: {
              url: 'https://r2.invalid/quarantine/uploads/m-new?X-Amz-Signature=putsig',
              method: 'PUT',
              headers: { 'Content-Length': '3', 'Content-Type': 'image/jpeg' },
              expires_in: 900,
            },
          },
        ],
      }),
    'POST /media/m-new/confirm': () => {
      listed = []
      return json(200, { id: 'm-new', status: 'uploaded' })
    },
  })
  const scrolled: Element[] = []
  Object.assign(Element.prototype, {
    scrollIntoView(this: Element) {
      scrolled.push(this)
    },
  })
  const clicks: { input: HTMLInputElement; connected: boolean }[] = []
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    clicks.push({ input: this, connected: this.isConnected })
  })

  const view = renderPage()
  await loaded()
  // CK-88: the section is open from the start — no toggle, and its one file
  // input already rendered (until CK-88 the press opened a closed section).
  expect(screen.queryByRole('button', { name: /^show photos/i })).toBeNull()
  expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Add photos' }))
  // Synchronously — nothing awaited between the press and the click.
  expect(clicks).toHaveLength(1)
  expect(clicks[0].connected).toBe(true)
  expect(clicks[0].input.type).toBe('file')
  expect(clicks[0].input.id).toBe('media-files')

  const file = new File([new Uint8Array([1, 2, 3])], 'cake.jpg', { type: 'image/jpeg' })
  fireEvent.change(screen.getByLabelText(/^add photos$/i), { target: { files: [file] } })
  expect(within(screen.getByRole('list', { name: 'Chosen files' })).getByText('cake.jpg')).toBeTruthy()
  const upload = screen.getByRole('button', { name: /^upload$/i })
  await waitFor(() => expect(document.activeElement).toBe(upload))
  expect(scrolled).toContain(screen.getByRole('region', { name: 'Photos' }))

  fireEvent.click(upload)
  await waitFor(() => expect(requests(mock, 'POST', '/media/m-new/confirm')).toHaveLength(1))
  const [, intent] = requests(mock, 'POST', '/gatherings/g-1/media/intents')[0]
  expect(JSON.parse(String(intent?.body))).toEqual({
    items: [{ content_type: 'image/jpeg', size_bytes: 3, filename: 'cake.jpg' }],
  })
  expect(mock.mock.calls.filter(([url, init]) => String(url).startsWith('https://r2.invalid/quarantine') && init?.method === 'PUT')).toHaveLength(1)
})

test('a choice made in the form itself moves nothing — focus stays where the person left it, as before', async () => {
  stubServer()
  const scrolled: Element[] = []
  Object.assign(Element.prototype, {
    scrollIntoView(this: Element) {
      scrolled.push(this)
    },
  })
  renderPage()
  await loaded()
  // CK-88: no toggle to press — the section is open from the start.
  const input = await screen.findByLabelText(/^add photos$/i)
  input.focus()
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })] } })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(document.activeElement).toBe(input)
  expect(scrolled).toEqual([])
})

test('Edit gathering for the organisers alone, opening today’s form beneath the actions; a second press or Cancel closes it', async () => {
  for (const [role, offered] of [
    ['host', true],
    ['co_host', true],
    [null, false],
  ] as const) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, detail({ caller_role: role })) })
    const view = renderPage()
    await loaded()
    expect(screen.queryByRole('button', { name: 'Edit gathering' }) !== null).toBe(offered)
    view.unmount()
  }
  stubServer()
  const view = renderPage()
  await loaded()
  const edit = screen.getByRole('button', { name: 'Edit gathering' })
  expect(edit.classList.contains('btn')).toBe(true)
  expect(edit.classList.contains('btn-primary')).toBe(false)
  expect(edit.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(edit)
  const form = screen.getByRole('form', { name: 'Edit gathering' })
  expect(edit.getAttribute('aria-expanded')).toBe('true')
  expect(edit.getAttribute('aria-controls')).toBe(form.id)
  // Today's form: its fields, the host's switch, Save and Cancel.
  expect((within(form).getByLabelText('Title') as HTMLInputElement).value).toBe('The Party')
  expect(within(form).getByLabelText('Who can see the RSVP list')).toBeTruthy()
  expect(within(form).getByLabelText(/review photos before they're published/i)).toBeTruthy()
  expect(within(form).getByRole('button', { name: 'Save' })).toBeTruthy()
  // Beneath the actions row.
  expect(form.previousElementSibling).toBe(view.container.querySelector('.gathering-actions'))
  fireEvent.click(edit)
  expect(screen.queryByRole('form', { name: 'Edit gathering' })).toBeNull()
  fireEvent.click(edit)
  fireEvent.click(within(screen.getByRole('form', { name: 'Edit gathering' })).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('form', { name: 'Edit gathering' })).toBeNull()
  expect(edit.getAttribute('aria-expanded')).toBe('false')
})

// ---------------------------------------------------------------------------
// When.
// ---------------------------------------------------------------------------

test('each date’s chip, as literals: Going, Maybe, Can’t make it, and Not answered in the dashed chip — text in the row, never the button’s name', async () => {
  stubServer({
    'GET /gatherings/g-1': () =>
      json(
        200,
        detail({
          caller_role: null,
          occurrences: [
            occurrence({ id: 'occ-a', starts_at: '2035-03-10T03:30:00+00:00', caller_response: 'yes' }),
            occurrence({ id: 'occ-b', starts_at: '2035-03-17T03:30:00+00:00', caller_response: 'maybe' }),
            occurrence({ id: 'occ-c', starts_at: '2035-03-24T03:30:00+00:00', caller_response: 'no' }),
            occurrence({ id: 'occ-d', starts_at: '2035-03-31T03:30:00+00:00', caller_response: null }),
            occurrence({ id: 'occ-e', starts_at: '2035-04-07T03:30:00+00:00' }),
          ],
        }),
      ),
  })
  renderPage()
  await loaded()
  const chips = dateItems().map((item) => {
    const chip = rowOf(item).querySelector('.answer') as HTMLElement
    return [chip.textContent, chip.classList.contains('answer-none')]
  })
  expect(chips).toEqual([
    ['Going', false],
    ['Maybe', false],
    ["Can't make it", false],
    ['Not answered', true],
    ['Not answered', true],
  ])
  for (const item of dateItems()) {
    const button = within(rowOf(item)).getByRole('button', { name: "RSVP and who's coming" })
    expect(button.textContent).toBe("RSVP and who's coming")
    expect(button.contains(rowOf(item).querySelector('.answer'))).toBe(false)
  }
})

test('THE CHIP FOLLOWS A SAVED ANSWER without the gathering read again: Not answered, then Going', async () => {
  let own: unknown = null
  const mock = stubServer({
    'GET /occurrences/occ-1/rsvps': () => json(200, { visibility: 'INVITEES', own, rsvps: [] }),
    'PUT /occurrences/occ-1/rsvp': (init) => {
      const body = JSON.parse(String(init?.body)) as { response: string }
      own = { response: body.response, stay_included: false, companions: [], arrival_time: null }
      return json(200, own)
    },
  })
  renderPage()
  await loaded()
  const chip = () => rowOf(dateItems()[0]).querySelector('.answer') as HTMLElement
  expect(chip().textContent).toBe('Not answered')
  fireEvent.click(screen.getByRole('button', { name: "RSVP and who's coming" }))
  await screen.findByText("You haven't answered yet.")
  fireEvent.click(screen.getByLabelText('Going'))
  fireEvent.click(screen.getByRole('button', { name: 'Send RSVP' }))
  await waitFor(() => expect(chip().textContent).toBe('Going'))
  expect(chip().classList.contains('answer-none')).toBe(false)
  await screen.findByRole('button', { name: 'Update RSVP' })
  expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(1)
})

test("When's date line names its weekday, in the profile's zone, as literals: the same day, across midnight, and with no end (CK-87.1)", async () => {
  const at = (wallClock: string) => wallClockToInstant(wallClock, ZONE)
  stubServer({
    'GET /gatherings/g-1': () =>
      json(
        200,
        detail({
          occurrences: [
            occurrence({ id: 'o1', starts_at: at('2026-07-04T16:00'), ends_at: at('2026-07-04T23:00') }),
            occurrence({ id: 'o2', starts_at: at('2026-07-04T22:00'), ends_at: at('2026-07-05T01:00') }),
            occurrence({ id: 'o3', starts_at: at('2026-07-05T16:00') }),
          ],
        }),
      ),
  })
  renderPage()
  await loaded()
  expect(dateItems().map((item) => item.querySelector('.occurrence-when')?.textContent)).toEqual([
    'Sat, Jul 4, 2026, 4:00 PM – 11:00 PM',
    'Sat, Jul 4, 2026, 10:00 PM – Sun, Jul 5, 1:00 AM',
    'Sun, Jul 5, 2026, 4:00 PM',
  ])
})

test('the place and the map on one line: place · Map, the map alone, the place alone, an unsafe map as text, neither', async () => {
  stubServer({
    'GET /gatherings/g-1': () =>
      json(
        200,
        detail({
          occurrences: [
            occurrence({ id: 'o1', starts_at: '2035-03-10T03:30:00+00:00', location: 'The hall', map_url: 'https://maps.example/hall' }),
            occurrence({ id: 'o2', starts_at: '2035-03-11T03:30:00+00:00', map_url: 'https://maps.example/park' }),
            occurrence({ id: 'o3', starts_at: '2035-03-12T03:30:00+00:00', location: 'The park' }),
            occurrence({ id: 'o4', starts_at: '2035-03-13T03:30:00+00:00', location: 'The barn', map_url: 'javascript:alert(1)' }),
            occurrence({ id: 'o5', starts_at: '2035-03-14T03:30:00+00:00' }),
          ],
        }),
      ),
  })
  renderPage()
  await loaded()
  const [hall, park, placeOnly, unsafe, neither] = dateItems().map((item) => item.querySelector('.occurrence-where'))
  expect(hall?.textContent).toBe('The hall · Map')
  expect(within(hall as HTMLElement).getByRole('link', { name: 'Map' }).getAttribute('href')).toBe('https://maps.example/hall')
  expect(within(hall as HTMLElement).getByRole('link', { name: 'Map' }).getAttribute('target')).toBe('_blank')
  expect(park?.textContent).toBe('Map')
  expect(within(park as HTMLElement).getByRole('link', { name: 'Map' }).getAttribute('href')).toBe('https://maps.example/park')
  expect(placeOnly?.textContent).toBe('The park')
  expect(within(placeOnly as HTMLElement).queryByRole('link')).toBeNull()
  // A stored value that fails the scheme guard is shown, never navigated to.
  expect(unsafe?.textContent).toBe('The barn · javascript:alert(1)')
  expect(within(unsafe as HTMLElement).queryByRole('link')).toBeNull()
  expect(neither).toBeNull()
  // Each line follows its date's time range.
  expect(hall?.previousElementSibling?.classList.contains('occurrence-when')).toBe(true)
})

test('the row’s order: the chip, RSVP and who’s coming, then the organisers’ Edit this date and Remove this date — an invitee’s row the first two alone', async () => {
  stubServer()
  const first = renderPage()
  await loaded()
  const order = (row: HTMLElement) =>
    Array.from(row.children).map((child) => (child.classList.contains('answer') ? 'chip' : child.textContent))
  expect(order(rowOf(dateItems()[0]))).toEqual(['chip', "RSVP and who's coming", 'Edit this date', 'Remove this date'])
  first.unmount()

  stubServer({ 'GET /gatherings/g-1': () => json(200, detail({ caller_role: null })) })
  renderPage()
  await loaded()
  expect(order(rowOf(dateItems()[0]))).toEqual(['chip', "RSVP and who's coming"])
  expect(screen.queryByRole('button', { name: 'Add another date' })).toBeNull()
})

test('the organisers’ date controls keep today’s steps: Remove this date’s warning beneath the row, and Edit this date’s form in the date’s place', async () => {
  const mock = stubServer({
    'DELETE /occurrences/occ-1': () =>
      json(409, { detail: { code: 'confirmation_required', rsvp_count: 2, message: 'answered' } }),
    'DELETE /occurrences/occ-1?confirm=true': () => new Response(null, { status: 204 }),
  })
  renderPage()
  await loaded()
  const item = dateItems()[0]
  fireEvent.click(within(rowOf(item)).getByRole('button', { name: 'Remove this date' }))
  const warning = await within(item).findByText('2 people have answered for this date. Removing it discards their answers.')
  // Beneath the row, with the deliberate second click and its way out.
  expect(rowOf(item).compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(rowOf(item).contains(warning)).toBe(false)
  expect(within(item).getByRole('button', { name: "Don't remove it" })).toBeTruthy()
  fireEvent.click(within(item).getByRole('button', { name: 'Remove it anyway' }))
  await waitFor(() => expect(requests(mock, 'DELETE', '/occurrences/occ-1?confirm=true')).toHaveLength(1))
  await waitFor(() => expect(requests(mock, 'GET', '/gatherings/g-1')).toHaveLength(2))

  fireEvent.click(within(rowOf(dateItems()[0])).getByRole('button', { name: 'Edit this date' }))
  const fields = within(dateItems()[0]).getByRole('group', { name: 'Edit this date' })
  expect(within(fields).getByLabelText('Starts')).toBeTruthy()
  expect(dateItems()[0].querySelector('.occurrence-row')).toBeNull()
  expect(screen.getByRole('button', { name: 'Add another date' })).toBeTruthy()
})

test('the RSVP block opens beneath the row, its button expanded over it, and a second press closes it', async () => {
  const mock = stubServer()
  renderPage()
  await loaded()
  const item = dateItems()[0]
  const button = within(rowOf(item)).getByRole('button', { name: "RSVP and who's coming" })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  // Collapsed: the page is one request.
  expect(requests(mock, 'GET', /\/rsvps$/)).toHaveLength(0)
  fireEvent.click(button)
  await within(item).findByText("You haven't answered yet.")
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const block = document.getElementById(button.getAttribute('aria-controls') as string) as HTMLElement
  expect(block.classList.contains('rsvp-block')).toBe(true)
  expect(rowOf(item).compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(rowOf(item).contains(block)).toBe(false)
  expect(item.contains(block)).toBe(true)
  // The button stays in the row while the block is open.
  expect(within(rowOf(item)).getByRole('button', { name: "RSVP and who's coming" })).toBe(button)
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(within(item).queryByText("You haven't answered yet.")).toBeNull()
})

// ---------------------------------------------------------------------------
// The photos-only view, and the order of the page's cards.
// ---------------------------------------------------------------------------

test('the photos-only view never shows a date or an answer — even from a body that carried both — and makes two requests: the detail and the photos', async () => {
  const mock = stubServer({
    'GET /gatherings/g-1': () =>
      json(200, memoryDetail({ occurrences: [occurrence({ caller_response: 'yes', location: 'The hall' })] })),
  })
  const view = renderPage()
  await loaded()
  expect(view.container.querySelector('.answer')).toBeNull()
  expect(screen.queryByText('Going')).toBeNull()
  expect(screen.queryByText('Not answered')).toBeNull()
  expect(screen.queryByText('The hall')).toBeNull()
  expect(view.container.querySelector('.cover-date')).toBeNull()
  expect(view.container.textContent).not.toMatch(/2035|\b\d{1,2}:\d\d\b/)
  await new Promise((resolve) => setTimeout(resolve, 30))
  // CK-88 (the kickoff's §1): the Photos section is open on load and reads
  // its list at once — the list is not something the view withholds — so the
  // view makes two requests, the detail and the media list, and nothing else
  // (the group's seat waits for the viewer, Steven's answer of 2026-11-02).
  expect(mock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/gatherings/g-1',
    '/gatherings/g-1/media',
  ])
})

test('the order of the page by seat: the crumb, the cover, the actions, then When, Photos, Who it’s for and the co-host or invitations section', async () => {
  const sections = () =>
    Array.from(document.querySelectorAll('main > *')).map((node) => {
      if (node.classList.contains('crumb')) return 'crumb'
      if (node.classList.contains('cover-card')) return 'cover'
      if (node.classList.contains('cover-panel')) return null
      if (node.classList.contains('gathering-actions')) return 'actions'
      if (node.tagName === 'P') return 'line'
      return node.querySelector('h2')?.textContent ?? node.getAttribute('aria-label')
    }).filter((name) => name !== null)

  const seats: [Record<string, unknown>, (string | null)[]][] = [
    [detail(), ['crumb', 'cover', 'actions', 'When', 'Photos', 'Invitations']],
    [detail({ group: GROUP }), ['crumb', 'cover', 'actions', 'When', 'Photos', "Who it's for", 'Co-hosts']],
    [detail({ caller_role: 'co_host', group: GROUP }), ['crumb', 'cover', 'actions', 'When', 'Photos', "Who it's for", 'Co-hosts']],
    [detail({ caller_role: null, group: GROUP }), ['crumb', 'cover', 'actions', 'When', 'Photos']],
    [memoryDetail(), ['crumb', 'cover', 'line', 'Photos']],
  ]
  for (const [body, expected] of seats) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderPage()
    await loaded()
    expect(sections()).toEqual(expected)
    view.unmount()
  }

  // The prompt to share sits beneath the actions, before When, once a date
  // has started and someone is kept a surprise.
  stubServer({
    'GET /gatherings/g-1': () =>
      json(200, detail({ group: GROUP, occurrences: [occurrence({ starts_at: new Date(Date.now() - HOUR).toISOString() })] })),
    'GET /gatherings/g-1/places': () =>
      json(200, {
        invitees_chosen: true,
        members: [{ membership_id: 'mem-dee-4444', display_name: 'Dee Test', place: 'left_out', co_host: false }],
      }),
  })
  renderPage()
  await loaded()
  await screen.findByText("Dee Test doesn't know about this gathering yet.")
  expect(sections()).toEqual(['crumb', 'cover', 'actions', 'Kept a surprise', 'When', 'Photos', "Who it's for", 'Co-hosts'])
})

// ---------------------------------------------------------------------------
// The page column, the rider in the source, and the styles.
// ---------------------------------------------------------------------------

test('a loaded gathering takes the page column in both views; the loading, not-found and failed screens keep today’s centred column', async () => {
  for (const body of [detail(), memoryDetail()]) {
    stubServer({ 'GET /gatherings/g-1': () => json(200, body) })
    const view = renderPage()
    const heading = await loaded()
    expect(heading.closest('main')?.classList.contains('page-column')).toBe(true)
    view.unmount()
  }
  stubServer({ 'GET /gatherings/g-1': () => json(404, { detail: 'Not Found' }) })
  const missing = renderPage()
  await screen.findByRole('heading', { name: 'Nothing here' })
  expect(missing.container.querySelector('main')?.className).toBe('auth-screen')
  expect(screen.getByRole('link', { name: 'Back to your gatherings' }).getAttribute('href')).toBe('/gatherings')
  missing.unmount()
  stubServer({ 'GET /gatherings/g-1': () => json(500, {}) })
  const failed = renderPage()
  await screen.findByRole('heading', { name: 'Something went wrong' })
  expect(failed.container.querySelector('main')?.className).toBe('auth-screen')
  expect(screen.getByRole('link', { name: 'Back to your gatherings' })).toBeTruthy()
})

test('the rider: listItemLine is gone — unused since CK-86 — with its stale comment', () => {
  expect(gatheringsLibSource).not.toMatch(/listItemLine/)
  expect(gatheringsLibSource).not.toMatch(/on a group's own list of gatherings/)
})

test('the gathering page’s styles name no colour and add no token, and hold the mockup’s measures', () => {
  const start = appCss.indexOf("/* ---------- a gathering's page (CK-87")
  expect(start).toBeGreaterThan(-1)
  const end = appCss.indexOf('/* ----------', start + 10)
  const section = appCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const selector of ['.gathering-page', '.occurrence-row', '.occurrence-where', '.answer', '.answer.answer-none']) {
    expect(section).toContain(selector)
  }
  expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  const used = [...new Set([...section.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  expect(used).toEqual(expect.arrayContaining(['--ck-tint', '--ck-active-ink', '--ck-muted', '--pg-surface-edge']))
  for (const name of used) expect(tokensCss, name).toMatch(new RegExp(`${name}\\s*:`))
  // The cards at the column's width, a field's reading width, the chip's
  // pill and its dashed edge.
  expect(section).toMatch(/max-width: none/)
  expect(section).toMatch(/max-width: 420px/)
  expect(section).toMatch(/border-radius: 999px/)
  expect(section).toMatch(/border: 1px dashed var\(--pg-surface-edge\)/)
  // The RSVP block is the mockup's box; the actions take the group page's
  // rules; a card's date is kept whole.
  expect(appCss).toMatch(/\.rsvp-block \{[^}]*border-radius: 14px;[^}]*background: var\(--pg-bg\);/)
  expect(appCss).toMatch(/\.group-actions,\n\.gathering-actions \{/)
  expect(appCss).toMatch(/\.nowrap \{\n {2}white-space: nowrap;\n\}/)
})
