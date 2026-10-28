// CK-80 pins on /gatherings/:id for a GROUP's gathering
// (decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §10,
// §11; Steven's answers of 2026-10-27). The values under test:
// - THE PHOTOS-ONLY VIEW, from a memory body whose `occurrences` is null:
//   the header, the group line and one line; the Photos section with no
//   upload, "Show photos", and no date on any photo; NO When, NO RSVP, NO
//   Edit, NO Invitations, NO places — and no request the view withholds
//   (`/occurrences/…/rsvps`, `/places`, `/invitations`, `/co-hosts`). An
//   unknown view is the same view (gates closed).
// - The group line on a group's gathering, a link to the group; none on a
//   standalone one.
// - WHO IT'S FOR, for organisers of a group's gathering only: each change
//   one tap and one PUT, the row from the server's entry; a co-host's row
//   with Invited alone; a member with no place; each refusal on its row from
//   its code, nothing re-read, with Refresh the list.
// - THE PROMPT once a date has started and someone is kept a surprise —
//   absent before the first date and when nobody is; Let {name} see the
//   photos one PUT `shared_with`, and the line goes.
// - The Invitations section on a group's gathering: no email form and no
//   Waiting on — every emailed invitation to it is the 409 `members_only` —
//   with co-host management intact; a standalone gathering's unchanged.
// - The failed read's Try again re-reading once per press.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import mediaSource from '../components/GatheringMedia.tsx?raw'
import appSource from '../App.tsx?raw'
import { formatInstant } from '../lib/datetime'
import gatheringsLibSource from '../lib/gatherings.ts?raw'
import groupsLibSource from '../lib/groups.ts?raw'
import placesSource from '../lib/places.ts?raw'
import { GatheringDetail } from './GatheringDetail'
import detailSource from './GatheringDetail.tsx?raw'
import newSource from './GatheringNew.tsx?raw'
import listSource from './Gatherings.tsx?raw'
import groupDetailSource from './GroupDetail.tsx?raw'
import groupNewGatheringSource from './GroupGatheringNew.tsx?raw'

const ZONE = 'America/Chicago'

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

beforeEach(() => {
  Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const HOUR = 60 * 60 * 1000
const startedAnHourAgo = () => new Date(Date.now() - HOUR).toISOString()
const startsNextWeek = () => new Date(Date.now() + 7 * 24 * HOUR).toISOString()

// Distinctive ids, so a leak would be found anywhere in the markup.
const MEM = { bea: 'mem-bea-2222', cee: 'mem-cee-3333', dee: 'mem-dee-4444', eve: 'mem-eve-5555' }
const GROUP = { id: 'grp-lees-1', name: 'The Lees' }

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
    group: GROUP,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    occurrences: [
      {
        id: 'occ-1',
        gathering_id: 'g-1',
        starts_at: startsNextWeek(),
        ends_at: null,
        location: '12 Elm Street',
        map_url: null,
      },
    ],
    ...over,
  }
}

// The memory body (CK-77): the dates and the RSVP setting withheld — NULL,
// never [] — and no role.
function memoryDetail(over: Record<string, unknown> = {}) {
  return detail({
    caller_role: null,
    caller_view: 'memory',
    rsvp_list_visibility: null,
    occurrences: null,
    ...over,
  })
}

function entry(membershipId: string, displayName: string, place: string | null, coHost = false) {
  return { membership_id: membershipId, display_name: displayName, place, co_host: coHost }
}

function placeList(over: Partial<{ inviteesChosen: boolean; members: unknown[] }> = {}) {
  return {
    invitees_chosen: over.inviteesChosen ?? true,
    members: over.members ?? [
      entry(MEM.bea, 'Bea Test', 'invited'),
      entry(MEM.cee, 'Cee Test', 'shared_with'),
      entry(MEM.dee, 'Dee Test', 'left_out'),
    ],
  }
}

