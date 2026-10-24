// CK-76.1 — the account-deleted screen shows. The value under test: a person
// who deletes their account through Settings lands on /account-deleted and
// reads "Your account is deleted", and their session is gone — in that order.
//
// STEP 1's red run, against the code before this phase: the location `/` and
// the sign-in form, the heading never rendered. `Settings.tsx::handleDelete`
// navigated to /account-deleted and then cleared the session in the same
// tick, counting on one batched render; React Router 7 runs a navigation
// inside `React.startTransition`, so the urgent signed-out update rendered
// FIRST, at /settings, where `RequireAuth` saw signed-out and redirected to
// `/` — and that navigation superseded the one to /account-deleted. The
// lockfile has carried react-router 7.18.2 and React 19.2.8 unchanged since
// CK-6, so the comment that promised the batching was never true of the
// router it was written against; nothing drove the deletion through the real
// route table with `RequireAuth` until this file.
//
// The fix: the deletion navigates FIRST, carrying a one-shot signal in the
// navigation's state, and the confirmation screen clears the session once it
// has rendered — only on that signal, which it then spends. A direct visit to
// /account-deleted, signed in or out, never signs anyone out. Everything here
// renders the app's real route table with the real `AuthProvider` over the
// real session store (`lib/session.ts`), so `RequireAuth` is in the tree
// exactly as it is in the app — the harness of CK-75.1's red-first test.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { useAuth } from '../auth/useAuth'
import { ACCOUNT_DELETED_SIGNAL } from '../lib/accountDeleted'
import { getToken, setToken } from '../lib/session'
import signalSource from '../lib/accountDeleted.ts?raw'
import deletedSource from './AccountDeleted.tsx?raw'
import settingsSource from './Settings.tsx?raw'

// The copy, as rendered literals — CK-8's, word for word.
const HEADING = 'Your account is deleted'
const LINE_ONE =
  'Your name and sign-in details are gone. What you contributed stays with the gatherings you gave it to.'
const LINE_TWO =
  "You're welcome back any time — signing up again starts a fresh account, not a way back into this one."
const BACK = 'Back to sign in'

const TOKEN = 'test-session-token'

const person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  // A set zone, so the provider's first-sign-in capture never PATCHes.
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const billing = {
  plan: null,
  status: null,
  current_period_end: null,
  ends_at: null,
  allowance: 10_000,
  used: 3,
  scheduled_change: null,
  plans: [
    { plan: null, allowance: 10_000, monthly_price_cents: null },
    { plan: 'photos_100k', allowance: 100_000, monthly_price_cents: 499 },
    { plan: 'photos_300k', allowance: 300_000, monthly_price_cents: 999 },
  ],
  next: 'checkout',
}

// ---------------------------------------------------------------------------
// The server, modelled honestly: once the deletion has answered 204 the
// person is anonymized, and every bearer request after it is a 401 — which
// `authFetch` answers by clearing the token (the 401 rule). So a request made
// in the window between the 204 and the clear would end the session early,
// at /settings, and the test would see the bounce: the window's answer is
// the request log, not an assumption.
// ---------------------------------------------------------------------------

interface Call {
  method: string
  path: string
  // The stored token at the instant of the call: null means the session was
  // already gone when the request went out.
  tokenAtCall: string | null
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function stubServer(deleteStatus = 204) {
  const calls: Call[] = []
  let deleted = false
  const fetchStub = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path, tokenAtCall: getToken() })
    if (method === 'POST' && path === '/me/delete') {
      if (deleteStatus === 204) deleted = true
      return Promise.resolve(new Response(null, { status: deleteStatus }))
    }
    if (path === '/health') return Promise.resolve(json(200, { status: 'ok' }))
    if (deleted) return Promise.resolve(json(401, { detail: 'Not authenticated' }))
    if (path === '/auth/me') return Promise.resolve(json(200, person))
    if (path === '/billing') return Promise.resolve(json(200, billing))
    if (path === '/me/passkeys') return Promise.resolve(json(200, []))
    return Promise.resolve(json(404, { detail: 'Not Found' }))
  })
  vi.stubGlobal('fetch', fetchStub)
  return { calls, fetchStub }
}

// ---------------------------------------------------------------------------
// Probes: the router's location as it changes, and the auth state.
// ---------------------------------------------------------------------------

