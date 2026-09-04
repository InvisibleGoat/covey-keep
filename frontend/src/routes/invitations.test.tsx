// CK-25 invitation-surface pins: the acceptance screen consumes the fragment,
// parks the token across the sign-in round trip, renders every dead-token
// state distinguished (never a blank page), and lands an accepted invitee on
// the gathering; the admin's invite form posts the channel-agnostic body and
// the backend's 422 lands on its field; a non-admin has no invitation
// affordance at all.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { readInvitationToken, storeInvitationToken } from '../lib/invitations'
import { GatheringDetail } from './GatheringDetail'
import { InvitationAccept } from './InvitationAccept'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const signedOut: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function renderAccept(auth: AuthState) {
  return render(
    <MemoryRouter initialEntries={['/invitations/accept']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/invitations/accept" element={<InvitationAccept />} />
          <Route path="/gatherings/:id" element={<p>gathering-detail-stub</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.location.hash = ''
})

test('signed out with a valid token: the fragment is consumed, the token parked, the title and sign-in path shown', async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(json(200, { status: 'valid', gathering_title: 'Sunday potluck' })),
  )
  vi.stubGlobal('fetch', fetchMock)
  window.location.hash = '#token=tok-abc'

  renderAccept(signedOut)
  expect(await screen.findByText(/you've been invited to "Sunday potluck"/i)).toBeTruthy()
  expect(screen.getByRole('link', { name: /sign in to accept/i }).getAttribute('href')).toBe('/')

  // The raw token left the address bar and parked for the sign-in round trip.
  expect(window.location.hash).toBe('')
  expect(readInvitationToken()).toBe('tok-abc')

  // The preview carried the token in a POST body, never a URL.
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/invitations/preview')
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-abc' })
})

test('signed out with an expired token: a distinguished screen, and the parked token is cleared', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(json(200, { status: 'expired', gathering_title: null }))),
  )
  window.location.hash = '#token=tok-old'

  renderAccept(signedOut)
  expect(await screen.findByText(/this invitation has expired/i)).toBeTruthy()
  expect(readInvitationToken()).toBeNull()
})

test('signed in with a valid token: accepted and landed on the gathering, token cleared', async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(json(200, { status: 'accepted', gathering_id: 'g-9' })),
  )
  vi.stubGlobal('fetch', fetchMock)
  window.location.hash = '#token=tok-go'

  renderAccept(signedIn)
  expect(await screen.findByText('gathering-detail-stub')).toBeTruthy()
  expect(readInvitationToken()).toBeNull()

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/invitations/accept')
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-go' })
})

test('the return leg after sign-in: no fragment, the parked token is redeemed', async () => {
  // The invitee left for their inbox and came back through /auth/callback —
  // the fragment is long gone, and the parked token is what accepts.
  storeInvitationToken('tok-parked')
  const fetchMock = vi.fn(() =>
    Promise.resolve(json(200, { status: 'already_accepted', gathering_id: 'g-9' })),
  )
  vi.stubGlobal('fetch', fetchMock)

  renderAccept(signedIn)
  expect(await screen.findByText('gathering-detail-stub')).toBeTruthy()
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-parked' })
})

test('signed in, a token someone else used: the distinguished spent-token screen', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(json(200, { status: 'used', gathering_id: null }))),
  )
  window.location.hash = '#token=tok-spent'

  renderAccept(signedIn)
  expect(await screen.findByText(/already been used/i)).toBeTruthy()
  expect(readInvitationToken()).toBeNull()
})

