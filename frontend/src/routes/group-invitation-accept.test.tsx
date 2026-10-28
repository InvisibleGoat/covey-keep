// CK-79 — /groups/invitations/accept, the emailed group invitation's
// landing: routes/invitations.test.tsx's acceptance cases (CK-25), on the
// group. The fragment is consumed, stripped and parked; signed out, the
// preview renders the invitation's state — every dead token distinguished —
// and Sign in to accept parks this address as the sign-in return; signed
// in, OPENING ACCEPTS (CK-25's rule — the invitation was addressed to them)
// and lands on the group's page; the parked token is cleared on redemption
// and on any dead state.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { readGroupInvitationToken, storeGroupInvitationToken } from '../lib/groupJoining'
import { readInvitationToken } from '../lib/invitations'
import { RETURN_PATH_KEY } from '../lib/returnPath'
import { GroupInvitationAccept } from './GroupInvitationAccept'

const person: Person = {
  id: 'person-dee',
  display_name: 'Dee',
  email: 'dee@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-dee',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const signedOut: AuthState = { ...signedIn, status: 'signedOut', person: null }

const FORBIDDEN = /\bsafe|secure|private|forever|backed up|\bevents?\b|notif/i

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderAccept(auth: AuthState) {
  return render(
    <MemoryRouter initialEntries={['/groups/invitations/accept']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/groups/invitations/accept" element={<GroupInvitationAccept />} />
          <Route path="/groups/:id" element={<p>group-page-stub</p>} />
          <Route path="/" element={<p>sign-in-stub</p>} />
        </Routes>
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.location.hash = ''
})

test('signed out with a valid token: the fragment is consumed, the token parked, the group named, and Sign in to accept parks this address and goes to /', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(json(200, { status: 'valid', group_name: 'The Lees' })))
  vi.stubGlobal('fetch', fetchMock)
  window.location.hash = '#token=tok-abc'

  renderAccept(signedOut)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
    "You're invited to join The Lees",
  )
  expect(
    screen.getByText("Sign in, or create your account, to accept — you'll come right back here."),
  ).toBeTruthy()

  // The raw token left the address bar and parked for the round trip — on
  // its own key, never CK-25's.
  expect(window.location.hash).toBe('')
  expect(readGroupInvitationToken()).toBe('tok-abc')
  expect(readInvitationToken()).toBeNull()

  // The preview carried the token in a POST body, never a URL.
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/group-invitations/preview')
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-abc' })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  const signIn = screen.getByRole('link', { name: 'Sign in to accept' })
  expect(signIn.getAttribute('href')).toBe('/')
  fireEvent.click(signIn)
  expect(await screen.findByText('sign-in-stub')).toBeTruthy()
  const parked = JSON.parse(localStorage.getItem(RETURN_PATH_KEY) ?? '{}') as { path?: string }
  expect(parked.path).toBe('/groups/invitations/accept')
})

for (const [status, heading, line] of [
  ['expired', 'This invitation has expired', 'Invitations last 7 days. Ask the person who invited you to send a fresh one.'],
  ['revoked', 'This invitation is no longer active', 'It was withdrawn or replaced. Ask the person who invited you to send a fresh one.'],
  ['invalid', "That invitation link didn't work", "The link looks incomplete or isn't valid. Try opening it again from your invitation, or ask for a new one."],
] as const) {
  test(`signed out with a ${status} token: its distinguished screen, and the parked token is cleared`, async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { status, group_name: null }))))
    window.location.hash = '#token=tok-old'
    renderAccept(signedOut)
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(heading)
    expect(screen.getByText(line)).toBeTruthy()
    expect(readGroupInvitationToken()).toBeNull()
  })
}

test('signed in with a valid token: opening accepts, lands on the group’s page, and clears the token', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(json(200, { status: 'accepted', group_id: 'g-9' })))
  vi.stubGlobal('fetch', fetchMock)
  window.location.hash = '#token=tok-go'

  renderAccept(signedIn)
  expect(await screen.findByText('group-page-stub')).toBeTruthy()
  expect(screen.getByTestId('location').textContent).toBe('/groups/g-9')
  expect(readGroupInvitationToken()).toBeNull()

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/group-invitations/accept')
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-go' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('the return leg after sign-in: no fragment, the parked token is redeemed, and already_accepted lands on the group too', async () => {
  storeGroupInvitationToken('tok-parked')
  const fetchMock = vi.fn(() => Promise.resolve(json(200, { status: 'already_accepted', group_id: 'g-9' })))
  vi.stubGlobal('fetch', fetchMock)

  renderAccept(signedIn)
  expect(await screen.findByText('group-page-stub')).toBeTruthy()
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-parked' })
  expect(readGroupInvitationToken()).toBeNull()
})

test('signed in, a token someone else used: the distinguished spent-token screen about the group, and the token cleared', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { status: 'used', group_id: null }))))
  window.location.hash = '#token=tok-spent'

  renderAccept(signedIn)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
    'This invitation has already been used',
  )
  expect(
    screen.getByText(
      'If that was you, sign in with the same account and the group will be in Your groups. Otherwise, ask the person who invited you to send a fresh one.',
    ),
  ).toBeTruthy()
  expect(readGroupInvitationToken()).toBeNull()
})

for (const status of ['expired', 'revoked', 'invalid'] as const) {
  test(`signed in, a ${status} token at accept: its screen, and the token cleared`, async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { status, group_id: null }))))
    window.location.hash = '#token=tok-dead'
    renderAccept(signedIn)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText('group-page-stub')).toBeNull()
    expect(readGroupInvitationToken()).toBeNull()
  })
}

test('a check that fails: Something went wrong, and the token is kept for another try', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(500, {}))))
  window.location.hash = '#token=tok-abc'
  renderAccept(signedIn)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Something went wrong')
  expect(readGroupInvitationToken()).toBe('tok-abc')
})

test('no token anywhere: the did-not-work screen, and no request goes out', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  renderAccept(signedOut)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
    "That invitation link didn't work",
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test('a session that settles after the preview accepts: signed out, then signed in, one preview and one acceptance', async () => {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      String(url).includes('/preview')
        ? json(200, { status: 'valid', group_name: 'The Lees' })
        : json(200, { status: 'accepted', group_id: 'g-9' }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  window.location.hash = '#token=tok-abc'
  const view = renderAccept(signedOut)
  await screen.findByRole('heading', { level: 1, name: "You're invited to join The Lees" })
  view.rerender(
    <MemoryRouter initialEntries={['/groups/invitations/accept']}>
      <AuthContext.Provider value={signedIn}>
        <Routes>
          <Route path="/groups/invitations/accept" element={<GroupInvitationAccept />} />
          <Route path="/groups/:id" element={<p>group-page-stub</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  expect(await screen.findByText('group-page-stub')).toBeTruthy()
  const paths = fetchMock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
  expect(paths).toEqual(['/group-invitations/preview', '/group-invitations/accept'])
})

test('no screen of the landing names a ban word or promises a notice', async () => {
  for (const [auth, body] of [
    [signedOut, { status: 'valid', group_name: 'The Lees' }],
    [signedOut, { status: 'expired', group_name: null }],
    [signedIn, { status: 'used', group_id: null }],
    [signedIn, { status: 'revoked', group_id: null }],
  ] as [AuthState, unknown][]) {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, body))))
    window.location.hash = '#token=tok-abc'
    renderAccept(auth)
    await screen.findByRole('heading', { level: 1 })
    expect(document.body.textContent).not.toMatch(FORBIDDEN)
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  }
})
