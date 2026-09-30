// CK-69 pins on co-hosts on the surface (decisions/2026-09-03-co-hosts.md
// §4, §7, as amended by two-bins §4; the classification is CK-68's, one
// line per check in the api-reference's Co-hosts router). The value under
// test: THE ROLE COMES FROM THE GATHERING BODY'S `caller_role` AND FROM
// NOTHING ELSE — the role matrix renders every delegable control for the
// host and a co-host and every reserved control for the host alone, with
// the host's account id and the signed-in account DISAGREEING in the
// co-host case and AGREEING in a null case, so no account comparison could
// produce these results; a co-host's edit form has no review switch and its
// save body never carries `requires_approval_override`, whichever other
// fields change; the host makes a co-host from an Accepted row in one
// click, reads "Co-host" beside a co-host's name, removes one behind a
// second step, and reads each refusal on the row it names, from its code;
// a co-host reads the list, steps down from their own row alone behind a
// second step, and the page re-renders as an invitee's; a co-host reads the
// full RSVP list and its total in every mode; and the visibility label
// names the organisers, never "me".
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { CO_HOST_HINT, STEP_DOWN_SENTENCE } from '../lib/coHosts'
import { GatheringDetail } from './GatheringDetail'

const person: Person = {
  id: 'person-1',
  display_name: 'peter',
  email: 'peter@example.com',
  timezone: 'America/Chicago',
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

const occurrence = {
  id: 'occ-1',
  gathering_id: 'g-1',
  starts_at: '2026-09-01T18:00:00+00:00',
  ends_at: null,
  location: null,
  map_url: null,
}

function detailBody(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'Test Potluck',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-9',
    host_account_id: 'acct-1',
    caller_role: 'host',
    created_at: '2026-08-25T12:00:00+00:00',
    updated_at: null,
    occurrences: [occurrence],
    ...over,
  }
}

// The seats. The co-host's body carries a host account that is NOT the
// signed-in one, and the null body one that IS — the two shapes an account
// comparison would get wrong, and the body's role gets right.
const asHost = (over: Record<string, unknown> = {}) => detailBody(over)
const asCoHost = (over: Record<string, unknown> = {}) =>
  detailBody({ host_account_id: 'acct-9', caller_role: 'co_host', ...over })
const asNobody = (over: Record<string, unknown> = {}) =>
  detailBody({ host_account_id: 'acct-1', caller_role: null, ...over })
const asInvitee = (over: Record<string, unknown> = {}) =>
  detailBody({ host_account_id: 'acct-9', caller_role: null, ...over })

interface StubRoute {
  method: string
  match: (url: string) => boolean
  response: (init: RequestInit | undefined, url: string) => Response
}

function stubRoutes(routes: StubRoute[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && r.match(String(url)))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response(init, String(url)))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const endsWith = (suffix: string) => (url: string) => url.endsWith(suffix)

function calls(mock: ReturnType<typeof vi.fn>, method: string, match: (url: string) => boolean) {
  return mock.mock.calls.filter(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET') === method && match(String(url)),
  ) as unknown as [string, RequestInit | undefined][]
}

const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'

const accepted = [
  { id: 'i-peter', display_name: 'peter', accepted_at: '2026-09-02T12:00:00+00:00' },
  { id: 'i-may', display_name: 'Aunt May', accepted_at: '2026-09-02T12:00:00+00:00' },
]

function coHostRow(invitationId: string, displayName: string, isSelf = false) {
  return {
    invitation_id: invitationId,
    display_name: displayName,
    added_at: '2026-09-30T12:00:00+00:00',
    is_self: isSelf,
  }
}

// The reads the page makes as one seat: the gathering (a function, so a
// test can change the seat after an act), the invitation lists, the co-host
// list (a function, so a make or a remove shows in the re-read), an empty
// photo list, and an RSVP list where a test needs one.
function detailRoutes(
  gathering: () => unknown,
  coHosts: () => unknown[] = () => [],
  extra: StubRoute[] = [],
): StubRoute[] {
  return [
    { method: 'GET', match: endsWith('/gatherings/g-1'), response: () => json(200, gathering()) },
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/invitations'),
      response: () => json(200, { pending: [], accepted }),
    },
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/co-hosts'),
      response: () => json(200, { co_hosts: coHosts() }),
    },
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: () => json(200, { media: [] }),
    },
    ...extra,
  ]
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