interface Visit {
  pathname: string
  state: unknown
}

const visits: Visit[] = []

function LocationProbe() {
  const location = useLocation()
  useEffect(() => {
    visits.push({ pathname: location.pathname, state: location.state })
  }, [location])
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

function authStatus() {
  return screen.getByTestId('auth-status').textContent
}

function headingText() {
  return screen.queryByRole('heading', { level: 1 })?.textContent ?? null
}

function signInFormShowing() {
  return screen.queryByRole('button', { name: /email me a sign-in link/i }) !== null
}

function expectConfirmationCopy() {
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
  expect(screen.getByText(LINE_ONE)).toBeTruthy()
  expect(screen.getByText(LINE_TWO)).toBeTruthy()
  expect(screen.getByRole('link', { name: BACK }).getAttribute('href')).toBe('/')
}

async function signedInAtSettings() {
  setToken(TOKEN)
  renderAppAt('/settings')
  // RequireAuth shows its loading branch until /auth/me answers.
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  expect(authStatus()).toBe('signedIn')
}

function typeDeleteAndConfirm() {
  fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'DELETE' } })
  const button = screen.getByRole('button', { name: 'Delete my account' })
  expect(button.hasAttribute('disabled')).toBe(false)
  fireEvent.click(button)
}

beforeEach(() => {
  localStorage.clear()
  visits.length = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// The fix: the deletion lands on the confirmation, and THEN the session goes.
// ---------------------------------------------------------------------------

test('deleting the account through Settings lands on /account-deleted with the heading, and only then is the session gone — never the sign-in form', async () => {
  const { calls } = stubServer()
  await signedInAtSettings()
  typeDeleteAndConfirm()

  // The defect read {location: '/', heading: 'CoveyKeep', signInForm: true}.
  await waitFor(() =>
    expect({ location: locationText(), heading: headingText(), signInForm: signInFormShowing() }).toEqual({
      location: '/account-deleted',
      heading: HEADING,
      signInForm: false,
    }),
  )
  expectConfirmationCopy()

  // The session ends on the confirmation screen, not before it.
  await waitFor(() => expect(authStatus()).toBe('signedOut'))
  expect(getToken()).toBeNull()
  // And it stays there: no guard bounces a signed-out person off this route.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(locationText()).toBe('/account-deleted')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
  expect(signInFormShowing()).toBe(false)

  // The path never passed through `/`: /settings, then /account-deleted —
  // first carrying the deletion's signal, then with it spent.
  expect(visits.map((v) => v.pathname)).not.toContain('/')
  expect(visits[0]).toEqual({ pathname: '/settings', state: null })
  const landing = visits.filter((v) => v.pathname === '/account-deleted')
  expect(landing.length).toBeGreaterThanOrEqual(2)
  expect(landing[0].state).toEqual({ accountDeleted: true })
  expect(landing.at(-1)?.state).toBeNull()

  // THE WINDOW: between the 204 and the clear the token is still stored
  // while the server has anonymized the person, so any bearer request in it
  // would 401 and end the session at /settings. Nothing is sent after the
  // delete — the deletion is the last request this page ever makes.
  const deleteIndex = calls.findIndex((c) => c.method === 'POST' && c.path === '/me/delete')
  expect(deleteIndex).toBeGreaterThan(-1)
  expect(calls[deleteIndex].tokenAtCall).toBe(TOKEN)
  expect(calls.slice(deleteIndex + 1)).toEqual([])
  // No request was ever sent without the session it needed.
  expect(calls.filter((c) => c.path !== '/health').every((c) => c.tokenAtCall === TOKEN)).toBe(true)
})

// ---------------------------------------------------------------------------
// A direct visit never signs anyone out.
// ---------------------------------------------------------------------------

test('a direct visit to /account-deleted while signed in shows the screen and leaves the session alone', async () => {
  stubServer()
  setToken(TOKEN)
  renderAppAt('/account-deleted')
  expectConfirmationCopy()
  // The provider loads the person as it would on any screen; nothing here
  // asks it to forget them.
  await waitFor(() => expect(authStatus()).toBe('signedIn'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(authStatus()).toBe('signedIn')
  expect(getToken()).toBe(TOKEN)
  expect(locationText()).toBe('/account-deleted')
  expect(visits.map((v) => v.pathname)).toEqual(['/account-deleted'])
  expect(visits[0].state).toBeNull()
})

test('signed out at /account-deleted: the screen shows, nothing thrown', async () => {
  stubServer()
  renderAppAt('/account-deleted')
  expectConfirmationCopy()
  expect(authStatus()).toBe('signedOut')
  expect(getToken()).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(locationText()).toBe('/account-deleted')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
})

test("the copy is CK-8's, as literals: the heading, the two lines, Back to sign in → /", () => {
  stubServer()
  renderAppAt('/account-deleted')
  const main = screen.getByRole('main')
  expect(main.querySelector('h1')?.textContent).toBe(HEADING)
  const paragraphs = Array.from(main.querySelectorAll('p')).map((p) => p.textContent)
  expect(paragraphs).toEqual([LINE_ONE, LINE_TWO])
  const back = screen.getByRole('link', { name: BACK })
  expect(back.getAttribute('href')).toBe('/')
  expect(main.querySelectorAll('a')).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// A failed deletion: the existing failure state, nothing moved.
// ---------------------------------------------------------------------------

test('a failed deletion reads the failure line with the session untouched and no navigation', async () => {
  const { calls } = stubServer(500)
  await signedInAtSettings()
  typeDeleteAndConfirm()
  expect(await screen.findByText('Something went wrong deleting your account. Try again.')).toBeTruthy()
  expect(locationText()).toBe('/settings')
  expect(authStatus()).toBe('signedIn')
  expect(getToken()).toBe(TOKEN)
  expect(visits.map((v) => v.pathname)).toEqual(['/settings'])
  // The control is live again for another try, with the typed value kept.
  expect(screen.getByRole('button', { name: 'Delete my account' }).hasAttribute('disabled')).toBe(false)
  expect(calls.filter((c) => c.path === '/me/delete')).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// The signal carries nothing identifying.
// ---------------------------------------------------------------------------

function stripComments(source: string) {
  // The CK-70 idiom: comments stripped so a comment explaining the rule does
  // not trip the rule. What is left is what runs.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function functionBody(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const IDENTIFYING = [/\bemail\b/i, /\btoken\b/i, /\bperson\b/i, /account_id|accountId|\bid\b/]

test('the signal is one boolean and nothing else, and neither the deletion path nor the confirmation screen names an id, an email or a token', () => {
  // The object itself: exactly the one key, exactly true.
  expect(ACCOUNT_DELETED_SIGNAL).toEqual({ accountDeleted: true })
  expect(Object.keys(ACCOUNT_DELETED_SIGNAL)).toEqual(['accountDeleted'])

  // The deletion path: the handler's body alone, because the rest of
  // Settings legitimately shows the person's own email address.
  const handler = functionBody(stripComments(settingsSource), 'handleDelete')
  expect(handler).toContain('navigate(')
  expect(handler).toContain('ACCOUNT_DELETED_SIGNAL')
  // The handler no longer ends the session itself — the screen does.
  expect(handler).not.toMatch(/clearToken|signOut|removeItem/)
  for (const word of IDENTIFYING) expect(handler).not.toMatch(word)
  // One state object goes out, and it is the signal.
  const states = handler.match(/state:\s*\w+/g) ?? []
  expect(states).toEqual(['state: ACCOUNT_DELETED_SIGNAL'])

  // The confirmation screen and the signal's module: no identifier read,
  // stored, sent or shown.
  for (const source of [stripComments(deletedSource), stripComments(signalSource)]) {
    for (const word of IDENTIFYING) expect(source).not.toMatch(word)
    expect(source).not.toMatch(/\bfetch\b|authFetch|apiFetch/)
    expect(source).not.toMatch(/localStorage|sessionStorage/)
  }
  // The screen never signs anyone out unconditionally: the one clear is
  // behind the signal's test.
  const deleted = stripComments(deletedSource)
  expect(deleted.match(/clearToken\(\)/g)).toHaveLength(1)
  expect(deleted).toMatch(/carriesAccountDeletedSignal\(/)
})

test('no new or changed source spells the product name — it flows from brand.ts', () => {
  for (const source of [signalSource, deletedSource]) {
    expect(source.toLowerCase()).not.toContain('covey')
  }
})
