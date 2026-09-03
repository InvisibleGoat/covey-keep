// CK-17 gathering-surface pins: the decedent field mirrors the type, the
// backend's 422s land inline on the right field (and unmappable ones still
// render), the empty list is a real screen, and the detail 404 is one
// undistinguishing not-found screen.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { formatInstant, wallClockToInstant } from '../lib/datetime'
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
  account_id: 'acct-1',
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

test('the list renders each date from the list response alone — one request, no per-row fetches', async () => {
  // CK-20: next_occurrence rides the list item, so the CK-17 per-gathering
  // detail fetches (and their per-row degrade) are gone. The request count is
  // the pin: one gathering, one request — a second request IS the regression.
  const startsAt = wallClockToInstant('2035-01-01T18:00', profileZone)
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          gatherings: [
            {
              id: 'g-1',
              gathering_type: 'potluck',
              title: 'Test Potluck',
              memorial_decedent_name: null,
              requires_approval: true,
              rsvp_list_visibility: 'INVITEES',
              publication_state: 'live',
              created_by_account_id: 'acct-1',
              admin_account_id: 'acct-1',
              created_at: '2026-08-25T12:00:00+00:00',
              updated_at: null,
              next_occurrence: { id: 'occ-1', starts_at: startsAt },
              occurrence_count: 1,
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)

  renderWithAuth(<Gatherings />)
  await screen.findByText('Test Potluck')
  const expectedDate = formatInstant(startsAt, profileZone)
  expect(screen.getByText((content) => content.includes(expectedDate))).toBeTruthy()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

// ---- CK-18: the editing surface on /gatherings/:id ----

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const startsInstant = wallClockToInstant('2026-09-01T18:00', profileZone)

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
    admin_account_id: 'acct-1',
    created_at: '2026-08-25T12:00:00+00:00',
    updated_at: null,
    occurrences: [
      {
        id: 'occ-1',
        gathering_id: 'g-1',
        starts_at: startsInstant,
        ends_at: null,
        location: null,
        map_url: null,
      },
    ],
    ...over,
  }
}

interface StubRoute {
  method: string
  path: string
  response: () => Response
}

function stubFetchRoutes(routes: StubRoute[]) {
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
  return renderWithAuth(
    <Routes>
      <Route path="/gatherings/:id" element={<GatheringDetail />} />
    </Routes>,
    ['/gatherings/g-1'],
  )
}

const seasonCap422 = () =>
  json(422, {
    detail: [
      {
        loc: ['body', 'starts_at'],
        msg: "Value error, a season's occurrences must all fall within one year of its earliest date — this would make the span 413 days",
        type: 'value_error',
      },
    ],
  })

test('a non-admin viewer sees the read-only page with no edit controls at all', async () => {
  // admin_account_id null is the claimable state — no one's account matches,
  // so the gate (the caller's account_id against the admin fact, CK-20)
  // renders no edit affordance.
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody({ admin_account_id: null })) },
  ])
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(screen.queryByRole('button', { name: /edit gathering/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /edit this date/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /remove this date/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /add another date/i })).toBeNull()
})

test("a gathering administered by someone ELSE renders no edit controls — the caller's account is compared, not just non-null", async () => {
  // The case CK-18's interim gate (`admin_account_id !== null`) could not
  // express: an admin exists and it is not the caller. Exact today only
  // because every reader of an admin-held gathering is its admin; the moment
  // invitations/keep/claim widen the audience, this comparison is what keeps
  // a keeper-non-admin from probing edit controls that 404.
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody({ admin_account_id: 'acct-2' })) },
  ])
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(screen.queryByRole('button', { name: /edit gathering/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /edit this date/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /remove this date/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /add another date/i })).toBeNull()
})

test('the edit form carries the decedent field for a memorial only, with the constraint stated', async () => {
  stubFetchRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () =>
        json(200, detailBody({ gathering_type: 'memorial', memorial_decedent_name: 'Granddad' })),
    },
  ])
  const memorial = renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  expect(screen.getByLabelText(/decedent/i)).toBeTruthy()
  // The null-is-not-provided constraint is labeled, never faked as clearable.
  expect(screen.getByText('The name can be corrected, not removed.')).toBeTruthy()
  memorial.unmount()
  vi.unstubAllGlobals()

  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  expect(screen.queryByLabelText(/decedent/i)).toBeNull()
})

test('save stays disabled until something changes, and a no-op edit sends no PATCH', async () => {
  const mock = stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Renamed Potluck' } })
  expect(save.disabled).toBe(false)
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Test Potluck' } })
  expect(save.disabled).toBe(true)
  const patches = mock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
  )
  expect(patches).toHaveLength(0)
})