// The delegable controls on the page itself, by presence.
function delegableOnPage() {
  return {
    editGathering: screen.queryByRole('button', { name: /edit gathering/i }) !== null,
    editDate: screen.queryByRole('button', { name: /edit this date/i }) !== null,
    removeDate: screen.queryByRole('button', { name: /remove this date/i }) !== null,
    addDate: screen.queryByRole('button', { name: /add another date/i }) !== null,
    invitations: screen.queryByRole('button', { name: /invite people/i }) !== null,
  }
}

async function openPhotos() {
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByText('No photos yet.')
}

const acceptedRows = () => within(screen.getByRole('list', { name: 'Accepted' })).getAllByRole('listitem')
const coHostRows = () => within(screen.getByRole('list', { name: 'Co-hosts' })).getAllByRole('listitem')
const rowNamed = (rows: HTMLElement[], name: string) =>
  rows.find((row) => row.textContent?.includes(name))!

test('the role matrix: every delegable control for the host and a co-host, every reserved control for the host alone, nothing for null — decided by caller_role, with the account ids disagreeing on purpose', async () => {
  // THE HOST (the body's host account IS the signed-in one; review on, so
  // the queue button exists for the host).
  stubRoutes(detailRoutes(() => asHost({ requires_approval: true, requires_approval_override: true })))
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(delegableOnPage()).toEqual({
    editGathering: true,
    editDate: true,
    removeDate: true,
    addDate: true,
    invitations: true,
  })
  await openPhotos()
  expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Removed from this gathering' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Awaiting your review' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /edit gathering/i }))
  expect(screen.getByLabelText(/review photos before they're published/i)).toBeTruthy()

  // A CO-HOST: the body's host account is NOT the signed-in one, and the
  // role says co-host. Every delegable control; no reserved one.
  cleanup()
  vi.unstubAllGlobals()
  stubRoutes(detailRoutes(() => asCoHost({ requires_approval: true, requires_approval_override: true })))
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(delegableOnPage()).toEqual({
    editGathering: true,
    editDate: true,
    removeDate: true,
    addDate: true,
    invitations: true,
  })
  await openPhotos()
  expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Removed from this gathering' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Awaiting your review' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /edit gathering/i }))
  expect(screen.getByLabelText(/^title$/i)).toBeTruthy()
  expect(screen.getByLabelText(/who can see the rsvp list/i)).toBeTruthy()
  expect(screen.queryByLabelText(/review photos/i)).toBeNull()
  expect(screen.queryByText(/nobody looks at them/i)).toBeNull()
  expect(screen.queryByText(/publish or decline/i)).toBeNull()

  // NULL, with the body's host account EQUAL to the signed-in one: nothing.
  // An account comparison would have opened every control here.
  cleanup()
  vi.unstubAllGlobals()
  stubRoutes(detailRoutes(() => asNobody({ requires_approval: true, requires_approval_override: true })))
  renderDetail()
  await screen.findByText('Test Potluck')
  expect(delegableOnPage()).toEqual({
    editGathering: false,
    editDate: false,
    removeDate: false,
    addDate: false,
    invitations: false,
  })
  expect(screen.queryByText('Invitations')).toBeNull()
  await openPhotos()
  expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Removed from this gathering' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Awaiting your review' })).toBeNull()
  expect(screen.queryByLabelText(/review photos/i)).toBeNull()
  expect(document.body.textContent).not.toMatch(/co-host/i)
})