const PHOTO = {
  id: 'm-photo-1',
  gathering_id: 'g-1',
  occurrence_id: 'occ-1',
  status: 'ready',
  publication_state: 'live',
  upload_content_type: 'image/jpeg',
  upload_size_bytes: 1000,
  uploaded_at: '2026-10-27T15:00:01+00:00',
  created_at: '2026-10-27T15:00:00+00:00',
  uploader_display_name: 'Ada Test',
  is_own: false,
  removed_at: null,
  filename: 'party.jpg',
  caption: null,
  tags: [],
  published_at: '2026-10-27T15:00:05+00:00',
  failure_reason: null,
}

type Responder = (init: RequestInit | undefined, path: string) => Response

interface Routes {
  detail?: Responder
  places?: Responder
  putPlace?: Responder
  invitations?: Responder
  coHosts?: Responder
  media?: Responder
}

function stubServer(over: Routes = {}) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const respond = (r: Responder | undefined, fallback: Responder) =>
      Promise.resolve((r ?? fallback)(init, path))
    if (method === 'GET' && path === '/gatherings/g-1') {
      return respond(over.detail, () => json(200, detail()))
    }
    if (method === 'GET' && path === '/gatherings/g-1/places') {
      return respond(over.places, () => json(200, placeList()))
    }
    if (method === 'PUT' && path.startsWith('/gatherings/g-1/places/')) {
      return respond(over.putPlace, (i, p) => {
        const membershipId = p.split('/').pop() as string
        const { place } = JSON.parse(String(i?.body)) as { place: string }
        const names: Record<string, string> = {
          [MEM.bea]: 'Bea Test',
          [MEM.cee]: 'Cee Test',
          [MEM.dee]: 'Dee Test',
          [MEM.eve]: 'Eve Test',
        }
        return json(200, entry(membershipId, names[membershipId], place))
      })
    }
    if (method === 'GET' && path === '/gatherings/g-1/invitations') {
      return respond(over.invitations, () =>
        json(200, {
          pending: [],
          accepted: [
            { id: 'inv-bea-1', display_name: 'Bea Test', accepted_at: '2026-10-27T12:00:00+00:00' },
          ],
        }),
      )
    }
    if (method === 'GET' && path === '/gatherings/g-1/co-hosts') {
      return respond(over.coHosts, () => json(200, { co_hosts: [] }))
    }
    if (method === 'POST' && path === '/gatherings/g-1/co-hosts') {
      return Promise.resolve(json(201, {}))
    }
    if (method === 'GET' && path.startsWith('/gatherings/g-1/media')) {
      return respond(over.media, () => json(200, { media: [PHOTO] }))
    }
    if (method === 'GET' && path.includes('/url?layer=')) {
      return Promise.resolve(json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } }))
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function requests(mock: ReturnType<typeof vi.fn>, method: string, match: RegExp) {
  return mock.mock.calls.filter(([url, init]) => {
    const m = (init as RequestInit | undefined)?.method ?? 'GET'
    return m === method && match.test(String(url).replace(/^https?:\/\/[^/]+/, ''))
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

function placesRegion(): HTMLElement {
  return screen.getByRole('region', { name: "Who it's for" })
}

function rowFor(name: string): HTMLElement {
  return within(placesRegion()).getByRole('group', { name: new RegExp(`^${name}`) })
}

function radio(name: string, label: string): HTMLInputElement {
  return within(rowFor(name)).getByRole('radio', { name: label }) as HTMLInputElement
}

function checkedLabel(name: string): string | null {
  const found = within(rowFor(name))
    .getAllByRole('radio')
    .find((r) => (r as HTMLInputElement).checked)
  return found ? (found.closest('label')?.textContent ?? '').trim() : null
}

const PHOTOS_ONLY_LINE =
  "You can see this gathering's photos. Its dates and plans are for the people invited."

// ---------------------------------------------------------------------------
// The photos-only view.
// ---------------------------------------------------------------------------

test('THE PHOTOS-ONLY VIEW from a memory body with occurrences null: the header, the group line and the line — no When, no RSVP, no Edit, no Invitations, no places, and none of their requests', async () => {
  const mock = stubServer({ detail: () => json(200, memoryDetail()) })
  renderPage()
  await loaded()
  expect(screen.getByText('Potluck')).toBeTruthy()
  expect(screen.getByText(PHOTOS_ONLY_LINE)).toBeTruthy()
  const groupLink = screen.getByRole('link', { name: 'The Lees' })
  expect(groupLink.getAttribute('href')).toBe('/groups/grp-lees-1')
  expect(groupLink.closest('p')?.textContent).toBe('In The Lees')
  const headings = screen.getAllByRole('heading').map((h) => h.textContent)
  expect(headings).toEqual(['The Party', 'Photos'])
  for (const absent of [/edit gathering/i, /rsvp/i, /invite people/i, /show co-hosts/i, /edit this date/i, /add another date/i]) {
    expect(screen.queryByRole('button', { name: absent })).toBeNull()
  }
  expect(screen.queryByText('12 Elm Street')).toBeNull()
  expect(screen.queryByRole('region', { name: "Who it's for" })).toBeNull()
  // Wait out any effect that might ask for something it should not.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(requests(mock, 'GET', /^\/occurrences\/.*\/rsvps$/)).toHaveLength(0)
  expect(requests(mock, 'GET', /\/places$/)).toHaveLength(0)
  expect(requests(mock, 'GET', /\/invitations$/)).toHaveLength(0)
  expect(requests(mock, 'GET', /\/co-hosts$/)).toHaveLength(0)
  expect(mock.mock.calls).toHaveLength(1)
})

test('in the photos-only view the Photos section reads "Show photos", offers no upload, and no photo carries a date', async () => {
  const mock = stubServer({ detail: () => json(200, memoryDetail()) })
  const view = renderPage()
  await loaded()
  expect(screen.queryByRole('button', { name: /show photos and add yours/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show photos' }))
  const list = await screen.findByRole('list', { name: 'Photos' })
  const row = within(list).getAllByRole('listitem')[0]
  expect(row.querySelector('strong')?.textContent).toBe('party.jpg')
  // The photo is labelled with a date in the full view; here, none — and not
  // the moment it was added either.
  expect(row.textContent).toContain('added by Ada Test')
  expect(row.textContent).not.toContain(' for ')
  expect(row.textContent).not.toContain(formatInstant(PHOTO.created_at, ZONE))
  expect(view.container.textContent).not.toMatch(/20\d\d|\b\d{1,2}:\d\d\b/)
  expect(screen.queryByLabelText('Add photos')).toBeNull()
  expect(view.container.querySelector('input[type="file"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /^upload/i })).toBeNull()
  expect(requests(mock, 'POST', /\/media\/intents$/)).toHaveLength(0)
})

test('an unknown view is the photos-only view — even beside a role, the page shows less, never the dates', async () => {
  const mock = stubServer({
    detail: () => json(200, detail({ caller_view: 'everything', caller_role: 'host' })),
  })
  renderPage()
  await loaded()
  expect(screen.getByText(PHOTOS_ONLY_LINE)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'When' })).toBeNull()
  expect(screen.queryByText('12 Elm Street')).toBeNull()
  expect(screen.queryByRole('button', { name: /edit gathering/i })).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(requests(mock, 'GET', /\/places$/)).toHaveLength(0)
  // A body with no `caller_view` at all reads the same.
  cleanup()
  const { caller_view: _view, ...noView } = detail()
  stubServer({ detail: () => json(200, noView) })
  renderPage()
  await loaded()
  expect(screen.getByText(PHOTOS_ONLY_LINE)).toBeTruthy()
})

// ---------------------------------------------------------------------------
// The group line.
// ---------------------------------------------------------------------------

test('the group line on a group’s gathering in the full view — for an invitee too — and none on a standalone one', async () => {
  stubServer({ detail: () => json(200, detail({ caller_role: null })) })
  renderPage()
  await loaded()
  expect(screen.getByRole('link', { name: 'The Lees' }).getAttribute('href')).toBe('/groups/grp-lees-1')
  expect(screen.getByRole('heading', { name: 'When' })).toBeTruthy()
  expect(screen.queryByText(PHOTOS_ONLY_LINE)).toBeNull()
  cleanup()
  stubServer({ detail: () => json(200, detail({ group: null })) })
  renderPage()
  await loaded()
  expect(screen.queryByText(/^In /)).toBeNull()
  expect(screen.queryByRole('link', { name: 'The Lees' })).toBeNull()
})

// ---------------------------------------------------------------------------
// Who it's for.
// ---------------------------------------------------------------------------

for (const role of ['host', 'co_host'] as const) {
  test(`Who it's for, as ${role === 'host' ? 'the host' : 'a co-host'}: read once on mount, the hint and the newcomer line, each member's row with the three choices and their place`, async () => {
    const mock = stubServer({ detail: () => json(200, detail({ caller_role: role })) })
    renderPage()
    await loaded()
    const region = placesRegion()
    await within(region).findByRole('group', { name: /^Bea Test/ })
    expect(
      within(region).getByText(
        "Invited people get the dates and the plans, and can add photos. People who see the photos get the photos and nothing else. Someone kept a surprise won't know about this gathering until you let them see the photos.",
      ),
    ).toBeTruthy()
    expect(within(region).getByText("Anyone who joins The Lees before it's over will see the photos.")).toBeTruthy()
    expect(checkedLabel('Bea Test')).toBe('Invited')
    expect(checkedLabel('Cee Test')).toBe('Sees the photos')
    expect(checkedLabel('Dee Test')).toBe('Kept a surprise')
    expect(within(rowFor('Bea Test')).getAllByRole('radio').map((r) => r.closest('label')?.textContent?.trim())).toEqual([
      'Invited',
      'Sees the photos',
      'Kept a surprise',
    ])
    expect(requests(mock, 'GET', /\/places$/)).toHaveLength(1)
  })
}

test('Who it’s for is the organisers’ alone and a group’s gathering’s alone: an invitee and a standalone gathering’s host get no section and no request', async () => {
  const invitee = stubServer({ detail: () => json(200, detail({ caller_role: null })) })
  renderPage()
  await loaded()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('region', { name: "Who it's for" })).toBeNull()
  expect(requests(invitee, 'GET', /\/places$/)).toHaveLength(0)
  cleanup()
  const standalone = stubServer({ detail: () => json(200, detail({ group: null })) })
  renderPage()
  await loaded()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('region', { name: "Who it's for" })).toBeNull()
  expect(requests(standalone, 'GET', /\/places$/)).toHaveLength(0)
})

test('each change is one tap and one PUT, the row re-rendered from the server’s entry — and the newcomer line follows once anyone is moved away from Invited', async () => {
  const mock = stubServer({
    places: () =>
      json(200, placeList({ inviteesChosen: false, members: [entry(MEM.bea, 'Bea Test', 'invited'), entry(MEM.eve, 'Eve Test', 'invited')] })),
  })
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Eve Test/ })
  expect(within(placesRegion()).getByText("Anyone who joins The Lees before it's over is invited too.")).toBeTruthy()
  fireEvent.click(radio('Eve Test', 'Sees the photos'))
  await waitFor(() => expect(checkedLabel('Eve Test')).toBe('Sees the photos'))
  const puts = requests(mock, 'PUT', /\/places\//)
  expect(puts).toHaveLength(1)
  expect(puts[0][0]).toMatch(new RegExp(`/gatherings/g-1/places/${MEM.eve}$`))
  expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ place: 'shared_with' })
  expect(within(placesRegion()).getByText("Anyone who joins The Lees before it's over will see the photos.")).toBeTruthy()
  // Nothing re-read: the row is the PUT's answer.
  expect(requests(mock, 'GET', /\/places$/)).toHaveLength(1)
  // And back — once chosen, chosen: the line stays.
  fireEvent.click(radio('Eve Test', 'Invited'))
  await waitFor(() => expect(checkedLabel('Eve Test')).toBe('Invited'))
  expect(requests(mock, 'PUT', /\/places\//)).toHaveLength(2)
  expect(within(placesRegion()).getByText("Anyone who joins The Lees before it's over will see the photos.")).toBeTruthy()
})

test('a co-host’s row offers Invited alone — the other two disabled — with "A co-host is always invited."', async () => {
  stubServer({
    places: () => json(200, placeList({ members: [entry(MEM.cee, 'Cee Test', 'invited', true), entry(MEM.bea, 'Bea Test', 'invited')] })),
  })
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Cee Test/ })
  expect(rowFor('Cee Test').querySelector('legend')?.textContent).toContain('Cee Test · Co-host')
  expect(radio('Cee Test', 'Invited').disabled).toBe(false)
  expect(radio('Cee Test', 'Sees the photos').disabled).toBe(true)
  expect(radio('Cee Test', 'Kept a surprise').disabled).toBe(true)
  expect(within(rowFor('Cee Test')).getByText('A co-host is always invited.')).toBeTruthy()
  // An ordinary member's row offers all three.
  expect(radio('Bea Test', 'Kept a surprise').disabled).toBe(false)
  expect(within(rowFor('Bea Test')).queryByText('A co-host is always invited.')).toBeNull()
})

test('a member with no place shows none checked and says so; choosing one writes it', async () => {
  const mock = stubServer({
    places: () => json(200, placeList({ members: [entry(MEM.eve, 'Eve Test', null)] })),
  })
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Eve Test/ })
  expect(checkedLabel('Eve Test')).toBeNull()
  expect(within(rowFor('Eve Test')).getByText('Eve Test has no place on this gathering yet.')).toBeTruthy()
  fireEvent.click(radio('Eve Test', 'Invited'))
  await waitFor(() => expect(checkedLabel('Eve Test')).toBe('Invited'))
  expect(within(rowFor('Eve Test')).queryByText('Eve Test has no place on this gathering yet.')).toBeNull()
  expect(requests(mock, 'PUT', /\/places\//)).toHaveLength(1)
})

for (const [label, response, line] of [
  ['has_answered', () => json(409, { detail: { code: 'has_answered', message: 'SERVER WORDING' } }), 'Bea Test has answered a date, so they stay invited.'],
  ['is_co_host', () => json(409, { detail: { code: 'is_co_host', message: 'SERVER WORDING' } }), 'Bea Test is a co-host, so they stay invited. Remove them as a co-host first.'],
  ['a 404', () => json(404, { detail: 'No such member.' }), "Bea Test isn't in The Lees any more — refresh the list."],
  ['a 500', () => json(500, {}), 'Something went wrong. Nothing changed — try again.'],
] as const) {
  test(`${label}: the refusal lands on its row from its code, the row unmoved and nothing re-read — then Refresh the list re-reads`, async () => {
    const mock = stubServer({ putPlace: response })
    renderPage()
    await loaded()
    await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
    fireEvent.click(radio('Bea Test', 'Kept a surprise'))
    expect(await within(rowFor('Bea Test')).findByText(line)).toBeTruthy()
    expect(document.body.textContent).not.toContain('SERVER WORDING')
    expect(checkedLabel('Bea Test')).toBe('Invited')
    expect(within(rowFor('Dee Test')).queryByRole('alert')).toBeNull()
    expect(requests(mock, 'GET', /\/places$/)).toHaveLength(1)
    fireEvent.click(within(rowFor('Bea Test')).getByRole('button', { name: 'Refresh the list' }))
    await waitFor(() => expect(requests(mock, 'GET', /\/places$/)).toHaveLength(2))
    await waitFor(() => expect(within(rowFor('Bea Test')).queryByText(line)).toBeNull())
  })
}

test('a network failure on a change reads the network line on the row', async () => {
  const mock = stubServer()
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
  // From here the PUT never reaches the server; every read still answers.
  const base = mock.getMockImplementation()!
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? Promise.reject(new TypeError('offline')) : base(url, init),
    ),
  )
  fireEvent.click(radio('Bea Test', 'Sees the photos'))
  expect(
    await within(rowFor('Bea Test')).findByText("Couldn't reach the server. Check your connection and try again."),
  ).toBeTruthy()
})

