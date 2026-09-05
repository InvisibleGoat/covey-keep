// CK-27 RSVP-surface pins (companions since CK-29): the block is collapsed
// until opened (the CK-25 pattern — the detail page stays one request); an
// unanswered occurrence is unanswered, never a defaulted "no"; keep-me-
// included surfaces only with "can't make it" and goes out false otherwise;
// the arrival time is sent EXACTLY as typed under a profile zone forced to
// differ from the runner's (the STEP-5 trap, pinned at the component
// boundary); companions are an add/remove list of NAMES — empty by default
// (adding nobody costs no clicks), riding every save wholesale, with an
// added-but-empty row omitted and counting as no change; the roster renders
// per the visibility setting with each person's companions beneath and the
// host's total computed from the names; and the admin's edit form carries
// the visibility selector whose change rides the PATCH.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { GatheringDetail } from './GatheringDetail'

// A profile zone guaranteed to differ from the runner's — a conversion bug
// shifts the arrival clock only when the zones differ, so only a mismatch
// can prove the conversion is absent.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const profileZone =
  runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: profileZone,
  account_id: 'acct-1',
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function detailBody(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  }
}

const ownYes = {
  id: 'r-1',
  occurrence_id: 'occ-1',
  response: 'yes',
  stay_included: false,
  companions: [],
  arrival_time: '15:30:00',
  created_at: '2026-09-01T12:00:00+00:00',
  updated_at: null,
}

interface StubRoute {
  method: string
  path: string
  response: () => Response
}

function stubRoutes(routes: StubRoute[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && String(url).endsWith(r.path))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderDetail() {
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('the RSVP block is collapsed until opened, and an unanswered occurrence is unanswered — never a defaulted "no"', async () => {
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () => json(200, { visibility: 'INVITEES', own: null, rsvps: [] }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  // Collapsed: the detail page stays one request.
  expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/rsvps'))).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))
  expect(await screen.findByText("You haven't answered yet.")).toBeTruthy()
  for (const label of ['Going', 'Maybe', "Can't make it"]) {
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false)
  }
  // No answer chosen yet: nothing to send.
  expect((screen.getByRole('button', { name: /send rsvp/i }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

test('keep-me-included surfaces only with "can\'t make it", and rides the body only then', async () => {
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () => json(200, { visibility: 'INVITEES', own: null, rsvps: [] }),
    },
    {
      method: 'PUT',
      path: '/occurrences/occ-1/rsvp',
      response: () =>
        json(200, { ...ownYes, response: 'no', stay_included: true, arrival_time: null }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))
  await screen.findByText("You haven't answered yet.")

  // Meaningless with "going": the option does not exist there.
  fireEvent.click(screen.getByLabelText('Going'))
  expect(screen.queryByLabelText(/keep me included/i)).toBeNull()

  fireEvent.click(screen.getByLabelText("Can't make it"))
  fireEvent.click(screen.getByLabelText(/keep me included/i))
  fireEvent.click(screen.getByRole('button', { name: /send rsvp/i }))

  await waitFor(() => {
    const puts = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(puts).toHaveLength(1)
    const [, init] = puts[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      response: 'no',
      stay_included: true,
      companions: [],
    })
  })
})

test('the arrival time goes out exactly as typed under a differing profile zone, and reads back identically', async () => {
  // The STEP-5 pin at the component boundary: person.timezone differs from
  // the runner's zone, and the arrival clock must pass through untouched in
  // BOTH directions — a wallClockToInstant detour would shift it by the
  // offset and this body assertion is what would fail.
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () => json(200, { visibility: 'INVITEES', own: ownYes, rsvps: [] }),
    },
    {
      method: 'PUT',
      path: '/occurrences/occ-1/rsvp',
      response: () => json(200, { ...ownYes, arrival_time: '16:45:00' }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))

  // The stored "15:30:00" reads back as the same wall clock, zone untouched.
  const arrival = (await screen.findByLabelText(/arriving around/i)) as HTMLInputElement
  expect(arrival.value).toBe('15:30')
  // The zone it applies to is stated beside it.
  expect(
    screen.getByText(`Clock time at the gathering — times in ${profileZone}.`),
  ).toBeTruthy()

  fireEvent.change(arrival, { target: { value: '16:45' } })
  fireEvent.click(screen.getByRole('button', { name: /update rsvp/i }))

  await waitFor(() => {
    const puts = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(puts).toHaveLength(1)
    const [, init] = puts[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      response: 'yes',
      stay_included: false,
      companions: [],
      arrival_time: '16:45',
    })
  })
})

test('HOST_ONLY as a non-admin: the caller still sees their own answer, no roster, and the hint says why', async () => {
  stubRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () =>
        json(200, detailBody({ host_account_id: 'acct-2', rsvp_list_visibility: 'HOST_ONLY' })),
    },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () =>
        json(200, {
          visibility: 'HOST_ONLY',
          own: { ...ownYes, response: 'no', arrival_time: null },
          rsvps: [],
        }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))

  // Their own answer is theirs whatever the setting says.
  expect(((await screen.findByLabelText("Can't make it")) as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByText("Who's coming")).toBeNull()
  expect(screen.getByText('Only the host sees the full list of answers.')).toBeTruthy()
})

test("the roster renders each person's companions beneath them, and the host sees the total computed from the names", async () => {
  // detailBody's host is acct-1 — the signed-in person — so the total line
  // (host-only) must render, derived from the "Going" rows: grandma plus her
  // two named companions is 3; the declined row adds nothing.
  stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () =>
        json(200, {
          visibility: 'INVITEES',
          own: null,
          rsvps: [
            {
              id: 'r-1',
              display_name: 'grandma',
              response: 'yes',
              stay_included: false,
              companions: ['Nana Pearl', 'Milo'],
              total: 3,
              arrival_time: '15:30:00',
            },
            {
              id: 'r-2',
              display_name: 'alaska-cousin',
              response: 'no',
              stay_included: true,
              companions: [],
              total: 1,
              arrival_time: null,
            },
          ],
        }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))

  expect(await screen.findByText("Who's coming")).toBeTruthy()
  expect(screen.getByText(/grandma — Going, arriving/)).toBeTruthy()
  const companionList = screen.getByRole('list', { name: 'Coming with grandma' })
  expect(companionList.textContent).toContain('Nana Pearl')
  expect(companionList.textContent).toContain('Milo')
  expect(
    screen.getByText(/alaska-cousin — Can't make it \(staying in the loop\)/),
  ).toBeTruthy()
  expect(screen.getByText(/Total going: 3 people — counted from the names\./)).toBeTruthy()
})

test('"Bringing anyone?" builds the body: added names ride the save, and a removed name leaves the next write', async () => {
  // The GET reflects the last save (the block re-fetches after every
  // successful mutation — optimistic-free), so the second edit starts from
  // the saved names.
  let saved: unknown = null
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () => json(200, { visibility: 'INVITEES', own: saved, rsvps: [] }),
    },
    {
      method: 'PUT',
      path: '/occurrences/occ-1/rsvp',
      response: () => {
        saved = { ...ownYes, arrival_time: null, companions: ['Nana Pearl', 'Milo'] }
        return json(200, saved)
      },
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))
  await screen.findByText("You haven't answered yet.")

  fireEvent.click(screen.getByLabelText('Going'))
  fireEvent.click(screen.getByRole('button', { name: /add someone/i }))
  fireEvent.click(screen.getByRole('button', { name: /add someone/i }))
  const nameInputs = screen.getAllByLabelText('Their name') as HTMLInputElement[]
  fireEvent.change(nameInputs[0], { target: { value: 'Nana Pearl' } })
  fireEvent.change(nameInputs[1], { target: { value: 'Milo' } })
  fireEvent.click(screen.getByRole('button', { name: /send rsvp/i }))

  await waitFor(() => {
    const puts = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(puts).toHaveLength(1)
    const [, init] = puts[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      response: 'yes',
      stay_included: false,
      companions: ['Nana Pearl', 'Milo'],
    })
  })

  // The block re-fetched the saved answer; edit from there. Remove one: the
  // next save carries the survivor only — the whole list, every save,
  // wholesale.
  const update = await screen.findByRole('button', { name: /update rsvp/i })
  await waitFor(() => {
    expect(screen.getAllByLabelText('Their name')).toHaveLength(2)
  })
  fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0])
  fireEvent.click(update)
  await waitFor(() => {
    const puts = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(puts).toHaveLength(2)
    const [, init] = puts[1] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      response: 'yes',
      stay_included: false,
      companions: ['Milo'],
    })
  })
})