test('no token anywhere: the did-not-work screen, and no request goes out', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  renderAccept(signedOut)
  expect(await screen.findByText(/that invitation link didn't work/i)).toBeTruthy()
  expect(fetchMock).not.toHaveBeenCalled()
})

// ---- the admin's invitation section on /gatherings/:id ----

const detailBody = {
  id: 'g-1',
  gathering_type: 'potluck',
  title: 'Test Potluck',
  memorial_decedent_name: null,
  requires_approval: true,
  rsvp_list_visibility: 'INVITEES',
  publication_state: 'live',
  created_by_account_id: 'acct-1',
  host_account_id: 'acct-1',
  created_at: '2026-08-25T12:00:00+00:00',
  updated_at: null,
  occurrences: [
    {
      id: 'occ-1',
      gathering_id: 'g-1',
      starts_at: '2026-09-01T18:00:00+00:00',
      ends_at: null,
      location: null,
      map_url: null,
    },
  ],
}

const emptyLists = { pending: [], accepted: [] }

function stubRoutes(routes: { method: string; path: string; response: () => Response }[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && String(url).endsWith(r.path))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderDetail(auth: AuthState = signedIn) {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/gatherings/:id" element={<GatheringDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

test('the invitations section is collapsed until opened, then loads the list and sends the channel-agnostic body', async () => {
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody) },
    {
      method: 'GET',
      path: '/gatherings/g-1/invitations',
      response: () =>
        json(200, {
          pending: [
            {
              id: 'p-1',
              channel: 'EMAIL',
              destination: 'aunt@example.com',
              created_at: '2026-09-01T12:00:00+00:00',
              expires_at: '2036-09-08T12:00:00+00:00',
            },
          ],
          accepted: [
            { id: 'i-1', display_name: 'Aunt May', accepted_at: '2026-09-02T12:00:00+00:00' },
          ],
        }),
    },
    {
      method: 'POST',
      path: '/gatherings/g-1/invitations',
      response: () =>
        json(201, {
          id: 'p-2',
          channel: 'EMAIL',
          destination: 'uncle@example.com',
          created_at: '2026-09-01T12:00:00+00:00',
          expires_at: '2036-09-08T12:00:00+00:00',
        }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  // Collapsed: no list request has gone out yet.
  expect(
    mock.mock.calls.filter(([url]) => String(url).endsWith('/invitations')),
  ).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  expect(await screen.findByText(/aunt@example\.com/)).toBeTruthy()
  expect(screen.getByText('Aunt May')).toBeTruthy()

  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: 'uncle@example.com' },
  })
  fireEvent.click(screen.getByRole('button', { name: /send invitation/i }))

  await waitFor(() => {
    const posts = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(posts).toHaveLength(1)
    const [, init] = posts[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      channel: 'EMAIL',
      destination: 'uncle@example.com',
    })
  })
})

test("the backend's destination 422 lands on the email field", async () => {
  stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody) },
    { method: 'GET', path: '/gatherings/g-1/invitations', response: () => json(200, emptyLists) },
    {
      method: 'POST',
      path: '/gatherings/g-1/invitations',
      response: () =>
        json(422, {
          detail: [
            { loc: ['body', 'destination'], msg: 'Value error, not an email address', type: 'value_error' },
          ],
        }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  // Passes the input's own type="email" shape check — the server is the
  // authority, and its refusal is what must land on the field.
  fireEvent.change(await screen.findByLabelText(/email address/i), {
    target: { value: 'someone@rejected' },
  })
  fireEvent.click(screen.getByRole('button', { name: /send invitation/i }))

  const error = await screen.findByText('Not an email address')
  expect(error.id).toBe('error-destination')
  expect(screen.getByLabelText(/email address/i).getAttribute('aria-describedby')).toBe(
    'error-destination',
  )
})

test('revoke calls DELETE on the pending invitation', async () => {
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody) },
    {
      method: 'GET',
      path: '/gatherings/g-1/invitations',
      response: () =>
        json(200, {
          pending: [
            {
              id: 'p-1',
              channel: 'EMAIL',
              destination: 'aunt@example.com',
              created_at: '2026-09-01T12:00:00+00:00',
              expires_at: '2036-09-08T12:00:00+00:00',
            },
          ],
          accepted: [],
        }),
    },
    { method: 'DELETE', path: '/invitations/pending/p-1', response: () => new Response(null, { status: 204 }) },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))

  await waitFor(() => {
    const deletes = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deletes).toHaveLength(1)
    expect(String((deletes[0] as unknown as [string])[0])).toContain('/invitations/pending/p-1')
  })
})

test('a non-admin viewer has no invitation affordance at all', async () => {
  stubRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () => json(200, { ...detailBody, host_account_id: 'acct-2' }),
    },
  ])
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(screen.queryByText('Invitations')).toBeNull()
  expect(screen.queryByRole('button', { name: /invite people/i })).toBeNull()
})