test('the failed places read fails in its own card with Try again, and the rest of the page stands', async () => {
  let fail = true
  const mock = stubServer({ places: () => (fail ? json(500, {}) : json(200, placeList())) })
  renderPage()
  await loaded()
  expect(await within(placesRegion()).findByText("Who it's for couldn't be loaded just now.")).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'When' })).toBeTruthy()
  fail = false
  fireEvent.click(within(placesRegion()).getByRole('button', { name: 'Try again' }))
  await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
  expect(requests(mock, 'GET', /\/places$/)).toHaveLength(2)
})

test('no membership id in the markup — not in a radio group’s name, an id or a label', async () => {
  stubServer({ detail: () => json(200, detail({ occurrences: [{ ...detail().occurrences[0], starts_at: startedAnHourAgo() }] })) })
  const view = renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
  await screen.findByText("Dee Test doesn't know about this gathering yet.")
  for (const id of Object.values(MEM)) expect(view.container.innerHTML).not.toContain(id)
})

// ---------------------------------------------------------------------------
// The prompt to share.
// ---------------------------------------------------------------------------

function startedDetail(over: Record<string, unknown> = {}) {
  return detail({
    occurrences: [
      { id: 'occ-1', gathering_id: 'g-1', starts_at: startedAnHourAgo(), ends_at: null, location: null, map_url: null },
      { id: 'occ-2', gathering_id: 'g-1', starts_at: startsNextWeek(), ends_at: null, location: null, map_url: null },
    ],
    ...over,
  })
}

