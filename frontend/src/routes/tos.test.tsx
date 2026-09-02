// CK-26 private-alpha notice pins. The value under test: /tos carries the
// load-bearing statements the alpha's condition 4 requires (private test,
// data not kept, sign-in links visible in a server log, real terms coming),
// the sign-in checkbox agrees to the test rather than to Terms that do not
// exist yet — with its mechanism intact (unchecked by default, submit
// disabled until checked) — and TOS_VERSION stays 1: the alpha notice's
// number, with the published terms taking 2
// (decisions/2026-08-31-private-alpha-scope.md §3).
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

test('the notice says what it is and carries every load-bearing statement', () => {
  render(
    <MemoryRouter>
      <Tos />
    </MemoryRouter>,
  )
  // The heading says what the page actually is — never "Terms of Service".
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    `${PRODUCT_NAME} is a private test`,
  )
  // Private test, by invitation, not a service.
  expect(screen.getByText(/invited you personally/i)).toBeTruthy()
  // The data will not be kept.
  expect(screen.getByText(/Nothing you put here will be kept/i)).toBeTruthy()
  expect(screen.getByText(/will be deleted when the test ends/i)).toBeTruthy()
  // What is collected — and that photo upload does not exist.
  expect(
    screen.getByText(/email address, the display name you choose, your timezone/i),
  ).toBeTruthy()
  expect(screen.getByText(/Photo upload doesn't exist yet/i)).toBeTruthy()
  // The console-mode disclosure: sign-in links are visible in a server log.
  expect(screen.getByText(/sign-in links are printed to a server log/i)).toBeTruthy()
  // Real terms and a privacy policy are coming, and they will need accepting.
  expect(screen.getByText(/asked to read and accept them/i)).toBeTruthy()
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

test('TOS_VERSION stays 1 — the alpha notice number; the published terms take 2', () => {
  // Twelve acceptance rows already point at version 1, and the alpha notice
  // is the text that makes them true. A later "tidy" renumber in either
  // direction breaks the acceptance records — the exact defect the ToS work
  // exists to close (private-alpha decision record §3).
  expect(TOS_VERSION).toBe(1)
})
