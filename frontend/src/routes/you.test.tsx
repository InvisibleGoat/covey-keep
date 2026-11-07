// CK-82 — You. The value under test: the mockup's words as literals — the
// heading, the person with their initials and "Initials until you add a
// profile picture", Display → Appearance with Light ("Paper by day.") and
// Dark ("Easier on the eyes at night."), Settings, Your plan with its line
// from GET /billing, Sign out, and the maker's line; the stored theme
// checked, an unknown stored value reading as light; Dark writes `dark` to
// covey-keep:theme and sets the attribute at once, Light writes `light`;
// Sign out signs out as Home's button did; the rows link where they say;
// and no Favorites (a later phase). Since CK-89 Display's first choice is Menu
// layout, then Appearance: One list and Rail and panel with their lines as
// literals, One list checked with nothing stored or anything unknown, and a
// choice written to covey-keep:menu-layout at once.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { chooseMenuLayout } from '../lib/menuLayout'
import { You } from './You'
import youSource from './You.tsx?raw'

const person: Person = {
  id: 'person-1',
  display_name: 'Sam Marlowe',
  email: 'sam@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

function authWith(over: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signedIn',
    person,
    signIn: () => {},
    signOut: async () => {},
    updatePerson: () => {},
    ...over,
  }
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

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function stubBilling(answer: () => Response = () => json(200, billing)) {
  const mock = vi.fn((url: string) =>
    Promise.resolve(String(url).endsWith('/billing') ? answer() : json(404, {})),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderYou(auth: AuthState = authWith()) {
  return render(
    <MemoryRouter initialEntries={['/you']}>
      <AuthContext.Provider value={auth}>
        <You />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function resetTheme() {
  document.documentElement.setAttribute('data-theme', 'light')
  chooseMenuLayout('list')
  localStorage.clear()
}

beforeEach(resetTheme)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetTheme()
})

test("You's words, as literals", async () => {
  stubBilling()
  const { container } = renderYou()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('You')
  const avatar = container.querySelector('.avatar')
  expect(avatar?.textContent).toBe('SM')
  expect(avatar?.getAttribute('aria-hidden')).toBe('true')
  expect(screen.getByText('Sam Marlowe')).toBeTruthy()
  expect(screen.getByText('Initials until you add a profile picture')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 2, name: 'Display' })).toBeTruthy()
  const appearance = screen.getByRole('group', { name: 'Appearance' })
  expect(within(appearance).getByRole('radio', { name: 'Light' }).getAttribute('aria-describedby')).toBeTruthy()
  expect(within(appearance).getByText('Paper by day.')).toBeTruthy()
  expect(within(appearance).getByRole('radio', { name: 'Dark' })).toBeTruthy()
  expect(within(appearance).getByText('Easier on the eyes at night.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy()
  expect(screen.getByRole('link', { name: /^Your plan/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  expect(screen.getByText('a Paper Goose product')).toBeTruthy()
  await screen.findByText('10,000 photos · Free')
})

test('no Favorites — a later phase; and since CK-89 the Menu layout is the first of two choices', async () => {
  // MOVED AT CK-89, with its reason: the Menu layout choice is built, so the
  // pin that said there were two radios and one group is now four radios in
  // two groups, Menu layout before Appearance.
  stubBilling()
  renderYou()
  await screen.findByText('10,000 photos · Free')
  expect(document.body.textContent).not.toMatch(/favou?rites?/i)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  expect(screen.getAllByRole('group').map((group) => group.querySelector('legend')?.textContent)).toEqual([
    'Menu layout',
    'Appearance',
  ])
})

test('Menu layout comes first under Display: the two choices and their lines, as literals', async () => {
  stubBilling()
  renderYou()
  const display = screen.getByRole('heading', { level: 2, name: 'Display' }).closest('section') as HTMLElement
  const groups = within(display).getAllByRole('group')
  expect(groups.map((group) => group.querySelector('legend')?.textContent)).toEqual(['Menu layout', 'Appearance'])
  const layout = groups[0]
  const radios = within(layout).getAllByRole('radio') as HTMLInputElement[]
  expect(radios.map((radio) => radio.name)).toEqual(['menu-layout', 'menu-layout'])
  expect(within(layout).getByRole('radio', { name: 'One list' }).getAttribute('aria-describedby')).toBeTruthy()
  expect(within(layout).getByText('Your groups and gatherings together, with a picture beside each name.')).toBeTruthy()
  expect(within(layout).getByRole('radio', { name: 'Rail and panel' }).getAttribute('aria-describedby')).toBeTruthy()
  expect(within(layout).getByText('Group pictures down the side, and the group you pick beside them.')).toBeTruthy()
  await screen.findByText('10,000 photos · Free')
})

test('One list is checked with nothing stored or anything unknown; a stored `rail` checks Rail and panel', async () => {
  stubBilling()
  const checked = () => [
    (screen.getByRole('radio', { name: 'One list' }) as HTMLInputElement).checked,
    (screen.getByRole('radio', { name: 'Rail and panel' }) as HTMLInputElement).checked,
  ]
  for (const [stored, expected] of [
    [null, [true, false]],
    ['list', [true, false]],
    ['sepia', [true, false]],
    ['rail', [false, true]],
  ] as const) {
    if (stored !== null) localStorage.setItem('covey-keep:menu-layout', stored)
    renderYou()
    expect(checked(), String(stored)).toEqual(expected)
    await screen.findByText('10,000 photos · Free')
    cleanup()
    localStorage.clear()
  }
})

test('a choice is written to covey-keep:menu-layout and checked at once; the theme is left alone', async () => {
  stubBilling()
  renderYou()
  fireEvent.click(screen.getByRole('radio', { name: 'Rail and panel' }))
  expect(localStorage.getItem('covey-keep:menu-layout')).toBe('rail')
  expect((screen.getByRole('radio', { name: 'Rail and panel' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'One list' }))
  expect(localStorage.getItem('covey-keep:menu-layout')).toBe('list')
  expect((screen.getByRole('radio', { name: 'One list' }) as HTMLInputElement).checked).toBe(true)
  expect(localStorage.getItem('covey-keep:theme')).toBeNull()
  await screen.findByText('10,000 photos · Free')
})

test('the rows link where they say: Settings to /settings, Your plan to /plan with its line from GET /billing', async () => {
  const mock = stubBilling()
  renderYou()
  expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
  const plan = screen.getByRole('link', { name: /^Your plan/ })
  expect(plan.getAttribute('href')).toBe('/plan')
  await waitFor(() => expect(plan.textContent).toBe('Your plan10,000 photos · Free'))
  expect(mock).toHaveBeenCalledTimes(1)
})

test("a failed read shows Your plan's row without the line", async () => {
  const mock = stubBilling(() => json(500, {}))
  renderYou()
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const plan = screen.getByRole('link', { name: /^Your plan/ })
  expect(plan.textContent).toBe('Your plan')
  expect(plan.getAttribute('href')).toBe('/plan')
})

test('light is the default: nothing stored, Light is checked', async () => {
  stubBilling()
  renderYou()
  expect((screen.getByRole('radio', { name: 'Light' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(false)
  await screen.findByText('10,000 photos · Free')
})

test('the stored theme is checked: dark stored, Dark is checked', async () => {
  stubBilling()
  localStorage.setItem('covey-keep:theme', 'dark')
  renderYou()
  expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true)
  await screen.findByText('10,000 photos · Free')
})

test('an unknown stored value reads as light', async () => {
  stubBilling()
  localStorage.setItem('covey-keep:theme', 'sepia')
  renderYou()
  expect((screen.getByRole('radio', { name: 'Light' }) as HTMLInputElement).checked).toBe(true)
  await screen.findByText('10,000 photos · Free')
})

test('Dark writes dark to covey-keep:theme and switches the page at once; Light writes light and switches back', async () => {
  stubBilling()
  renderYou()
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(localStorage.getItem('covey-keep:theme')).toBe('dark')
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true)

  fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
  expect(localStorage.getItem('covey-keep:theme')).toBe('light')
  expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  expect((screen.getByRole('radio', { name: 'Light' }) as HTMLInputElement).checked).toBe(true)
  await screen.findByText('10,000 photos · Free')
})

test('Sign out signs out, as Home’s button did', async () => {
  stubBilling()
  const signOut = vi.fn(async () => {})
  renderYou(authWith({ signOut }))
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledTimes(1)
  await screen.findByText('10,000 photos · Free')
})

test("with no profile, You says so in Home's words, and the rest still works", async () => {
  stubBilling()
  renderYou(authWith({ person: null }))
  expect(screen.getByText("You're signed in, but your profile couldn't be loaded just now.")).toBeTruthy()
  expect(document.querySelector('.avatar')).toBeNull()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  await screen.findByText('10,000 photos · Free')
})

test('You reads and writes the theme only through lib/theme.ts, and spells no brand of its own', () => {
  expect(youSource).toContain("from '../lib/theme'")
  expect(youSource).not.toMatch(/localStorage|data-theme|dataset/)
  expect(youSource).not.toMatch(/covey ?keep|paper goose/i)
})