test('THE PROMPT: once a date has started, one line per member kept a surprise; Let {name} see the photos sends one PUT shared_with and the line goes', async () => {
  const mock = stubServer({
    detail: () => json(200, startedDetail()),
    places: () =>
      json(200, placeList({ members: [entry(MEM.bea, 'Bea Test', 'invited'), entry(MEM.dee, 'Dee Test', 'left_out'), entry(MEM.eve, 'Eve Test', 'left_out')] })),
  })
  renderPage()
  await loaded()
  const prompt = await screen.findByRole('region', { name: 'Kept a surprise' })
  expect(within(prompt).getByText("Dee Test doesn't know about this gathering yet.")).toBeTruthy()
  expect(within(prompt).getByText("Eve Test doesn't know about this gathering yet.")).toBeTruthy()
  expect(within(prompt).queryByText(/Bea Test/)).toBeNull()
  // At the top of the page, beneath the header and above everything else.
  const headings = screen.getAllByRole('heading').map((h) => h.textContent)
  expect(headings[0]).toBe('The Party')
  expect(prompt.compareDocumentPosition(screen.getByRole('heading', { name: 'When' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(within(prompt).getByRole('button', { name: 'Let Dee Test see the photos' }))
  await waitFor(() => expect(screen.queryByText("Dee Test doesn't know about this gathering yet.")).toBeNull())
  const puts = requests(mock, 'PUT', /\/places\//)
  expect(puts).toHaveLength(1)
  expect(puts[0][0]).toMatch(new RegExp(`/places/${MEM.dee}$`))
  expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ place: 'shared_with' })
  // Who it's for agrees, from the same entry.
  expect(checkedLabel('Dee Test')).toBe('Sees the photos')
  expect(screen.getByText("Eve Test doesn't know about this gathering yet.")).toBeTruthy()
  // No dialog, no notification copy.
  expect(document.body.textContent).not.toMatch(/notif|we'll tell|they'll be told|email/i)
})

test('no prompt before the first date has started, and none when nobody is kept a surprise', async () => {
  stubServer()
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Dee Test/ })
  expect(screen.queryByRole('region', { name: 'Kept a surprise' })).toBeNull()
  expect(screen.queryByText(/doesn't know about this gathering yet/)).toBeNull()
  cleanup()
  stubServer({
    detail: () => json(200, startedDetail()),
    places: () => json(200, placeList({ members: [entry(MEM.bea, 'Bea Test', 'invited'), entry(MEM.cee, 'Cee Test', 'shared_with')] })),
  })
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Cee Test/ })
  expect(screen.queryByRole('region', { name: 'Kept a surprise' })).toBeNull()
})

test('the prompt is the organisers’: an invitee of a started gathering sees none and asks for no places', async () => {
  const mock = stubServer({ detail: () => json(200, startedDetail({ caller_role: null })) })
  renderPage()
  await loaded()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('region', { name: 'Kept a surprise' })).toBeNull()
  expect(requests(mock, 'GET', /\/places$/)).toHaveLength(0)
})

