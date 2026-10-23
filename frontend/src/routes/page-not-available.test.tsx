// CK-75.1 — the catch-all keeps the address. The value under test: an
// address this bundle has no route for keeps its path, query and fragment
// exactly as it arrived (STEP 1's red run read `/` signed out and `/home`
// signed in, the fragment gone both times — the `<Navigate to="/" replace />`
// the catch-all was until CK-75.1), and the screen that renders there never
// navigates, reads nothing from the address, asks the one service-worker
// owner for an update once on mount, and switches to the newer-version form
// whenever that owner says a newer version has taken control — with Reload a
// plain reload through an injected prop, because jsdom implements no
// navigation (the CK-74 `follow` idiom). The copy is pinned as literals, the
// forbidden words banned over the whole rendered screen, and the existing
// routes shown to still render their own screens at their own paths.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import { AppUpdateContext, type AppUpdateState } from '../components/appUpdate'
import { PageNotAvailable } from './PageNotAvailable'
import pageSource from './PageNotAvailable.tsx?raw'
import providerSource from '../components/AppUpdateProvider.tsx?raw'
import contextSource from '../components/appUpdate.ts?raw'
import hookSource from '../components/useAppUpdate.ts?raw'
import promptSource from '../components/PwaUpdatePrompt.tsx?raw'
import stubSource from '../test-support/pwaRegister.ts?raw'

// Rendering the route table mounts the one service-worker owner, which
// imports the PWA plugin's virtual module (resolved to an inert stub under
// tests — vitest.config.ts). The mock captures the callbacks the owner
// registers, so a test can say "a newer worker has taken control" the way
// the real helper would; no worker is ever touched.
type SwOptions = {
  onNeedReload?: () => void
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void
}
const sw = vi.hoisted(() => ({ options: undefined as SwOptions | undefined }))
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options?: SwOptions) => {
    sw.options = options
    return {
      needRefresh: [false, () => {}],
      offlineReady: [false, () => {}],
      updateServiceWorker: async () => {},
    }
  },
}))

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Los_Angeles',
  account_id: 'acct-1',
}

const signedOut: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const signedIn: AuthState = { ...signedOut, status: 'signedIn', person }

// The copy, as rendered literals. The link's label is built on brand.ts in
// the source (the brand rule, pinned below) and pinned here as the sentence a
// person reads — the CK-64 precedent.
const HEADING = "This page isn't available"
const BODY = "The link may be for something that isn't ready yet, or the address may be mistyped."
const NEWER_VERSION = 'A newer version is ready, and it may have this page.'
const GO_HOME = 'Go to CoveyKeep'
const FORBIDDEN = [/invitation/i, /token/i, /safe/i, /lost/i]

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sw.options = undefined
})

type Respond = (url: string, init?: RequestInit) => Response

const healthOk: Respond = () =>
  new Response(JSON.stringify({ status: 'ok' }), { status: 200 })

function renderAppAt(address: string, auth: AuthState, respond: Respond = healthOk) {
  // Every request the route table could make is answered locally; the probe
  // reads the router's location back after the render has settled.
  const fetchStub = vi.fn((url: string, init?: RequestInit) => Promise.resolve(respond(url, init)))
  vi.stubGlobal('fetch', fetchStub)
  const view = render(
    <MemoryRouter initialEntries={[address]}>
      <AuthContext.Provider value={auth}>
        <App />
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  return { ...view, fetchStub }
}

function locationText() {
  return screen.getByTestId('location').textContent
}

function expectNoHomeOrSignIn() {
  expect(screen.queryByRole('heading', { name: /welcome/i })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /email me a sign-in link/i })).toBeNull()
  expect(screen.queryByText(/^API:/)).toBeNull()
}

// ---------------------------------------------------------------------------
// The fix: the address survives, and the screen renders — signed in or out.
// ---------------------------------------------------------------------------

const UNKNOWN_ADDRESSES = [
  // The two URLs CK-75's backend mints into routes Groups 3 builds.
  '/groups/invitations/accept#token=abc',
  '/groups/join#token=abc',
  // A mistyped address, with nothing in the fragment.
  '/zz-ck751-nowhere',
]

