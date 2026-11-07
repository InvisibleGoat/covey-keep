// CK-89.1 — the menu re-reads at once after an act that lands with no page
// change and changes something it draws, through the app's real route table.
// The value under test: after a rename, an approval or a removal on a People
// page, and after Edit gathering's save and a date added, edited or removed on
// a gathering's page, the menu — Rail and panel's heading, tile, People row and
// gathering rows, and One list's rows — shows the server's new answer with the
// address unchanged; the re-read is the menu's own two reads, once per act,
// never `/members` and never a group's gatherings; and a refused act re-reads
// nothing (lib/frame.ts's announceMenuChange).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { clearCoverPictures } from '../lib/covers'
import { formatDayWithYear, formatWeekdayDay, instantToWallClock } from '../lib/datetime'
import { chooseMenuLayout, type MenuLayout } from '../lib/menuLayout'

const ZONE = 'America/Chicago'

const person: Person = {
  id: 'person-ada',
  display_name: 'Ada Lee',
  email: 'ada@example.com',
  timezone: ZONE,
  account_id: 'acct-ada',
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

type Occurrence = { id: string; starts_at: string }

// A stateful fake: an act moves the state, so a re-read shows what the server
// would — the group's name and people, and the gathering's title and dates.
interface State {
  name: string
  members: { id: string; name: string; role: string; self: boolean }[]
  requests: { id: string; display_name: string; created_at: string }[]
  title: string
  occurrences: Occurrence[]
}

let state: State
// The acts that refuse in this test, by name.
let refuse: Set<string>
let mock: ReturnType<typeof vi.fn>

function freshState(occurrences: Occurrence[] = [{ id: 'occ-1', starts_at: at(2) }]): State {
  return {
    name: 'The Lees',
    members: [
      { id: 'mem-ada', name: 'Ada Lee', role: 'admin', self: true },
      { id: 'mem-bea', name: 'Bea', role: 'member', self: false },
      { id: 'mem-cal', name: 'Cal', role: 'member', self: false },
    ],
    requests: [{ id: 'req-zoe', display_name: 'Zoe', created_at: '2026-10-26T15:00:00+00:00' }],
    title: 'Lees Picnic',
    occurrences,
  }
}

// The server's next-or-most-recent rule.
function nextOf(occurrences: Occurrence[]): Occurrence | null {
  const sorted = [...occurrences].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
  return sorted.find((o) => Date.parse(o.starts_at) >= Date.now()) ?? sorted[sorted.length - 1] ?? null
}

function groupBody() {
  return {
    id: 'g-1',
    name: state.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: state.members.length,
    caller_role: 'admin',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

const COUSINS = { ...{ group_type: 'HOUSEHOLD', admin_person_id: 'person-x', caller_role: 'member', cover: null }, id: 'g-2', name: 'Cousins', member_count: 2, created_at: '2026-10-27T12:00:00+00:00', updated_at: null }

function base(id: string, title: string, group: { id: string; name: string } | null) {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-ada',
    host_account_id: 'acct-ada',
    caller_role: 'host',
    caller_view: 'full',
    group,
    cover: null,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
  }
}

function leesItem() {
  const next = nextOf(state.occurrences)
  return {
    ...base('lees-1', state.title, { id: 'g-1', name: state.name }),
    next_occurrence: next,
    occurrence_count: state.occurrences.length,
  }
}

const COUSINS_ITEM = {
  ...base('cousins-1', 'Cousins Brunch', { id: 'g-2', name: 'Cousins' }),
  caller_role: null,
  next_occurrence: { id: 'occ-c', starts_at: at(5) },
  occurrence_count: 1,
}

function detailBody() {
  return {
    ...base('lees-1', state.title, { id: 'g-1', name: state.name }),
    occurrences: state.occurrences.map((o) => ({
      ...o,
      gathering_id: 'lees-1',
      ends_at: null,
      location: null,
      map_url: null,
      caller_response: null,
    })),
  }
}

function path(url: unknown) {
  return String(url).replace(/^https?:\/\/[^/]+/, '')
}

function stubServer() {
  mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const p = path(url)
    const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
    if (method === 'GET' && p === '/groups') return json(200, { groups: [groupBody(), COUSINS] })
    if (method === 'GET' && p === '/gatherings') return json(200, { gatherings: [leesItem(), COUSINS_ITEM] })
    // The People page's reads.
    if (method === 'GET' && p === '/groups/g-1') return json(200, groupBody())
    if (method === 'GET' && p === '/groups/g-1/members')
      return json(200, {
        members: state.members.map((m) => ({ membership_id: m.id, display_name: m.name, role: m.role, is_self: m.self })),
      })
    if (method === 'GET' && p === '/groups/g-1/link') return json(200, { url: null, expires_at: null })
    if (method === 'GET' && p === '/groups/g-1/join-requests') return json(200, { join_requests: state.requests })
    if (method === 'GET' && p === '/groups/g-1/invitations') return json(200, { pending: [] })
    // The People page's acts.
    if (method === 'PATCH' && p === '/groups/g-1') {
      if (refuse.has('rename'))
        return json(422, { detail: [{ loc: ['body', 'name'], msg: 'String should have at most 200 characters', type: 'string_too_long' }] })
      state.name = body().name.trim()
      return json(200, groupBody())
    }
    const approve = p.match(/^\/groups\/g-1\/join-requests\/([^/]+)\/approve$/)
    if (method === 'POST' && approve) {
      if (refuse.has('approve')) return json(409, { detail: { code: 'already_decided', outcome: 'declined' } })
      const request = state.requests.find((r) => r.id === approve[1])
      state.requests = state.requests.filter((r) => r.id !== approve[1])
      if (request) state.members.push({ id: `mem-${request.id}`, name: request.display_name, role: 'member', self: false })
      return json(200, {})
    }
    const member = p.match(/^\/groups\/g-1\/members\/([^/]+)$/)
    if (method === 'DELETE' && member) {
      if (refuse.has('remove')) return json(422, { detail: { code: 'not_a_member' } })
      state.members = state.members.filter((m) => m.id !== member[1])
      return new Response(null, { status: 204 })
    }
    // The gathering page's reads.
    if (method === 'GET' && p === '/gatherings/lees-1') return json(200, detailBody())
    if (method === 'GET' && p.startsWith('/gatherings/lees-1/media')) return json(200, { media: [] })
    if (method === 'GET' && p === '/gatherings/lees-1/places') return json(200, { invitees_chosen: true, members: [] })
    // The gathering page's acts.
    if (method === 'PATCH' && p === '/gatherings/lees-1') {
      if (refuse.has('save'))
        return json(422, { detail: [{ loc: ['body', 'title'], msg: 'String should have at most 200 characters', type: 'string_too_long' }] })
      const patch = body()
      if (typeof patch.title === 'string') state.title = patch.title
      return json(200, detailBody())
    }
    if (method === 'POST' && p === '/gatherings/lees-1/occurrences') {
      if (refuse.has('add'))
        return json(422, { detail: [{ loc: ['body', 'starts_at'], msg: 'Input should be a valid datetime', type: 'datetime_parsing' }] })
      const added = { id: 'occ-new', starts_at: body().starts_at }
      state.occurrences = [...state.occurrences, added]
      return json(201, { ...added, gathering_id: 'lees-1', ends_at: null, location: null, map_url: null })
    }
    const occurrence = p.match(/^\/occurrences\/([^/?]+)/)
    if (method === 'PATCH' && occurrence) {
      if (refuse.has('edit'))
        return json(422, { detail: [{ loc: ['body', 'starts_at'], msg: 'Input should be a valid datetime', type: 'datetime_parsing' }] })
      const patch = body()
      state.occurrences = state.occurrences.map((o) =>
        o.id === occurrence[1] && typeof patch.starts_at === 'string' ? { ...o, starts_at: patch.starts_at } : o,
      )
      return json(200, {})
    }
    if (method === 'DELETE' && occurrence) {
      if (refuse.has('removeDate'))
        return json(422, { detail: [{ loc: ['path', 'occurrence_id'], msg: 'A gathering keeps at least one date', type: 'value_error' }] })
      state.occurrences = state.occurrences.filter((o) => o.id !== occurrence[1])
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && p === '/billing') return json(404, {})
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', mock)
}

// The GET requests made so far, by path.
function gets(): string[] {
  return mock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
    .map(([url]) => path(url))
}

function writes(method: string, match: RegExp): number {
  return mock.mock.calls.filter(
    ([url, init]) => (init as RequestInit | undefined)?.method === method && match.test(path(url)),
  ).length
}

// The menu's two reads, and the reads it must never make, counted together.
function menuReads() {
  const all = gets()
  return {
    groups: all.filter((p) => p === '/groups').length,
    gatherings: all.filter((p) => p === '/gatherings').length,
    members: all.filter((p) => p.endsWith('/members')).length,
    groupGatherings: all.filter((p) => /^\/groups\/[^/]+\/gatherings/.test(p)).length,
  }
}

function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: wide, media: '', addEventListener: () => {}, removeEventListener: () => {} })),
  )
}

