// CK-74 pins on /plan — the plan screen (paid-tiers record §12; the design
// session's words, adjusted where the product says otherwise). The value
// under test: every state rendered as literals — free; paid and renewing;
// paid and ending (with both sentences); paid with a change scheduled; the
// usage line's three forms and the bar capped — with every number from the
// body and every date a DAY in the profile zone; Upgrade and Manage your
// plan each posting once and following the URL, which appears in no other
// call and nowhere in the DOM (a Checkout or portal URL is a bearer
// credential — the presigned-URL rule); each refusal from its code; the
// return from Checkout as a wait — 2 s polls, 10 s after 30 s with the slow
// line, never an error, stopped on unmount, the query string cleared once
// the plan shows; a cancelled Checkout saying nothing; "Recommended" on
// the free view only; no Stripe id rendered; and the copy ban over the
// whole screen in every state — no "safe", "secure", "backed up",
// "forever", "guarantee", "quota", "storage" or "GB" (keeping-explained §3).
//
// CK-74.1 — the screen says only what is true: on a plan that is ending
// the Free card carries no "cancel in Manage your plan" line (the plan is
// already cancelled) while the other paid card still offers the portal; a
// failed read can be retried — Try again re-reads once per press, back
// through the loading state; and the waiting page carries the heading and
// the way back to Settings, in the slow state too. The clock pins are
// unedited.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import type { Billing } from '../lib/billing'
import { networkErrors } from '../lib/formErrors'
import { Plan } from './Plan'
import planSource from './Plan.tsx?raw'
import billingSource from '../lib/billing.ts?raw'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Los_Angeles',
  account_id: 'acct-1',
}

function authFor(over: Partial<Person> = {}): AuthState {
  return {
    status: 'signedIn',
    person: { ...person, ...over },
    signIn: () => {},
    signOut: async () => {},
    updatePerson: () => {},
  }
}

const PLANS = [
  { plan: null, allowance: 10_000, monthly_price_cents: null },
  { plan: 'photos_100k' as const, allowance: 100_000, monthly_price_cents: 499 },
  { plan: 'photos_300k' as const, allowance: 300_000, monthly_price_cents: 999 },
]

const PERIOD_END = '2026-11-12T02:10:00+00:00'

function body(over: Partial<Billing> = {}): Billing {
  return {
    plan: null,
    status: null,
    current_period_end: null,
    ends_at: null,
    allowance: 10_000,
    used: 1_240,
    scheduled_change: null,
    plans: PLANS,
    next: 'checkout',
    ...over,
  }
}

const PAID_100K = body({
  plan: 'photos_100k',
  status: 'active',
  current_period_end: PERIOD_END,
  allowance: 100_000,
  used: 1_240,
  next: 'portal',
})

const PAID_300K = body({
  plan: 'photos_300k',
  status: 'active',
  current_period_end: PERIOD_END,
  allowance: 300_000,
  used: 1_240,
  next: 'portal',
})

// The ids Stripe would spell, were any to leak into a body or the screen.
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_never_in_the_dom_1234567890'
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_never_in_the_dom_0987654321'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

interface StubRoute {
  method: string
  match: (url: string) => boolean
  response: () => Response
}