test('an added-but-empty companion row is not a change: it is omitted from the send and leaves save disabled', async () => {
  stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'GET',
      path: '/occurrences/occ-1/rsvps',
      response: () => json(200, { visibility: 'INVITEES', own: ownYes, rsvps: [] }),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))
  await screen.findByLabelText(/arriving around/i)

  // Saved answer loaded, nothing changed yet: no send to make.
  const update = screen.getByRole('button', { name: /update rsvp/i }) as HTMLButtonElement
  expect(update.disabled).toBe(true)

  // An empty row is "no entry", not a value — still nothing to send.
  fireEvent.click(screen.getByRole('button', { name: /add someone/i }))
  expect(update.disabled).toBe(true)

  // Typing a name is a change.
  fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Milo' } })
  expect(update.disabled).toBe(false)
})

test("the admin's edit form carries the visibility selector, and its change rides the PATCH", async () => {
  const mock = stubRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'PATCH',
      path: '/gatherings/g-1',
      response: () => json(200, detailBody({ rsvp_list_visibility: 'HOST_ONLY' })),
    },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /edit gathering/i }))

  const select = screen.getByLabelText(/who can see the rsvp list/i) as HTMLSelectElement
  expect(select.value).toBe('INVITEES')
  const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.change(select, { target: { value: 'HOST_ONLY' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)

  await waitFor(() => {
    const patches = mock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patches).toHaveLength(1)
    const [, init] = patches[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ rsvp_list_visibility: 'HOST_ONLY' })
  })
})
