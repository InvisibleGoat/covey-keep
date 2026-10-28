// CK-79 — /groups/join, the group link's landing. The value under test: the
// fragment is consumed once, stripped and parked, and picked back up on the
// return leg; the preview comes first, signed in or out, and every dead
// token has its own screen; NOTHING IS SENT ON OPENING — a signed-in holder
// asks to join with a press, and only then (Steven, 2026-10-27); signed out,
// Sign in to ask to join parks this address as the sign-in return; each
// outcome of asking has its screen, and the parked token is cleared at every
// terminal one; no screen promises a notice.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { readGroupLinkToken, storeGroupLinkToken } from '../lib/groupJoining'
import { RETURN_PATH_KEY } from '../lib/returnPath'
import { GroupJoin } from './GroupJoin'
import joinSource from './GroupJoin.tsx?raw'
import acceptSource from './GroupInvitationAccept.tsx?raw'
import detailSource from './GroupDetail.tsx?raw'
import callbackSource from './AuthCallback.tsx?raw'
import invitationSource from './InvitationAccept.tsx?raw'
import guardSource from '../components/RequireAuth.tsx?raw'
import providerSource from '../auth/AuthContext.tsx?raw'
import contextSource from '../auth/context.ts?raw'
import returnPathSource from '../lib/returnPath.ts?raw'
import joiningSource from '../lib/groupJoining.ts?raw'
import appSource from '../App.tsx?raw'

