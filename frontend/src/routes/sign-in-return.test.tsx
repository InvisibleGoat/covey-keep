// CK-79 — the sign-in return, through the app's REAL route table with the
// REAL AuthProvider over the real session store (the CK-76.1 Gotcha: a flow
// that crosses RequireAuth is tested with RequireAuth in the tree exactly as
// it is in the app, never under a hand-built context).
//
// The value under test: a signed-out visit to a gated page is turned away
// to `/` with its path and query PARKED — never its fragment — and the
// sign-in callback brings the person back there; with nothing parked the
// callback lands on Home, a parked CK-25 invitation token still lands on its
// acceptance screen, and a hostile or stale parked path lands on Home. A
// sign-out, or a 401 that ends a session this page load held, parks
// NOTHING — the next person to sign in on a shared device lands on Home,
// never on the last one's page — and a sign-out clears whatever was parked.
// A stored session that fails its first check is a signed-out visit.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { useAuth } from '../auth/useAuth'
import { readInvitationToken, storeInvitationToken } from '../lib/invitations'
import { RETURN_PATH_KEY, RETURN_PATH_TTL } from '../lib/returnPath'
import { getToken, setToken } from '../lib/session'

const person = {
  id: 'person-bea',
  display_name: 'Bea',
  email: 'bea@example.com',
  // A set zone, so the provider's first-sign-in capture never PATCHes.
  timezone: 'America/Chicago',
  account_id: 'acct-bea',
}

const group = {
  id: 'g-1',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-ada',
  member_count: 2,
  caller_role: 'member',
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
}

const members = {
  members: [
    { membership_id: 'm-ada', display_name: 'Ada', role: 'admin', is_self: false },
    { membership_id: 'm-bea', display_name: 'Bea', role: 'member', is_self: true },
  ],
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

type Responder = (init?: RequestInit) => Response

// Every request the route table can make, answered locally. `over` replaces
// a route by "METHOD /path".
function stubServer(over: Record<string, Responder> = {}) {
  const calls: string[] = []
  const fetchStub = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    const key = `${init?.method ?? 'GET'} ${path}`
    calls.push(key)
    const respond = over[key]
    if (respond) return Promise.resolve(respond(init))
    switch (key) {
      case 'GET /health':
        return Promise.resolve(json(200, { status: 'ok' }))
      case 'GET /auth/me':
        return Promise.resolve(json(200, person))
      case 'POST /auth/logout':
        return Promise.resolve(new Response(null, { status: 204 }))
      case 'GET /groups/g-1':
        return Promise.resolve(json(200, group))
      case 'GET /groups/g-1/members':
        return Promise.resolve(json(200, members))
      case 'GET /groups/g-1/link':
        return Promise.resolve(json(200, { url: null, expires_at: null }))
      case 'GET /billing':
        return Promise.resolve(json(500, {}))
      case 'GET /me/passkeys':
        return Promise.resolve(json(200, []))
      case 'POST /invitations/accept':
        return Promise.resolve(json(200, { status: 'used', gathering_id: null }))
      default:
        return Promise.resolve(json(404, { detail: 'Not Found' }))
    }
  })
  vi.stubGlobal('fetch', fetchStub)
  return { calls }
}

function LocationProbe() {
  const location = useLocation()
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
      {location.hash}
    </span>
  )
}

function AuthProbe() {
  const { status } = useAuth()
  return <span data-testid="auth-status">{status}</span>
}