for (const address of UNKNOWN_ADDRESSES) {
  for (const [seat, auth] of [
    ['signed out', signedOut],
    ['signed in', signedIn],
  ] as const) {
    test(`${seat}, ${address} keeps its path and fragment and renders the screen, never Home or sign-in`, () => {
      const { fetchStub } = renderAppAt(address, auth)
      expect(locationText()).toBe(address)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
      expectNoHomeOrSignIn()
      // The screen makes no request of its own, and no other screen rendered
      // to make one (the sign-in screen would have probed /health).
      expect(fetchStub).not.toHaveBeenCalled()
    })
  }
}

test('the screen is wired to the one service-worker owner: a newer worker taking control switches the copy in, the address still kept', () => {
  renderAppAt('/groups/invitations/accept#token=abc', signedIn)
  expect(screen.queryByText(NEWER_VERSION)).toBeNull()
  expect(sw.options?.onNeedReload).toBeTypeOf('function')
  // What the register helper does when the new worker has activated and
  // claimed the page (autoUpdate) — after the first render.
  act(() => sw.options?.onNeedReload?.())
  expect(screen.getByText(NEWER_VERSION)).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
  expect(locationText()).toBe('/groups/invitations/accept#token=abc')
})

// ---------------------------------------------------------------------------
// The copy, as literals; the update path; the token never read.
// ---------------------------------------------------------------------------

function updateState(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    updateReady: false,
    dismissed: false,
    dismiss: vi.fn(),
    checkForUpdate: vi.fn(),
    ...over,
  }
}

function renderScreen(state: AppUpdateState, reload: () => void = vi.fn()) {
  const ui = (value: AppUpdateState) => (
    <MemoryRouter initialEntries={['/zz-ck751-nowhere']}>
      <AppUpdateContext.Provider value={value}>
        <PageNotAvailable reload={reload} />
      </AppUpdateContext.Provider>
    </MemoryRouter>
  )
  const view = render(ui(state))
  return {
    rerenderWith: (next: Partial<AppUpdateState>) => view.rerender(ui({ ...state, ...next })),
  }
}

function expectForbiddenWordsAbsent() {
  const page = document.body.textContent ?? ''
  for (const word of FORBIDDEN) expect(page).not.toMatch(word)
}

test('no newer version: the heading, the body and the way home, nothing to reload', () => {
  renderScreen(updateState())
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING)
  expect(screen.getByText(BODY)).toBeTruthy()
  const home = screen.getByRole('link', { name: GO_HOME })
  expect(home.getAttribute('href')).toBe('/')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  expectForbiddenWordsAbsent()
})

test('a newer version ready: the line in a status region with Reload, above the same heading, body and link', () => {
  renderScreen(updateState({ updateReady: true }))
  const status = screen.getByRole('status')
  expect(within(status).getByText(NEWER_VERSION)).toBeTruthy()
  expect(within(status).getByRole('button', { name: 'Reload' })).toBeTruthy()
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.textContent).toBe(HEADING)
  // Above the heading: the status region precedes it in the document.
  expect(status.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText(BODY)).toBeTruthy()
  expect(screen.getByRole('link', { name: GO_HOME }).getAttribute('href')).toBe('/')
  expectForbiddenWordsAbsent()
})

test('checkForUpdate is called exactly once, on mount, and a ready state arriving later switches the copy in', () => {
  const checkForUpdate = vi.fn()
  const { rerenderWith } = renderScreen(updateState({ checkForUpdate }))
  expect(checkForUpdate).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('status')).toBeNull()
  rerenderWith({ updateReady: true })
  expect(screen.getByRole('status').textContent).toContain(NEWER_VERSION)
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  // Still once: the first render asked; a re-render does not ask again.
  expect(checkForUpdate).toHaveBeenCalledTimes(1)
})

