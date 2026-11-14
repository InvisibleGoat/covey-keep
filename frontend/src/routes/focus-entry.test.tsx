// CK-96 — focus after an answer on the three whole-page surfaces CK-94 left:
// sign-in, Your plan and the group's link landing, through the app's REAL
// route table with the REAL AuthProvider (the CK-76.1 Gotcha), against the
// fake server in test-support/world96.ts. A press disables the control it
// was made on, or the answer replaces it, and Chrome drops focus to the
// body; jsdom does not, so each test drops it by hand (test-support/focus.ts)
// before the answer lands. The values under test (the kickoff's §4):
// - sign-in, in `.auth-side`: sent → the card's heading; a 429, a failure or
//   a 422 → the button, the line an alert; Use a different address → the
//   Email address field; a passkey cancelled or failed → Use a passkey;
// - Your plan, in `<main>`: a refused Upgrade → that Upgrade;
//   `already_subscribed` → Manage your plan once the re-read lands, that
//   Upgrade if it fails; a refused Manage or Switch → that button; the
//   portal's `not_found` → the button pressed if still there once the
//   re-read lands, else the `<h1>`, the button pressed if it fails; Try
//   again → the `<h1>` or the new Try again; the Checkout wait keeping Back
//   to settings the same element;
// - the join landing, in `<main>`: a refused Ask to join → Ask to join; a
//   new screen → its `<h1>`; Try again → the screen's `<h1>` or the new Try
//   again;
// - a person who moved outside the container while it waited keeps their
//   place, for a failure and for a success (sign-in's column, a page's main).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle } from '../test-support/focus'
import { paidBilling, resetWorld96, stubWorld96, world96 } from '../test-support/world96'

const ceremony = vi.hoisted(() => ({ outcome: 'cancel' as 'cancel' | 'fail' }))
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => {
    if (ceremony.outcome === 'cancel') {
      const error = new Error('The operation either timed out or was not allowed.')
      error.name = 'NotAllowedError'
      throw error
    }
    throw new Error('the authenticator failed')
  },
}))

beforeEach(() => {
  localStorage.clear()
  resetWorld96()
  stubWorld96()
  ceremony.outcome = 'cancel'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  document.querySelectorAll('[data-outside]').forEach((node) => node.remove())
})

function open(path: string, signedIn = true) {
  if (signedIn) setToken('tok-ada')
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// A control outside every container a move could check: a person who moved
// there while the request waited.
function outside(): HTMLElement {
  const stand = document.createElement('button')
  stand.dataset.outside = ''
  stand.textContent = 'elsewhere'
  document.body.append(stand)
  return stand
}

// ---------------------------------------------------------------- sign-in

async function signInForm() {
  open('/', false)
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'pat@example.com' } })
  fireEvent.click(screen.getByRole('checkbox'))
  return screen.getByRole('button', { name: 'Email me a sign-in link' })
}

