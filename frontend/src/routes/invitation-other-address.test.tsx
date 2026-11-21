// CK-101 — an invitation asks before another account accepts it, on both
// landings: `/groups/invitations/accept` and `/invitations/accept`, through
// the app's REAL route table with the REAL AuthProvider over the real
// session store (the CK-76.1 Gotcha), on world96's fake server.
//
// FINDING 1 of CK-100's switch checks: a phone still signed in to one
// account opened an invitation sent to another address, and the landing
// accepted it on opening. Since CK-101 the server compares the address and,
// when it differs and nothing confirms it, answers `other_address` and
// writes nothing; the landing then draws THE STEP:
// - its words as approved (Q4), naming the signed-in account's own name and
//   address and never the invited address (Q1), with the fallback words when
//   the person has not loaded;
// - focus on its <h1>, never on either button, both quiet pills (Q2);
// - Accept as {name} sends exactly {"token", "confirm_other_address": true}
//   and lands as any acceptance does; a failed one keeps the step, says the
//   house line as an alert beneath the buttons, puts focus back on the
//   button, and the next press clears the line;
// - Sign out and use the invited address ends the session and leaves the
//   parked token where it is, so the landing shows its signed-out screen —
//   the preview, then Sign in to accept, which parks the sign-in return —
//   with focus on that screen's <h1>; the gathering landing re-runs on the
//   sign-out as the group landing does.
// A match still accepts on opening with no step, and an answer the screen
// does not know still reads as `invalid`.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { readGroupInvitationToken } from '../lib/groupJoining'
import { readInvitationToken } from '../lib/invitations'
import { RETURN_PATH_KEY } from '../lib/returnPath'
import { getToken, setToken } from '../lib/session'
import { gate, pressHeld, settle } from '../test-support/focus'
import { GROUP, resetWorld96, stubWidth, stubWorld96, world96, type Key } from '../test-support/world96'

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

const HEADING = 'This invitation was sent to a different email address'
const SIGN_OUT = 'Sign out and use the invited address'
const REFUSED = 'Something went wrong. Nothing changed — try again.'

const PAGES = [
  {
    name: 'the group landing',
    path: '/groups/invitations/accept',
    accept: 'groupInvitationAccept' as Key,
    preview: 'groupInvitationPreview' as Key,
    acceptUrl: '/group-invitations/accept',
    previewUrl: '/group-invitations/preview',
    other: { status: 'other_address', group_id: null, group_name: GROUP.name },
    accepted: { status: 'accepted', group_id: GROUP.id },
    second: `You're signed in as Ada Test (ada@example.com). The invitation to join ${GROUP.name} was sent to another address.`,
    secondUnloaded: `You're signed in on this device. The invitation to join ${GROUP.name} was sent to another address.`,
    landed: GROUP.name,
    invited: `You're invited to join ${GROUP.name}`,
    parked: readGroupInvitationToken,
  },
  {
    name: 'the gathering landing',
    path: '/invitations/accept',
    accept: 'invitationAccept' as Key,
    preview: 'invitationPreview' as Key,
    acceptUrl: '/invitations/accept',
    previewUrl: '/invitations/preview',
    other: { status: 'other_address', gathering_id: null, gathering_title: 'The Party' },
    accepted: { status: 'accepted', gathering_id: 'g-1' },
    second: 'You\'re signed in as Ada Test (ada@example.com). The invitation to "The Party" was sent to another address.',
    secondUnloaded: 'You\'re signed in on this device. The invitation to "The Party" was sent to another address.',
    landed: 'The Party',
    invited: "You're invited",
    parked: readInvitationToken,
  },
]

const THIRD = "If that address is yours too, you can accept as Ada Test. If it's someone else's, sign out so they can sign in with it."
const THIRD_UNLOADED =
  "If that address is yours too, you can accept with this account. If it's someone else's, sign out so they can sign in with it."

function renderAt(path: string) {
  setToken('tok-ada')
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// The bodies the landing sent to one path, in order.
function bodiesTo(url: string): unknown[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([called]) => String(called).replace(/^https?:\/\/[^/]+/, '') === url)
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? 'null')))
}

async function settled() {
  await waitFor(() => expect(world96.inflight).toBe(0))
  await settle()
}

