// CK-78 pins on your groups and starting one (Groups 3a). The value under
// test: Home links to the list above the gatherings; the list is ONE request
// and shows each group's name, its count ("1 member" for one) and the
// caller's own role, in the server's order; the empty state is a real screen
// that promises nothing without a screen yet; a failed read can be retried —
// Try again re-reads once per press — never "Try again." with nothing to
// press; starting a group sends exactly `{"name"}` (no type, no control for
// one), waits for a non-blank character, lands the server's 422 on the
// field, and navigates to the new group's page; and the route table reaches
// the three screens while the join link CK-75 mints still reaches the
// catch-all, signed in and out (CK-75.1 — the group routes must not swallow
// it). The brand rule runs over every new source file.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import groupsLibSource from '../lib/groups.ts?raw'
import { GroupNew } from './GroupNew'
import groupNewSource from './GroupNew.tsx?raw'
import { Groups } from './Groups'
import groupsSource from './Groups.tsx?raw'
import groupDetailSource from './GroupDetail.tsx?raw'
import { Home } from './Home'

const person: Person = {
  id: 'person-1',
  display_name: 'Ada',
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

const signedOut: AuthState = { ...signedIn, status: 'signedOut', person: null }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    name: 'The Lees',
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-1',
    member_count: 3,
    caller_role: 'admin',
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    ...over,
  }
}

const FORBIDDEN = /\bsafe|secure|private|forever|backed up|\bevents?\b/i

function LocationProbe() {
  const location = useLocation()
  return (
    <span data-testid="location">
      {location.pathname}
      {location.hash}
    </span>
  )
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/groups']}>
      <Routes>
        <Route path="/groups" element={<Groups />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Home, and the route table.
// ---------------------------------------------------------------------------

test('Home links to Your groups, above Your gatherings', () => {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={signedIn}>
        <Home />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  const groups = screen.getByRole('link', { name: 'Your groups' })
  const gatherings = screen.getByRole('link', { name: 'Your gatherings' })
  expect(groups.getAttribute('href')).toBe('/groups')
  expect(groups.compareDocumentPosition(gatherings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

function renderAppAt(address: string, auth: AuthState, respond: (url: string) => Response) {
  const fetchStub = vi.fn((url: string) => Promise.resolve(respond(String(url))))
  vi.stubGlobal('fetch', fetchStub)
  render(
    <MemoryRouter initialEntries={[address]}>
      <AuthContext.Provider value={auth}>
        <App />
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  return fetchStub
}

test('the route table reaches the list, the form and a group page, each behind sign-in', async () => {
  renderAppAt('/groups', signedIn, () => json(200, { groups: [group()] }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Your groups' })).toBeTruthy()
  cleanup()

  renderAppAt('/groups/new', signedIn, () => json(500, {}))
  expect(screen.getByRole('heading', { level: 1, name: 'Start a group' })).toBeTruthy()
  cleanup()

  renderAppAt('/groups/g-1', signedIn, (url) =>
    url.endsWith('/members')
      ? json(200, { members: [{ membership_id: 'm-1', display_name: 'Ada', role: 'admin', is_self: true }] })
      : json(200, group()),
  )
  expect(await screen.findByRole('heading', { level: 1, name: 'The Lees' })).toBeTruthy()
  cleanup()

  // Signed out, a group route is RequireAuth's like every other.
  renderAppAt('/groups', signedOut, () => json(200, { status: 'ok' }))
  expect(screen.getByTestId('location').textContent).toBe('/')
})

for (const [seat, auth] of [
  ['signed out', signedOut],
  ['signed in', signedIn],
] as const) {
  test(`${seat}, /groups/join#token=abc still reaches the catch-all — the group routes do not swallow the join link`, () => {
    const fetchStub = renderAppAt('/groups/join#token=abc', auth, () => json(200, {}))
    expect(screen.getByTestId('location').textContent).toBe('/groups/join#token=abc')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("This page isn't available")
    expect(screen.queryByText('Nothing here')).toBeNull()
    expect(fetchStub).not.toHaveBeenCalled()
  })
}

// ---------------------------------------------------------------------------
// /groups — the list.
// ---------------------------------------------------------------------------

test('the list: one request, each group linking to its page with its name, its count and the caller’s role, in the server’s order', async () => {
  const groups = [
    group({ id: 'g-new', name: 'The Lees', member_count: 3, caller_role: 'admin' }),
    group({ id: 'g-mid', name: 'Hawkins Family', member_count: 1, caller_role: 'co_admin' }),
    group({ id: 'g-old', name: 'Cousins', member_count: 12, caller_role: 'member' }),
  ]
  const mock = vi.fn(() => Promise.resolve(json(200, { groups })))
  vi.stubGlobal('fetch', mock)
  renderList()
  const list = await screen.findByRole('list', { name: 'Your groups' })
  expect(mock).toHaveBeenCalledTimes(1)
  expect(String((mock.mock.calls[0] as unknown[])[0])).toMatch(/\/groups$/)

  const links = within(list).getAllByRole('link')
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/groups/g-new',
    '/groups/g-mid',
    '/groups/g-old',
  ])
  expect(links.map((link) => link.textContent)).toEqual([
    'The Lees3 members · Admin',
    'Hawkins Family1 member · Co-admin',
    'Cousins12 members',
  ])
  expect(screen.getByRole('link', { name: 'Start a group' }).getAttribute('href')).toBe('/groups/new')
  expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/home')
  expect(document.body.textContent).not.toMatch(FORBIDDEN)
})

test('the empty state is a real screen, as literals, promising nothing without a screen yet', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { groups: [] }))))
  renderList()
  expect(await screen.findByRole('heading', { level: 1, name: 'No groups yet' })).toBeTruthy()
  expect(screen.getByText('Groups you start or join will be listed here.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Start a group' }).getAttribute('href')).toBe('/groups/new')
  expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/home')
  expect(screen.getAllByRole('link')).toHaveLength(2)
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/invit|gathering|photo/i)
  expect(text).not.toMatch(FORBIDDEN)
})

