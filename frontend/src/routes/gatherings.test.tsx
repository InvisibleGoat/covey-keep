// CK-17 gathering-surface pins: the decedent field mirrors the type, the
// backend's 422s land inline on the right field (and unmappable ones still
// render), the empty list is a real screen, and the detail 404 is one
// undistinguishing not-found screen.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { wallClockToInstant } from '../lib/datetime'
import { GatheringDetail } from './GatheringDetail'
import { GatheringNew } from './GatheringNew'
import { Gatherings } from './Gatherings'

// A profile zone guaranteed to differ from the test runner's — the point of
// the CK-17 timezone rule is that the profile zone wins over the device zone,
// which only a mismatch can prove.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const profileZone =
  runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: profileZone,
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

function renderWithAuth(ui: React.ReactElement, initialEntries?: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  // Vitest runs without injected globals, so testing-library's automatic
  // cleanup never registers — without this, renders accumulate across tests.
  cleanup()
  vi.unstubAllGlobals()
})

test('the decedent field appears and disappears with the memorial type', () => {
  renderWithAuth(<GatheringNew />)
  expect(screen.queryByLabelText(/decedent/i)).toBeNull()

  fireEvent.change(screen.getByLabelText(/type of gathering/i), {
    target: { value: 'memorial' },
  })
  expect(screen.getByLabelText(/decedent/i)).toBeTruthy()

  fireEvent.change(screen.getByLabelText(/type of gathering/i), {
    target: { value: 'potluck' },
  })
  expect(screen.queryByLabelText(/decedent/i)).toBeNull()
})

test('the form states the profile zone next to the time fields', () => {
  renderWithAuth(<GatheringNew />)
  expect(
    screen.getByText(`Times in ${profileZone} — your profile time zone.`),
  ).toBeTruthy()
})

test('a 422 lands on the field it names, and times post in the profile zone', async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          detail: [
            {
              loc: ['body', 'memorial_decedent_name'],
              msg: "Value error, a memorial requires the decedent's name",
              type: 'value_error',
            },
          ],
        }),
        { status: 422 },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)

  renderWithAuth(<GatheringNew />)
  fireEvent.change(screen.getByLabelText(/type of gathering/i), {
    target: { value: 'memorial' },
  })
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'For Granddad' } })
  fireEvent.change(screen.getByLabelText(/^starts$/i), {
    target: { value: '2026-09-01T18:00' },
  })
  // The decedent name stays blank — the submit must still go out (the
  // backend's 422 is the authority; nothing client-side pre-empts it).
  fireEvent.click(screen.getByRole('button', { name: /create gathering/i }))

  const error = await screen.findByText("A memorial requires the decedent's name")
  expect(error.id).toBe('error-memorial_decedent_name')
  expect(screen.getByLabelText(/decedent/i).getAttribute('aria-describedby')).toBe(
    'error-memorial_decedent_name',
  )

  // The posted wall clock was interpreted in the PROFILE zone, not the
  // runner's — the zones differ, so a browser-zone conversion would not match.
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  const body = JSON.parse(init.body as string) as {
    memorial_decedent_name: string | null
    occurrences: { starts_at: string }[]
  }
  expect(body.memorial_decedent_name).toBeNull()
  expect(body.occurrences[0].starts_at).toBe(wallClockToInstant('2026-09-01T18:00', profileZone))
})

test('a 422 that maps to no visible field still renders, form-level', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            detail: [{ loc: ['body', 'surprise'], msg: 'mystery failure', type: 'value_error' }],
          }),
          { status: 422 },
        ),
      ),
    ),
  )

  renderWithAuth(<GatheringNew />)
  fireEvent.change(screen.getByLabelText(/type of gathering/i), {
    target: { value: 'potluck' },
  })
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Sunday lunch' } })
  fireEvent.change(screen.getByLabelText(/^starts$/i), {
    target: { value: '2026-09-01T12:00' },
  })
  fireEvent.click(screen.getByRole('button', { name: /create gathering/i }))

  expect(await screen.findByText('Mystery failure (surprise)')).toBeTruthy()
})

test('the empty list is a real screen with the call to action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ gatherings: [] }), { status: 200 })),
    ),
  )

  renderWithAuth(<Gatherings />)
  expect(await screen.findByText('No gatherings yet')).toBeTruthy()
  const cta = screen.getByRole('link', { name: /create your first gathering/i })
  expect(cta.getAttribute('href')).toBe('/gatherings/new')
})

test('a detail 404 renders the one not-found screen', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'No such gathering.' }), { status: 404 }),
      ),
    ),
  )

  renderWithAuth(
    <Routes>
      <Route path="/gatherings/:id" element={<GatheringDetail />} />
    </Routes>,
    ['/gatherings/00000000-0000-0000-0000-000000000000'],
  )
  expect(await screen.findByText('Nothing here')).toBeTruthy()
  expect(screen.getByText("There's no gathering to show at this address.")).toBeTruthy()
})