function Probe() {
  const location = useLocation()
  return <span data-testid="at">{location.pathname + location.hash}</span>
}

function renderAt(address: string, layout: MenuLayout, wide = true) {
  chooseMenuLayout(layout)
  stubWidth(wide)
  return render(
    <MemoryRouter initialEntries={[address]}>
      <AuthContext.Provider value={signedIn}>
        <App />
        <Probe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

const where = () => screen.getByTestId('at').textContent
const side = () => document.getElementById('frame-menu') as HTMLElement
const panel = () => side().querySelector('.panel') as HTMLElement
const rail = () => side().querySelector('.rail') as HTMLElement
const oneList = () => side().querySelector('nav.menu') as HTMLElement

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
}

beforeEach(() => {
  clearCoverPictures()
  state = freshState()
  refuse = new Set()
  stubServer()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  chooseMenuLayout('list')
  localStorage.clear()
  document.body.classList.remove('menu-open')
})

// What Rail and panel draws of the group: the panel's heading, the tile's name
// and title, and the People row's line.
function railDraws() {
  const tile = within(rail()).getAllByRole('link').find((a) => a.getAttribute('href') === '/groups/g-1')
  const peopleRow = Array.from(panel().querySelectorAll('.nrows.d a')).find((a) => a.querySelector('b')?.textContent === 'People')
  return {
    heading: panel().querySelector('.dcover h2')?.textContent,
    tile: [tile?.getAttribute('aria-label'), tile?.getAttribute('title')],
    people: peopleRow?.querySelector('.t span')?.textContent,
  }
}

// One list's *Your groups* row for the group: its name and its count.
function listRow() {
  const rows = within(within(oneList()).getByRole('list', { name: 'Your groups' })).getAllByRole('link')
  const row = rows.find((a) => a.getAttribute('href') === '/groups/g-1')
  return [row?.querySelector('b')?.textContent, row?.querySelector('.t span')?.textContent]
}

async function rename(to: string) {
  const form = await screen.findByRole('form', { name: 'Rename the group' })
  fireEvent.change(within(form).getByLabelText('Group name'), { target: { value: to } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
}

async function approveZoe() {
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Approve Zoe' })).getByRole('button', { name: 'Approve Zoe' }))
}

async function removeCal() {
  const list = await screen.findByRole('list', { name: 'Members' })
  const row = within(list)
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.member-name')?.textContent === 'Cal') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Remove from group' }))
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Remove Cal from the group' })).getByRole('button', { name: 'Remove from group' }),
  )
}

