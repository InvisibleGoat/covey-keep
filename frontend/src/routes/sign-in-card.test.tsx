// CK-100 — the sign-in card, Check your email (THE DESIGN §8; THE WORDS,
// approved by Steven 2026-11-19). Since CK-100 an address with neither an
// account nor an invitation is sent a note, not a link, so the card's first
// line says a MESSAGE is on its way; and a line about the spam folder is
// added. The card is the same whatever the address: the request's answer is
// byte-identical (the API's no-enumeration rule), so the page cannot know and
// never says which was sent. The product's name comes from brand.ts.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import { SignIn } from './SignIn'
import signInSource from './SignIn.tsx?raw'

const signedOut: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const ANSWER = { detail: 'If that address can receive email, a sign-in link is on its way.' }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubApi() {
  const requests: { url: string; body: string | undefined }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined })
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify(ANSWER), { status: 202 }))
    }),
  )
  return requests
}

async function sendFor(address: string) {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={signedOut}>
        <SignIn />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: address } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
  return screen.findByRole('heading', { name: 'Check your email' })
}

function cardLines(heading: HTMLElement): string[] {
  const card = heading.closest('section') as HTMLElement
  return Array.from(card.querySelectorAll('p')).map((p) =>
    (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

test("the card's three lines, as literals", async () => {
  stubApi()
  const heading = await sendFor('pat@example.com')
  expect(cardLines(heading)).toEqual([
    `If that address can receive email, a message from ${PRODUCT_NAME} is on its way.`,
    'The link works once and expires in 15 minutes.',
    'Not there in a few minutes? Check your spam folder.',
  ])
  await screen.findByText('API: ok')
})

test('the old first line is gone: the card no longer promises a sign-in link to every address', async () => {
  stubApi()
  await sendFor('pat@example.com')
  expect(document.body.textContent ?? '').not.toMatch(/a sign-in link is on its way/i)
  await screen.findByText('API: ok')
})

test('the card is the same for any address — the page reads nothing from the answer', async () => {
  const requests = stubApi()
  const first = cardLines(await sendFor('aunt.may@kinmail.net'))
  cleanup()
  const second = cardLines(await sendFor('pat@example.com'))
  expect(first).toEqual(second)
  const sent = requests.filter((r) => r.url.endsWith('/auth/request-link'))
  expect(sent.map((r) => JSON.parse(r.body ?? '{}').email)).toEqual([
    'aunt.may@kinmail.net',
    'pat@example.com',
  ])
})

test('the card names the product through the brand module, never a literal', () => {
  expect(signInSource.toLowerCase()).not.toContain('covey')
})