function stubRoutes(routes: StubRoute[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && r.match(String(url)))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const endsWith = (suffix: string) => (url: string) => url.endsWith(suffix)

function calls(mock: ReturnType<typeof vi.fn>, method: string, match: (url: string) => boolean) {
  return mock.mock.calls.filter(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET') === method && match(String(url)),
  ) as unknown as [string, RequestInit | undefined][]
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function renderPlan(
  path = '/plan',
  over: { person?: Partial<Person>; follow?: (url: string) => void } = {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={authFor(over.person)}>
        <Routes>
          <Route
            path="/plan"
            element={
              <>
                <Plan follow={over.follow} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// The copy ban (keeping-explained §3; the currency record): a plan is space,
// never a guarantee that memories survive, and never "quota" or a byte unit.
const COPY_BAN = /safe|secure|backed up|forever|guarantee|quota|storage|\bGB\b/i
// A Stripe id, were one ever rendered: the body carries none, and the
// screen shows none.
const STRIPE_ID = /\b(cus|sub|price|prod|cs|sub_sched|evt)_[A-Za-z0-9]/

function expectClean() {
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(COPY_BAN)
  expect(text).not.toMatch(STRIPE_ID)
  expect(document.body.innerHTML).not.toContain('stripe.com')
}

function currentCard() {
  return screen.getByRole('region', { name: /current plan/i })
}

function planCard(name: string) {
  return screen.getByRole('region', { name })
}

async function openScreen() {
  await screen.findByRole('heading', { level: 1, name: 'Your plan' })
}

test('the free tier: the current card, More space with both paid plans, Recommended on 100,000, the usage line, the two closing lines', async () => {
  stubRoutes([{ method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) }])
  renderPlan()
  await openScreen()
  // ADJUSTED from the prototype: "gatherings", because no group can be kept yet.
  expect(screen.getByText('Space for the photos in the gatherings you keep.')).toBeTruthy()

  const current = currentCard()
  expect(within(current).getByText('Current plan')).toBeTruthy()
  expect(within(current).getByRole('heading', { level: 2 }).textContent).toBe('10,000 photos')
  expect(within(current).getByText('Free')).toBeTruthy()
  expect(within(current).getByText('1,240 of 10,000 photos')).toBeTruthy()
  // The bar carries no text and no name: the line carries the number.
  const meter = current.querySelector('.plan-meter') as HTMLElement
  expect(meter.getAttribute('aria-hidden')).toBe('true')
  expect((meter.firstElementChild as HTMLElement).style.width).toBe('12.4%')
  expect(within(current).queryByRole('button', { name: 'Manage your plan' })).toBeNull()
  // The prototype's "See what's using it" is NOT built: that screen does not exist.
  expect(screen.queryByText(/what's using it/i)).toBeNull()

  expect(screen.getByRole('heading', { level: 2, name: 'More space' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Other plans' })).toBeNull()
  const hundred = planCard('100,000 photos')
  const threeHundred = planCard('300,000 photos')
  expect(within(hundred).getByText('$4.99 a month')).toBeTruthy()
  expect(within(hundred).getByRole('button', { name: 'Upgrade for $4.99 a month' })).toBeTruthy()
  expect(within(threeHundred).getByText('$9.99 a month')).toBeTruthy()
  expect(within(threeHundred).getByRole('button', { name: 'Upgrade for $9.99 a month' })).toBeTruthy()
  // Recommended: once, on the 100,000 card, on the free view.
  expect(screen.getAllByText('Recommended')).toHaveLength(1)
  expect(within(hundred).getByText('Recommended')).toBeTruthy()
  expect(within(threeHundred).queryByText('Recommended')).toBeNull()
  // The current plan is not offered again.
  expect(screen.queryByRole('region', { name: '10,000 photos' })).toBeNull()

  expect(
    screen.getByText(`${PRODUCT_NAME} sells no data and shows no ads, free or paid.`),
  ).toBeTruthy()
  expect(
    screen.getByText(
      `Paid plans renew every month until you cancel. Payment is handled by Stripe, so your card never reaches ${PRODUCT_NAME}.`,
    ),
  ).toBeTruthy()
  expectClean()
})

test("a paid plan renewing: the price and the renewal DAY in the profile zone, Other plans, Switch in Manage your plan, the free card's sentence, no Recommended, Manage your plan", async () => {
  stubRoutes([{ method: 'GET', match: endsWith('/billing'), response: () => json(200, PAID_100K) }])
  renderPlan()
  await openScreen()
  const current = currentCard()
  expect(within(current).getByRole('heading', { level: 2 }).textContent).toBe('100,000 photos')
  // 02:10 UTC on Nov 12 is the evening of Nov 11 in Pacific time — the
  // person's profile zone decides, never the browser's.
  expect(within(current).getByText('$4.99 a month · Renews on Nov 11')).toBeTruthy()
  expect(within(current).getByText('1,240 of 100,000 photos')).toBeTruthy()
  expect(within(current).getByRole('button', { name: 'Manage your plan' })).toBeTruthy()
  expect(within(current).queryByText(/Switches to/)).toBeNull()
  expect(within(current).queryByText(/You keep this plan/)).toBeNull()

  expect(screen.getByRole('heading', { level: 2, name: 'Other plans' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'More space' })).toBeNull()
  const threeHundred = planCard('300,000 photos')
  expect(within(threeHundred).getByText('$9.99 a month')).toBeTruthy()
  expect(
    within(threeHundred).getByRole('button', { name: 'Switch in Manage your plan' }),
  ).toBeTruthy()
  const free = planCard('10,000 photos')
  expect(within(free).getByText('Free')).toBeTruthy()
  expect(within(free).getByText('To go back to free, cancel in Manage your plan.')).toBeTruthy()
  expect(within(free).queryByRole('button')).toBeNull()
  // No Upgrade anywhere, and no Recommended: the badge on every view would
  // recommend a downgrade to someone on 300,000 (ADJUSTED from the prototype).
  expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull()
  expect(screen.queryByText('Recommended')).toBeNull()
  expect(screen.queryByRole('region', { name: '100,000 photos' })).toBeNull()
  expectClean()
})

test('Recommended is on the free view only: a person on 300,000 is not recommended a downgrade', async () => {
  stubRoutes([{ method: 'GET', match: endsWith('/billing'), response: () => json(200, PAID_300K) }])
  renderPlan()
  await openScreen()
  expect(screen.queryByText('Recommended')).toBeNull()
  expect(
    within(planCard('100,000 photos')).getByRole('button', { name: 'Switch in Manage your plan' }),
  ).toBeTruthy()
  expectClean()
})

test('a paid plan ending: Ends on, both sentences — the free figure from the body — and no cancel line on the Free card', async () => {
  stubRoutes([
    {
      method: 'GET',
      match: endsWith('/billing'),
      response: () => json(200, { ...PAID_100K, ends_at: PERIOD_END }),
    },
  ])
  renderPlan('/plan', { person: { timezone: 'UTC' } })
  await openScreen()
  const current = currentCard()
  expect(within(current).getByText('$4.99 a month · Ends on Nov 12')).toBeTruthy()
  expect(within(current).queryByText(/Renews/)).toBeNull()
  expect(
    within(current).getByText(
      "You keep this plan until then. After that you're on the free plan, 10,000 photos, and nothing you keep is removed or hidden.",
    ),
  ).toBeTruthy()
  // ADDED beside the prototype's sentence: a person must not learn this at the wall.
  expect(
    within(current).getByText(
      "If what you keep is more than 10,000 photos, new photos stop until there's room.",
    ),
  ).toBeTruthy()
  expect(within(current).queryByText(/Switches to/)).toBeNull()
  // CK-74.1: the plan is already cancelled, so the Free card says nothing
  // about cancelling — pinned by the line's absence from the WHOLE card,
  // not the one sentence — while the other paid card still offers the
  // portal: on a cancelling plan it still offers Update subscription beside
  // Don't cancel subscription (seen on the deploy, 2026-10-21).
  const free = planCard('10,000 photos')
  expect(within(free).getByText('Free')).toBeTruthy()
  expect(within(free).queryByText(/To go back to free/)).toBeNull()
  expect(free.textContent).not.toMatch(/cancel/i)
  expect(within(free).queryByRole('button')).toBeNull()
  expect(
    within(planCard('300,000 photos')).getByRole('button', { name: 'Switch in Manage your plan' }),
  ).toBeTruthy()
  expectClean()
})

test('a change scheduled for renewal: the plan names it and its day; absent when nothing is scheduled', async () => {
  stubRoutes([
    {
      method: 'GET',
      match: endsWith('/billing'),
      response: () =>
        json(200, {
          ...PAID_300K,
          scheduled_change: { plan: 'photos_100k', allowance: 100_000, at: PERIOD_END },
        }),
    },
  ])
  renderPlan('/plan', { person: { timezone: 'UTC' } })
  await openScreen()
  const current = currentCard()
  expect(within(current).getByText('$9.99 a month · Renews on Nov 12')).toBeTruthy()
  expect(within(current).getByText('Switches to 100,000 photos on Nov 12.')).toBeTruthy()
  expect(within(current).queryByText(/You keep this plan/)).toBeNull()
  // The Free card's line stays on a plan that is not ending (CK-74.1 took
  // it off the ending state alone; the renewing test pins it there too).
  expect(
    within(planCard('10,000 photos')).getByText('To go back to free, cancel in Manage your plan.'),
  ).toBeTruthy()
  expectClean()
})

test("the usage line's three forms, and the bar capped at full", async () => {
  const cases: [number, number, string, string][] = [
    [5_000, 10_000, '5,000 of 10,000 photos', '50%'],
    [9_600, 10_000, 'Your space is almost full: 9,600 of 10,000 photos.', '96%'],
    [10_200, 10_000, 'Your space is full: 10,200 of 10,000 photos.', '100%'],
    // As true on a paid plan (ADJUSTED from the prototype's free-tier-only line).
    [95_000, 100_000, 'Your space is almost full: 95,000 of 100,000 photos.', '95%'],
  ]
  for (const [used, allowance, line, width] of cases) {
    const paid = allowance > 10_000
    stubRoutes([
      {
        method: 'GET',
        match: endsWith('/billing'),
        response: () =>
          json(200, paid ? { ...PAID_100K, used, allowance } : body({ used, allowance })),
      },
    ])
    renderPlan()
    await openScreen()
    const current = currentCard()
    expect(within(current).getByText(line)).toBeTruthy()
    const meter = current.querySelector('.plan-meter') as HTMLElement
    expect((meter.firstElementChild as HTMLElement).style.width).toBe(width)
    expectClean()
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('Upgrade posts the plan once and follows the URL, which appears in no other call and nowhere in the DOM', async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) },
    {
      method: 'POST',
      match: endsWith('/billing/checkout'),
      response: () => json(200, { url: CHECKOUT_URL }),
    },
  ])
  const followed: string[] = []
  renderPlan('/plan', {
    follow: (url) => {
      followed.push(url)
    },
  })
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade for $9.99 a month' }))
  await waitFor(() => expect(followed).toEqual([CHECKOUT_URL]))
  const posts = calls(mock, 'POST', endsWith('/billing/checkout'))
  expect(posts).toHaveLength(1)
  expect(posts[0][1]?.body).toBe(JSON.stringify({ plan: 'photos_300k' }))
  // The URL went to exactly one place: the follow. Not into the DOM, not
  // into any other request.
  expect(document.body.innerHTML).not.toContain('stripe.com')
  for (const [url, init] of mock.mock.calls as unknown as [string, RequestInit | undefined][]) {
    expect(url).not.toContain('stripe.com')
    expect(String(init?.body ?? '')).not.toContain('stripe.com')
  }
  expect(screen.queryByRole('alert')).toBeNull()
  expectClean()
})

test('Manage your plan posts the portal once and follows the URL, which appears nowhere in the DOM', async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, PAID_100K) },
    { method: 'POST', match: endsWith('/billing/portal'), response: () => json(200, { url: PORTAL_URL }) },
  ])
  const followed: string[] = []
  renderPlan('/plan', {
    follow: (url) => {
      followed.push(url)
    },
  })
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Manage your plan' }))
  await waitFor(() => expect(followed).toEqual([PORTAL_URL]))
  expect(calls(mock, 'POST', endsWith('/billing/portal'))).toHaveLength(1)
  expect(document.body.innerHTML).not.toContain('stripe.com')
  expectClean()
  // Switch in Manage your plan opens the same portal.
  fireEvent.click(screen.getByRole('button', { name: 'Switch in Manage your plan' }))
  await waitFor(() => expect(followed).toEqual([PORTAL_URL, PORTAL_URL]))
  expect(calls(mock, 'POST', endsWith('/billing/portal'))).toHaveLength(2)
})

test("Checkout's refusals, from the code: already_subscribed re-reads the plan; billing_unavailable says nothing was charged; a network failure the app's own line", async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) },
    {
      method: 'POST',
      match: endsWith('/billing/checkout'),
      response: () => json(409, { detail: { code: 'already_subscribed', message: 'reworded' } }),
    },
  ])
  const followed: string[] = []
  renderPlan('/plan', {
    follow: (url) => {
      followed.push(url)
    },
  })
  await openScreen()
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade for $4.99 a month' }))
  const refusal = await screen.findByRole('alert')
  expect(refusal.textContent).toContain('You already have a plan. Use Manage your plan to change it.')
  expect(refusal.textContent).not.toContain('reworded')
  // Re-read: the screen shows what is true now.
  await waitFor(() => expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(2))
  expect(followed).toEqual([])
  expectClean()
  cleanup()
  vi.unstubAllGlobals()

  stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) },
    {
      method: 'POST',
      match: endsWith('/billing/checkout'),
      response: () => json(503, { detail: { code: 'billing_unavailable', message: 'reworded' } }),
    },
  ])
  renderPlan()
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade for $4.99 a month' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    "Stripe didn't answer, and nothing was charged. Try again in a moment.",
  )
  expectClean()
  cleanup()
  vi.unstubAllGlobals()

  const failing = vi.fn((_url: string, init?: RequestInit) =>
    (init?.method ?? 'GET') === 'POST'
      ? Promise.reject(new TypeError('network'))
      : Promise.resolve(json(200, body())),
  )
  vi.stubGlobal('fetch', failing)
  renderPlan()
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade for $4.99 a month' }))
  expect((await screen.findByRole('alert')).textContent).toContain(networkErrors().form[0])
  expectClean()
})