// ---------------------------------------------------------------------------
// The People page: a rename, an approval, a removal.
// ---------------------------------------------------------------------------

test('a rename: the panel\'s heading and the tile\'s name and title are new with no page change, by the menu\'s two reads once', async () => {
  renderAt('/groups/g-1/people', 'rail')
  await settle()
  expect(railDraws()).toEqual({ heading: 'The Lees', tile: ['The Lees', 'The Lees'], people: '3 people' })
  const before = menuReads()
  await rename('The Lee Family')
  // The page renders the PATCH's body at once: the crumb says the act landed.
  await waitFor(() => expect(document.querySelector('.crumb a')?.textContent).toBe('The Lee Family'))
  await settle()
  expect(where()).toBe('/groups/g-1/people')
  expect(railDraws()).toEqual({ heading: 'The Lee Family', tile: ['The Lee Family', 'The Lee Family'], people: '3 people' })
  // The menu's two reads, once each; the page's rename re-reads the group and not its members.
  expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1 })
})

test('a rename in One list: the Your groups row is new with no page change', async () => {
  renderAt('/groups/g-1/people', 'list')
  await settle()
  expect(listRow()).toEqual(['The Lees', '3 people'])
  await rename('The Lee Family')
  await waitFor(() => expect(document.querySelector('.crumb a')?.textContent).toBe('The Lee Family'))
  await settle()
  expect(where()).toBe('/groups/g-1/people')
  expect(listRow()).toEqual(['The Lee Family', '3 people'])
})