test("a co-host's edit form has no review switch, and its save body never contains requires_approval_override — after changing every other field", async () => {
  const sent: { body: unknown } = { body: null }
  stubRoutes(
    detailRoutes(
      () =>
        asCoHost({
          gathering_type: 'memorial',
          memorial_decedent_name: 'Granddad',
          requires_approval: true,
          requires_approval_override: true,
        }),
      () => [],
      [
        {
          method: 'PATCH',
          match: endsWith('/gatherings/g-1'),
          response: (init) => {
            sent.body = JSON.parse(init!.body as string)
            const { occurrences: _occurrences, ...body } = asCoHost({
              gathering_type: 'memorial',
              memorial_decedent_name: 'Grandfather',
              title: 'Renamed',
              rsvp_list_visibility: 'HOST_ONLY',
              requires_approval: true,
              requires_approval_override: true,
            })
            return json(200, body)
          },
        },
      ],
    ),
  )
  renderDetail()
  fireEvent.click(await screen.findByRole('button', { name: /edit gathering/i }))
  const form = screen.getByRole('form', { name: /edit gathering/i })
  // No switch, no hint about it, no accuracy statement — and no review
  // vocabulary anywhere on the form.
  expect(within(form).queryByLabelText(/review photos/i)).toBeNull()
  expect(form.textContent).not.toMatch(/review|publish|declin|nobody looks/i)
  // Every other field, changed.
  fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Renamed' } })
  fireEvent.change(screen.getByLabelText(/decedent/i), { target: { value: 'Grandfather' } })
  fireEvent.change(screen.getByLabelText(/who can see the rsvp list/i), { target: { value: 'HOST_ONLY' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
  await waitFor(() => {
    expect(sent.body).not.toBeNull()
  })
  expect(sent.body).toEqual({
    title: 'Renamed',
    memorial_decedent_name: 'Grandfather',
    rsvp_list_visibility: 'HOST_ONLY',
  })
  expect(JSON.stringify(sent.body)).not.toContain('requires_approval')
  // The editor closes on success and the detail re-fetches (optimistic-free).
  await waitFor(() => {
    expect(screen.queryByRole('form', { name: /edit gathering/i })).toBeNull()
  })
})

test('management, host: Make co-host on Accepted rows not yet co-hosts, posting the invitation id once and reloading the list; "Co-host" beside a co-host\'s name; Remove as co-host behind a second step, Keep as co-host inert, the confirm posting one DELETE', async () => {
  let rows: ReturnType<typeof coHostRow>[] = []
  const mock = stubRoutes(
    detailRoutes(
      () => asHost(),
      () => rows,
      [
        {
          method: 'POST',
          match: endsWith('/gatherings/g-1/co-hosts'),
          response: (init) => {
            const body = JSON.parse(init!.body as string) as { invitation_id: string }
            rows = [...rows, coHostRow(body.invitation_id, 'peter')]
            return json(201, coHostRow(body.invitation_id, 'peter'))
          },
        },
        {
          method: 'DELETE',
          match: endsWith('/gatherings/g-1/co-hosts/i-peter'),
          response: () => {
            rows = rows.filter((row) => row.invitation_id !== 'i-peter')
            return new Response(null, { status: 204 })
          },
        },
      ],
    ),
  )
  renderDetail()
  await screen.findByText('Test Potluck')
  // Collapsed: no co-host request until the section opens.
  expect(calls(mock, 'GET', endsWith('/co-hosts'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  await screen.findByText('Aunt May')
  await waitFor(() => {
    expect(calls(mock, 'GET', endsWith('/co-hosts'))).toHaveLength(1)
  })
  // The host's hint, and the empty state.
  expect(screen.getByText(CO_HOST_HINT)).toBeTruthy()
  expect(await screen.findByText('No co-hosts yet.')).toBeTruthy()
  // Make co-host on every Accepted row — none is a co-host yet.
  let accepteds = acceptedRows()
  expect(accepteds).toHaveLength(2)
  for (const row of accepteds) {
    expect(within(row).getByRole('button', { name: 'Make co-host' })).toBeTruthy()
  }
  expect(screen.queryByText(/— Co-host/)).toBeNull()

  // One click, no confirmation: one POST naming the accepted invitation.
  fireEvent.click(within(rowNamed(accepteds, 'peter')).getByRole('button', { name: 'Make co-host' }))
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/co-hosts'))).toHaveLength(1)
  })
  const [, postInit] = calls(mock, 'POST', endsWith('/co-hosts'))[0]
  expect(JSON.parse(postInit!.body as string)).toEqual({ invitation_id: 'i-peter' })
  // The list re-reads: peter is a co-host, his Accepted row says so instead
  // of offering the act, and Aunt May's still offers it.
  await waitFor(() => {
    expect(calls(mock, 'GET', endsWith('/co-hosts'))).toHaveLength(2)
  })
  await screen.findByRole('list', { name: 'Co-hosts' })
  expect(coHostRows()).toHaveLength(1)
  expect(coHostRows()[0].textContent).toContain('peter')
  expect(screen.queryByText('No co-hosts yet.')).toBeNull()
  accepteds = acceptedRows()
  expect(screen.getByText('peter — Co-host')).toBeTruthy()
  expect(within(rowNamed(accepteds, 'peter')).queryByRole('button', { name: 'Make co-host' })).toBeNull()
  expect(within(rowNamed(accepteds, 'Aunt May')).getByRole('button', { name: 'Make co-host' })).toBeTruthy()
  // The co-host list carries no Step down for the host — the host is never
  // a co-host — and no email or id.
  expect(screen.queryByRole('button', { name: 'Step down' })).toBeNull()
  expect(document.body.textContent).not.toMatch(/i-peter|acct-|person-|@/)

  // Remove as co-host: the first click only asks.
  fireEvent.click(within(coHostRows()[0]).getByRole('button', { name: 'Remove as co-host' }))
  const step = within(coHostRows()[0]).getByRole('group', { name: 'Remove peter as co-host' })
  expect(step.textContent).toContain(
    'peter will no longer be able to edit this gathering, invite people, or take photos off it.',
  )
  expect(calls(mock, 'DELETE', () => true)).toHaveLength(0)
  // Keep as co-host: inert — the step closes, nothing sent.
  fireEvent.click(within(step).getByRole('button', { name: 'Keep as co-host' }))
  expect(within(coHostRows()[0]).queryByRole('group', { name: /^Remove / })).toBeNull()
  expect(calls(mock, 'DELETE', () => true)).toHaveLength(0)
  expect(rows).toHaveLength(1)
  // The second, deliberate click: one DELETE to the row's own path, and the
  // list re-reads empty.
  fireEvent.click(within(coHostRows()[0]).getByRole('button', { name: 'Remove as co-host' }))
  fireEvent.click(
    within(within(coHostRows()[0]).getByRole('group', { name: /^Remove / })).getByRole('button', {
      name: 'Remove as co-host',
    }),
  )
  await waitFor(() => {
    expect(calls(mock, 'DELETE', () => true)).toHaveLength(1)
  })
  expect(calls(mock, 'DELETE', () => true)[0][0].endsWith('/gatherings/g-1/co-hosts/i-peter')).toBe(true)
  expect(await screen.findByText('No co-hosts yet.')).toBeTruthy()
  expect(rows).toHaveLength(0)
  expect(within(rowNamed(acceptedRows(), 'peter')).getByRole('button', { name: 'Make co-host' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('SERVER WORDING')
})

test('management, host: the four 422 codes and the 404 each render their line on the Accepted row they name — from the code, never the wording', async () => {
  const refusals = [
    ['not_invited', "That invitation can't be found any more — refresh the list."],
    ['is_host', "That's you — you're already the host."],
    ['already_co_host', 'Aunt May is already a co-host — refresh the list.'],
    ['account_deleted', "This person has deleted their account, so they can't be a co-host."],
  ]
  const queue: Response[] = [
    ...refusals.map(([code]) =>
      json(422, {
        detail: [{ loc: ['body', 'invitation_id'], msg: SERVER_WORDING, type: 'value_error', code }],
      }),
    ),
    json(404, { detail: 'No such gathering.' }),
  ]
  const mock = stubRoutes(
    detailRoutes(
      () => asHost(),
      () => [],
      [{ method: 'POST', match: endsWith('/gatherings/g-1/co-hosts'), response: () => queue.shift()! }],
    ),
  )
  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  await screen.findByText('No co-hosts yet.')
  const may = () => rowNamed(acceptedRows(), 'Aunt May')
  const peter = () => rowNamed(acceptedRows(), 'peter')
  for (const [, line] of refusals) {
    fireEvent.click(within(may()).getByRole('button', { name: 'Make co-host' }))
    await waitFor(() => {
      expect(within(may()).getByRole('alert').textContent).toContain(line)
    })
    expect(within(peter()).queryByRole('alert')).toBeNull()
  }
  // The 404: the caller is no longer allowed.
  fireEvent.click(within(may()).getByRole('button', { name: 'Make co-host' }))
  await waitFor(() => {
    expect(within(may()).getByRole('alert').textContent).toContain(
      "You can't change co-hosts for this gathering any more — refresh the page.",
    )
  })
  expect(calls(mock, 'POST', endsWith('/co-hosts'))).toHaveLength(5)
  // Nothing was made: the list never re-read after a refusal, and the
  // server's words reached the page nowhere.
  expect(calls(mock, 'GET', endsWith('/co-hosts'))).toHaveLength(1)
  expect(screen.getByText('No co-hosts yet.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('SERVER WORDING')
})

test("management, co-host: the list with no Make co-host or Remove as co-host anywhere; Step down on the is_self row only, behind a second step, Stay a co-host inert; the DELETE with their own invitation id, the gathering reloaded and every organiser control gone", async () => {
  let body: unknown = asCoHost()
  const mock = stubRoutes(
    detailRoutes(
      () => body,
      () => [coHostRow('i-may', 'Aunt May'), coHostRow('i-peter', 'peter', true)],
      [
        {
          method: 'DELETE',
          match: endsWith('/gatherings/g-1/co-hosts/i-peter'),
          response: () => {
            // Stepping down ends the role at once: the next read of the
            // gathering carries no role.
            body = asInvitee()
            return new Response(null, { status: 204 })
          },
        },
      ],
    ),
  )
  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /invite people/i }))
  await screen.findByRole('list', { name: 'Co-hosts' })
  // The list, read-only but for the caller's own row.
  expect(coHostRows()).toHaveLength(2)
  expect(coHostRows()[0].textContent).toContain('Aunt May')
  expect(coHostRows()[1].textContent).toContain('peter')
  expect(screen.queryByRole('button', { name: 'Make co-host' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove as co-host' })).toBeNull()
  expect(screen.queryByText(CO_HOST_HINT)).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Step down' })).toHaveLength(1)
  expect(within(coHostRows()[1]).getByRole('button', { name: 'Step down' })).toBeTruthy()
  expect(within(coHostRows()[0]).queryByRole('button', { name: 'Step down' })).toBeNull()
  // The Accepted rows say who is a co-host and offer nothing.
  expect(screen.getByText('peter — Co-host')).toBeTruthy()
  expect(screen.getByText('Aunt May — Co-host')).toBeTruthy()

  // Step down: the first click only asks; Stay a co-host is inert.
  fireEvent.click(within(coHostRows()[1]).getByRole('button', { name: 'Step down' }))
  const step = within(coHostRows()[1]).getByRole('group', { name: 'Step down as co-host' })
  expect(step.textContent).toContain(STEP_DOWN_SENTENCE)
  expect(calls(mock, 'DELETE', () => true)).toHaveLength(0)
  fireEvent.click(within(step).getByRole('button', { name: 'Stay a co-host' }))
  expect(within(coHostRows()[1]).queryByRole('group', { name: /step down/i })).toBeNull()
  expect(calls(mock, 'DELETE', () => true)).toHaveLength(0)
  expect(screen.getByRole('button', { name: /edit gathering/i })).toBeTruthy()

  // The second, deliberate click: one DELETE with their OWN invitation id,
  // the gathering re-read, and the page re-rendered as an invitee's.
  fireEvent.click(within(coHostRows()[1]).getByRole('button', { name: 'Step down' }))
  fireEvent.click(
    within(within(coHostRows()[1]).getByRole('group', { name: 'Step down as co-host' })).getByRole('button', {
      name: 'Step down',
    }),
  )
  await waitFor(() => {
    expect(calls(mock, 'DELETE', () => true)).toHaveLength(1)
  })
  expect(calls(mock, 'DELETE', () => true)[0][0].endsWith('/gatherings/g-1/co-hosts/i-peter')).toBe(true)
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /edit gathering/i })).toBeNull()
  })
  expect(calls(mock, 'GET', endsWith('/gatherings/g-1'))).toHaveLength(2)
  expect(delegableOnPage()).toEqual({
    editGathering: false,
    editDate: false,
    removeDate: false,
    addDate: false,
    invitations: false,
  })
  expect(screen.queryByText('Invitations')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Co-hosts' })).toBeNull()
  expect(screen.getByText('Test Potluck')).toBeTruthy()
})

test('RSVP, co-host: the full list and "Total going" in HOST_ONLY mode, no hint, and the visibility label names the organisers — never "me"', async () => {
  stubRoutes(
    detailRoutes(
      () => asCoHost({ rsvp_list_visibility: 'HOST_ONLY' }),
      () => [],
      [
        {
          method: 'GET',
          match: endsWith('/occurrences/occ-1/rsvps'),
          response: () =>
            json(200, {
              visibility: 'HOST_ONLY',
              own: null,
              rsvps: [
                {
                  id: 'r-1',
                  display_name: 'grandma',
                  response: 'yes',
                  stay_included: false,
                  companions: ['Milo'],
                  total: 2,
                  arrival_time: null,
                },
              ],
            }),
        },
      ],
    ),
  )
  renderDetail()
  await screen.findByText('Test Potluck')
  fireEvent.click(screen.getByRole('button', { name: /rsvp and who's coming/i }))
  // The full list, the companion names, and the organisers' total — and no
  // hint that the list is withheld.
  expect(await screen.findByText("Who's coming")).toBeTruthy()
  expect(screen.getByText(/grandma — Going/)).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Coming with grandma' }).textContent).toContain('Milo')
  expect(screen.getByText(/Total going: 2 people — counted from the names\./)).toBeTruthy()
  expect(screen.queryByText(/see the full list of answers/i)).toBeNull()
  // The selector's narrowest option names the organisers.
  fireEvent.click(screen.getByRole('button', { name: /edit gathering/i }))
  const select = screen.getByLabelText(/who can see the rsvp list/i) as HTMLSelectElement
  const labels = Array.from(select.options).map((option) => option.textContent)
  expect(labels).toContain('Only the host and co-hosts')
  expect(labels).not.toContain('Only me')
  expect(select.value).toBe('HOST_ONLY')
})