test('a refused prompt lands on its line from its code, and the line stays', async () => {
  stubServer({
    detail: () => json(200, startedDetail()),
    putPlace: () => json(404, { detail: 'No such member.' }),
  })
  renderPage()
  await loaded()
  const prompt = await screen.findByRole('region', { name: 'Kept a surprise' })
  fireEvent.click(within(prompt).getByRole('button', { name: 'Let Dee Test see the photos' }))
  expect(await within(prompt).findByText("Dee Test isn't in The Lees any more — refresh the list.")).toBeTruthy()
  expect(within(prompt).getByText("Dee Test doesn't know about this gathering yet.")).toBeTruthy()
  expect(within(placesRegion()).queryByRole('alert')).toBeNull()
})

// ---------------------------------------------------------------------------
// The Invitations section on a group's gathering.
// ---------------------------------------------------------------------------

test('a group’s gathering: the section is Co-hosts — opened by Show co-hosts — with no email form and no Waiting on, the list headed Invited, and Make co-host intact', async () => {
  const mock = stubServer()
  renderPage()
  await loaded()
  const section = screen.getByRole('region', { name: 'Co-hosts' })
  expect(screen.queryByRole('heading', { name: 'Invitations' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Invite people' })).toBeNull()
  fireEvent.click(within(section).getByRole('button', { name: 'Show co-hosts' }))
  const invited = await within(section).findByRole('list', { name: 'Invited' })
  expect(within(section).queryByLabelText('Email address')).toBeNull()
  expect(within(section).queryByRole('button', { name: 'Send invitation' })).toBeNull()
  expect(within(section).queryByText('Waiting on')).toBeNull()
  expect(within(section).queryByText('No pending invitations.')).toBeNull()
  expect(within(section).queryByText('Accepted')).toBeNull()
  expect(within(section).getByRole('heading', { name: 'Invited' })).toBeTruthy()
  expect(await within(section).findByText('No co-hosts yet.')).toBeTruthy()
  fireEvent.click(within(invited).getByRole('button', { name: 'Make co-host' }))
  await waitFor(() => expect(requests(mock, 'POST', /\/co-hosts$/)).toHaveLength(1))
  expect(JSON.parse(String(requests(mock, 'POST', /\/co-hosts$/)[0][1]?.body))).toEqual({
    invitation_id: 'inv-bea-1',
  })
  expect(requests(mock, 'POST', /\/invitations$/)).toHaveLength(0)
})

test('Make co-host re-reads the places: the new co-host’s row in Who it’s for offers Invited alone at once, with no reload', async () => {
  let made = false
  const mock = stubServer({
    places: () =>
      json(200, placeList({ members: [entry(MEM.bea, 'Bea Test', 'invited', made), entry(MEM.dee, 'Dee Test', 'left_out')] })),
  })
  // The POST lands, and from then on the server says Bea co-hosts.
  const base = mock.getMockImplementation()!
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/co-hosts')) made = true
      return base(url, init)
    }),
  )
  renderPage()
  await loaded()
  await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
  expect(radio('Bea Test', 'Kept a surprise').disabled).toBe(false)
  const section = screen.getByRole('region', { name: 'Co-hosts' })
  fireEvent.click(within(section).getByRole('button', { name: 'Show co-hosts' }))
  const invited = await within(section).findByRole('list', { name: 'Invited' })
  fireEvent.click(await within(invited).findByRole('button', { name: 'Make co-host' }))
  await waitFor(() => expect(radio('Bea Test', 'Kept a surprise').disabled).toBe(true))
  expect(radio('Bea Test', 'Sees the photos').disabled).toBe(true)
  expect(within(rowFor('Bea Test')).getByText('A co-host is always invited.')).toBeTruthy()
})

