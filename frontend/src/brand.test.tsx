// CK-14 brand-module pins. The value under test is never the name's current
// spelling — it is that the rendered heading, the tagline, and the document
// title all flow from src/brand.ts, so the next rename touches one file.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import indexHtml from '../index.html?raw'
import { AuthContext, type AuthState } from './auth/context'
import { PRODUCT_NAME, TAGLINE } from './brand'
import { SignIn } from './routes/SignIn'

const signedOutAuth: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('sign-in heading and tagline render from the brand module', async () => {
  // The sign-in screen probes /health on mount; answer it locally so the test
  // never opens a network connection and the effect settles inside the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    ),
  )
  render(
    <MemoryRouter>
      <AuthContext.Provider value={signedOutAuth}>
        <SignIn />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(PRODUCT_NAME)
  expect(screen.getByText(TAGLINE)).toBeTruthy()
  await screen.findByText('API: ok')
})

test('document title comes from the brand module, never a literal', () => {
  // index.html carries only the placeholder the build fills from PRODUCT_NAME
  // (the brand-title plugin in vite.config.ts) — no spelling of the name may
  // exist there for the title to drift toward.
  expect(indexHtml).toContain('<title>%PRODUCT_NAME%</title>')
  expect(indexHtml.toLowerCase()).not.toContain('covey')
})