test("the portal's refusals, from the code: a 404 says there is no plan to manage and re-reads; a 503 says nothing was charged", async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, PAID_100K) },
    { method: 'POST', match: endsWith('/billing/portal'), response: () => json(404, { detail: 'No such plan.' }) },
  ])
  renderPlan()
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Manage your plan' }))
  expect((await screen.findByRole('alert')).textContent).toContain("There's no plan to manage yet.")
  await waitFor(() => expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(2))
  expectClean()
  cleanup()
  vi.unstubAllGlobals()

  stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, PAID_100K) },
    {
      method: 'POST',
      match: endsWith('/billing/portal'),
      response: () => json(503, { detail: { code: 'billing_unavailable', message: 'reworded' } }),
    },
  ])
  renderPlan()
  await openScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Manage your plan' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    "Stripe didn't answer, and nothing was charged. Try again in a moment.",
  )
  expectClean()
})

test('the return from Checkout waits, re-reading every 2 s until a paid plan shows, then shows the screen and clears the query string', async () => {
  vi.useFakeTimers()
  let reads = 0
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/billing'),
      response: () => json(200, ++reads >= 3 ? PAID_100K : body()),
    },
  ])
  renderPlan('/plan?checkout=complete')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByRole('status').textContent).toContain('Setting up your plan…')
  // CK-74.1: the waiting page carries the heading above the status region
  // and the way back beneath it — this pin read the heading ABSENT until
  // then, and moved with the page.
  expect(screen.getByRole('heading', { level: 1, name: 'Your plan' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('/settings')
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(1)
  expect(screen.queryByRole('alert')).toBeNull()
  expectClean()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(2)
  expect(screen.getByRole('status').textContent).toContain('Setting up your plan…')
  expect(screen.queryByText(/taking a little longer/)).toBeNull()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(3)
  expect(screen.getByRole('heading', { level: 1, name: 'Your plan' })).toBeTruthy()
  expect(within(currentCard()).getByText('$4.99 a month · Renews on Nov 11')).toBeTruthy()
  // The wait ended: the status region is gone (the heading alone no longer
  // tells the two pages apart since CK-74.1).
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText(/Setting up your plan/)).toBeNull()
  // The query string is cleared, so a reload is the ordinary screen.
  expect(screen.getByTestId('location').textContent).toBe('/plan')
  // And no further read: the wait ended.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(3)
  expectClean()
})

