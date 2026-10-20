// CK-26 private-alpha notice pins, revised at CK-73.3 for version 2. The value
// under test: /tos carries the load-bearing statements the alpha's condition 4
// requires — private test, data not kept, what is stored (photos among it:
// the three copies and the deleted original, location removed, the bin's 30
// days, what deletion leaves behind, invitees' addresses cleared after a week,
// plans in Stripe's test mode), sign-in links visible in a server log, real
// terms coming — and NEVER the sentence that went false (version 1's "Photo
// upload doesn't exist yet"); the sign-in checkbox agrees to the test rather
// than to Terms that do not exist yet — with its mechanism intact (unchecked
// by default, submit disabled until checked) — and TOS_VERSION is 2: this
// text's number, version 1 being the CK-26 text and the published terms
// taking 3 (decisions/2026-08-31-private-alpha-scope.md §3, §3.1).
//
// THE LESSON THIS FILE CARRIES: from CK-26 to CK-73.3 it pinned "Photo upload
// doesn't exist yet" — a sentence about something not built yet — and that
// pin kept a false statement alive for six weeks after CK-36 stored the first
// photograph, because no phase that began storing data looked here. Pin what
// the product DOES, and the negation of what it no longer says; never pin a
// claim about what is not built.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import { TOS_VERSION } from '../lib/api'
import { SignIn } from './SignIn'
import { Tos } from './Tos'
import tosSource from './Tos.tsx?raw'

const signedOut: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderNotice() {
  return render(
    <MemoryRouter>
      <Tos />
    </MemoryRouter>,
  )
}

test('the notice says what it is and carries every load-bearing statement', () => {
  renderNotice()
  // The heading says what the page actually is — never "Terms of Service".
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    `${PRODUCT_NAME} is a private test`,
  )
  // Private test, by invitation, not a service.
  expect(screen.getByText(/invited you personally/i)).toBeTruthy()
  // The data will not be kept — on test systems, not "a development database":
  // photos live in a storage bucket and a plan at Stripe, so the broader word.
  expect(screen.getByText(/Nothing you put here will be kept/i)).toBeTruthy()
  expect(screen.getByText(/stored on test systems/i)).toBeTruthy()
  expect(screen.getByText(/will be deleted when the test ends/i)).toBeTruthy()
  // What is collected, in version 2's words: identity, gatherings and groups,
  // RSVP answers with companion names, invitees' addresses (and when they are
  // cleared — the pending row lives out its week, acceptance clears nothing),
  // sign-in records, a passkey.
  expect(
    screen.getByText(/stores your email address, the display name you choose and your timezone/i),
  ).toBeTruthy()
  expect(screen.getByText(/gatherings and groups you create or join/i)).toBeTruthy()
  expect(screen.getByText(/names of anyone you say you're bringing/i)).toBeTruthy()
  expect(
    screen.getByText(
      /email addresses of people you invite, which are cleared after the invitation runs out a week later/i,
    ),
  ).toBeTruthy()
  expect(screen.getByText(/a passkey if you add one/i)).toBeTruthy()
  // The console-mode disclosure: sign-in links are visible in a server log.
  expect(screen.getByText(/sign-in links are printed to a server log/i)).toBeTruthy()
  // Real terms and a privacy policy are coming, and they will need accepting.
  expect(screen.getByText(/asked to read and accept them/i)).toBeTruthy()
})

test('the notice tells the truth about photographs, deletion and plans', () => {
  renderNotice()
  // Photos: three copies, the uploaded file deleted (processing.py's three
  // layers; the worker deletes the original after the ready commit).
  expect(
    screen.getByText(
      /keeps three copies of each photo at different sizes and deletes the file you uploaded/i,
    ),
  ).toBeTruthy()
  // Location removed (every byte of metadata is dropped from the copies).
  expect(screen.getByText(/location and other camera details are removed/i)).toBeTruthy()
  // Your own photos are yours to delete; the bin's clock is the sweep's
  // REMOVED_BIN, 30 days, and the sweep is on (check (gt), 2026-10-19).
  expect(screen.getByText(/delete your own photos at any time/i)).toBeTruthy()
  expect(
    screen.getByText(/a photo sent to a bin is deleted for good 30 days later/i),
  ).toBeTruthy()
  // Deletion is anonymization: the email and name go, the contributions stay
  // under ANONYMIZED_DISPLAY_NAME (api/profile.py) — the omission that
  // mattered most for consent, and the sentence a person must read before
  // they agree.
  expect(
    screen.getByText(/removes your email address and name, but photos and answers you added stay/i),
  ).toBeTruthy()
  expect(screen.getByText(/under [“"]a former member[”"]/i)).toBeTruthy()
  // Plans: Stripe's test mode, no real payment, never your card (the key is
  // boot-checked to rk_test_; the subscriptions row holds a plan and nothing
  // about a card).
  expect(
    screen.getByText(/Stripe's test mode: no real payment is taken, and a real card won't work/i),
  ).toBeTruthy()
  expect(screen.getByText(/keeps a record of which plan you're on, never your card/i)).toBeTruthy()
})

test("the sentence that went false never renders — version 1's photo claim is gone", () => {
  // The NEGATION of the CK-26 pin. "Photo upload doesn't exist yet, so no
  // photos are stored" was true on 2026-09-02 and false from CK-36 on; the
  // old pin asserted it present, and nothing failed when it stopped being
  // true. Read the whole rendered page, not one element, so the sentence is
  // caught however it is split.
  renderNotice()
  const page = document.body.textContent ?? ''
  expect(page).not.toMatch(/Photo upload doesn't exist/i)
  expect(page).not.toMatch(/no photos are stored/i)
})

test('the notice renders the product name from the brand module, never a literal', () => {
  // The brand.test.tsx discipline: the source may contain no spelling of the
  // name at all, so the rendered heading can only come from brand.ts.
  expect(tosSource.toLowerCase()).not.toContain('covey')
})

test('the sign-in checkbox agrees to the private test; the mechanism is unchanged', async () => {
  // Answer the /health probe locally so the effect settles inside the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    ),
  )
  render(
    <MemoryRouter>
      <AuthContext.Provider value={signedOut}>
        <SignIn />
      </AuthContext.Provider>
    </MemoryRouter>,
  )

  // Affirmative and unchecked by default, submit disabled until checked —
  // contract-formation hygiene that the copy change must not weaken.
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  const submit = screen.getByRole('button', {
    name: /email me a sign-in link/i,
  }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)

  // The label links to the notice and no longer names a Terms of Service
  // that does not exist.
  const noticeLink = screen.getByRole('link', { name: /private test notice/i })
  expect(noticeLink.getAttribute('href')).toBe('/tos')
  expect(screen.queryByText(/terms of service/i)).toBeNull()

  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(true)
  expect(submit.disabled).toBe(false)
  await screen.findByText('API: ok')
})

test('TOS_VERSION is 2 — this notice; version 1 is the CK-26 text, the published terms take 3', () => {
  // One number means one text, forever. Version 1 is CK-26's notice and the
  // acceptance rows recorded against it (every account created before
  // CK-73.3 — all Steven's household); 2 is the text in Tos.tsx today, true
  // about what is stored; 3 is the published terms', set by the phase that
  // publishes them. Never renumber an existing version in either direction —
  // the acceptance records would then name the wrong text, the exact defect
  // the ToS work exists to close (private-alpha decision record §3, §3.1).
  // The next change to what the product stores, or to what deletion does,
  // moves this to 3 and the terms to 4 — with the text, never without it.
  expect(TOS_VERSION).toBe(2)
})
