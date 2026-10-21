// CK-74 pins on the plan screen's helpers. The value under test: every
// number on the screen comes from the body — the allowance, the usage, the
// prices and the free tier's figure all read from `GET /billing`, so the
// screen keeps no numbers of its own; the usage line's three forms (plain,
// "almost full" at 90%, "full" at or past the allowance — as true on a paid
// plan as on the free tier) and a bar that never draws past full; dates as a
// DAY in the person's zone (a renewal at 02:10 UTC on Nov 12 is Nov 11 in
// Pacific time, and the line says so); the two acts posting once and
// FOLLOWING THE URL INSIDE THE CALL — a Checkout or portal URL is a bearer
// credential (the presigned-URL rule, CK-38) and never comes back to the
// caller, into state, a log or an error; and one refusal line per code,
// never per wording.
import { afterEach, expect, test, vi } from 'vitest'
import { PRODUCT_NAME } from '../brand'
import {
  type Billing,
  billingRefusalMessage,
  CHECKOUT_POLL_MS,
  CHECKOUT_POLL_SLOW_MS,
  CHECKOUT_SLOW_AFTER_MS,
  currentPlanLine,
  endingLines,
  formatPhotos,
  NO_DATA_LINE,
  openPortal,
  otherPlans,
  planLine,
  priceLabel,
  readBilling,
  RECOMMENDED_PLAN,
  RENEWAL_LINE,
  scheduledChangeLine,
  startCheckout,
  upgradeLabel,
  usageFraction,
  usageLine,
} from './billing'
import { networkErrors } from './formErrors'

afterEach(() => {
  vi.unstubAllGlobals()
})

// The body's plan table, as GET /billing sends it (the backend's one table).
const PLANS = [
  { plan: null, allowance: 10_000, monthly_price_cents: null },
  { plan: 'photos_100k' as const, allowance: 100_000, monthly_price_cents: 499 },
  { plan: 'photos_300k' as const, allowance: 300_000, monthly_price_cents: 999 },
]

function billing(over: Partial<Billing> = {}): Billing {
  return {
    plan: null,
    status: null,
    current_period_end: null,
    ends_at: null,
    allowance: 10_000,
    used: 0,
    scheduled_change: null,
    plans: PLANS,
    next: 'checkout',
    ...over,
  }
}

const PERIOD_END = '2026-11-12T02:10:00+00:00'
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_never_in_state_1234567890'
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_never_in_state_0987654321'