describe('the step on both landings', () => {
  beforeEach(() => {
    localStorage.clear()
    resetWorld96()
    stubWorld96()
    stubWidth(false)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.location.hash = ''
  })

  for (const page of PAGES) {
    async function openStep() {
      world96.answer[page.accept] = { status: 200, body: page.other }
      window.location.hash = '#token=tok-abc'
      renderAt(page.path)
      const h1 = await screen.findByRole('heading', { level: 1, name: HEADING })
      await settled()
      return h1
    }

    test(`${page.name}: the step's words as literals, naming the signed-in account and never the invited address`, async () => {
      await openStep()
      const main = screen.getByRole('main')
      const paragraphs = [...main.querySelectorAll('p')].map((p) => p.textContent)
      expect(paragraphs).toEqual([page.second, THIRD])
      const buttons = screen.getAllByRole('button').filter((b) => main.contains(b))
      expect(buttons.map((b) => b.textContent)).toEqual(['Accept as Ada Test', SIGN_OUT])
      // Neither leads (Q2): both quiet pills, no primary class on either.
      for (const button of buttons) {
        expect(button.className).not.toMatch(/primary/)
        expect(button.getAttribute('type')).toBe('button')
      }
      // The first acceptance sent today's body exactly, with no confirmation.
      expect(bodiesTo(page.acceptUrl)).toEqual([{ token: 'tok-abc' }])
      // Nothing was spent, and the token stays parked for either answer.
      expect(page.parked()).toBe('tok-abc')
      // The one address on the step is the signed-in account's own (Q1).
      expect(main.textContent?.match(/[\w.+-]+@[\w.-]+/g)).toEqual(['ada@example.com'])
    })

    test(`${page.name}: the fallback words when the person has not loaded`, async () => {
      world96.fail.me = { status: 500 }
      await openStep()
      const main = screen.getByRole('main')
      expect([...main.querySelectorAll('p')].map((p) => p.textContent)).toEqual([page.secondUnloaded, THIRD_UNLOADED])
      expect(screen.getByRole('button', { name: 'Accept with this account' })).toBeTruthy()
      expect(screen.getByRole('button', { name: SIGN_OUT })).toBeTruthy()
    })

    test(`${page.name}: focus lands on the step's <h1> and never on either button`, async () => {
      const h1 = await openStep()
      await waitFor(() => expect(document.activeElement).toBe(h1))
      await settle(100)
      expect(document.activeElement).toBe(h1)
      expect(document.activeElement?.tagName).not.toBe('BUTTON')
    })

    test(`${page.name}: Accept as sends exactly the token and the confirmation, and lands on the page`, async () => {
      await openStep()
      world96.answer[page.accept] = { status: 200, body: page.accepted }
      fireEvent.click(screen.getByRole('button', { name: 'Accept as Ada Test' }))
      await screen.findByRole('heading', { level: 1, name: page.landed })
      expect(bodiesTo(page.acceptUrl)).toEqual([{ token: 'tok-abc' }, { token: 'tok-abc', confirm_other_address: true }])
      expect(page.parked()).toBeNull()
    })

    test(`${page.name}: a failed Accept keeps the step, says the house line as an alert, puts focus on the button, and the next press clears it`, async () => {
      await openStep()
      world96.answer[page.accept] = { status: 500 }
      const hold = gate()
      world96.hold[page.accept] = hold
      await pressHeld(screen.getByRole('button', { name: 'Accept as Ada Test' }), hold)
      await settled()
      expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeTruthy()
      const line = screen.getByRole('alert')
      expect(line.textContent).toBe(REFUSED)
      const accept = screen.getByRole('button', { name: 'Accept as Ada Test' })
      await waitFor(() => expect(document.activeElement).toBe(accept))
      // The line sits beneath the buttons.
      const signOut = screen.getByRole('button', { name: SIGN_OUT })
      expect(signOut.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(page.parked()).toBe('tok-abc')

      // The next press clears it, while its request is still out.
      const again = gate()
      world96.hold[page.accept] = again
      world96.answer[page.accept] = { status: 200, body: page.accepted }
      fireEvent.click(accept)
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      again.release()
      await screen.findByRole('heading', { level: 1, name: page.landed })
    })

    test(`${page.name}: Sign out ends the session, leaves the token parked, and draws the signed-out screen with focus on its <h1>`, async () => {
      await openStep()
      fireEvent.click(screen.getByRole('button', { name: SIGN_OUT }))
      const h1 = await screen.findByRole('heading', { level: 1, name: page.invited })
      await waitFor(() => expect(document.activeElement).toBe(h1))
      expect(getToken()).toBeNull()
      expect(page.parked()).toBe('tok-abc')
      // The landing re-ran on the sign-out: the preview went out once, after
      // the acceptance, with the token still held.
      expect(bodiesTo(page.previewUrl)).toEqual([{ token: 'tok-abc' }])
      expect(world96.log.lastIndexOf(page.preview)).toBeGreaterThan(world96.log.indexOf(page.accept))
      // Sign in to accept parks the sign-in return, so the invited address
      // comes back here and accepts on opening.
      fireEvent.click(screen.getByRole('link', { name: 'Sign in to accept' }))
      await waitFor(() => {
        const parked = JSON.parse(localStorage.getItem(RETURN_PATH_KEY) ?? '{}') as { path?: string }
        expect(parked.path).toBe(page.path)
      })
      expect(page.parked()).toBe('tok-abc')
    })

    test(`${page.name}: a match accepts on opening, with no step`, async () => {
      const headings: string[] = []
      const watch = new MutationObserver(() => {
        document.querySelectorAll('h1').forEach((h) => headings.push(h.textContent ?? ''))
      })
      watch.observe(document.body, { childList: true, subtree: true, characterData: true })
      window.location.hash = '#token=tok-abc'
      renderAt(page.path)
      await screen.findByRole('heading', { level: 1, name: page.landed })
      watch.disconnect()
      expect(headings).not.toContain(HEADING)
      expect(screen.queryByRole('button', { name: SIGN_OUT })).toBeNull()
      expect(bodiesTo(page.acceptUrl)).toEqual([{ token: 'tok-abc' }])
    })

    test(`${page.name}: an answer the screen does not know still reads as invalid`, async () => {
      world96.answer[page.accept] = { status: 200, body: { status: 'something_new' } }
      window.location.hash = '#token=tok-abc'
      renderAt(page.path)
      await screen.findByRole('heading', { level: 1, name: "That invitation link didn't work" })
      expect(page.parked()).toBeNull()
    })
  }
})
