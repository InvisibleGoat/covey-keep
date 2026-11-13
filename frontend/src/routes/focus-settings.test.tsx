// CK-94 — focus after an answer on Settings, through the app's REAL route
// table with the REAL AuthProvider (the CK-76.1 Gotcha), against a fake
// server that holds each write on a released promise. A press disables the
// control it was made on, and Chrome drops focus to the body while the
// request waits; jsdom has neither, so each test drops focus to the body by
// hand (test-support/focus.ts) before the answer lands. The values under
// test (the kickoff's §3, Settings):
// - Save: a 422 to the field, any other failure to Save, a success to Save
//   with *Saved.* announced (`role="status"`);
// - Send confirmation link: a 422 or the same-address check to the email
//   field, a 429 or any other failure to the button, a success to the
//   pending sentence;
// - Cancel the change: a failure to the button, a success to the email field;
// - Delete my account: a failure to the button, DELETE kept;
// - Add a passkey: a failure, a cancel or a success to Add a passkey;
// - Remove: a failure to that Remove, a success to the next passkey's
//   Remove, else Add a passkey;
// - a person who moved elsewhere while it waited keeps their place;
// - the failure lines carry `role="alert"`.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle, type Gate } from '../test-support/focus'

const ceremony = vi.hoisted(() => ({ outcome: 'ok' as 'ok' | 'cancel' }))
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => {
    if (ceremony.outcome === 'cancel') {
      const error = new Error('The operation either timed out or was not allowed.')
      error.name = 'NotAllowedError'
      throw error
    }
    return { id: 'cred-new', rawId: 'cred-new', type: 'public-key', response: {} }
  },
  startAuthentication: async () => ({}),
}))

const PERSON = {
  id: 'person-sam',
  display_name: 'Sam Marlowe',
  email: 'sam@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-sam',
}

type Key = 'profile' | 'email' | 'emailCancel' | 'delete' | 'pkBegin' | 'pkComplete' | 'pkRemove'

interface World {
  status: Partial<Record<Key, number>>
  field: string
  hold: Partial<Record<Key, Gate>>
  passkeys: { id: string; nickname: string | null; backup_eligible: null; created_at: string; last_used_at: null }[]
}

let world: World
let mock: ReturnType<typeof vi.fn>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function passkey(id: string, nickname: string) {
  return { id, nickname, backup_eligible: null, created_at: '2026-11-01T12:00:00+00:00', last_used_at: null }
}

async function answer(key: Key, ok: () => Response): Promise<Response> {
  await world.hold[key]?.promise
  const status = world.status[key]
  if (status === undefined) return ok()
  if (status === 422) return json(422, { detail: [{ loc: ['body', world.field], msg: 'Value error, refused', type: 'value_error' }] })
  return json(status, { detail: 'refused' })
}

function stubServer() {
  mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/auth/me') return json(200, PERSON)
    if (p === '/groups') return json(200, { groups: [] })
    if (p === '/gatherings') return json(200, { gatherings: [] })
    if (p === '/billing') return json(404, {})
    if (p === '/me/profile' && method === 'PATCH') return answer('profile', () => json(200, PERSON))
    if (p === '/me/email-change' && method === 'POST') return answer('email', () => new Response(null, { status: 202 }))
    if (p === '/me/email-change' && method === 'DELETE') return answer('emailCancel', () => new Response(null, { status: 204 }))
    if (p === '/me/delete' && method === 'POST') return answer('delete', () => new Response(null, { status: 204 }))
    if (p === '/me/passkeys') return json(200, { passkeys: world.passkeys })
    if (p === '/me/passkeys/register/begin') return answer('pkBegin', () => json(200, { challenge: 'c', rp: { name: 'x' } }))
    if (p === '/me/passkeys/register/complete') {
      return answer('pkComplete', () => {
        const added = passkey('pk-new', 'Tablet')
        world.passkeys = [...world.passkeys, added]
        return json(201, added)
      })
    }
    if (p.startsWith('/me/passkeys/') && method === 'DELETE') {
      return answer('pkRemove', () => {
        world.passkeys = world.passkeys.filter((entry) => entry.id !== p.split('/').pop())
        return new Response(null, { status: 204 })
      })
    }
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', mock)
}