function answer(status: number, body?: unknown) {
  const mock = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

test('the usage line has three forms, as true on a paid plan as on the free tier, and the bar never draws past full', () => {
  expect(usageLine(1_240, 10_000)).toBe('1,240 of 10,000 photos')
  expect(usageLine(0, 100_000)).toBe('0 of 100,000 photos')
  expect(usageLine(8_999, 10_000)).toBe('8,999 of 10,000 photos')
  // At 90% or more: almost full.
  expect(usageLine(9_000, 10_000)).toBe('Your space is almost full: 9,000 of 10,000 photos.')
  expect(usageLine(9_600, 10_000)).toBe('Your space is almost full: 9,600 of 10,000 photos.')
  // ADJUSTED from the prototype, which said it on the free tier only: the
  // statement is as true on a paid plan.
  expect(usageLine(95_000, 100_000)).toBe('Your space is almost full: 95,000 of 100,000 photos.')
  // At or over the allowance: full.
  expect(usageLine(10_000, 10_000)).toBe('Your space is full: 10,000 of 10,000 photos.')
  expect(usageLine(10_200, 10_000)).toBe('Your space is full: 10,200 of 10,000 photos.')
  // The bar: a fraction of the allowance, capped at full.
  expect(usageFraction(0, 10_000)).toBe(0)
  expect(usageFraction(5_000, 10_000)).toBe(0.5)
  expect(usageFraction(10_000, 10_000)).toBe(1)
  expect(usageFraction(10_200, 10_000)).toBe(1)
})

test('every number reads from the body: allowances, prices, the plan line, the upgrade label', () => {
  expect(formatPhotos(10_000)).toBe('10,000 photos')
  expect(formatPhotos(100_000)).toBe('100,000 photos')
  expect(priceLabel(499)).toBe('$4.99 a month')
  expect(priceLabel(999)).toBe('$9.99 a month')
  expect(priceLabel(null)).toBe('Free')
  expect(upgradeLabel(499)).toBe('Upgrade for $4.99 a month')
  // The Settings line: the current allowance and the current plan's price,
  // the price found in the body's table by the plan.
  expect(planLine(billing())).toBe('10,000 photos · Free')
  expect(planLine(billing({ plan: 'photos_100k', allowance: 100_000, next: 'portal' }))).toBe(
    '100,000 photos · $4.99 a month',
  )
  expect(planLine(billing({ plan: 'photos_300k', allowance: 300_000, next: 'portal' }))).toBe(
    '300,000 photos · $9.99 a month',
  )
  // The other plans: every offer but the current one, in the body's order.
  expect(otherPlans(billing()).map((offer) => offer.plan)).toEqual(['photos_100k', 'photos_300k'])
  expect(
    otherPlans(billing({ plan: 'photos_100k', allowance: 100_000 })).map((offer) => offer.plan),
  ).toEqual([null, 'photos_300k'])
  expect(RECOMMENDED_PLAN).toBe('photos_100k')
})

test('the current plan line: renews or ends on a DAY in the zone, or Free', () => {
  const paid = billing({
    plan: 'photos_100k',
    status: 'active',
    current_period_end: PERIOD_END,
    allowance: 100_000,
    next: 'portal',
  })
  expect(currentPlanLine(paid, 'UTC')).toBe('$4.99 a month · Renews on Nov 12')
  // 02:10 UTC on Nov 12 is the evening of Nov 11 in Pacific time — the
  // CK-17 rule: the person's profile zone, never the browser's.
  expect(currentPlanLine(paid, 'America/Los_Angeles')).toBe('$4.99 a month · Renews on Nov 11')
  expect(currentPlanLine({ ...paid, ends_at: PERIOD_END }, 'UTC')).toBe(
    '$4.99 a month · Ends on Nov 12',
  )
  expect(currentPlanLine({ ...paid, ends_at: PERIOD_END }, 'America/Los_Angeles')).toBe(
    '$4.99 a month · Ends on Nov 11',
  )
  // A paid row with no period end yet (nullable on the row): the price alone.
  expect(currentPlanLine({ ...paid, current_period_end: null }, 'UTC')).toBe('$4.99 a month')
  expect(currentPlanLine(billing(), 'UTC')).toBe('Free')
})

test('the scheduled change names the plan and its day; the ending lines name the free tier from the body', () => {
  const scheduled = billing({
    plan: 'photos_300k',
    status: 'active',
    current_period_end: PERIOD_END,
    allowance: 300_000,
    scheduled_change: { plan: 'photos_100k', allowance: 100_000, at: PERIOD_END },
    next: 'portal',
  })
  expect(scheduledChangeLine(scheduled, 'UTC')).toBe('Switches to 100,000 photos on Nov 12.')
  expect(scheduledChangeLine(scheduled, 'America/Los_Angeles')).toBe(
    'Switches to 100,000 photos on Nov 11.',
  )
  expect(scheduledChangeLine(billing(), 'UTC')).toBeNull()

  const ending = billing({
    plan: 'photos_100k',
    status: 'active',
    current_period_end: PERIOD_END,
    ends_at: PERIOD_END,
    allowance: 100_000,
    next: 'portal',
  })
  expect(endingLines(ending)).toEqual([
    "You keep this plan until then. After that you're on the free plan, 10,000 photos, and nothing you keep is removed or hidden.",
    "If what you keep is more than 10,000 photos, new photos stop until there's room.",
  ])
  // The free figure is the body's, not the screen's: a different free tier
  // in the table reads through.
  const otherFree = {
    ...ending,
    plans: [{ plan: null, allowance: 20_000, monthly_price_cents: null }, ...PLANS.slice(1)],
  }
  expect(endingLines(otherFree)?.[0]).toContain('20,000 photos')
  expect(endingLines(billing())).toBeNull()
  expect(endingLines({ ...ending, ends_at: null })).toBeNull()
})

test('the two closing lines name the product from brand.ts and promise nothing', () => {
  expect(NO_DATA_LINE).toBe(`${PRODUCT_NAME} sells no data and shows no ads, free or paid.`)
  expect(RENEWAL_LINE).toBe(
    `Paid plans renew every month until you cancel. Payment is handled by Stripe, so your card never reaches ${PRODUCT_NAME}.`,
  )
  // The return page's cadence: 2 s, then 10 s after the first 30 s.
  expect([CHECKOUT_POLL_MS, CHECKOUT_POLL_SLOW_MS, CHECKOUT_SLOW_AFTER_MS]).toEqual([
    2_000, 10_000, 30_000,
  ])
})

test('startCheckout posts the plan once, follows the URL inside the call, and never returns it', async () => {
  const mock = answer(200, { url: CHECKOUT_URL })
  const followed: string[] = []
  const outcome = await startCheckout('photos_100k', (url) => {
    followed.push(url)
  })
  expect(outcome).toEqual({ ok: true })
  expect(JSON.stringify(outcome)).not.toContain('stripe')
  expect(followed).toEqual([CHECKOUT_URL])
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url.endsWith('/billing/checkout')).toBe(true)
  expect(init.method).toBe('POST')
  expect(init.body).toBe(JSON.stringify({ plan: 'photos_100k' }))
})

