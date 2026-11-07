// CK-82 — the frame, through the app's real route table. The value under
// test: every signed-in route carries the frame and no frameless route does;
// each page keeps its one <main> and every navigation landmark is labelled;
// on a phone the top bar and the bottom bar's three tabs — Groups, Gatherings
// and You, the current one marked for each section's routes, and no
// Calendar — and the menu as a drawer that is a modal dialog: it takes focus,
// keeps it, closes on Escape, the scrim and any navigation, gives focus back
// to the menu button, and stills the page behind; from 900px the menu as a
// column and no bars; and Home retired — /home and a signed-in `/` both land
// on /groups.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthContext, type AuthState, type Person } from '../auth/context'

const person: Person = {
  id: 'person-1',
  display_name: 'Ada Lee',
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
  document.body.classList.remove('menu-open')
})

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

const group = {
  id: 'g-1',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-1',
  member_count: 2,
  caller_role: 'admin',
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
}

// Every request the route table can make, answered locally.
function stubServer() {
  const mock = vi.fn((input: string) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    switch (path) {
      case '/health':
        return Promise.resolve(json(200, { status: 'ok' }))
      case '/groups':
        return Promise.resolve(json(200, { groups: [group] }))
      case '/gatherings':
        return Promise.resolve(json(200, { gatherings: [] }))
      case '/groups/g-1':
        return Promise.resolve(json(200, group))
      case '/groups/g-1/members':
        return Promise.resolve(
          json(200, { members: [{ membership_id: 'm-1', display_name: 'Ada Lee', role: 'admin', is_self: true }] }),
        )
      case '/groups/g-1/gatherings':
        return Promise.resolve(json(200, { gatherings: [] }))
      case '/me/passkeys':
        return Promise.resolve(json(200, []))
      default:
        return Promise.resolve(json(404, { detail: 'Not Found' }))
    }
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderAppAt(address: string, auth: AuthState = signedIn) {
  stubServer()
  return render(
    <MemoryRouter initialEntries={[address]}>
      <AuthContext.Provider value={auth}>
        <App />
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function locationText() {
  return screen.getByTestId('location').textContent
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
}

// A window from 900px wide, or narrower: matchMedia as the frame reads it.
function stubWidth(initiallyWide: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: initiallyWide,
    media: '(min-width: 900px)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    resize(wide: boolean) {
      query.matches = wide
      act(() => listeners.forEach((listener) => listener()))
    },
  }
}

const SIGNED_IN_ROUTES: [string, 'groups' | 'gatherings' | 'you'][] = [
  ['/groups', 'groups'],
  ['/groups/new', 'groups'],
  ['/groups/g-1', 'groups'],
  // A group's People page (CK-86): inside the frame, the Groups tab current.
  ['/groups/g-1/people', 'groups'],
  ['/groups/g-1/gatherings/new', 'groups'],
  ['/gatherings', 'gatherings'],
  ['/gatherings/new', 'gatherings'],
  ['/gatherings/x-1', 'gatherings'],
  ['/settings', 'you'],
  ['/plan', 'you'],
  ['/you', 'you'],
]

const TAB = { groups: 'Groups', gatherings: 'Gatherings', you: 'You' }

// ---------------------------------------------------------------------------
// The frame on the right routes.
// ---------------------------------------------------------------------------

test('every signed-in route carries the frame: one <main>, the bars, the menu, and every navigation landmark labelled', async () => {
  for (const [address] of SIGNED_IN_ROUTES) {
    renderAppAt(address)
    await screen.findByRole('navigation', { name: 'Sections' })
    expect(document.querySelector('.frame'), address).toBeTruthy()
    expect(screen.getByRole('banner'), address).toBeTruthy()
    // MOVED AT CK-89, with its reason, here and at this file's three other reads
    // of the name: the dialog is *Menu*, and a nav called *Menu* inside it was read
    // out twice (CK-82's review), so the nav is *Main* in both layouts.
    expect(document.getElementById('frame-menu')?.querySelector('nav[aria-label="Main"]'), address).toBeTruthy()
    expect(document.querySelectorAll('main'), address).toHaveLength(1)
    for (const nav of document.querySelectorAll('nav')) expect(nav.getAttribute('aria-label'), address).toBeTruthy()
    await settle()
    expect(document.querySelectorAll('main'), address).toHaveLength(1)
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('no frameless route carries the frame — sign-in, the callback, the three landings, the notice, the email-change result, the account-deleted screen and the catch-all', async () => {
  const frameless: [string, AuthState][] = [
    ['/', signedOut],
    ['/auth/callback', signedOut],
    ['/invitations/accept', signedOut],
    ['/groups/join', signedOut],
    ['/groups/invitations/accept', signedOut],
    ['/tos', signedOut],
    ['/email-change', signedOut],
    ['/account-deleted', signedOut],
    ['/zz-ck82-nowhere', signedOut],
    // Signed in, the routes outside the frame stay outside too.
    ['/invitations/accept', signedIn],
    ['/groups/join', signedIn],
    ['/tos', signedIn],
    ['/email-change', signedIn],
    ['/zz-ck82-nowhere', signedIn],
  ]
  for (const [address, auth] of frameless) {
    renderAppAt(address, auth)
    await settle()
    const label = `${address} (${auth.status})`
    expect(locationText(), label).toBe(address)
    expect(document.querySelector('.frame'), label).toBeNull()
    expect(document.getElementById('frame-menu'), label).toBeNull()
    expect(screen.queryByRole('navigation'), label).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open menu' }), label).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
  }
})

// ---------------------------------------------------------------------------
// Phones: the top bar and the bottom bar.
// ---------------------------------------------------------------------------

test('the top bar: the menu button and the brand, which goes to Groups', async () => {
  renderAppAt('/gatherings')
  const banner = screen.getByRole('banner')
  const button = within(banner).getByRole('button', { name: 'Open menu' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(button.getAttribute('aria-controls')).toBe('frame-menu')
  const brand = within(banner).getByRole('link', { name: 'CoveyKeep' })
  expect(brand.getAttribute('href')).toBe('/groups')
  expect(brand.querySelector('img')?.getAttribute('alt')).toBe('')
  await settle()
})

test("the bottom bar: three tabs — Groups, Gatherings and You — the current one marked for each section's routes, and no Calendar", async () => {
  for (const [address, section] of SIGNED_IN_ROUTES) {
    renderAppAt(address)
    const bar = await screen.findByRole('navigation', { name: 'Sections' })
    const tabs = within(bar).getAllByRole('link')
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('href')]), address).toEqual([
      ['Groups', '/groups'],
      ['Gatherings', '/gatherings'],
      ['You', '/you'],
    ])
    const current = tabs.filter((tab) => tab.getAttribute('aria-current') === 'page')
    expect(current.map((tab) => tab.textContent), address).toEqual([TAB[section]])
    for (const tab of tabs) expect(tab.querySelector('.pill svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.textContent, address).not.toMatch(/calendar/i)
    await settle()
    cleanup()
    vi.unstubAllGlobals()
  }
})

// ---------------------------------------------------------------------------
// Phones: the drawer is a dialog.
// ---------------------------------------------------------------------------

// MOVED AT CK-85, with its reason: seven tests in this file (here, the 900px
// crossing and Home retired) wait for the Groups page's heading to know the
// page has rendered. The page takes the mockup's words
// since CK-85 — its heading reads *Groups*, where it read *Your groups* —
// and what each test pins about the frame is unchanged.

test('closed, the drawer is inert and hidden, and no dialog is open', async () => {
  renderAppAt('/groups')
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  const side = document.getElementById('frame-menu')
  expect(side?.hasAttribute('inert')).toBe(true)
  expect(side?.getAttribute('aria-hidden')).toBe('true')
  expect(side?.getAttribute('role')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
  expect(document.querySelector('.frame-scrim')).toBeNull()
})

test('the menu button opens the drawer as a modal dialog that takes focus and stills the page; Escape closes it, focus back on the button', async () => {
  renderAppAt('/groups')
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  const button = screen.getByRole('button', { name: 'Open menu' })
  fireEvent.click(button)

  const dialog = screen.getByRole('dialog', { name: 'Menu' })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(dialog.id).toBe('frame-menu')
  expect(dialog.hasAttribute('inert')).toBe(false)
  expect(within(dialog).getByRole('navigation', { name: 'Main' })).toBeTruthy()
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(document.body.classList.contains('menu-open')).toBe(true)
  expect(document.querySelector('.frame-col')?.hasAttribute('inert')).toBe(true)
  expect(document.querySelector('.frame-scrim')).toBeTruthy()

  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.body.classList.contains('menu-open')).toBe(false)
  expect(document.querySelector('.frame-col')?.hasAttribute('inert')).toBe(false)
  await settle()
})

test('focus stays in the open drawer: Tab from the last control wraps to the first, Shift+Tab from the first to the last', async () => {
  renderAppAt('/groups')
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  const dialog = screen.getByRole('dialog', { name: 'Menu' })
  // Wait for the menu's lists, so the last control is the footer's.
  await within(dialog).findByRole('list', { name: 'Your groups' })
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  expect(last.getAttribute('aria-label')).toBe('Settings')

  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
})

test('a tap on the scrim closes the drawer, focus back on the button', async () => {
  renderAppAt('/groups')
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  const button = screen.getByRole('button', { name: 'Open menu' })
  fireEvent.click(button)
  expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()
  const scrim = document.querySelector('.frame-scrim') as HTMLElement
  expect(scrim.getAttribute('aria-hidden')).toBe('true')
  fireEvent.click(scrim)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(button)
  await settle()
})

test('any navigation closes the drawer: a row in it opens its page, and the drawer is gone', async () => {
  renderAppAt('/gatherings')
  await screen.findByRole('navigation', { name: 'Sections' })
  const button = screen.getByRole('button', { name: 'Open menu' })
  fireEvent.click(button)
  const dialog = screen.getByRole('dialog', { name: 'Menu' })
  const row = await within(dialog).findByRole('link', { name: /The Lees/ })
  expect(row.getAttribute('href')).toBe('/groups/g-1')
  fireEvent.click(row)
  await waitFor(() => expect(locationText()).toBe('/groups/g-1'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.getElementById('frame-menu')?.hasAttribute('inert')).toBe(true)
  expect(document.body.classList.contains('menu-open')).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }))
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
})

// ---------------------------------------------------------------------------
// From 900px: the menu as a column.
// ---------------------------------------------------------------------------

test('from 900px: the menu as a column beside the page — no top bar, no bottom bar, no drawer', async () => {
  stubWidth(true)
  stubServer()
  render(
    <MemoryRouter initialEntries={['/groups/g-1']}>
      <AuthContext.Provider value={signedIn}>
        <App />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  const menu = screen.getByRole('navigation', { name: 'Main' })
  expect(within(menu).getByRole('link', { name: 'Groups' }).getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('banner')).toBeNull()
  expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  const side = document.getElementById('frame-menu')
  expect(side?.hasAttribute('inert')).toBe(false)
  expect(side?.getAttribute('aria-hidden')).toBeNull()
  expect(document.querySelector('.frame')?.classList.contains('frame-wide')).toBe(true)
  expect(document.querySelectorAll('main')).toHaveLength(1)
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
})

test('the window crossing 900px: an open drawer closes into the column, and the bars come back below it', async () => {
  const width = stubWidth(false)
  stubServer()
  render(
    <MemoryRouter initialEntries={['/groups']}>
      <AuthContext.Provider value={signedIn}>
        <App />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()

  width.resize(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull()
  expect(document.body.classList.contains('menu-open')).toBe(false)

  width.resize(false)
  expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy()
  // Narrow again, the drawer stays closed: nothing reopens it by itself.
  expect(screen.queryByRole('dialog')).toBeNull()
  await settle()
})

// ---------------------------------------------------------------------------
// Home retired.
// ---------------------------------------------------------------------------

test('Home is retired: /home lands on /groups', async () => {
  renderAppAt('/home')
  await waitFor(() => expect(locationText()).toBe('/groups'))
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
  expect(screen.queryByRole('heading', { name: /welcome/i })).toBeNull()
})

test('signed in, the sign-in screen sends you to /groups', async () => {
  renderAppAt('/')
  await waitFor(() => expect(locationText()).toBe('/groups'))
  await screen.findByRole('heading', { level: 1, name: 'Groups' })
})