test('a rename at a phone\'s width: the drawer opened after it shows the new name, with no page change', async () => {
  renderAt('/groups/g-1/people', 'rail', false)
  await settle()
  await rename('The Lee Family')
  await waitFor(() => expect(document.querySelector('.crumb a')?.textContent).toBe('The Lee Family'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  await screen.findByRole('dialog', { name: 'Menu' })
  expect(where()).toBe('/groups/g-1/people')
  expect(railDraws()).toEqual({ heading: 'The Lee Family', tile: ['The Lee Family', 'The Lee Family'], people: '3 people' })
})

for (const layout of ['rail', 'list'] as const) {
  const how = layout === 'rail' ? 'Rail and panel\'s People row' : 'One list\'s row'

  test(`an approval: ${how} counts the new member with no page change, by the menu's two reads once`, async () => {
    renderAt('/groups/g-1/people', layout)
    await settle()
    const before = menuReads()
    await approveZoe()
    await screen.findByText('No one is waiting to join.')
    await settle()
    expect(where()).toBe('/groups/g-1/people')
    if (layout === 'rail') expect(railDraws().people).toBe('4 people')
    else expect(listRow()).toEqual(['The Lees', '4 people'])
    // The page re-reads the members itself, once; the menu reads its two lists and never /members.
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1, members: before.members + 1 })
  })

  test(`a removal: ${how} counts one fewer with no page change, by the menu's two reads once`, async () => {
    renderAt('/groups/g-1/people', layout)
    await settle()
    const before = menuReads()
    await removeCal()
    await waitFor(() =>
      expect(
        Array.from(screen.getByRole('list', { name: 'Members' }).querySelectorAll('.member-name')).map((n) => n.textContent),
      ).toEqual(['Ada Lee', 'Bea']),
    )
    await settle()
    expect(where()).toBe('/groups/g-1/people')
    if (layout === 'rail') expect(railDraws().people).toBe('2 people')
    else expect(listRow()).toEqual(['The Lees', '2 people'])
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1, members: before.members + 1 })
  })
}

// ---------------------------------------------------------------------------
// A gathering's page: Edit gathering's save, and a date added, edited, removed.
// ---------------------------------------------------------------------------

// The gathering's row as the menu draws it: in a group's panel (Rail and
// panel, the gathering current) or in One list's *Gatherings coming up* — its
// title and its line, or null when the list does not hold it.
function gatheringRow(layout: MenuLayout): [string | null | undefined, string | null | undefined] | null {
  const scope = layout === 'rail' ? within(panel()).getByRole('list', { name: 'Gatherings' }) : coming()
  if (scope === null) return null
  const row = within(scope)
    .queryAllByRole('link')
    .find((a) => a.getAttribute('href') === '/gatherings/lees-1')
  if (!row) return null
  return [row.querySelector('b')?.textContent, row.querySelector('.t span')?.textContent ?? null]
}