test('Reload calls the injected reload once — a plain reload of the same address, nothing else', () => {
  const reload = vi.fn()
  renderScreen(updateState({ updateReady: true }), reload)
  expect(reload).not.toHaveBeenCalled()
  screen.getByRole('button', { name: 'Reload' }).click()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(reload).toHaveBeenCalledWith()
})

test('the screen never reads, navigates or stores: the source, comments stripped, names no address, no fragment, no storage, no request and no navigation', () => {
  // The CK-70 idiom: comments stripped so a comment explaining the rule does
  // not trip the rule. What is left is what runs.
  const code = pageSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // The address and its fragment.
  expect(code).not.toMatch(/\bhash\b/)
  expect(code).not.toMatch(/\bsearch\b/)
  expect(code).not.toMatch(/location\.(href|search|pathname|assign|replace)/)
  expect(code).not.toMatch(/document\.(URL|location)/)
  expect(code).not.toMatch(/useLocation/)
  // Storage and the network.
  expect(code).not.toMatch(/localStorage|sessionStorage/)
  expect(code).not.toMatch(/\bfetch\b/)
  // Navigation of any kind: the address is the point.
  expect(code).not.toMatch(/\bNavigate\b/)
  expect(code).not.toMatch(/useNavigate|navigate\(/)
  expect(code).not.toMatch(/history\./)
  // The one window.location use is the reload, and nothing else.
  const locationUses = code.match(/window\.location\.\w+/g) ?? []
  expect(locationUses).toEqual(['window.location.reload'])
})

// ---------------------------------------------------------------------------
// Existing routes unharmed: each still renders its own screen at its own
// path, and the catch-all's heading is nowhere on it.
// ---------------------------------------------------------------------------

test('/tos still renders the notice at /tos', () => {
  renderAppAt('/tos', signedOut)
  expect(locationText()).toBe('/tos')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    `${PRODUCT_NAME} is a private test`,
  )
  expect(screen.queryByText(HEADING)).toBeNull()
})

test('/invitations/accept still renders the acceptance screen at /invitations/accept', () => {
  renderAppAt('/invitations/accept', signedOut)
  expect(locationText()).toBe('/invitations/accept')
  // No token parked and none in the (empty) window fragment: the screen's
  // own "didn't work" state, not the catch-all.
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    "That invitation link didn't work",
  )
  expect(screen.queryByText(HEADING)).toBeNull()
})

test('/plan still renders the plan screen at /plan', async () => {
  const billing = {
    plan: null,
    status: null,
    current_period_end: null,
    ends_at: null,
    allowance: 10_000,
    used: 12,
    scheduled_change: null,
    plans: [
      { plan: null, allowance: 10_000, monthly_price_cents: null },
      { plan: 'photos_100k', allowance: 100_000, monthly_price_cents: 499 },
      { plan: 'photos_300k', allowance: 300_000, monthly_price_cents: 999 },
    ],
    next: 'checkout',
  }
  renderAppAt('/plan', signedIn, (url) =>
    url.endsWith('/billing')
      ? new Response(JSON.stringify(billing), { status: 200 })
      : new Response('', { status: 404 }),
  )
  expect(locationText()).toBe('/plan')
  await screen.findByRole('heading', { level: 1, name: 'Your plan' })
  expect(screen.queryByText(HEADING)).toBeNull()
})

test('/gatherings/:id still renders the gathering page — its own not-found state — at its path', async () => {
  renderAppAt('/gatherings/g-1', signedIn, () => new Response('', { status: 404 }))
  expect(locationText()).toBe('/gatherings/g-1')
  // The gathering page's one not-found screen (CK-17) is a different thing
  // from the catch-all and is untouched.
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(screen.queryByText(HEADING)).toBeNull()
})

// ---------------------------------------------------------------------------
// The brand rule over every new or changed source file.
// ---------------------------------------------------------------------------

test('no new or changed source spells the product name — it flows from brand.ts', () => {
  for (const source of [
    pageSource,
    providerSource,
    contextSource,
    hookSource,
    promptSource,
    stubSource,
  ]) {
    expect(source.toLowerCase()).not.toContain('covey')
  }
})
