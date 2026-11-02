// CK-78 pins on your groups and starting one (Groups 3a). The value under
// test: the way to the list comes above the gatherings (Home's links until
// CK-82, the frame's sections since); the list is ONE request
// and, since CK-85, the mockup's layout — *Groups* and New group, the first
// group as the featured card and the rest under *More groups*, each card one
// link with its count in people ("1 person" for one) and the caller's own
// role, in the server's order; the empty state is a real screen
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
// The People page holds what the group's page held until CK-86, so the brand
// pin reads it too.
import groupPeopleSource from './GroupPeople.tsx?raw'

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

// MOVED AT CK-82, with its reason: until CK-82 this pinned Home's two links,
// Your groups above Your gatherings. Home is retired (the merge record
// §1.4); the frame's bottom bar carries the sections, Groups first and
// Gatherings after it — what the pin always held.
test('the way to Your groups comes above the gatherings: the frame’s Groups tab precedes its Gatherings tab', async () => {
  renderAppAt('/groups', signedIn, (url) =>
    url.endsWith('/gatherings') ? json(200, { gatherings: [] }) : json(200, { groups: [group()] }),
  )
  // MOVED AT CK-85, with its reason: the page's heading is the mockup's
  // *Groups* since CK-85 (it read *Your groups*); the pin is the tabs' order.
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  const bar = screen.getByRole('navigation', { name: 'Sections' })
  const groups = within(bar).getByRole('link', { name: 'Groups' })
  const gatherings = within(bar).getByRole('link', { name: 'Gatherings' })
  expect(groups.getAttribute('href')).toBe('/groups')
  expect(groups.compareDocumentPosition(gatherings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('the route table reaches the list, the form, a group page and its People page, each behind sign-in', async () => {
  renderAppAt('/groups', signedIn, () => json(200, { groups: [group()] }))
  // MOVED AT CK-85, with its reason: the list's heading is the mockup's
  // *Groups* since CK-85.
  expect(await screen.findByRole('heading', { level: 1, name: 'Groups' })).toBeTruthy()
  cleanup()

  renderAppAt('/groups/new', signedIn, () => json(500, {}))
  // MOVED AT CK-86, with its reason: the form is headed *New group*.
  expect(screen.getByRole('heading', { level: 1, name: 'New group' })).toBeTruthy()
  cleanup()

  renderAppAt('/groups/g-1', signedIn, (url) =>
    url.endsWith('/members')
      ? json(200, { members: [{ membership_id: 'm-1', display_name: 'Ada', role: 'admin', is_self: true }] })
      : json(200, group()),
  )
  expect(await screen.findByRole('heading', { level: 1, name: 'The Lees' })).toBeTruthy()
  cleanup()

  // The People page (CK-86): its own route, `/groups/:id/people`.
  renderAppAt('/groups/g-1/people', signedIn, (url) =>
    url.endsWith('/members')
      ? json(200, { members: [{ membership_id: 'm-1', display_name: 'Ada', role: 'admin', is_self: true }] })
      : json(200, group()),
  )
  expect(await screen.findByRole('heading', { level: 1, name: 'People' })).toBeTruthy()
  expect(screen.getByTestId('location').textContent).toBe('/groups/g-1/people')
  cleanup()

  // Signed out, a group route is RequireAuth's like every other.
  renderAppAt('/groups', signedOut, () => json(200, { status: 'ok' }))
  expect(screen.getByTestId('location').textContent).toBe('/')
})

for (const [seat, auth] of [
  ['signed out', signedOut],
  ['signed in', signedIn],
] as const) {
  // MOVED AT CK-79, with its reason: until CK-79 `/groups/join` was a static
  // row rendering the catch-all, so the join URL reached "This page isn't
  // available". CK-79 replaces that row with the link's landing. What this
  // pin always held still holds — `/groups/:id` does not swallow the join
  // link, and RequireAuth does not send it to `/` — and the screen it
  // reaches is now the landing's. (The landing reads the WINDOW's fragment;
  // this router's address carries one and the window's holds none, so the
  // landing has no token, says so, and sends nothing.)
  test(`${seat}, /groups/join#token=abc reaches the join landing — the group routes do not swallow the join link`, async () => {
    const fetchStub = renderAppAt('/groups/join#token=abc', auth, () => json(200, {}))
    expect(screen.getByTestId('location').textContent).toBe('/groups/join#token=abc')
    await screen.findByRole('heading', { level: 1, name: "That link didn't work" })
    expect(screen.queryByText("This page isn't available")).toBeNull()
    expect(screen.queryByText('Nothing here')).toBeNull()
    expect(fetchStub).not.toHaveBeenCalled()
  })
}

// ---------------------------------------------------------------------------
// /groups — the list.
// ---------------------------------------------------------------------------

// MOVED AT CK-85, with its reason: until CK-85 this was one test over one
// list — each group a row with its name, "{n} members" and the caller's
// role, and *Start a group* beneath. CK-85 builds the mockup's layout (the
// merge record §3 item 5): the page head's *Groups* and **New group**, the
// first group as the featured card, and the rest under *More groups*; the
// count says people (Steven, 2026-11-01). What it always held still holds —
// one request, the server's order, each group one link to its page, the
// caller's role beside the count, no Back home — and the tests below pin it
// in the new layout.
const THREE = [
  group({ id: 'g-new', name: 'The Lees', member_count: 3, caller_role: 'admin' }),
  group({ id: 'g-mid', name: 'Hawkins Family', member_count: 1, caller_role: 'co_admin' }),
  group({ id: 'g-old', name: 'Cousins', member_count: 12, caller_role: 'member' }),
]

function featuredCard(): HTMLElement {
  const card = document.querySelector('article.cover-hero')
  if (!(card instanceof HTMLElement)) throw new Error('no featured card')
  return card
}

test('the page head: the heading Groups and New group, a link to /groups/new — no lede, no pin, no Pinned, no Active', async () => {
  const mock = vi.fn(() => Promise.resolve(json(200, { groups: THREE })))
  vi.stubGlobal('fetch', mock)
  renderList()
  const heading = await screen.findByRole('heading', { level: 1, name: 'Groups' })
  expect(mock).toHaveBeenCalledTimes(1)
  expect(String((mock.mock.calls[0] as unknown[])[0])).toMatch(/\/groups$/)
  const head = heading.closest('.page-head') as HTMLElement
  const newGroup = within(head).getByRole('link', { name: 'New group' })
  expect(newGroup.getAttribute('href')).toBe('/groups/new')
  expect(newGroup.classList.contains('btn-primary')).toBe(true)
  // The mockup's lede — *Pinned groups first, then the ones with something
  // new.* — is left out: neither pins nor last-active ordering is built.
  expect(head.querySelector('.lede')).toBeNull()
  expect(head.querySelector('p')).toBeNull()
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/Pinned|\bpin\b|\bActive\b|\bago\b|something new/i)
  expect(screen.queryByRole('button', { name: /pin/i })).toBeNull()
  expect(document.querySelector('.pin, .chip')).toBeNull()
  // The populated list's way to a new group is New group now; *Start a
  // group* stays the empty state's words and the form's heading.
  expect(screen.queryByRole('link', { name: 'Start a group' })).toBeNull()
  // MOVED AT CK-82, with its reason: the page's Back home link is gone —
  // Home is retired, and inside the frame the menu is the way around.
  expect(screen.queryByRole('link', { name: 'Back home' })).toBeNull()
  expect(text).not.toMatch(FORBIDDEN)
})

test("the featured card is the first group and More groups holds the rest, in the server's order, each card one link to its page", async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { groups: THREE }))))
  renderList()
  await screen.findByRole('heading', { level: 1, name: 'Groups' })

  // The featured card: the name over the scrim in an <h2> holding the link.
  const featured = featuredCard()
  const title = within(featured).getByRole('heading', { level: 2 })
  expect(title.textContent).toBe('The Lees')
  const featuredLinks = within(featured).getAllByRole('link')
  expect(featuredLinks).toHaveLength(1)
  expect(featuredLinks[0].getAttribute('href')).toBe('/groups/g-new')
  expect(featuredLinks[0].closest('h2')).toBe(title)
  // Open group is a picture of a button: hidden from the accessibility tree,
  // never a second link or a button.
  const open = within(featured).getByText('Open group')
  expect(open.getAttribute('aria-hidden')).toBe('true')
  expect(open.tagName).toBe('SPAN')
  expect(within(featured).queryByRole('button')).toBeNull()

  // More groups: a heading and a grid list it names, the rest in order.
  const moreHeading = screen.getByRole('heading', { level: 2, name: 'More groups' })
  const more = screen.getByRole('list', { name: 'More groups' })
  expect(more.getAttribute('aria-labelledby')).toBe(moreHeading.id)
  expect(featured.compareDocumentPosition(moreHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const cards = more.querySelectorAll(':scope > li > article.cover-tile')
  expect(cards).toHaveLength(2)
  const links = within(more).getAllByRole('link')
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/groups/g-mid', '/groups/g-old'])
  expect(links.map((link) => link.closest('h3')?.textContent)).toEqual(['Hawkins Family', 'Cousins'])
  // Every card is a whole-card link: one link each, the mockup's stretch.
  for (const link of [...featuredLinks, ...links]) expect(link.classList.contains('cover-link')).toBe(true)
  for (const card of cards) expect(within(card as HTMLElement).getAllByRole('link')).toHaveLength(1)
  // Each group appears once on the page.
  expect(screen.getAllByText('The Lees')).toHaveLength(1)
})

