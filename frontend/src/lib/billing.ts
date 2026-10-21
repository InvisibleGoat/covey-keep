// The plan screen's helpers (CK-74; decisions/2026-10-10-paid-tiers-on-stripe.md
// §5, §7, §11, §12; the copy keeping-explained §3's): the API types, the
// two acts that spend a Checkout or portal URL, one refusal line per code,
// and every piece of copy that carries a number.
//
// Three rules, binding on every reader of this module:
//
// - EVERY NUMBER COMES FROM THE BODY. The allowance, the usage, the prices
//   and the free tier's figure are all read from `GET /billing` (its
//   `allowance`, `used` and `plans`), so the screen keeps no numbers of its
//   own — a price changed on the backend changes here with no edit. `used`
//   is the CHARGED count (the bin record §4: photographs in the gatherings
//   the caller keeps, binned and in-flight ones included) and is the
//   caller's own; it is shown to them alone and never called "your photos".
//
// - A CHECKOUT OR PORTAL URL NEVER LEAVES ITS CALL. It is a bearer credential
//   for a payment surface (the presigned-URL rule, CK-38): `startCheckout`
//   and `openPortal` read it from the response and hand it to `follow` —
//   `window.location.assign` in the app, a spy in a test — and answer with
//   an outcome that carries no URL. Not into state, the DOM, a log or an
//   error.
//
// - THE COPY FOLLOWS keeping-explained §3. Never "safe", "secure", "backed
//   up" or "forever"; never "quota" (it is space); never a byte unit. A
//   plan is space, never a guarantee that memories survive. Dates render as
//   a DAY in the person's profile zone through lib/datetime.ts (the CK-17
//   rule): a renewal at 02:10 UTC on Nov 12 is Nov 11 in Pacific time, and
//   the line says Nov 11 there.
import { PRODUCT_NAME } from '../brand'
import { authFetch } from './api'
import { formatDay } from './datetime'
import { networkErrors } from './formErrors'

export type BillingPlanId = 'photos_100k' | 'photos_300k'

// One row of the body's plan table: the free tier (`plan` null, no price)
// and each paid plan, by allowance.
export interface PlanOffer {
  plan: BillingPlanId | null
  allowance: number
  monthly_price_cents: number | null
}

// The change waiting for renewal (CK-73.2): the next plan, its allowance
// and the instant it takes effect; null whenever the plan is ending.
export interface ScheduledChange {
  plan: BillingPlanId
  allowance: number
  at: string
}

// `GET /billing` (CK-73; `ends_at` CK-73.1; `scheduled_change` CK-73.2;
// `used` and `plans` CK-74). Never a Stripe id.
export interface Billing {
  plan: BillingPlanId | null
  status: string | null
  current_period_end: string | null
  ends_at: string | null
  allowance: number
  used: number
  scheduled_change: ScheduledChange | null
  plans: PlanOffer[]
  next: 'checkout' | 'portal'
}

export type BillingRead =
  | { ok: true; billing: Billing }
  | { ok: false; code: 'failed' | 'unreachable' }

