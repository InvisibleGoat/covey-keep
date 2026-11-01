// CK-82's riders on Settings and the email-change result. The value under
// test: both Settings forms' refusals go through the one mapper
// (lib/formErrors.ts) and render through components/FieldError.tsx with the
// error-<field> / aria-describedby contract — the profile's 422 on
// display_name and on timezone inline, any other field form-level instead
// of vanishing; the email form's 422 on new_email still reads "That doesn't
// look like an email address.", and any other 422 or a string detail renders
// a line rather than nothing; no words change for a refusal the server sends
// today. The two "Back to your gatherings" links point at /gatherings, which
// is what they say; and the email-change result, unmounted before its
// profile read answers, never calls updatePerson.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { setToken } from '../lib/session'
import { EmailChangeResult } from './EmailChangeResult'
import { Settings } from './Settings'
import settingsSource from './Settings.tsx?raw'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

function authWith(over: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signedIn',
    person,
    signIn: () => {},
    signOut: async () => {},
    updatePerson: () => {},
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.location.hash = ''
})

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

// The profile PATCH and the email-change POST answer as told; everything
// else the page loads answers quietly.
function stubServer(answers: { profile?: () => Response; emailChange?: () => Response }) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    if (method === 'PATCH' && path === '/me/profile' && answers.profile) return Promise.resolve(answers.profile())
    if (method === 'POST' && path === '/me/email-change' && answers.emailChange)
      return Promise.resolve(answers.emailChange())
    if (path === '/me/passkeys') return Promise.resolve(json(200, []))
    return Promise.resolve(json(404, { detail: 'Not Found' }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthContext.Provider value={authWith()}>
        <Settings />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function detail(field: string, msg: string) {
  return { detail: [{ loc: ['body', field], msg, type: 'value_error' }] }
}

// ---------------------------------------------------------------------------
// The profile form.
// ---------------------------------------------------------------------------

test("the profile's 422 on display_name lands on the field, wired to it, in the server's words", async () => {
  stubServer({ profile: () => json(422, detail('display_name', 'Value error, display name cannot be empty')) })
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const error = await screen.findByRole('alert')
  expect(error.id).toBe('error-display_name')
  expect(error.textContent).toBe('⚠ Display name cannot be empty')
  expect(screen.getByLabelText('Display name').getAttribute('aria-describedby')).toBe('error-display_name')
  expect(screen.getByLabelText('Time zone').getAttribute('aria-describedby')).toBeNull()
})

test("the profile's 422 on timezone lands on the field, wired to it", async () => {
  stubServer({ profile: () => json(422, detail('timezone', 'Value error, unknown time zone')) })
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const error = await screen.findByRole('alert')
  expect(error.id).toBe('error-timezone')
  expect(error.textContent).toBe('⚠ Unknown time zone')
  expect(screen.getByLabelText('Time zone').getAttribute('aria-describedby')).toBe('error-timezone')
})

test("the profile's 422 on any other field lands form-level instead of vanishing", async () => {
  stubServer({ profile: () => json(422, detail('nickname', 'Value error, not a field we know')) })
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const error = await screen.findByRole('alert')
  expect(error.id).toBe('')
  expect(error.textContent).toBe('⚠ Not a field we know (nickname)')
  expect(screen.getByLabelText('Display name').getAttribute('aria-describedby')).toBeNull()
})

test("the profile's other failures keep their line", async () => {
  stubServer({ profile: () => json(500, {}) })
  renderSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Something went wrong saving your settings. Try again.')).toBeTruthy()
})

// ---------------------------------------------------------------------------
// The email form.
// ---------------------------------------------------------------------------

function sendEmail(address: string) {
  fireEvent.change(screen.getByLabelText('New email address'), { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }))
}

test("the email form's 422 on new_email still reads this screen's own line, on the field", async () => {
  stubServer({ emailChange: () => json(422, detail('new_email', 'Value error, not an email address')) })
  renderSettings()
  // An address the browser's own check passes, which the server refuses.
  sendEmail('new@example')
  const error = await screen.findByRole('alert')
  expect(error.id).toBe('error-new_email')
  expect(error.textContent).toBe("⚠ That doesn't look like an email address.")
  expect(screen.getByLabelText('New email address').getAttribute('aria-describedby')).toBe('error-new_email')
  expect(document.body.textContent).not.toContain('Not an email address')
})

test("the email form's 422 on any other field renders a line rather than nothing", async () => {
  stubServer({ emailChange: () => json(422, detail('something_else', 'Value error, refused for a reason')) })
  renderSettings()
  sendEmail('new@example.com')
  const error = await screen.findByRole('alert')
  expect(error.textContent).toBe('⚠ Refused for a reason (something_else)')
  expect(screen.getByLabelText('New email address').getAttribute('aria-describedby')).toBeNull()
})

test("the email form's 422 with a string detail renders a line rather than nothing", async () => {
  stubServer({ emailChange: () => json(422, { detail: 'That address cannot be used.' }) })
  renderSettings()
  sendEmail('new@example.com')
  expect((await screen.findByRole('alert')).textContent).toBe('⚠ That address cannot be used.')
})

test("the email form's other lines are unchanged: the 429, the failure, and your own address", async () => {
  stubServer({ emailChange: () => json(429, {}) })
  renderSettings()
  sendEmail('new@example.com')
  expect((await screen.findByRole('alert')).textContent).toBe('⚠ Too many attempts. Wait a few minutes and try again.')
  cleanup()
  vi.unstubAllGlobals()

  stubServer({ emailChange: () => json(500, {}) })
  renderSettings()
  sendEmail('new@example.com')
  expect((await screen.findByRole('alert')).textContent).toBe('⚠ Something went wrong sending the link. Try again.')
  cleanup()
  vi.unstubAllGlobals()

  const mock = stubServer({})
  renderSettings()
  sendEmail('Steven@Example.com')
  const own = await screen.findByRole('alert')
  expect(own.textContent).toBe("⚠ That's already your sign-in address.")
  expect(screen.getByLabelText('New email address').getAttribute('aria-describedby')).toBe(own.id)
  expect(mock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
})

test("Settings' own mapper is gone: no ValidationDetail, no FieldErrors type, no loop over loc", () => {
  expect(settingsSource).not.toMatch(/ValidationDetail|interface FieldErrors|\.loc\b|humanize/)
  expect(settingsSource).toContain("from '../lib/formErrors'")
  expect(settingsSource).toContain("from '../components/FieldError'")
})

// ---------------------------------------------------------------------------
// The two "Back to your gatherings" links (the CK-19 rider).
// ---------------------------------------------------------------------------

test("Settings' Back to your gatherings points at /gatherings", () => {
  stubServer({})
  renderSettings()
  expect(screen.getByRole('link', { name: 'Back to your gatherings' }).getAttribute('href')).toBe('/gatherings')
})

test("the email-change result's Back to your gatherings points at /gatherings", () => {
  stubServer({})
  window.location.hash = '#status=success'
  render(
    <MemoryRouter initialEntries={['/email-change']}>
      <AuthContext.Provider value={authWith()}>
        <EmailChangeResult />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Back to your gatherings' }).getAttribute('href')).toBe('/gatherings')
})

// ---------------------------------------------------------------------------
// The email-change result's effect cancels on unmount (the CK-17 pattern).
// ---------------------------------------------------------------------------

test('the email-change result, unmounted before its profile read answers, never calls updatePerson', async () => {
  const gate: { release?: () => void } = {}
  const mock = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      gate.release = resolve
    })
    return json(200, { ...person, email: 'new@example.com' })
  })
  vi.stubGlobal('fetch', mock)
  setToken('session-1')
  window.location.hash = '#status=success'
  const updatePerson = vi.fn()
  const view = render(
    <MemoryRouter initialEntries={['/email-change']}>
      <AuthContext.Provider value={authWith({ updatePerson })}>
        <EmailChangeResult />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1))
  view.unmount()
  gate.release?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(updatePerson).not.toHaveBeenCalled()
})

test('the email-change result, still mounted, refreshes the person when its read answers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { ...person, email: 'new@example.com' })))
  setToken('session-1')
  window.location.hash = '#status=success'
  const updatePerson = vi.fn()
  render(
    <MemoryRouter initialEntries={['/email-change']}>
      <AuthContext.Provider value={authWith({ updatePerson })}>
        <EmailChangeResult />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(updatePerson).toHaveBeenCalledTimes(1))
  expect(updatePerson).toHaveBeenCalledWith({ ...person, email: 'new@example.com' })
})