function coming(): HTMLElement | null {
  return within(oneList()).queryByRole('list', { name: 'Gatherings coming up' })
}

const dates = () => document.querySelectorAll('.occurrence-dates > .occurrence-item').length

for (const layout of ['rail', 'list'] as const) {
  const how = layout === 'rail' ? 'the group panel\'s row' : 'One list\'s Gatherings coming up'

  test(`Edit gathering's save: ${how} carries the new title with no page change, by the menu's two reads once`, async () => {
    renderAt('/gatherings/lees-1', layout)
    await settle()
    expect(gatheringRow(layout)?.[0]).toBe('Lees Picnic')
    const before = menuReads()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit gathering' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Lees Lakeside Picnic' } })
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit gathering' })).getByRole('button', { name: 'Save' }))
    await screen.findByRole('heading', { level: 1, name: 'Lees Lakeside Picnic' })
    await settle()
    expect(where()).toBe('/gatherings/lees-1')
    expect(gatheringRow(layout)?.[0]).toBe('Lees Lakeside Picnic')
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1 })
  })

  test(`a date added: ${how} follows the new next date with no page change`, async () => {
    state = freshState([{ id: 'occ-1', starts_at: at(-3) }])
    renderAt('/gatherings/lees-1', layout)
    await settle()
    if (layout === 'rail') expect(gatheringRow(layout)?.[1]).toBe(formatDayWithYear(state.occurrences[0].starts_at, ZONE))
    else expect(gatheringRow(layout)).toBeNull()
    const before = menuReads()
    fireEvent.click(await screen.findByRole('button', { name: 'Add another date' }))
    fireEvent.change(screen.getByLabelText('Starts', { selector: '#add-starts' }), {
      target: { value: instantToWallClock(at(4), ZONE) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add this date' }))
    await waitFor(() => expect(dates()).toBe(2))
    await settle()
    expect(where()).toBe('/gatherings/lees-1')
    const added = state.occurrences.find((o) => o.id === 'occ-new') as Occurrence
    expect(gatheringRow(layout)).toEqual(['Lees Picnic', formatWeekdayDay(added.starts_at, ZONE)])
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1 })
  })

  test(`a date edited: ${how} follows the moved date with no page change`, async () => {
    renderAt('/gatherings/lees-1', layout)
    await settle()
    expect(gatheringRow(layout)?.[1]).toBe(formatWeekdayDay(state.occurrences[0].starts_at, ZONE))
    const before = menuReads()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit this date' }))
    fireEvent.change(screen.getByLabelText('Starts', { selector: '#edit-starts-occ-1' }), {
      target: { value: instantToWallClock(at(9), ZONE) },
    })
    fireEvent.click(within(screen.getByRole('group', { name: 'Edit this date' })).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit this date' })).toBeNull())
    await settle()
    expect(where()).toBe('/gatherings/lees-1')
    expect(gatheringRow(layout)).toEqual(['Lees Picnic', formatWeekdayDay(state.occurrences[0].starts_at, ZONE)])
    expect(Date.parse(state.occurrences[0].starts_at)).toBeGreaterThan(Date.now() + 8 * DAY)
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1 })
  })

  test(`a date removed: ${how} follows what is left with no page change`, async () => {
    state = freshState([
      { id: 'occ-1', starts_at: at(2) },
      { id: 'occ-2', starts_at: at(-3) },
    ])
    renderAt('/gatherings/lees-1', layout)
    await settle()
    expect(gatheringRow(layout)?.[1]).toBe(formatWeekdayDay(state.occurrences[0].starts_at, ZONE))
    const before = menuReads()
    const first = document.querySelector('.occurrence-dates > .occurrence-item') as HTMLElement
    fireEvent.click(within(first).getByRole('button', { name: 'Remove this date' }))
    await waitFor(() => expect(dates()).toBe(1))
    await settle()
    expect(where()).toBe('/gatherings/lees-1')
    // The one date left is past: the panel's line says so, and One list no longer counts it coming up.
    if (layout === 'rail') expect(gatheringRow(layout)).toEqual(['Lees Picnic', formatDayWithYear(state.occurrences[0].starts_at, ZONE)])
    else expect(gatheringRow(layout)).toBeNull()
    expect(menuReads()).toEqual({ ...before, groups: before.groups + 1, gatherings: before.gatherings + 1 })
  })
}

