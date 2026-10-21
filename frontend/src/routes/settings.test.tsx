// CK-74 pins on the Settings page's Your plan section. The value under test:
// the section sits ABOVE Sign-in email with the heading, one line — the
// current allowance and price, read from GET /billing and never kept by the
// screen — and a "See your plan" link to /plan; and when the read fails the
// section shows the link alone, never a number it does not have.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { Settings } from './Settings'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const PLANS = [
  { plan: null, allowance: 10_000, monthly_price_cents: null },
  { plan: 'photos_100k', allowance: 100_000, monthly_price_cents: 499 },
  { plan: 'photos_300k', allowance: 300_000, monthly_price_cents: 999 },
]

function billingBody(over: Record<string, unknown> = {}) {
  return {
    plan: null,
    status: null,
    current_period_end: null,
    ends_at: null,
    allowance: 10_000,
    used: 3,
    scheduled_change: null,
    plans: PLANS,
    next: 'checkout',
    ...over,
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

// Permissive: the page's other sections load their own things (the
// passkey list); anything this file does not care about answers 404.
function stubBilling(answer: () => Promise<Response>) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && String(url).endsWith('/billing')) return answer()
    return Promise.resolve(json(404, { detail: 'Not Found' }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function billingReads(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter(([url]) => String(url).endsWith('/billing'))
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthContext.Provider value={auth}>
        <Settings />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('the Your plan section sits above Sign-in email with the free line and the link', async () => {
  stubBilling(() => Promise.resolve(json(200, billingBody())))
  renderSettings()
  expect(await screen.findByText('10,000 photos · Free')).toBeTruthy()
  const section = screen.getByRole('region', { name: 'Your plan' })
  const link = screen.getByRole('link', { name: 'See your plan' })
  expect(link.getAttribute('href')).toBe('/plan')
  expect(section.contains(link)).toBe(true)
  // Above Sign-in email: the section precedes the email heading in the document.
  const email = screen.getByRole('heading', { name: 'Sign-in email' })
  expect(section.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // The usage figure is the plan screen's: not here.
  expect(document.body.textContent).not.toContain('3 of')
})

test("a paid plan's line: the allowance and the price from the body", async () => {
  stubBilling(() =>
    Promise.resolve(
      json(200, billingBody({ plan: 'photos_100k', status: 'active', allowance: 100_000, next: 'portal' })),
    ),
  )
  renderSettings()
  expect(await screen.findByText('100,000 photos · $4.99 a month')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'See your plan' }).getAttribute('href')).toBe('/plan')
})

test('when the read fails, the section shows the link alone', async () => {
  const mock = stubBilling(() => Promise.resolve(json(500, {})))
  renderSettings()
  await waitFor(() => expect(billingReads(mock)).toHaveLength(1))
  expect(screen.getByRole('region', { name: 'Your plan' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'See your plan' }).getAttribute('href')).toBe('/plan')
  expect(screen.queryByText(/photos ·/)).toBeNull()
  cleanup()
  vi.unstubAllGlobals()

  const failing = stubBilling(() => Promise.reject(new TypeError('network')))
  renderSettings()
  await waitFor(() => expect(billingReads(failing)).toHaveLength(1))
  expect(screen.getByRole('link', { name: 'See your plan' })).toBeTruthy()
  expect(screen.queryByText(/photos ·/)).toBeNull()
  // The link is there from the first paint, whatever the read does.
})