test('a standalone gathering’s section is unchanged: Invitations, Invite people, the email form, Waiting on and Accepted', async () => {
  stubServer({ detail: () => json(200, detail({ group: null })) })
  renderPage()
  await loaded()
  const section = screen.getByRole('region', { name: 'Invitations' })
  fireEvent.click(within(section).getByRole('button', { name: 'Invite people' }))
  expect(within(section).getByLabelText('Email address')).toBeTruthy()
  expect(await within(section).findByText('Waiting on')).toBeTruthy()
  expect(within(section).getByRole('heading', { name: 'Co-hosts' })).toBeTruthy()
  expect(within(section).getByRole('list', { name: 'Accepted' })).toBeTruthy()
})

// ---------------------------------------------------------------------------
// The rider: the failed read's Try again.
// ---------------------------------------------------------------------------

test('a failed read says so and Try again re-reads once per press, through the loading state, until the page renders', async () => {
  let fail = true
  const mock = stubServer({ detail: () => (fail ? json(500, {}) : json(200, detail())) })
  renderPage()
  expect(await screen.findByText("This gathering couldn't be loaded just now.")).toBeTruthy()
  expect(screen.queryByText(/Try again\./)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(requests(mock, 'GET', /^\/gatherings\/g-1$/)).toHaveLength(2))
  expect(await screen.findByText("This gathering couldn't be loaded just now.")).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await loaded()
  expect(requests(mock, 'GET', /^\/gatherings\/g-1$/)).toHaveLength(3)
})