// ---------------------------------------------------------------------------
// A refused act announces nothing.
// ---------------------------------------------------------------------------

test('a refused rename, approval or removal re-reads nothing and the menu keeps what it drew', async () => {
  const acts: [string, () => Promise<void>, () => number][] = [
    ['rename', () => rename('The Lee Family'), () => writes('PATCH', /^\/groups\/g-1$/)],
    ['approve', approveZoe, () => writes('POST', /\/approve$/)],
    ['remove', removeCal, () => writes('DELETE', /\/members\//)],
  ]
  for (const [name, run, sent] of acts) {
    state = freshState()
    refuse = new Set([name])
    renderAt('/groups/g-1/people', 'rail')
    await settle()
    const before = menuReads()
    await run()
    await waitFor(() => expect(sent(), name).toBe(1))
    await settle()
    await settle()
    expect(menuReads(), name).toEqual(before)
    expect(railDraws(), name).toEqual({ heading: 'The Lees', tile: ['The Lees', 'The Lees'], people: '3 people' })
    cleanup()
  }
})

test('a refused gathering save, date added, date edited or date removed re-reads nothing', async () => {
  const acts: [string, () => Promise<void>, () => number][] = [
    [
      'save',
      async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Edit gathering' }))
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Lees Lakeside Picnic' } })
        fireEvent.click(within(screen.getByRole('form', { name: 'Edit gathering' })).getByRole('button', { name: 'Save' }))
      },
      () => writes('PATCH', /^\/gatherings\/lees-1$/),
    ],
    [
      'add',
      async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Add another date' }))
        fireEvent.change(screen.getByLabelText('Starts', { selector: '#add-starts' }), {
          target: { value: instantToWallClock(at(4), ZONE) },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Add this date' }))
      },
      () => writes('POST', /\/occurrences$/),
    ],
    [
      'edit',
      async () => {
        // The first of the two dates, occ-1, in the body's order.
        fireEvent.click((await screen.findAllByRole('button', { name: 'Edit this date' }))[0])
        fireEvent.change(screen.getByLabelText('Starts', { selector: '#edit-starts-occ-1' }), {
          target: { value: instantToWallClock(at(9), ZONE) },
        })
        fireEvent.click(within(screen.getByRole('group', { name: 'Edit this date' })).getByRole('button', { name: 'Save' }))
      },
      () => writes('PATCH', /^\/occurrences\//),
    ],
    [
      'removeDate',
      async () => {
        const first = (await screen.findAllByRole('button', { name: 'Remove this date' }))[0]
        fireEvent.click(first)
      },
      () => writes('DELETE', /^\/occurrences\//),
    ],
  ]
  for (const [name, run, sent] of acts) {
    state = freshState([
      { id: 'occ-1', starts_at: at(2) },
      { id: 'occ-2', starts_at: at(-3) },
    ])
    refuse = new Set([name])
    const line = formatWeekdayDay(state.occurrences[0].starts_at, ZONE)
    renderAt('/gatherings/lees-1', 'rail')
    await settle()
    expect(gatheringRow('rail'), name).toEqual(['Lees Picnic', line])
    const before = menuReads()
    await run()
    await waitFor(() => expect(sent(), name).toBe(1))
    await settle()
    await settle()
    expect(menuReads(), name).toEqual(before)
    expect(gatheringRow('rail'), name).toEqual(['Lees Picnic', line])
    cleanup()
  }
})