test('sign-in: a link sent puts focus on the sent card’s heading, Check your email', async () => {
  const submit = await signInForm()
  const hold = gate()
  world96.hold.requestLink = hold
  await pressHeld(submit, hold)
  const heading = screen.getByRole('heading', { name: 'Check your email' })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

test.each([
  [429, 'Too many link requests just now — wait a few minutes and try again.'],
  [500, 'Something went wrong sending the link. Try again.'],
  ['network', 'Something went wrong sending the link. Try again.'],
] as const)('sign-in: a %s puts focus back on Email me a sign-in link, its line an alert', async (status, line) => {
  const submit = await signInForm()
  const hold = gate()
  world96.hold.requestLink = hold
  world96.answer.requestLink = { status }
  await pressHeld(submit, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email me a sign-in link' }))
  expect(screen.getByRole('alert').textContent).toBe(line)
})

test('sign-in: a 422 keeps the generic line and puts focus back on the button, naming no field', async () => {
  const submit = await signInForm()
  const hold = gate()
  world96.hold.requestLink = hold
  world96.answer.requestLink = { status: 422, body: { detail: [{ loc: ['body', 'email'], msg: 'bad', type: 'value_error' }] } }
  await pressHeld(submit, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email me a sign-in link' }))
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong sending the link. Try again.')
  expect(screen.getByLabelText('Email address').getAttribute('aria-describedby')).toBeNull()
})

test('sign-in: Use a different address puts focus on the Email address field', async () => {
  const submit = await signInForm()
  fireEvent.click(submit)
  const again = await screen.findByRole('button', { name: 'Use a different address' })
  again.focus()
  fireEvent.click(again)
  await settle()
  expect(document.activeElement).toBe(screen.getByLabelText('Email address'))
})

test.each(['cancel', 'fail'] as const)('sign-in: a passkey that %ss puts focus back on Use a passkey', async (outcome) => {
  ceremony.outcome = outcome
  open('/', false)
  const passkey = await screen.findByRole('button', { name: 'Use a passkey' })
  const hold = gate()
  world96.hold.passkeyBegin = hold
  world96.answer.passkeyBegin = { status: 200, body: { challenge: 'c' } }
  await pressHeld(passkey, hold)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use a passkey' })))
  if (outcome === 'fail') {
    expect(screen.getByRole('alert').textContent).toBe("Passkey sign-in didn't work. Emailing yourself a link still does.")
  } else {
    expect(screen.queryByRole('alert')).toBeNull()
  }
})

test('sign-in: a refused begin is a failed passkey, its line an alert and focus on Use a passkey', async () => {
  open('/', false)
  const passkey = await screen.findByRole('button', { name: 'Use a passkey' })
  const hold = gate()
  world96.hold.passkeyBegin = hold
  await pressHeld(passkey, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use a passkey' }))
  expect(screen.getByRole('alert').textContent).toBe("Passkey sign-in didn't work. Emailing yourself a link still does.")
})

test.each([
  ['a success', undefined],
  ['a failure', { status: 500 as const }],
])('sign-in: a person who moved outside the column keeps their place after %s', async (_name, answer) => {
  const submit = await signInForm()
  const hold = gate()
  world96.hold.requestLink = hold
  if (answer) world96.answer.requestLink = answer
  const away = outside()
  await pressHeld(submit, hold, away)
  expect(document.activeElement).toBe(away)
})

// ---------------------------------------------------------------- Your plan

async function plan(billing: Record<string, unknown> = world96.billing) {
  world96.billing = billing
  open('/plan')
  await screen.findByRole('heading', { level: 1, name: 'Your plan' })
  await screen.findByText(/Space for the photos/)
}

test('Your plan: a refused Upgrade puts focus back on that Upgrade', async () => {
  await plan()
  const upgrade = screen.getByRole('button', { name: 'Upgrade for $9.99 a month' })
  const hold = gate()
  world96.hold.checkout = hold
  world96.answer.checkout = { status: 500 }
  await pressHeld(upgrade, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Upgrade for $9.99 a month' }))
})

test('Your plan: already_subscribed puts focus on Manage your plan once the plan read again lands', async () => {
  await plan()
  const upgrade = screen.getByRole('button', { name: 'Upgrade for $4.99 a month' })
  const hold = gate()
  world96.hold.checkout = hold
  world96.answer.checkout = { status: 409, body: { detail: { code: 'already_subscribed' } } }
  world96.billing = paidBilling()
  // The plan read again is held: nothing moves before it lands, not even to
  // the Upgrade pressed.
  const reread = gate()
  world96.hold.billing = reread
  await pressHeld(upgrade, hold)
  await settle()
  expect(document.activeElement).toBe(document.body)
  await act(async () => reread.release())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage your plan' })))
})

test('Your plan: already_subscribed with the plan read failing puts focus back on that Upgrade', async () => {
  await plan()
  const upgrade = screen.getByRole('button', { name: 'Upgrade for $4.99 a month' })
  const hold = gate()
  world96.hold.checkout = hold
  world96.answer.checkout = { status: 409, body: { detail: { code: 'already_subscribed' } } }
  world96.fail.billing = { status: 500 }
  await pressHeld(upgrade, hold)
  await settle()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Upgrade for $4.99 a month' }))
})

test.each([
  ['Manage your plan', 'Manage your plan'],
  ['Switch in Manage your plan', 'Switch in Manage your plan'],
])('Your plan: a refused %s puts focus back on that button', async (name) => {
  await plan(paidBilling())
  const button = screen.getByRole('button', { name })
  const hold = gate()
  world96.hold.portal = hold
  world96.answer.portal = { status: 500 }
  await pressHeld(button, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name }))
})

test('Your plan: the portal’s not_found puts focus back on the button pressed once the read lands, when it is still there', async () => {
  await plan(paidBilling())
  const hold = gate()
  world96.hold.portal = hold
  world96.answer.portal = { status: 404, body: { detail: { code: 'not_found' } } }
  await pressHeld(screen.getByRole('button', { name: 'Manage your plan' }), hold)
  await settle()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage your plan' }))
})

test('Your plan: the portal’s not_found puts focus on the <h1> once the read lands, when the button pressed is gone', async () => {
  await plan(paidBilling())
  const hold = gate()
  world96.hold.portal = hold
  world96.answer.portal = { status: 404, body: { detail: { code: 'not_found' } } }
  // The re-read shows the larger plan held, so its card, and the Switch
  // pressed on it, is not drawn.
  world96.billing = { ...paidBilling(), plan: 'photos_300k', allowance: 300000 }
  // The re-read draws the 100,000 card's Switch in its place, a different
  // button: the one pressed has left the page.
  const pressed = screen.getByRole('button', { name: 'Switch in Manage your plan' })
  await pressHeld(pressed, hold)
  await waitFor(() => expect(pressed.isConnected).toBe(false))
  await settle()
  const heading = screen.getByRole('heading', { level: 1, name: 'Your plan' })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

test('Your plan: the portal’s not_found with the read failing puts focus back on the button pressed', async () => {
  await plan(paidBilling())
  const hold = gate()
  world96.hold.portal = hold
  world96.answer.portal = { status: 404, body: { detail: { code: 'not_found' } } }
  world96.fail.billing = { status: 500 }
  await pressHeld(screen.getByRole('button', { name: 'Switch in Manage your plan' }), hold)
  await settle()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Switch in Manage your plan' }))
})

async function failedPlan() {
  world96.fail.billing = { status: 500 }
  open('/plan')
  return screen.findByRole('button', { name: 'Try again' })
}

test('Your plan: Try again that lands puts focus on the <h1> Your plan', async () => {
  const again = await failedPlan()
  delete world96.fail.billing
  const hold = gate()
  world96.hold.billing = hold
  await pressHeld(again, hold)
  await screen.findByText(/Space for the photos/)
  await settle()
  const heading = screen.getByRole('heading', { level: 1, name: 'Your plan' })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

test('Your plan: Try again that fails again puts focus on the new Try again', async () => {
  const again = await failedPlan()
  const hold = gate()
  world96.hold.billing = hold
  await pressHeld(again, hold)
  const next = await screen.findByRole('button', { name: 'Try again' })
  await settle()
  expect(document.activeElement).toBe(next)
})

test('Your plan: the Checkout wait giving way to the plan keeps Back to settings the same element, focus on it', async () => {
  const hold = gate()
  world96.hold.billing = hold
  world96.billing = paidBilling()
  open('/plan?checkout=complete')
  const back = await screen.findByRole('link', { name: 'Back to settings' })
  back.focus()
  hold.release()
  await screen.findByText(/Space for the photos/)
  await settle()
  expect(screen.getByRole('link', { name: 'Back to settings' })).toBe(back)
  expect(document.activeElement).toBe(back)
})

test.each([
  ['a success', false],
  ['a failure', true],
])('Your plan: a person who moved outside the page keeps their place after %s', async (_name, fails) => {
  const again = await failedPlan()
  if (!fails) delete world96.fail.billing
  const hold = gate()
  world96.hold.billing = hold
  const away = outside()
  await pressHeld(again, hold, away)
  await settle()
  expect(document.activeElement).toBe(away)
})

// ---------------------------------------------------------------- the join landing

async function landing() {
  window.location.hash = '#token=tok-abc'
  open('/groups/join')
  return screen.findByRole('button', { name: 'Ask to join' })
}

test('the join landing: a refused Ask to join puts focus back on Ask to join', async () => {
  const ask = await landing()
  const hold = gate()
  world96.hold.join = hold
  world96.answer.join = { status: 500 }
  await pressHeld(ask, hold)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask to join' }))
})

test.each([
  ['requested', 'Your request is in'],
  ['pending', "You've already asked to join"],
  ['invalid', "That link didn't work"],
])('the join landing: Ask to join answered %s puts focus on the new screen’s <h1>', async (status, title) => {
  const ask = await landing()
  const hold = gate()
  world96.hold.join = hold
  world96.joinAnswer = { status, group_id: null }
  await pressHeld(ask, hold)
  const heading = screen.getByRole('heading', { level: 1, name: title })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

async function failedLanding() {
  window.location.hash = '#token=tok-abc'
  world96.fail.preview = { status: 500 }
  open('/groups/join')
  return screen.findByRole('button', { name: 'Try again' })
}

test('the join landing: Try again that lands puts focus on the screen’s <h1>', async () => {
  const again = await failedLanding()
  delete world96.fail.preview
  const hold = gate()
  world96.hold.preview = hold
  await pressHeld(again, hold)
  await settle()
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Join The Lees?' }))
})

test('the join landing: Try again that fails again puts focus on the new Try again', async () => {
  const again = await failedLanding()
  const hold = gate()
  world96.hold.preview = hold
  await pressHeld(again, hold)
  const next = await screen.findByRole('button', { name: 'Try again' })
  await settle()
  expect(document.activeElement).toBe(next)
})

test('the join landing: an already_member answer navigates, and nothing is focused by hand', async () => {
  const ask = await landing()
  world96.joinAnswer = { status: 'already_member', group_id: 'grp-1' }
  ask.focus()
  fireEvent.click(ask)
  await screen.findByRole('heading', { level: 1, name: 'The Lees' })
  dropFocusToBody()
  await settle()
  expect(document.activeElement).toBe(document.body)
})