test('openPortal posts once with no body, follows the URL inside the call, and never returns it', async () => {
  const mock = answer(200, { url: PORTAL_URL })
  const followed: string[] = []
  const outcome = await openPortal((url) => {
    followed.push(url)
  })
  expect(outcome).toEqual({ ok: true })
  expect(JSON.stringify(outcome)).not.toContain('stripe')
  expect(followed).toEqual([PORTAL_URL])
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url.endsWith('/billing/portal')).toBe(true)
  expect(init.method).toBe('POST')
  expect(init.body).toBeUndefined()
})

test("a refused act answers the server's code and never its wording, and follows nothing", async () => {
  const followed: string[] = []
  const follow = (url: string) => {
    followed.push(url)
  }
  answer(409, { detail: { code: 'already_subscribed', message: 'reworded on purpose' } })
  expect(await startCheckout('photos_100k', follow)).toEqual({ ok: false, code: 'already_subscribed' })
  answer(503, { detail: { code: 'billing_unavailable', message: 'reworded on purpose' } })
  expect(await startCheckout('photos_300k', follow)).toEqual({ ok: false, code: 'billing_unavailable' })
  expect(await openPortal(follow)).toEqual({ ok: false, code: 'billing_unavailable' })
  answer(404, { detail: 'No such plan.' })
  expect(await openPortal(follow)).toEqual({ ok: false, code: 'not_found' })
  answer(500)
  expect(await startCheckout('photos_100k', follow)).toEqual({ ok: false, code: 'failed' })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network'))))
  expect(await startCheckout('photos_100k', follow)).toEqual({ ok: false, code: 'unreachable' })
  expect(await openPortal(follow)).toEqual({ ok: false, code: 'unreachable' })
  expect(followed).toEqual([])
})

test('one refusal line per code', () => {
  expect(billingRefusalMessage('already_subscribed')).toBe(
    'You already have a plan. Use Manage your plan to change it.',
  )
  expect(billingRefusalMessage('billing_unavailable')).toBe(
    "Stripe didn't answer, and nothing was charged. Try again in a moment.",
  )
  expect(billingRefusalMessage('not_found')).toBe("There's no plan to manage yet.")
  expect(billingRefusalMessage('unreachable')).toBe(networkErrors().form[0])
  expect(billingRefusalMessage('failed')).toBe('Something went wrong. Nothing changed — try again.')
})

test('readBilling returns the body, or why it could not', async () => {
  answer(200, billing({ used: 7 }))
  const read = await readBilling()
  expect(read.ok && read.billing.used).toBe(7)
  answer(500)
  expect(await readBilling()).toEqual({ ok: false, code: 'failed' })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network'))))
  expect(await readBilling()).toEqual({ ok: false, code: 'unreachable' })
})