export async function readBilling(): Promise<BillingRead> {
  try {
    const response = await authFetch('/billing')
    if (!response.ok) return { ok: false, code: 'failed' }
    return { ok: true, billing: (await response.json()) as Billing }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// --- the two acts -----------------------------------------------------------------

// The server's stable codes (the CK-30 marker precedent) plus the client's
// own two: `not_found` for the portal's 404 (no customer yet), `unreachable`
// for a request that never reached the server, `failed` for anything else.
export type BillingRefusalCode =
  | 'already_subscribed'
  | 'billing_unavailable'
  | 'not_found'
  | 'unreachable'
  | 'failed'

export type BillingActOutcome = { ok: true } | { ok: false; code: BillingRefusalCode }

// Where a Checkout or portal URL goes, and the only place: a full
// navigation to Stripe's own page. The app passes nothing else; a test
// passes a spy.
export function followUrl(url: string): void {
  window.location.assign(url)
}

async function spend(
  path: string,
  init: RequestInit,
  follow: (url: string) => void,
): Promise<BillingActOutcome> {
  try {
    const response = await authFetch(path, init)
    if (response.ok) {
      // The URL lives in this block alone: read, followed, gone.
      const { url } = (await response.json()) as { url: string }
      follow(url)
      return { ok: true }
    }
    if (response.status === 404) return { ok: false, code: 'not_found' }
    if (response.status === 409 || response.status === 503) {
      const body = (await response.json().catch(() => null)) as {
        detail?: { code?: string }
      } | null
      const code = body?.detail?.code
      return {
        ok: false,
        code: code === 'already_subscribed' || code === 'billing_unavailable' ? code : 'failed',
      }
    }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// Buy a plan: `POST /billing/checkout {plan}`, then Stripe's Checkout page.
export function startCheckout(
  plan: BillingPlanId,
  follow: (url: string) => void = followUrl,
): Promise<BillingActOutcome> {
  return spend(
    '/billing/checkout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    },
    follow,
  )
}

// Manage the plan: `POST /billing/portal`, then the Customer Portal — the
// card, switching plans, cancelling and the invoices are all Stripe's
// surfaces (record §7); the product builds no switching UI of its own.
export function openPortal(follow: (url: string) => void = followUrl): Promise<BillingActOutcome> {
  return spend('/billing/portal', { method: 'POST' }, follow)
}

// What a refused act tells the person — switched on the CODE and never the
// wording, so a reworded server message changes nothing here. None claims
// anything was charged, changed or set up when it was not.
export function billingRefusalMessage(code: string): string {
  switch (code) {
    case 'already_subscribed':
      return 'You already have a plan. Use Manage your plan to change it.'
    case 'billing_unavailable':
      return "Stripe didn't answer, and nothing was charged. Try again in a moment."
    case 'not_found':
      return "There's no plan to manage yet."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// --- the copy, every number from the body ------------------------------------------

function number(n: number): string {
  return n.toLocaleString('en-US')
}

// "100,000 photos" — a plan is named by what it holds (record §3).
export function formatPhotos(allowance: number): string {
  return `${number(allowance)} photos`
}

// "$4.99 a month", or "Free" for the tier with no price.
export function priceLabel(cents: number | null): string {
  if (cents === null) return 'Free'
  return `$${(cents / 100).toFixed(2)} a month`
}

export function upgradeLabel(cents: number): string {
  return `Upgrade for ${priceLabel(cents)}`
}

export function isPaid(billing: Billing): boolean {
  return billing.plan !== null
}

function currentOffer(billing: Billing): PlanOffer | undefined {
  return billing.plans.find((offer) => offer.plan === billing.plan)
}

export function currentPriceCents(billing: Billing): number | null {
  return currentOffer(billing)?.monthly_price_cents ?? null
}

// The free tier's figure, from the body's table and never from here.
function freeAllowance(billing: Billing): number {
  return (
    billing.plans.find((offer) => offer.plan === null)?.allowance ??
    Math.min(...billing.plans.map((offer) => offer.allowance))
  )
}

// The Settings line: "10,000 photos · Free", "100,000 photos · $4.99 a month".
export function planLine(billing: Billing): string {
  return `${formatPhotos(billing.allowance)} · ${priceLabel(currentPriceCents(billing))}`
}

// Every plan but the current one, in the body's order (by allowance).
export function otherPlans(billing: Billing): PlanOffer[] {
  return billing.plans.filter((offer) => offer.plan !== billing.plan)
}

// The current card's line beneath its allowance: on a paid plan the price
// and the day it renews — or ends, when `ends_at` is set — in the zone;
// "Free" on the free tier.
export function currentPlanLine(billing: Billing, zone: string): string {
  if (!isPaid(billing)) return 'Free'
  const price = priceLabel(currentPriceCents(billing))
  const day = billing.ends_at ?? billing.current_period_end
  if (!day) return price
  return `${price} · ${billing.ends_at ? 'Ends on' : 'Renews on'} ${formatDay(day, zone)}`
}

// The record §12's line, its allowance and its day from the body.
export function scheduledChangeLine(billing: Billing, zone: string): string | null {
  const change = billing.scheduled_change
  if (!change) return null
  return `Switches to ${formatPhotos(change.allowance)} on ${formatDay(change.at, zone)}.`
}

// What ending means, said here so nobody learns it at the wall
// (keeping-explained §1 item 13: nothing frozen, hidden or deleted; new
// photos stop for the gatherings they keep if what they keep is more than
// the free tier holds). The first sentence is the prototype's; the second
// is CK-74's addition beside it.
export function endingLines(billing: Billing): [string, string] | null {
  if (!isPaid(billing) || !billing.ends_at) return null
  const free = formatPhotos(freeAllowance(billing))
  return [
    `You keep this plan until then. After that you're on the free plan, ${free}, and nothing you keep is removed or hidden.`,
    `If what you keep is more than ${free}, new photos stop until there's room.`,
  ]
}

// The usage line's three forms. "Almost full" at 90% or more, "full" at or
// past the allowance — as true on a paid plan as on the free tier (the
// prototype said it on the free tier only; ADJUSTED).
export const USAGE_ALMOST_FULL_AT = 0.9

export function usageLine(used: number, allowance: number): string {
  const figures = `${number(used)} of ${formatPhotos(allowance)}`
  if (allowance > 0 && used >= allowance) return `Your space is full: ${figures}.`
  if (allowance > 0 && used / allowance >= USAGE_ALMOST_FULL_AT) {
    return `Your space is almost full: ${figures}.`
  }
  return figures
}

// The bar beneath the line: a fraction of the allowance, never past full.
export function usageFraction(used: number, allowance: number): number {
  if (allowance <= 0) return 1
  return Math.min(1, Math.max(0, used / allowance))
}

// The bar's width, one decimal, never past 100.
export function usagePercent(used: number, allowance: number): number {
  return Math.round(usageFraction(used, allowance) * 1000) / 10
}

// --- the fixed copy ------------------------------------------------------------------

export const RECOMMENDED_PLAN: BillingPlanId = 'photos_100k'
// "Recommended", not "Most popular": nothing has been sold (Steven,
// 2026-10-14; the honey record §7). On the free view only — on every view
// it would recommend a downgrade to someone on 300,000.
export const RECOMMENDED_LABEL = 'Recommended'
export const MORE_SPACE_HEADING = 'More space'
export const OTHER_PLANS_HEADING = 'Other plans'
export const MANAGE_LABEL = 'Manage your plan'
export const SWITCH_LABEL = 'Switch in Manage your plan'
export const BACK_TO_FREE_LINE = 'To go back to free, cancel in Manage your plan.'
// keeping-explained §5.8: stated where someone decides to pay.
export const NO_DATA_LINE = `${PRODUCT_NAME} sells no data and shows no ads, free or paid.`
export const RENEWAL_LINE = `Paid plans renew every month until you cancel. Payment is handled by Stripe, so your card never reaches ${PRODUCT_NAME}.`

// The return from Checkout (record §12): a wait, never an error. Re-read
// every 2 s; after the first 30 s every 10 s, with the slow line.
export const WAITING_LINE = 'Setting up your plan…'
export const SLOW_LINE =
  'This is taking a little longer than usual. Your plan will appear here when Stripe confirms it.'
export const CHECKOUT_POLL_MS = 2_000
export const CHECKOUT_POLL_SLOW_MS = 10_000
export const CHECKOUT_SLOW_AFTER_MS = 30_000