test('each meta line is the count in people, with · Admin or · Co-admin only for the caller who holds one', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { groups: THREE }))))
  renderList()
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  expect(featuredCard().querySelector('.cover-hero-meta')?.textContent).toBe('3 people · Admin')
  const more = screen.getByRole('list', { name: 'More groups' })
  expect([...more.querySelectorAll('.cover-meta')].map((line) => line.textContent)).toEqual([
    '1 person · Co-admin',
    '12 people',
  ])
  expect(document.body.textContent).not.toMatch(/\bmembers?\b/)
})

test('one group: the featured card alone, and no More groups heading or list', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { groups: [group()] }))))
  renderList()
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  expect(within(featuredCard()).getByRole('heading', { level: 2, name: 'The Lees' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'More groups' })).toBeNull()
  expect(screen.queryByRole('list')).toBeNull()
  expect(document.querySelector('article.cover-tile')).toBeNull()
})

test('an empty cover on the featured card and on a grid card: the quail and No cover photo yet', async () => {
  // The fixtures carry no `cover`: every card draws the empty cover, and
  // no picture is asked for.
  const mock = vi.fn(() => Promise.resolve(json(200, { groups: THREE })))
  vi.stubGlobal('fetch', mock)
  renderList()
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  const cards = [featuredCard(), ...document.querySelectorAll<HTMLElement>('article.cover-tile')]
  expect(cards).toHaveLength(3)
  for (const card of cards) {
    const empty = card.querySelector('.cover-frame .cover-empty')
    expect(empty?.querySelector('img')?.getAttribute('src')).toBe('/img/covey-keep-quail-640.webp')
    expect(empty?.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(empty?.textContent).toBe('No cover photo yet')
  }
  expect(mock).toHaveBeenCalledTimes(1)
})

test('the empty state is a real screen, as literals, promising nothing without a screen yet', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { groups: [] }))))
  renderList()
  expect(await screen.findByRole('heading', { level: 1, name: 'No groups yet' })).toBeTruthy()
  expect(screen.getByText('Groups you start or join will be listed here.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Start a group' }).getAttribute('href')).toBe('/groups/new')
  // MOVED AT CK-82, with its reason: Back home is gone (Home is retired; the
  // frame's menu is the way around), so Start a group is the screen's one
  // link.
  expect(screen.queryByRole('link', { name: 'Back home' })).toBeNull()
  expect(screen.getAllByRole('link')).toHaveLength(1)
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
  // MOVED AT CK-85, with its reason: the failed read's heading follows its
  // page's, *Groups* since CK-85 (it read *Your groups*); its line is today's.
  expect(screen.getByRole('heading', { level: 1, name: 'Groups' })).toBeTruthy()
  // MOVED AT CK-82, with its reason: Back home is gone with Home.
  expect(screen.queryByRole('link', { name: 'Back home' })).toBeNull()
  expect(mock).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(2))
  expect(screen.getByText('Loading your groups…')).toBeTruthy()
  gate.release?.()
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong loading your groups.')
  expect(mock).toHaveBeenCalledTimes(2)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  // MOVED AT CK-85, with its reason: one group is the featured card alone —
  // no list — so the read that succeeds is seen by its card's heading.
  expect(await screen.findByRole('heading', { level: 2, name: 'The Lees' })).toBeTruthy()
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
  // MOVED AT CK-86, with its reason: the form is headed *New group*, the
  // words of the button that opens it (Steven, 2026-11-01); its submit keeps
  // *Start group*, pinned below, and the empty state's *Start a group* holds.
  expect(screen.getByRole('heading', { level: 1, name: 'New group' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start a group' })).toBeNull()
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
  for (const source of [groupsLibSource, groupsSource, groupNewSource, groupDetailSource, groupPeopleSource]) {
    expect(source.toLowerCase()).not.toContain('covey')
  }
})