function renderAppAt(address: string) {
  return render(
    <MemoryRouter initialEntries={[address]}>
      <AuthProvider>
        <App />
        <LocationProbe />
        <AuthProbe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

function locationText() {
  return screen.getByTestId('location').textContent
}

function parked(): { path?: string; parkedAt?: number } | null {
  const raw = localStorage.getItem(RETURN_PATH_KEY)
  return raw === null ? null : (JSON.parse(raw) as { path?: string; parkedAt?: number })
}

// The magic link's landing — a fresh page load, the token in the window's
// fragment (AuthCallback reads `window.location.hash`, not the router's).
async function openSignInLink(session = 'session-new') {
  window.location.hash = `#token=${session}`
  renderAppAt('/auth/callback')
  await waitFor(() => expect(screen.getByTestId('auth-status').textContent).toBe('signedIn'))
}

beforeEach(() => {
  localStorage.clear()
  window.location.hash = ''
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.location.hash = ''
})

test('signed out at /groups/g-1?x=1#frag: turned away to / with /groups/g-1?x=1 parked and no fragment — and the sign-in link then lands there', async () => {
  stubServer()
  renderAppAt('/groups/g-1?x=1#frag')
  await waitFor(() => expect(locationText()).toBe('/'))
  await waitFor(() => expect(parked()?.path).toBe('/groups/g-1?x=1'))
  const raw = localStorage.getItem(RETURN_PATH_KEY) ?? ''
  expect(raw).not.toContain('#')
  expect(raw).not.toContain('frag')
  cleanup()

  await openSignInLink()
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  expect(locationText()).toBe('/groups/g-1?x=1')
  expect(getToken()).toBe('session-new')
  // Taken once: nothing is left parked to resurface later.
  expect(parked()).toBeNull()
  // The fragment was stripped from the window's address bar.
  expect(window.location.hash).toBe('')
})

test('signed out at /plan: parked, and the sign-in link lands on /plan', async () => {
  stubServer()
  renderAppAt('/plan')
  await waitFor(() => expect(parked()?.path).toBe('/plan'))
  cleanup()
  await openSignInLink()
  await waitFor(() => expect(locationText()).toBe('/plan'))
})

test('nothing parked: the sign-in link lands on /home', async () => {
  stubServer()
  await openSignInLink()
  await screen.findByRole('heading', { level: 1, name: 'Welcome, Bea' })
  expect(locationText()).toBe('/home')
})

test('a parked CK-25 invitation token and no return path: the sign-in link still lands on /invitations/accept', async () => {
  stubServer()
  storeInvitationToken('tok-25')
  await openSignInLink()
  await waitFor(() => expect(locationText()).toBe('/invitations/accept'))
  // The acceptance screen took it from there, as CK-25 built it.
  await screen.findByRole('heading', { level: 1, name: 'This invitation has already been used' })
  expect(readInvitationToken()).toBeNull()
})

test('a hostile or a stale parked path lands on /home, and is cleared', async () => {
  const now = Date.now()
  for (const entry of [
    { path: '//evil.example', parkedAt: now },
    { path: 'https://evil.example/groups/g-1', parkedAt: now },
    { path: '/\\evil.example', parkedAt: now },
    { path: 'javascript:alert(1)', parkedAt: now },
    { path: '/groups/g-1#token=abc', parkedAt: now },
    { path: '/groups/g-1', parkedAt: now - RETURN_PATH_TTL - 60_000 },
  ]) {
    stubServer()
    localStorage.setItem(RETURN_PATH_KEY, JSON.stringify(entry))
    await openSignInLink()
    await screen.findByRole('heading', { level: 1, name: 'Welcome, Bea' })
    expect(locationText(), JSON.stringify(entry)).toBe('/home')
    expect(parked()).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  }
})

test('a sign-out parks nothing — and clears what was parked: Home’s Sign out lands on / with nothing parked, and the next sign-in lands on /home', async () => {
  stubServer()
  setToken('session-old')
  // Something left parked earlier in the day, on this device.
  localStorage.setItem(RETURN_PATH_KEY, JSON.stringify({ path: '/plan', parkedAt: Date.now() }))
  renderAppAt('/home')
  await screen.findByRole('heading', { level: 1, name: 'Welcome, Bea' })
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(locationText()).toBe('/'))
  expect(screen.getByTestId('auth-status').textContent).toBe('signedOut')
  expect(parked()).toBeNull()
  cleanup()

  await openSignInLink('session-next')
  await screen.findByRole('heading', { level: 1, name: 'Welcome, Bea' })
  expect(locationText()).toBe('/home')
})

test('a 401 that ends a session on a page that was signed in parks nothing: /settings, revoked mid-page, back to / with nothing parked; the next sign-in lands on /home', async () => {
  stubServer({ 'GET /billing': () => json(401, { detail: 'Not authenticated' }) })
  setToken('session-old')
  renderAppAt('/settings')
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  // The billing read's 401 clears the session (authFetch's rule) and the
  // guard turns the page away — without parking it.
  await waitFor(() => expect(locationText()).toBe('/'))
  expect(getToken()).toBeNull()
  expect(parked()).toBeNull()
  cleanup()

  await openSignInLink('session-next')
  await screen.findByRole('heading', { level: 1, name: 'Welcome, Bea' })
  expect(locationText()).toBe('/home')
})

test('a stored session that fails its first check is a signed-out visit: /groups/g-1 is parked, and the sign-in link returns there', async () => {
  stubServer({ 'GET /auth/me': () => json(401, { detail: 'Not authenticated' }) })
  setToken('session-stale')
  renderAppAt('/groups/g-1')
  await waitFor(() => expect(locationText()).toBe('/'))
  await waitFor(() => expect(parked()?.path).toBe('/groups/g-1'))
  cleanup()
  vi.unstubAllGlobals()

  stubServer()
  await openSignInLink()
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  expect(locationText()).toBe('/groups/g-1')
})

test('the join landing’s return: signed out at /groups/join with a link, Sign in to ask to join parks /groups/join, and the sign-in link brings the holder back to ask — nothing asked on the way', async () => {
  const { calls } = stubServer({
    'POST /group-links/preview': () => json(200, { status: 'valid', group_name: 'The Lees' }),
  })
  window.location.hash = '#token=tok-link'
  renderAppAt('/groups/join')
  await screen.findByRole('heading', { level: 1, name: 'Join The Lees' })
  fireEvent.click(screen.getByRole('link', { name: 'Sign in to ask to join' }))
  await waitFor(() => expect(locationText()).toBe('/'))
  expect(parked()?.path).toBe('/groups/join')
  cleanup()

  await openSignInLink()
  await screen.findByRole('heading', { level: 1, name: 'Join The Lees?' })
  expect(locationText()).toBe('/groups/join')
  expect(calls).not.toContain('POST /group-links/join')
  expect(calls.filter((call) => call === 'POST /group-links/preview')).toHaveLength(2)
})