test('the nothing-to-update 422 still renders if it ever arrives', async () => {
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'PATCH',
      path: '/gatherings/g-1',
      response: () =>
        json(422, {
          detail: [
            {
              loc: ['body'],
              msg: 'Value error, nothing to update — provide title and/or memorial_decedent_name',
              type: 'value_error',
            },
          ],
        }),
    },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Renamed Potluck' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  const message = await screen.findByText(
    'Nothing to update — provide title and/or memorial_decedent_name',
  )
  // The no-op guard is client-side UX, but the server's answer still renders
  // (with the CK-18 error affordance) rather than leaving a dead button.
  expect(message.getAttribute('role')).toBe('alert')
})

test("the season cap at occurrence-add lands on the add form's starts field", async () => {
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody({ gathering_type: 'season' })) },
    { method: 'POST', path: '/gatherings/g-1/occurrences', response: seasonCap422 },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /add another date/i }))
  fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2027-10-18T10:00' } })
  fireEvent.click(screen.getByRole('button', { name: /add this date/i }))
  const error = await screen.findByText(/would make the span 413 days/)
  expect(error.id).toBe('error-starts_at')
  expect(screen.getByLabelText(/^starts$/i).getAttribute('aria-describedby')).toBe(
    'error-starts_at',
  )
})

test("the season cap at a date move lands on that date's starts field", async () => {
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody({ gathering_type: 'season' })) },
    { method: 'PATCH', path: '/occurrences/occ-1', response: seasonCap422 },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit this date/i }))
  const starts = screen.getByLabelText(/^starts$/i)
  fireEvent.change(starts, { target: { value: '2027-10-18T10:00' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  const error = await screen.findByText(/would make the span 413 days/)
  expect(error.id).toBe('error-occ-1-starts_at')
  expect(starts.getAttribute('aria-describedby')).toBe('error-occ-1-starts_at')
})

test('the last-occurrence refusal renders beside the remove control, with the error affordance', async () => {
  stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'DELETE',
      path: '/occurrences/occ-1',
      response: () =>
        json(422, {
          detail: [
            {
              loc: ['path', 'occurrence_id'],
              msg: 'a gathering keeps at least one occurrence',
              type: 'value_error',
            },
          ],
        }),
    },
  ])
  renderDetail()
  const remove = await screen.findByRole('button', { name: /remove this date/i })
  fireEvent.click(remove)
  const error = await screen.findByText('A gathering keeps at least one occurrence')
  expect(error.id).toBe('error-occ-1-occurrence_id')
  expect(remove.getAttribute('aria-describedby')).toBe('error-occ-1-occurrence_id')
  expect(error.getAttribute('role')).toBe('alert')
  expect(error.className).toContain('form-error')
})

test('a successful save re-renders from the server, not from local form state', async () => {
  let title = 'Test Potluck'
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return Promise.resolve(json(200, detailBody({ title })))
    if (method === 'PATCH') {
      title = 'Sunday Potluck (server-normalized)'
      const { occurrences: _occurrences, ...body } = detailBody({ title })
      return Promise.resolve(json(200, body))
    }
    throw new Error(`no stub for ${method} ${String(url)}`)
  })
  vi.stubGlobal('fetch', mock)
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Sunday Potluck' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  // The heading shows what the SERVER holds — proof of a fresh GET rather
  // than trust in the submitted form value (optimistic-free, CK-18).
  await screen.findByRole('heading', { name: 'Sunday Potluck (server-normalized)' })
  const gets = mock.mock.calls.filter(
    ([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  )
  expect(gets).toHaveLength(2)
})

test('the season cap at create lands on the occurrences control, with the error affordance', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json(422, {
          detail: [
            {
              loc: ['body', 'occurrences'],
              msg: "Value error, a season's occurrences must all fall within one year of its earliest date — this would make the span 413 days",
              type: 'value_error',
            },
          ],
        }),
      ),
    ),
  )
  renderWithAuth(<GatheringNew />)
  fireEvent.change(screen.getByLabelText(/type of gathering/i), { target: { value: 'season' } })
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Fall ball' } })
  fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-08-31T10:00' } })
  fireEvent.click(screen.getByRole('button', { name: /create gathering/i }))
  const error = await screen.findByText(/would make the span 413 days/)
  expect(error.id).toBe('error-occurrences')
  expect(error.getAttribute('role')).toBe('alert')
  expect(error.className).toContain('form-error')
})

// ---- CK-21: the map-link render guard ----

function detailWithMapUrl(mapUrl: string) {
  return detailBody({
    occurrences: [
      {
        id: 'occ-1',
        gathering_id: 'g-1',
        starts_at: startsInstant,
        ends_at: null,
        location: null,
        map_url: mapUrl,
      },
    ],
  })
}