// ---------------------------------------------------------------------------
// The brand rule over every new or changed source, and the ban over what the
// pages render (CK-80).
// ---------------------------------------------------------------------------

test('no new or changed source spells the product name — it flows from brand.ts', () => {
  for (const source of [
    placesSource,
    gatheringsLibSource,
    groupsLibSource,
    detailSource,
    newSource,
    listSource,
    groupDetailSource,
    groupNewGatheringSource,
    mediaSource,
    appSource,
  ]) {
    expect(source).not.toMatch(/covey ?keep/i)
  }
})

const BANNED = /\bsafe|secure|private|forever|backed up|\bevents?\b/i
const NOTICE = /notif|we'll tell|they'll be told|you'll be told|we'll let|will be emailed/i

test('the ban: no rendered copy — the organiser’s page with the prompt, Who it’s for and the co-host section open, or the photos-only view — says a banned word or promises anyone is told', async () => {
  stubServer({ detail: () => json(200, startedDetail()) })
  renderPage()
  await loaded()
  await screen.findByRole('region', { name: 'Kept a surprise' })
  await within(placesRegion()).findByRole('group', { name: /^Bea Test/ })
  fireEvent.click(screen.getByRole('button', { name: 'Show co-hosts' }))
  await screen.findByRole('list', { name: 'Invited' })
  expect(document.body.textContent).not.toMatch(BANNED)
  expect(document.body.textContent).not.toMatch(NOTICE)
  cleanup()
  stubServer({ detail: () => json(200, memoryDetail()) })
  renderPage()
  await loaded()
  fireEvent.click(screen.getByRole('button', { name: 'Show photos' }))
  await screen.findByRole('list', { name: 'Photos' })
  expect(document.body.textContent).not.toMatch(BANNED)
  expect(document.body.textContent).not.toMatch(NOTICE)
})