test('a slow webhook is a wait, never an error: 10 s polls and the slow line after 30 s, and polling stops when the page is left', async () => {
  vi.useFakeTimers()
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) },
  ])
  const view = renderPlan('/plan?checkout=complete')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  // 2 s polls: at 0, 2, 4 … 28 s — fifteen reads by 29 s, none slow yet.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(15)
  expect(screen.queryByText(/taking a little longer/)).toBeNull()
  // At 30 s: the sixteenth read, the cadence drops to 10 s, and the line.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(16)
  expect(screen.getByRole('status').textContent).toContain(
    'This is taking a little longer than usual. Your plan will appear here when Stripe confirms it.',
  )
  expect(screen.getByRole('status').textContent).toContain('Setting up your plan…')
  expect(screen.queryByRole('alert')).toBeNull()
  // CK-74.1: the heading and the way back stand in the slow state too, and
  // both outside the status region.
  expect(screen.getByRole('heading', { level: 1, name: 'Your plan' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('/settings')
  expect(within(screen.getByRole('status')).queryByRole('heading')).toBeNull()
  expect(within(screen.getByRole('status')).queryByRole('link')).toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(16)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(17)
  expectClean()
  // Leaving the page stops the polling.
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(17)
})

test('a cancelled Checkout returns to the ordinary screen with nothing changed and nothing said, and the query string cleared', async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/billing'), response: () => json(200, body()) },
  ])
  renderPlan('/plan?checkout=cancelled')
  await openScreen()
  expect(screen.queryByText(/Setting up your plan/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(document.body.textContent).not.toMatch(/cancel(l)?ed/i)
  expect(screen.getByTestId('location').textContent).toBe('/plan')
  expect(calls(mock, 'GET', endsWith('/billing'))).toHaveLength(1)
  expectClean()
})