beforeEach(() => {
  localStorage.clear()
  setToken('token-sam')
  ceremony.outcome = 'ok'
  world = { status: {}, field: 'display_name', hold: {}, passkeys: [passkey('pk-1', 'Laptop'), passkey('pk-2', 'Phone')] }
  stubServer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function openSettings() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  await screen.findByText('Laptop')
  await settle()
}

// Hold the write, press, drop focus to the body (or move it), release.
async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  world.hold[key] = gate()
  await pressHeld(control, world.hold[key]!, movedTo)
  await settle()
}

const save = () => screen.getByRole('button', { name: 'Save' })
const profileForm = () => save().closest('form')!
const sendLink = () => screen.getByRole('button', { name: 'Send confirmation link' })
const emailField = () => screen.getByLabelText('New email address')
const passkeys = () => screen.getByRole('region', { name: 'Passkeys' })
const addPasskey = () => within(passkeys()).getByRole('button', { name: 'Add a passkey' })
const removes = () => within(passkeys()).getAllByRole('button', { name: 'Remove' })

async function pending() {
  fireEvent.change(emailField(), { target: { value: 'new@example.com' } })
  fireEvent.click(sendLink())
  await screen.findByRole('button', { name: 'Cancel the change' })
  await settle()
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

test("Save's 422 on display_name puts focus on the display name field", async () => {
  await openSettings()
  world.status.profile = 422
  world.field = 'display_name'
  await held('profile', save())
  expect(document.activeElement).toBe(screen.getByLabelText('Display name'))
})

test("Save's 422 on timezone puts focus on the time zone", async () => {
  await openSettings()
  world.status.profile = 422
  world.field = 'timezone'
  await held('profile', save())
  expect(document.activeElement).toBe(screen.getByLabelText('Time zone'))
})

test("Save's 422 on a field the form does not show puts focus back on Save", async () => {
  await openSettings()
  world.status.profile = 422
  world.field = 'nickname'
  await held('profile', save())
  expect(document.activeElement).toBe(save())
})

test('a failed Save puts focus back on Save, the line an alert', async () => {
  await openSettings()
  world.status.profile = 500
  await held('profile', save())
  expect(document.activeElement).toBe(save())
  expect(within(profileForm()).getByRole('alert').textContent).toBe('Something went wrong saving your settings. Try again.')
})

test('a landed Save puts focus back on Save, with Saved. announced', async () => {
  await openSettings()
  await held('profile', save())
  expect(document.activeElement).toBe(save())
  expect(within(profileForm()).getByRole('status').textContent).toBe('Saved.')
})

test('a person who moved on while Save waited keeps their place, on a failure and on a success', async () => {
  await openSettings()
  const elsewhere = screen.getByRole('link', { name: 'See your plan' })
  world.status.profile = 500
  await held('profile', save(), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
  delete world.status.profile
  await held('profile', save(), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
  expect(within(profileForm()).getByRole('status').textContent).toBe('Saved.')
})

// ---------------------------------------------------------------------------
// Send confirmation link and Cancel the change
// ---------------------------------------------------------------------------

test("Send confirmation link's 422 puts focus on the email field", async () => {
  await openSettings()
  fireEvent.change(emailField(), { target: { value: 'new@example.com' } })
  world.status.email = 422
  world.field = 'new_email'
  await held('email', sendLink())
  expect(document.activeElement).toBe(emailField())
})

test('the same-address check puts focus on the email field', async () => {
  await openSettings()
  fireEvent.change(emailField(), { target: { value: 'sam@example.com' } })
  sendLink().focus()
  fireEvent.click(sendLink())
  await settle()
  expect(document.activeElement).toBe(emailField())
  expect(count('POST /me/email-change')).toBe(0)
})

test.each([429, 500])('Send confirmation link refused with %i puts focus back on the button', async (status) => {
  await openSettings()
  fireEvent.change(emailField(), { target: { value: 'new@example.com' } })
  world.status.email = status
  await held('email', sendLink())
  expect(document.activeElement).toBe(sendLink())
})

test('a landed Send confirmation link puts focus on the pending sentence', async () => {
  await openSettings()
  fireEvent.change(emailField(), { target: { value: 'new@example.com' } })
  await held('email', sendLink())
  const sentence = screen.getByText(/We sent a confirmation link to/)
  expect(document.activeElement).toBe(sentence)
  expect(sentence.getAttribute('tabindex')).toBe('-1')
})

test('a failed Cancel the change puts focus back on the button, the line an alert', async () => {
  await openSettings()
  await pending()
  world.status.emailCancel = 500
  const cancel = screen.getByRole('button', { name: 'Cancel the change' })
  await held('emailCancel', cancel)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel the change' }))
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong cancelling. Try again.')
})

test('a landed Cancel the change puts focus on the email field', async () => {
  await openSettings()
  await pending()
  await held('emailCancel', screen.getByRole('button', { name: 'Cancel the change' }))
  expect(document.activeElement).toBe(emailField())
})

test('a person who moved on while Send waited keeps their place on its success', async () => {
  await openSettings()
  fireEvent.change(emailField(), { target: { value: 'new@example.com' } })
  const elsewhere = screen.getByLabelText(/Type DELETE to confirm/)
  await held('email', sendLink(), elsewhere)
  expect(screen.getByText(/We sent a confirmation link to/)).toBeTruthy()
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Delete my account
// ---------------------------------------------------------------------------

test('a failed Delete my account puts focus back on the button, DELETE kept, the line an alert', async () => {
  await openSettings()
  const field = screen.getByLabelText(/Type DELETE to confirm/) as HTMLInputElement
  fireEvent.change(field, { target: { value: 'DELETE' } })
  world.status.delete = 500
  const button = screen.getByRole('button', { name: 'Delete my account' })
  await held('delete', button)
  expect(document.activeElement).toBe(button)
  expect(field.value).toBe('DELETE')
  const zone = screen.getByRole('region', { name: 'Delete your account' })
  expect(within(zone).getByRole('alert').textContent).toBe('Something went wrong deleting your account. Try again.')
})

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

test('a failed Add a passkey puts focus back on Add a passkey, the line an alert', async () => {
  await openSettings()
  world.status.pkComplete = 500
  await held('pkComplete', addPasskey())
  expect(document.activeElement).toBe(addPasskey())
  expect(within(passkeys()).getByRole('alert').textContent).toBe(
    "Something went wrong adding the passkey. It wasn't saved — try again.",
  )
})

test('a cancelled Add a passkey puts focus back on Add a passkey', async () => {
  await openSettings()
  ceremony.outcome = 'cancel'
  await held('pkBegin', addPasskey())
  expect(document.activeElement).toBe(addPasskey())
  expect(within(passkeys()).queryByRole('alert')).toBeNull()
})

test('a landed Add a passkey puts focus back on Add a passkey', async () => {
  await openSettings()
  await held('pkComplete', addPasskey())
  expect(removes()).toHaveLength(3)
  expect(document.activeElement).toBe(addPasskey())
})

test('a failed Remove puts focus back on that Remove', async () => {
  await openSettings()
  world.status.pkRemove = 500
  const second = removes()[1]
  await held('pkRemove', second)
  expect(document.activeElement).toBe(removes()[1])
  expect(within(passkeys()).getByRole('alert').textContent).toBe('Something went wrong removing the passkey. Try again.')
})

test("a landed Remove puts focus on the next passkey's Remove", async () => {
  await openSettings()
  await held('pkRemove', removes()[0])
  expect(removes()).toHaveLength(1)
  expect(document.activeElement).toBe(removes()[0])
  expect(within(passkeys()).getByText('Phone')).toBeTruthy()
})

test('a landed Remove with no passkey after it puts focus on Add a passkey', async () => {
  await openSettings()
  await held('pkRemove', removes()[1])
  expect(removes()).toHaveLength(1)
  expect(document.activeElement).toBe(addPasskey())
})

test('a person who moved on while Remove waited keeps their place', async () => {
  await openSettings()
  const elsewhere = screen.getByLabelText('Display name')
  await held('pkRemove', removes()[0], elsewhere)
  expect(removes()).toHaveLength(1)
  expect(document.activeElement).toBe(elsewhere)
})

function count(entry: string): number {
  return mock.mock.calls.filter(
    ([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}` === entry,
  ).length
}

// Untouched by CK-94's table but in its scope: nothing here asks for focus
// when no press was made.
test('opening Settings moves no focus', async () => {
  dropFocusToBody()
  await openSettings()
  await act(async () => undefined)
  await waitFor(() => expect(document.activeElement).toBe(document.body))
})