const person: Person = {
  id: 'person-bea',
  display_name: 'Bea',
  email: 'bea@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-bea',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const signedOut: AuthState = { ...signedIn, status: 'signedOut', person: null }

// The screen's copy, as rendered literals.
const SIGNED_OUT_LINE =
  'Sign in, or create your account, to ask to join. An admin or co-admin approves each request.'
const CONSENT_LINE = "When you ask, the group's admin and co-admins will see your name, Bea."
const REQUEST_IN_LINE =
  "An admin or co-admin of The Lees will see it. You won't get a message when they decide — if they approve it, the group will be in Your groups."
const RATE_LIMITED = 'Many people are asking to join this group just now — try again in a few minutes.'
const NETWORK = "Couldn't reach the server. Check your connection and try again."
const FORBIDDEN = /\bsafe|secure|private|forever|backed up|\bevents?\b|notif|we'll let you know|you'll hear|we'll tell/i

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderJoin(auth: AuthState) {
  return render(
    <MemoryRouter initialEntries={['/groups/join']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/groups/join" element={<GroupJoin />} />
          <Route path="/groups/:id" element={<p>group-page-stub</p>} />
          <Route path="/groups" element={<p>your-groups-stub</p>} />
          <Route path="/home" element={<p>home-stub</p>} />
          <Route path="/" element={<p>sign-in-stub</p>} />
        </Routes>
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

interface Server {
  preview?: () => Response
  join?: () => Response
}

function stubServer(server: Server) {
  const mock = vi.fn((url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (path === '/group-links/preview') {
      return Promise.resolve((server.preview ?? (() => json(200, { status: 'valid', group_name: 'The Lees' })))())
    }
    if (path === '/group-links/join') {
      return Promise.resolve((server.join ?? (() => json(500, {})))())
    }
    throw new Error(`no stub for ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function pathsOf(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
}

function bodyOf(mock: ReturnType<typeof vi.fn>, index: number): unknown {
  const [, init] = mock.mock.calls[index] as unknown as [string, RequestInit]
  return JSON.parse(String(init.body))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.location.hash = ''
})

// ---------------------------------------------------------------------------
// The fragment, the preview, and nothing sent on opening.
// ---------------------------------------------------------------------------

test('signed out with a valid link: the fragment is consumed and parked, the preview names the group, and Sign in to ask to join parks this address and goes to /', async () => {
  const mock = stubServer({})
  window.location.hash = '#token=tok-abc'
  renderJoin(signedOut)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Join The Lees')
  expect(screen.getByText(SIGNED_OUT_LINE)).toBeTruthy()
  // The raw token left the address bar and parked for the round trip.
  expect(window.location.hash).toBe('')
  expect(readGroupLinkToken()).toBe('tok-abc')
  // The preview — and nothing else: no join request on opening.
  expect(pathsOf(mock)).toEqual(['/group-links/preview'])
  expect(bodyOf(mock, 0)).toEqual({ token: 'tok-abc' })
  expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()

  const signIn = screen.getByRole('link', { name: 'Sign in to ask to join' })
  expect(signIn.getAttribute('href')).toBe('/')
  fireEvent.click(signIn)
  expect(await screen.findByText('sign-in-stub')).toBeTruthy()
  const parked = JSON.parse(localStorage.getItem(RETURN_PATH_KEY) ?? '{}') as { path?: string }
  expect(parked.path).toBe('/groups/join')
  // The token stays parked for the return leg.
  expect(readGroupLinkToken()).toBe('tok-abc')
  expect(pathsOf(mock)).toEqual(['/group-links/preview'])
})

test('signed in with a valid link: the preview, the consent line naming them, Ask to join and Not now — and no join request until the press', async () => {
  const mock = stubServer({})
  window.location.hash = '#token=tok-abc'
  renderJoin(signedIn)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Join The Lees?')
  expect(screen.getByText(CONSENT_LINE)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Ask to join' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  // Settle anything pending, then confirm nothing but the preview went out.
  await waitFor(() => expect(pathsOf(mock)).toEqual(['/group-links/preview']))
  expect(readGroupLinkToken()).toBe('tok-abc')
})

test('the return leg: no fragment, the parked token is previewed — and a signed-in return still waits for the press', async () => {
  storeGroupLinkToken('tok-parked')
  const mock = stubServer({})
  renderJoin(signedIn)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Join The Lees?')
  expect(pathsOf(mock)).toEqual(['/group-links/preview'])
  expect(bodyOf(mock, 0)).toEqual({ token: 'tok-parked' })
})

test('no token anywhere: the did-not-work screen, and no request goes out', async () => {
  const mock = stubServer({})
  renderJoin(signedOut)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe("That link didn't work")
  expect(
    screen.getByText("The link looks incomplete or isn't valid. Ask someone in the group to send it again."),
  ).toBeTruthy()
  expect(mock).not.toHaveBeenCalled()
})

for (const [seat, auth] of [
  ['signed out', signedOut],
  ['signed in', signedIn],
] as const) {
  for (const [status, heading, line] of [
    ['expired', 'This link has expired', 'Group links last 7 days. Ask someone in the group for the current one.'],
    ['revoked', 'This link has been turned off', 'Ask someone in the group for the current link.'],
    ['invalid', "That link didn't work", "The link looks incomplete or isn't valid. Ask someone in the group to send it again."],
  ] as const) {
    test(`${seat}, a ${status} link on preview: its own screen, the parked token cleared, nothing asked`, async () => {
      const mock = stubServer({ preview: () => json(200, { status, group_name: null }) })
      window.location.hash = '#token=tok-dead'
      renderJoin(auth)
      expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(heading)
      expect(screen.getByText(line)).toBeTruthy()
      expect(readGroupLinkToken()).toBeNull()
      expect(pathsOf(mock)).toEqual(['/group-links/preview'])
      expect(screen.queryByRole('button', { name: 'Ask to join' })).toBeNull()
    })
  }
}

test('a preview that fails: Something went wrong, the token kept, and Try again previews once more', async () => {
  let fail = true
  const mock = stubServer({
    preview: () => (fail ? json(500, {}) : json(200, { status: 'valid', group_name: 'The Lees' })),
  })
  window.location.hash = '#token=tok-abc'
  renderJoin(signedOut)
  expect((await screen.findByRole('alert')).textContent).toBe("The link couldn't be checked just now.")
  expect(readGroupLinkToken()).toBe('tok-abc')
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Join The Lees')
  expect(pathsOf(mock)).toEqual(['/group-links/preview', '/group-links/preview'])
})

// ---------------------------------------------------------------------------
// Asking to join: one press, one request, and each outcome its screen.
// ---------------------------------------------------------------------------

async function askAs(server: Server) {
  const mock = stubServer(server)
  window.location.hash = '#token=tok-abc'
  renderJoin(signedIn)
  fireEvent.click(await screen.findByRole('button', { name: 'Ask to join' }))
  return mock
}

test('Ask to join → requested: one join request with the token, Your request is in, the way on — and the parked token cleared', async () => {
  const mock = await askAs({ join: () => json(200, { status: 'requested', group_id: null }) })
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Your request is in')
  expect(screen.getByText(REQUEST_IN_LINE)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Your groups' }).getAttribute('href')).toBe('/groups')
  expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/home')
  expect(pathsOf(mock)).toEqual(['/group-links/preview', '/group-links/join'])
  expect(bodyOf(mock, 1)).toEqual({ token: 'tok-abc' })
  expect(readGroupLinkToken()).toBeNull()
  expect(document.body.textContent).not.toMatch(FORBIDDEN)
})

test('Ask to join → pending: the same screen, headed You’ve already asked to join, and the token cleared', async () => {
  await askAs({ join: () => json(200, { status: 'pending', group_id: null }) })
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe("You've already asked to join")
  expect(screen.getByText(REQUEST_IN_LINE)).toBeTruthy()
  expect(readGroupLinkToken()).toBeNull()
})

test('Ask to join → already_member: straight to the group’s page, and the token cleared', async () => {
  await askAs({ join: () => json(200, { status: 'already_member', group_id: 'g-7' }) })
  expect(await screen.findByText('group-page-stub')).toBeTruthy()
  expect(screen.getByTestId('location').textContent).toBe('/groups/g-7')
  expect(readGroupLinkToken()).toBeNull()
})

for (const [status, heading] of [
  ['expired', 'This link has expired'],
  ['revoked', 'This link has been turned off'],
  ['invalid', "That link didn't work"],
] as const) {
  test(`Ask to join → a ${status} link at the press: its screen, and the token cleared`, async () => {
    await askAs({ join: () => json(200, { status, group_id: null }) })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(heading)
    expect(readGroupLinkToken()).toBeNull()
  })
}

test('Ask to join → a 429: the line, the button live again, the token kept — and a second press asks again', async () => {
  let limited = true
  const mock = await askAs({
    join: () => (limited ? json(429, { detail: 'SERVER WORDING' }) : json(200, { status: 'requested', group_id: null })),
  })
  expect((await screen.findByRole('alert')).textContent).toContain(RATE_LIMITED)
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  const ask = screen.getByRole('button', { name: 'Ask to join' }) as HTMLButtonElement
  expect(ask.disabled).toBe(false)
  expect(readGroupLinkToken()).toBe('tok-abc')
  limited = false
  fireEvent.click(ask)
  expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Your request is in')
  expect(pathsOf(mock)).toEqual(['/group-links/preview', '/group-links/join', '/group-links/join'])
})

test('Ask to join → a network failure: the app’s line, the button live again, the token kept', async () => {
  const mock = stubServer({})
  window.location.hash = '#token=tok-abc'
  renderJoin(signedIn)
  const ask = await screen.findByRole('button', { name: 'Ask to join' })
  mock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
  fireEvent.click(ask)
  expect((await screen.findByRole('alert')).textContent).toContain(NETWORK)
  expect((screen.getByRole('button', { name: 'Ask to join' }) as HTMLButtonElement).disabled).toBe(false)
  expect(readGroupLinkToken()).toBe('tok-abc')
})

test('Not now: no request, the token cleared, and Home', async () => {
  const mock = stubServer({})
  window.location.hash = '#token=tok-abc'
  renderJoin(signedIn)
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
  expect(await screen.findByText('home-stub')).toBeTruthy()
  expect(readGroupLinkToken()).toBeNull()
  expect(pathsOf(mock)).toEqual(['/group-links/preview'])
})

test('a signed-in holder with no profile loaded: the consent line without a name, still truthful', async () => {
  stubServer({})
  window.location.hash = '#token=tok-abc'
  renderJoin({ ...signedIn, person: null })
  expect(await screen.findByText("When you ask, the group's admin and co-admins will see your name.")).toBeTruthy()
})

test('no screen of the landing names a ban word or promises a notice', async () => {
  for (const [auth, server] of [
    [signedOut, {}],
    [signedIn, {}],
    [signedIn, { preview: () => json(200, { status: 'expired', group_name: null }) }],
    [signedIn, { preview: () => json(200, { status: 'revoked', group_name: null }) }],
  ] as [AuthState, Server][]) {
    stubServer(server)
    window.location.hash = '#token=tok-abc'
    renderJoin(auth)
    await screen.findByRole('heading', { level: 1 })
    expect(document.body.textContent).not.toMatch(FORBIDDEN)
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  }
})

// ---------------------------------------------------------------------------
// The brand rule over every new or changed source (CK-79).
// ---------------------------------------------------------------------------

test('no new or changed source spells the product name — it flows from brand.ts', () => {
  // `/covey ?keep/i`, the CK-74 form: two of these modules carry the
  // `covey-keep:` storage-key slug, which is the filesystem convention, not
  // the product's name.
  for (const source of [
    joinSource,
    acceptSource,
    detailSource,
    callbackSource,
    invitationSource,
    guardSource,
    providerSource,
    contextSource,
    returnPathSource,
    joiningSource,
    appSource,
  ]) {
    expect(source).not.toMatch(/covey ?keep/i)
  }
})