test('a failed read says so and can be retried: Try again re-reads once per press, back through the loading state, and a read that succeeds renders the screen', async () => {
  // CK-74.1: the sentence lost its "Try again." — the button carries it,
  // and until then there was nothing to press — so the literal pin moved
  // from the two-sentence line to the one, and the alert is pinned EXACT.
  const gate: { release?: () => void } = {}
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET' || !String(url).endsWith('/billing')) {
      throw new Error(`no stub for ${String(url)}`)
    }
    const read = mock.mock.calls.length
    // The second read is held until the test releases it, so the loading
    // state between the press and the answer can be seen.
    if (read === 2) {
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
    }
    return read >= 3 ? json(200, body()) : json(500, {})
  })
  vi.stubGlobal('fetch', mock)
  renderPlan()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent?.trim()).toBe('Something went wrong loading your plan.')
  expect(screen.getByRole('heading', { level: 1, name: 'Your plan' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('/settings')
  expect(mock).toHaveBeenCalledTimes(1)
  expectClean()

  // One press, one read — through the loading state while it is pending.
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(2))
  expect(screen.getByText('Loading your plan…')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  await act(async () => {
    gate.release?.()
  })
  // That read failed too: the failed state again, and nothing more read
  // until the next press.
  expect((await screen.findByRole('alert')).textContent?.trim()).toBe(
    'Something went wrong loading your plan.',
  )
  expect(mock).toHaveBeenCalledTimes(2)
  expectClean()

  // A press whose read succeeds renders the screen.
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('region', { name: /current plan/i })
  expect(within(currentCard()).getByText('1,240 of 10,000 photos')).toBeTruthy()
  expect(mock).toHaveBeenCalledTimes(3)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expectClean()
})

test('the source: the product is named from brand.ts, the honey colour is unused, and no URL is held in state', () => {
  // The brand rule (CK-14): no spelling of the product name in the source.
  for (const source of [planSource, billingSource]) {
    expect(source).not.toMatch(/covey ?keep/i)
    // No code may use honey — its values or its tokens — until paper-goose
    // registers it (the honey record §3); the word may appear in a comment
    // saying exactly that.
    expect(source).not.toMatch(/#F2BE4E|#E8B64A|--pg-events-honey|honey-ink|honey-tint/i)
  }
  // A Checkout or portal URL never enters state: the component holds no
  // `url` in a useState, and the helpers hand it to `follow` alone.
  expect(planSource).not.toMatch(/useState<[^>]*url/i)
  expect(billingSource).not.toMatch(/return \{ ok: true, url/)
})