test('a stored javascript: map link renders as text with NO anchor element', async () => {
  stubFetchRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () => json(200, detailWithMapUrl('javascript:alert(1)')),
    },
  ])
  const { container } = renderDetail()
  await screen.findByText('Test Potluck')
  // The stored value is visible — a silently vanished field is its own bug —
  // but it is text, never a link: assert the ABSENCE of the anchor, not just
  // the presence of the text (the "Back to your gatherings" router link is
  // the only anchor on the page).
  expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Map' })).toBeNull()
  const anchors = Array.from(container.querySelectorAll('a'))
  expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['/gatherings'])
})

test('a valid https map link still renders as a new-tab link', async () => {
  stubFetchRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () => json(200, detailWithMapUrl('https://maps.example.com/park')),
    },
  ])
  renderDetail()
  const link = await screen.findByRole('link', { name: 'Map' })
  expect(link.getAttribute('href')).toBe('https://maps.example.com/park')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noreferrer')
})

// ---- CK-22: blanking an optional occurrence field clears it ----

const endsInstant = wallClockToInstant('2026-09-01T21:00', profileZone)

function fullOccurrence(over: Record<string, unknown> = {}) {
  return {
    id: 'occ-1',
    gathering_id: 'g-1',
    starts_at: startsInstant,
    ends_at: endsInstant,
    location: 'the park',
    map_url: 'https://maps.example.com/park',
    ...over,
  }
}

test('blanking a saved location sends an explicit null — and the untouched fields stay out of the patch', async () => {
  // The absent-means-leave-alone half is the one a merge-patch bug breaks
  // silently: the body must be EXACTLY { location: null }, with the map link
  // and end time never sent at all.
  let cleared = false
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      return Promise.resolve(
        json(200, detailBody({ occurrences: [fullOccurrence(cleared ? { location: null } : {})] })),
      )
    }
    if (method === 'PATCH') {
      cleared = true
      return Promise.resolve(json(200, fullOccurrence({ location: null })))
    }
    throw new Error(`no stub for ${method} ${String(url)}`)
  })
  vi.stubGlobal('fetch', mock)
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit this date/i }))
  const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  // "Had a saved value, now blank" is a real change: Save enables.
  fireEvent.change(screen.getByLabelText(/^location/i), { target: { value: '' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  // The re-fetched detail shows the location gone and the map link untouched.
  await waitFor(() => expect(screen.queryByText('the park')).toBeNull())
  expect(screen.getByRole('link', { name: 'Map' })).toBeTruthy()
  const patchCall = mock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
  )
  const body = JSON.parse((patchCall![1] as RequestInit).body as string)
  expect(body).toEqual({ location: null })
})

test('clearing the end time and the map link sends explicit nulls for both', async () => {
  const mock = stubFetchRoutes([
    {
      method: 'GET',
      path: '/gatherings/g-1',
      response: () => json(200, detailBody({ occurrences: [fullOccurrence()] })),
    },
    {
      method: 'PATCH',
      path: '/occurrences/occ-1',
      response: () => json(200, fullOccurrence({ ends_at: null, map_url: null })),
    },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit this date/i }))
  fireEvent.change(screen.getByLabelText(/^ends/i), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText(/^map link/i), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  // The editor closes on success and the detail re-fetches.
  await screen.findByRole('button', { name: /edit this date/i })
  const patchCall = mock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
  )
  const body = JSON.parse((patchCall![1] as RequestInit).body as string)
  expect(body).toEqual({ ends_at: null, map_url: null })
})

test('a field that was already empty and is still empty is omitted — no null, no PATCH', async () => {
  // Sending null for an already-null field would be a no-op write that
  // muddies what null means; empty → empty is simply not a change.
  const mock = stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit this date/i }))
  const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
  const location = screen.getByLabelText(/^location/i)
  fireEvent.change(location, { target: { value: 'somewhere' } })
  expect(save.disabled).toBe(false)
  fireEvent.change(location, { target: { value: '' } })
  expect(save.disabled).toBe(true)
  const patches = mock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
  )
  expect(patches).toHaveLength(0)
})

test('a whitespace-only entry goes out as typed and the blank-rejection 422 renders — blank is never a clear', async () => {
  const mock = stubFetchRoutes([
    { method: 'GET', path: '/gatherings/g-1', response: () => json(200, detailBody()) },
    {
      method: 'PATCH',
      path: '/occurrences/occ-1',
      response: () =>
        json(422, {
          detail: [
            {
              loc: ['body', 'location'],
              msg: 'Value error, location cannot be empty — leave it out instead',
              type: 'value_error',
            },
          ],
        }),
    },
  ])
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit this date/i }))
  fireEvent.change(screen.getByLabelText(/^location/i), { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  const error = await screen.findByText(/location cannot be empty/i)
  expect(error.id).toBe('error-occ-1-location')
  const patchCall = mock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
  )
  const body = JSON.parse((patchCall![1] as RequestInit).body as string)
  expect(body).toEqual({ location: '   ' })
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
