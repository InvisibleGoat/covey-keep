// Your plan (CK-74; decisions/2026-10-10-paid-tiers-on-stripe.md §12 — the
// design session's words, adjusted where the product says otherwise; the
// copy keeping-explained §3's): the current plan named by its allowance,
// its price and the day it renews or ends, the change waiting for renewal,
// the caller's own usage line with a bar beneath it, Manage your plan on a
// paid plan, and the other plans — Upgrade on the free tier, the portal on
// a paid one, because the product builds no switching UI of its own (record
// §7). Every number is the body's (lib/billing.ts), every date a DAY in the
// profile zone, and a Checkout or portal URL never enters this component:
// the helpers follow it and keep nothing.
//
// The route's path is fixed by the backend's return URLs: Checkout returns
// to /plan?checkout=complete or /plan?checkout=cancelled, the portal to
// /plan (record §11). The return from Checkout is a WAIT, never an error
// (§12): the row arrives when the webhook writes it, so this page re-reads
// GET /billing every 2 s until a paid plan shows, drops to every 10 s after
// the first 30 s and says so, stops when the page is left, and clears the
// query string once the plan shows so a reload is the ordinary screen. A
// cancelled Checkout is the ordinary screen with nothing changed and
// nothing said.
//
// Built in the app's current styles: the prototype's look belongs to the
// theming phase, and the honey colour is not registered yet, so nothing
// here may use it.
//
// CK-74.1 — the screen says only what is true. On a plan that is ending
// the Free card carries no "To go back to free, cancel in Manage your
// plan." — the plan is already cancelled, and the current card above it
// says so and what free means — while the other paid card still offers
// the portal (on a cancelling plan it still offers Update subscription
// beside Don't cancel subscription; seen on the deploy, 2026-10-21). A
// failed read can be retried: Try again re-reads GET /billing, back
// through the loading state. The waiting page carries the heading above
// its status region and the way back beneath it; leaving stops the
// polling, and the plan lands anyway when the webhook writes the row.
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import {
  BACK_TO_FREE_LINE,
  type Billing,
  type BillingPlanId,
  billingRefusalMessage,
  CHECKOUT_POLL_MS,
  CHECKOUT_POLL_SLOW_MS,
  CHECKOUT_SLOW_AFTER_MS,
  currentPlanLine,
  endingLines,
  followUrl,
  formatPhotos,
  isPaid,
  MANAGE_LABEL,
  MORE_SPACE_HEADING,
  NO_DATA_LINE,
  openPortal,
  OTHER_PLANS_HEADING,
  otherPlans,
  priceLabel,
  readBilling,
  RECOMMENDED_LABEL,
  RECOMMENDED_PLAN,
  RENEWAL_LINE,
  scheduledChangeLine,
  SLOW_LINE,
  startCheckout,
  SWITCH_LABEL,
  upgradeLabel,
  usageLine,
  usagePercent,
  WAITING_LINE,
} from '../lib/billing'
import { effectiveZone } from '../lib/datetime'

type Mode = 'loading' | 'waiting' | 'loaded' | 'failed'