test('a failed read says so and can be retried: Try again re-reads once per press, through the loading state, and a read that succeeds renders the list', async () => {
  const gate: { release?: () => void } = {}
  const mock = vi.fn(async () => {
    const read = mock.mock.calls.length
    if (read === 1) return json(500, {})
    if (read === 2) {
      // Held until released, so the loading state between the press and
      // the answer can be seen; then a failure again.
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      return json(503, {})
    }
    return json(200, { groups: [group()] })
  })
  vi.stubGlobal('fetch', mock)
  renderList()

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Something went wrong loading your groups.')
  expect(screen.getByRole('heading', { level: 1, name: 'Your groups' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/home')
  expect(mock).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(2))
  expect(screen.getByText('Loading your groups…')).toBeTruthy()
  gate.release?.()
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong loading your groups.')
  expect(mock).toHaveBeenCalledTimes(2)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('list', { name: 'Your groups' })).toBeTruthy()
  expect(mock).toHaveBeenCalledTimes(3)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

// ---------------------------------------------------------------------------
// /groups/new — starting a group.
// ---------------------------------------------------------------------------

function GroupPageProbe() {
  const location = useLocation()
  return <p data-testid="landed">{location.pathname}</p>
}

function renderNew() {
  return render(
    <MemoryRouter initialEntries={['/groups/new']}>
      <Routes>
        <Route path="/groups/new" element={<GroupNew />} />
        <Route path="/groups/:id" element={<GroupPageProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

test('starting a group: one field and no type control, the button waiting for a non-blank character', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request expected'))))
  renderNew()
  expect(screen.getByRole('heading', { level: 1, name: 'Start a group' })).toBeTruthy()
  const input = screen.getByLabelText('Name') as HTMLInputElement
  expect(input.maxLength).toBe(200)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(document.body.textContent).not.toMatch(/household|congregation|team|club|type/i)
  expect(
    screen.getByText('Most groups are named for a family — the Hawkins Family, the Lees.'),
  ).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')

  const button = screen.getByRole('button', { name: 'Start group' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(input, { target: { value: '   ' } })
  expect(button.disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'The Lees' } })
  expect(button.disabled).toBe(false)
})

test('starting a group: the body is exactly {"name"}, the button says Starting… while it runs, and a 201 lands on the new page', async () => {
  const gate: { release?: () => void } = {}
  const mock = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      gate.release = resolve
    })
    return json(201, group({ id: 'g-new', member_count: 1 }))
  })
  vi.stubGlobal('fetch', mock)
  renderNew()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'The Lees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start group' }))

  const starting = (await screen.findByRole('button', { name: 'Starting…' })) as HTMLButtonElement
  expect(starting.disabled).toBe(true)
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(url)).toMatch(/\/groups$/)
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ name: 'The Lees' })
  expect(String(init.body)).not.toContain('group_type')

  gate.release?.()
  expect((await screen.findByTestId('landed')).textContent).toBe('/groups/g-new')
})

test("starting a group: the server's 422 on name lands on the field, wired to the input; anything else is a form-level line", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json(422, {
          detail: [{ loc: ['body', 'name'], msg: 'Value error, name is limited to 200 characters', type: 'value_error' }],
        }),
      ),
    ),
  )
  renderNew()
  const input = screen.getByLabelText('Name')
  fireEvent.change(input, { target: { value: 'The Lees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start group' }))
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('Name is limited to 200 characters')
  expect(error.id).toBe('error-name')
  expect(input.getAttribute('aria-describedby')).toBe('error-name')
  expect(screen.queryByTestId('landed')).toBeNull()
  // The button is live again for a corrected name.
  expect((screen.getByRole('button', { name: 'Start group' }) as HTMLButtonElement).disabled).toBe(false)
  cleanup()
  vi.unstubAllGlobals()

  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(500, {}))))
  renderNew()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'The Lees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start group' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Something went wrong. Nothing was saved — try again.',
  )
})

// ---------------------------------------------------------------------------
// The brand rule over every new source file.
// ---------------------------------------------------------------------------

test('no new source spells the product name — it flows from brand.ts', () => {
  for (const source of [groupsLibSource, groupsSource, groupNewSource, groupDetailSource]) {
    expect(source.toLowerCase()).not.toContain('covey')
  }
})
