// CK-80 pins on /groups/:id/gatherings/new — a gathering in the group
// (decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §9;
// Steven's answers of 2026-10-27). The values under test: Who it's for lists
// every member but the caller, each with one choice of three in a radio
// group named for them, EVERYONE STARTING INVITED; the two bulk buttons set
// every row; THE BODY: every member Invited sends `group_id` and NEITHER
// list — the whole-group create, pinned on the exact body, so a later
// newcomer is invited too — and the mixed cases send exactly what placesBody
// says; the newcomer line follows the choice; an item-level 422 lands on the
// member's row it names, from its code; a 201 lands on the gathering; a 404
// on either read is one not-found screen; and no membership id is ever in
// the markup. The plain /gatherings/new keeps no group choice.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { wallClockToInstant } from '../lib/datetime'
import { GatheringNew } from './GatheringNew'
import { GroupGatheringNew } from './GroupGatheringNew'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const ZONE = 'America/Chicago'

const person: Person = {
  id: 'person-ada-0000',
  display_name: 'Ada Test',
  email: 'ada@example.com',
  timezone: ZONE,
  account_id: 'acct-ada-0000',
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

// Distinctive membership ids, so a leak would be found anywhere in the markup.
const MEM = {
  ada: 'mem-ada-1111',
  bea: 'mem-bea-2222',
  cee: 'mem-cee-3333',
  dee: 'mem-dee-4444',
}

const GROUP = {
  id: 'g-1',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-ada-0000',
  member_count: 4,
  caller_role: 'admin',
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
}

const MEMBERS = [
  { membership_id: MEM.ada, display_name: 'Ada Test', role: 'admin', is_self: true },
  { membership_id: MEM.bea, display_name: 'Bea Test', role: 'member', is_self: false },
  { membership_id: MEM.cee, display_name: 'Cee Test', role: 'co_admin', is_self: false },
  { membership_id: MEM.dee, display_name: 'Dee Test', role: 'member', is_self: false },
]

type Responder = (init: RequestInit | undefined) => Response

function stubServer(
  over: { group?: Responder; members?: Responder; create?: Responder } = {},
  members = MEMBERS,
) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (method === 'GET' && path === '/groups/g-1') {
      return Promise.resolve((over.group ?? (() => json(200, GROUP)))(init))
    }
    if (method === 'GET' && path === '/groups/g-1/members') {
      return Promise.resolve((over.members ?? (() => json(200, { members })))(init))
    }
    if (method === 'POST' && path === '/gatherings') {
      return Promise.resolve(
        (over.create ?? (() => json(201, { id: 'gath-new-9999', title: 'The Party' })))(init),
      )
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function GatheringProbe() {
  const { id } = useParams()
  return <p data-testid="gathering-page">gathering {id}</p>
}

function renderForm() {
  return render(
    <MemoryRouter initialEntries={['/groups/g-1/gatherings/new']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/groups/:id/gatherings/new" element={<GroupGatheringNew />} />
          <Route path="/gatherings/:id" element={<GatheringProbe />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'New gathering in The Lees' })
}

function rowFor(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

function chosen(name: string): string | null {
  const checked = within(rowFor(name))
    .getAllByRole('radio')
    .find((radio) => (radio as HTMLInputElement).checked)
  return checked ? (checked.closest('label')?.textContent ?? '').trim() : null
}

function choose(name: string, label: string) {
  fireEvent.click(within(rowFor(name)).getByRole('radio', { name: label }))
}

const STARTS = '2026-11-14T18:00'

function fillTheForm() {
  fireEvent.change(screen.getByLabelText('Type of gathering'), { target: { value: 'potluck' } })
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Party' } })
  fireEvent.change(screen.getByLabelText('Starts'), { target: { value: STARTS } })
}

function posts(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return mock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
}

async function submit(mock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const before = posts(mock).length
  fireEvent.click(screen.getByRole('button', { name: 'Create gathering' }))
  await waitFor(() => expect(posts(mock).length).toBe(before + 1))
  return posts(mock)[before]
}

const HINT =
  "Invited people get the dates and the plans, and can add photos. People who see the photos get the photos and nothing else. Someone kept a surprise won't know about this gathering until you let them see the photos."
const NEWCOMER_INVITED = "Anyone who joins The Lees before it's over is invited too."
const NEWCOMER_SEES = "Anyone who joins The Lees before it's over will see the photos."

test('Who it’s for: every member but the caller, in joining order, each a radio group of three named for them, everyone starting Invited', async () => {
  stubServer()
  renderForm()
  await loaded()
  const section = screen.getByRole('region', { name: "Who it's for" })
  expect(within(section).getByText(HINT)).toBeTruthy()
  const groups = within(section).getAllByRole('group').map((g) => g.getAttribute('aria-label') ?? g.querySelector('legend')?.textContent)
  // The caller has no row — the creator becomes the host and has no place.
  expect(within(section).queryByRole('group', { name: 'Ada Test' })).toBeNull()
  expect(groups.map((name) => name?.replace(/^[A-Z?]{1,2}\s/, ''))).toEqual(['Bea Test', 'Cee Test', 'Dee Test'])
  for (const name of ['Bea Test', 'Cee Test', 'Dee Test']) {
    expect(within(rowFor(name)).getAllByRole('radio').map((r) => r.closest('label')?.textContent?.trim())).toEqual([
      'Invited',
      'Sees the photos',
      'Kept a surprise',
    ])
    expect(chosen(name)).toBe('Invited')
  }
  // The initials beside each name, aria-hidden.
  const initialsSpan = rowFor('Bea Test').querySelector('.member-initials')
  expect(initialsSpan?.textContent).toBe('BT')
  expect(initialsSpan?.getAttribute('aria-hidden')).toBe('true')
  expect(within(section).getByText(NEWCOMER_INVITED)).toBeTruthy()
})

test('the two bulk buttons: Let everyone see the photos sets every row and the newcomer line follows; Invite everyone sets them back', async () => {
  stubServer()
  renderForm()
  await loaded()
  fireEvent.click(screen.getByRole('button', { name: 'Let everyone see the photos' }))
  for (const name of ['Bea Test', 'Cee Test', 'Dee Test']) expect(chosen(name)).toBe('Sees the photos')
  expect(screen.getByText(NEWCOMER_SEES)).toBeTruthy()
  expect(screen.queryByText(NEWCOMER_INVITED)).toBeNull()
  // The record's "invite only these; share with everyone else": then the few.
  choose('Bea Test', 'Invited')
  expect(chosen('Bea Test')).toBe('Invited')
  expect(chosen('Cee Test')).toBe('Sees the photos')
  fireEvent.click(screen.getByRole('button', { name: 'Invite everyone' }))
  for (const name of ['Bea Test', 'Cee Test', 'Dee Test']) expect(chosen(name)).toBe('Invited')
  expect(screen.getByText(NEWCOMER_INVITED)).toBeTruthy()
})

test('the newcomer line follows the choice: one member moved away from Invited is enough to make it "will see the photos"', async () => {
  stubServer()
  renderForm()
  await loaded()
  expect(screen.getByText(NEWCOMER_INVITED)).toBeTruthy()
  choose('Dee Test', 'Kept a surprise')
  expect(screen.getByText(NEWCOMER_SEES)).toBeTruthy()
  choose('Dee Test', 'Invited')
  expect(screen.getByText(NEWCOMER_INVITED)).toBeTruthy()
})

test('THE WHOLE-GROUP CREATE: everyone left Invited sends group_id and NEITHER list — pinned on the exact body', async () => {
  const mock = stubServer()
  renderForm()
  await loaded()
  fillTheForm()
  const body = await submit(mock)
  expect(body).toEqual({
    gathering_type: 'potluck',
    title: 'The Party',
    occurrences: [{ starts_at: wallClockToInstant(STARTS, ZONE) }],
    group_id: 'g-1',
  })
  expect('invited' in body).toBe(false)
  expect('left_out' in body).toBe(false)
})

test('the mixed cases send what placesBody says: one who sees the photos, one kept a surprise, nobody invited', async () => {
  const cases: [Record<string, string>, Record<string, unknown>][] = [
    [{ 'Cee Test': 'Sees the photos' }, { invited: [MEM.bea, MEM.dee] }],
    [
      { 'Cee Test': 'Sees the photos', 'Dee Test': 'Kept a surprise' },
      { invited: [MEM.bea], left_out: [MEM.dee] },
    ],
    [
      { 'Bea Test': 'Sees the photos', 'Cee Test': 'Sees the photos', 'Dee Test': 'Sees the photos' },
      { invited: [] },
    ],
  ]
  for (const [choices, lists] of cases) {
    const mock = stubServer()
    renderForm()
    await loaded()
    fillTheForm()
    for (const [name, label] of Object.entries(choices)) choose(name, label)
    const body = await submit(mock)
    const { invited, left_out, group_id } = body as Record<string, unknown>
    expect({ group_id, ...(invited !== undefined ? { invited } : {}), ...(left_out !== undefined ? { left_out } : {}) }).toEqual({
      group_id: 'g-1',
      ...lists,
    })
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('a 201 lands on the new gathering’s page', async () => {
  stubServer()
  renderForm()
  await loaded()
  fillTheForm()
  fireEvent.click(screen.getByRole('button', { name: 'Create gathering' }))
  expect((await screen.findByTestId('gathering-page')).textContent).toBe('gathering gath-new-9999')
})

test('an item-level 422 lands on the row it names — mapped back through the list as sent — from its code, with nothing form-level and "Nothing was created."', async () => {
  const mock = stubServer({
    create: () =>
      json(422, {
        detail: [
          {
            loc: ['body', 'left_out', 0],
            msg: 'SERVER WORDING — nobody is a member of this group by that id',
            type: 'value_error',
            code: 'not_a_member',
          },
        ],
      }),
  })
  renderForm()
  await loaded()
  fillTheForm()
  choose('Bea Test', 'Kept a surprise')
  choose('Dee Test', 'Kept a surprise')
  const body = await submit(mock)
  expect(body.left_out).toEqual([MEM.bea, MEM.dee])
  // left_out[0] is Bea — her row carries the line, Dee's carries none.
  expect(
    await within(rowFor('Bea Test')).findByText(
      "Bea Test isn't in this group any more — go back to the group and start again.",
    ),
  ).toBeTruthy()
  expect(within(rowFor('Dee Test')).queryByRole('alert')).toBeNull()
  expect(screen.getByText('Nothing was created.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  expect(document.body.textContent).not.toContain('left_out')
  expect(screen.queryByTestId('gathering-page')).toBeNull()
})

test('the codes this form cannot produce read as the generic line, on the row they name', async () => {
  const mock = stubServer({
    create: () =>
      json(422, {
        detail: [
          { loc: ['body', 'invited', 1], msg: 'SERVER WORDING', type: 'value_error', code: 'duplicate' },
        ],
      }),
  })
  renderForm()
  await loaded()
  fillTheForm()
  choose('Bea Test', 'Sees the photos')
  await submit(mock)
  // invited = [Cee, Dee]: index 1 is Dee.
  expect(
    await within(rowFor('Dee Test')).findByText('Something went wrong. Nothing was created — try again.'),
  ).toBeTruthy()
})

test('every other 422 stays on its field through the one mapper', async () => {
  const mock = stubServer({
    create: () =>
      json(422, {
        detail: [{ loc: ['body', 'title'], msg: 'Value error, title cannot be empty', type: 'value_error' }],
      }),
  })
  renderForm()
  await loaded()
  fillTheForm()
  await submit(mock)
  expect((await screen.findByText('Title cannot be empty')).id).toBe('error-title')
  expect(screen.queryByText('Nothing was created.')).toBeNull()
})

test('with no other member: "No one else is in The Lees yet.", no choices, and the body sends neither list', async () => {
  const mock = stubServer({}, [MEMBERS[0]])
  renderForm()
  await loaded()
  const section = screen.getByRole('region', { name: "Who it's for" })
  expect(within(section).getByText('No one else is in The Lees yet.')).toBeTruthy()
  expect(within(section).queryAllByRole('radio')).toHaveLength(0)
  expect(within(section).queryByRole('button', { name: 'Invite everyone' })).toBeNull()
  fillTheForm()
  const body = await submit(mock)
  expect(body.group_id).toBe('g-1')
  expect('invited' in body || 'left_out' in body).toBe(false)
})

for (const which of ['group', 'members'] as const) {
  test(`a 404 on the ${which} read is CK-78's one not-found screen, and nothing is posted`, async () => {
    const mock = stubServer({ [which]: () => json(404, { detail: 'No such group.' }) })
    renderForm()
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy()
    expect(screen.getByText("There's no group to show at this address.")).toBeTruthy()
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(posts(mock)).toHaveLength(0)
  })
}

test('a failed read offers Try again, which re-reads both, and a read that succeeds renders the form', async () => {
  let fail = true
  const mock = stubServer({ members: () => (fail ? json(500, {}) : json(200, { members: MEMBERS })) })
  renderForm()
  expect(await screen.findByText('Something went wrong loading this group.')).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await loaded()
  const reads = mock.mock.calls.filter(([url]) => String(url).endsWith('/groups/g-1/members'))
  expect(reads).toHaveLength(2)
})

test('no membership id in the markup — not in a radio group’s name, an id or a label — and the way back is the group', async () => {
  stubServer()
  const view = renderForm()
  await loaded()
  choose('Dee Test', 'Kept a surprise')
  for (const id of Object.values(MEM)) expect(view.container.innerHTML).not.toContain(id)
  expect(screen.getByRole('link', { name: 'Back to The Lees' }).getAttribute('href')).toBe('/groups/g-1')
  expect(document.body.textContent).not.toMatch(/\bsafe|secure|private|forever|backed up|\bevents?\b/i)
  expect(document.body.textContent).not.toMatch(/notif|we'll tell|they'll be told/i)
})

test('the plain /gatherings/new stays standalone: no Who it’s for, no group choice, no group_id in the body', async () => {
  const mock = vi.fn(() => Promise.resolve(json(201, { id: 'gath-solo-1' })))
  vi.stubGlobal('fetch', mock)
  render(
    <MemoryRouter initialEntries={['/gatherings/new']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/gatherings/new" element={<GatheringNew />} />
          <Route path="/gatherings/:id" element={<GatheringProbe />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1, name: 'New gathering' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: "Who it's for" })).toBeNull()
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(screen.queryByText(/group/i)).toBeNull()
  fillTheForm()
  fireEvent.click(screen.getByRole('button', { name: 'Create gathering' }))
  await screen.findByTestId('gathering-page')
  const body = JSON.parse(String((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
  expect(Object.keys(body).sort()).toEqual(['gathering_type', 'occurrences', 'title'])
})