// `follow` is a prop for tests only: the app follows a URL with
// window.location.assign (lib/billing.ts::followUrl).
export function Plan({ follow = followUrl }: { follow?: (url: string) => void }) {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [searchParams, setSearchParams] = useSearchParams()
  const checkout = searchParams.get('checkout')
  const [mode, setMode] = useState<Mode>(() => (checkout === 'complete' ? 'waiting' : 'loading'))
  const [billing, setBilling] = useState<Billing | null>(null)
  const [slow, setSlow] = useState(false)
  // One act at a time; which button is working, so the others wait.
  const [acting, setActing] = useState<string | null>(null)
  // A refusal stays beside the control that drew it until the next act.
  const [refusal, setRefusal] = useState<{ at: string; message: string } | null>(null)
  const alive = useRef(true)
  const setParams = useRef(setSearchParams)
  setParams.current = setSearchParams

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A cancelled Checkout: the query string cleared, nothing said.
  useEffect(() => {
    if (checkout === 'cancelled') setParams.current({}, { replace: true })
  }, [checkout])

  // The ordinary read.
  useEffect(() => {
    if (mode !== 'loading') return
    let cancelled = false
    void (async () => {
      const result = await readBilling()
      if (cancelled) return
      if (result.ok) {
        setBilling(result.billing)
        setMode('loaded')
      } else {
        setMode('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode])

  // The return from Checkout: re-read until a paid plan shows. A slow
  // webhook is a wait, never an error — a failed read is retried on the
  // same clock, and nothing here renders as a refusal.
  useEffect(() => {
    if (mode !== 'waiting') return
    let cancelled = false
    let elapsed = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      const result = await readBilling()
      if (cancelled) return
      if (result.ok && isPaid(result.billing)) {
        setBilling(result.billing)
        setMode('loaded')
        setParams.current({}, { replace: true })
        return
      }
      const slowNow = elapsed >= CHECKOUT_SLOW_AFTER_MS
      if (slowNow) setSlow(true)
      const delay = slowNow ? CHECKOUT_POLL_SLOW_MS : CHECKOUT_POLL_MS
      elapsed += delay
      timer = setTimeout(() => void tick(), delay)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [mode])

  // After a refusal that means the screen is stale, re-read in place: the
  // refusal stays where it landed and the figures catch up.
  async function refresh() {
    const result = await readBilling()
    if (!alive.current || !result.ok) return
    setBilling(result.billing)
  }

  async function upgrade(plan: BillingPlanId) {
    setActing(plan)
    setRefusal(null)
    const outcome = await startCheckout(plan, follow)
    if (!alive.current) return
    setActing(null)
    if (outcome.ok) return
    setRefusal({ at: plan, message: billingRefusalMessage(outcome.code) })
    if (outcome.code === 'already_subscribed') void refresh()
  }

  async function manage(at: string) {
    setActing(at)
    setRefusal(null)
    const outcome = await openPortal(follow)
    if (!alive.current) return
    setActing(null)
    if (outcome.ok) return
    setRefusal({ at, message: billingRefusalMessage(outcome.code) })
    if (outcome.code === 'not_found') void refresh()
  }

  if (mode === 'waiting') {
    return (
      <main className="auth-screen">
        <h1>Your plan</h1>
        <section className="plan-wait" role="status">
          <p>{WAITING_LINE}</p>
          {slow && <p className="field-hint">{SLOW_LINE}</p>}
        </section>
        <Link to="/settings">Back to settings</Link>
      </main>
    )
  }

  if (mode === 'failed') {
    // Try again is the ordinary read over again: back to `loading`, whose
    // effect re-reads, then the screen or this state once more.
    return (
      <main className="auth-screen">
        <h1>Your plan</h1>
        <p className="form-error" role="alert">
          Something went wrong loading your plan.
        </p>
        <button type="button" onClick={() => setMode('loading')}>
          Try again
        </button>
        <Link to="/settings">Back to settings</Link>
      </main>
    )
  }

  if (mode === 'loading' || billing === null) {
    return (
      <main className="auth-screen">
        <p>Loading your plan…</p>
      </main>
    )
  }

  const paid = isPaid(billing)
  const scheduled = scheduledChangeLine(billing, zone)
  const ending = endingLines(billing)
  const percent = usagePercent(billing.used, billing.allowance)

  return (
    <main className="auth-screen">
      <h1>Your plan</h1>
      {/* ADJUSTED from the prototype's "groups and gatherings": no group can
          be kept until Arc B writes owning_group_id (keeping-explained §3). */}
      <p>Space for the photos in the gatherings you keep.</p>

      <section className="auth-card plan-card plan-current" aria-labelledby="plan-current-tag">
        <p className="plan-tag" id="plan-current-tag">
          Current plan
        </p>
        <h2>{formatPhotos(billing.allowance)}</h2>
        <p>{currentPlanLine(billing, zone)}</p>
        {scheduled && <p>{scheduled}</p>}
        {ending && (
          <>
            <p>{ending[0]}</p>
            <p>{ending[1]}</p>
          </>
        )}
        {/* The usage line carries the number; the bar beneath it carries
            nothing — aria-hidden — and never draws past full. The
            prototype's "See what's using it" is not built: that screen
            does not exist. */}
        <p className="plan-usage">{usageLine(billing.used, billing.allowance)}</p>
        <div className="plan-meter" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
        {paid && (
          <button
            type="button"
            onClick={() => void manage('manage')}
            disabled={acting !== null}
          >
            {MANAGE_LABEL}
          </button>
        )}
        {refusal?.at === 'manage' && (
          <p className="form-error" role="alert">
            {refusal.message}
          </p>
        )}
      </section>

      <h2>{paid ? OTHER_PLANS_HEADING : MORE_SPACE_HEADING}</h2>
      <ul className="plan-list">
        {otherPlans(billing).map((offer) => {
          const key = offer.plan ?? 'free'
          const headingId = `plan-offer-${key}`
          const recommended = !paid && offer.plan === RECOMMENDED_PLAN
          return (
            <li key={key}>
              <section className="auth-card plan-card" aria-labelledby={headingId}>
                {recommended && <p className="plan-recommended">{RECOMMENDED_LABEL}</p>}
                <h3 id={headingId}>{formatPhotos(offer.allowance)}</h3>
                <p>{priceLabel(offer.monthly_price_cents)}</p>
                {offer.plan !== null && offer.monthly_price_cents !== null && !paid && (
                  <button
                    type="button"
                    onClick={() => void upgrade(offer.plan as BillingPlanId)}
                    disabled={acting !== null}
                  >
                    {upgradeLabel(offer.monthly_price_cents)}
                  </button>
                )}
                {offer.plan !== null && paid && (
                  <button
                    type="button"
                    onClick={() => void manage(key)}
                    disabled={acting !== null}
                  >
                    {SWITCH_LABEL}
                  </button>
                )}
                {/* Not on a plan that is ending: it is already cancelled, and
                    the current card says so. The other paid card's Switch
                    stays — the portal still offers it there. */}
                {offer.plan === null && !ending && (
                  <p className="field-hint">{BACK_TO_FREE_LINE}</p>
                )}
                {refusal?.at === key && (
                  <p className="form-error" role="alert">
                    {refusal.message}
                  </p>
                )}
              </section>
            </li>
          )
        })}
      </ul>

      <p>{NO_DATA_LINE}</p>
      <p className="field-hint">{RENEWAL_LINE}</p>
      <Link to="/settings">Back to settings</Link>
    </main>
  )
}
