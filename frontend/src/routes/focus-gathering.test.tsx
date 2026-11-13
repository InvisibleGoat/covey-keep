// CK-94 — focus after an answer on a gathering's page (routes/GatheringDetail.tsx
// and components/InviteByEmail.tsx), through the app's REAL route table with
// the REAL AuthProvider, each request held on a released promise and focus
// dropped to the body while it waits, as Chrome drops it from a disabled
// control (test-support/focus.ts). The values under test (the kickoff's §3,
// a gathering's page):
// - a 422 puts focus on the first field it names, in the form's order;
// - any other failure puts focus back on the control pressed, or the control
//   that carries the act on where the pressed one has gone;
// - a success puts focus on the next thing the person acts on: the checked
//   answer, Edit gathering, that date's Edit this date, Add another date,
//   When's heading where the row has left, the address field cleared, the
//   next line's button, the radio chosen, that member's other co-host act;
// - a press that opens a second step puts focus on the step — a group
//   labelled by its sentence, never its destructive button — and the step's
//   keep button puts it back on the button that opened it;
// - a person who moved elsewhere while it waited keeps their place.
// Remove this date and Revoke are never disabled, so their press keeps
// focus where it was (Chrome does too) until the answer lands.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { removeCoHostSentence, STEP_DOWN_SENTENCE } from '../lib/coHosts'
import { clearCoverPictures } from '../lib/covers'
import { setToken } from '../lib/session'
import { gate, pressHeld, settle, type Gate } from '../test-support/focus'

const DAY = 24 * 60 * 60 * 1000
const nextWeek = () => new Date(Date.now() + 7 * DAY).toISOString()
const yesterday = () => new Date(Date.now() - DAY).toISOString()

const GROUP = { id: 'grp-lees-1', name: 'The Lees' }

function date(id: string, startsAt: string) {
  return {
    id,
    gathering_id: 'g-1',
    starts_at: startsAt,
    ends_at: null,
    location: null,
    map_url: null,
    caller_response: null,
  }
}

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'The Party',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-ada',
    host_account_id: 'acct-ada',
    caller_role: 'host',
    caller_view: 'full',
    group: GROUP,
    cover: null,
    created_at: '2026-11-01T12:00:00+00:00',
    updated_at: null,
    occurrences: [date('occ-1', nextWeek())],
    outside_invitations: { on: false, since: null, by: null, may_change: false },
    caller_in_group: true,
    outside_alert: false,
    ...over,
  }
}

const STANDALONE = { group: null, outside_invitations: null, caller_in_group: null, outside_alert: null }

type Key =
  | 'rsvp'
  | 'edit'
  | 'occEdit'
  | 'occAdd'
  | 'occRemove'
  | 'occConfirm'
  | 'place'
  | 'invite'
  | 'revoke'
  | 'makeCoHost'
  | 'removeCoHost'

interface Answer {
  status: number
  body?: unknown
}

interface Member {
  membership_id: string
  display_name: string
  place: string | null
  co_host: boolean
}

interface World {
  detail: Record<string, unknown>
  own: Record<string, unknown> | null
  roster: {
    pending: { id: string; channel: string; destination: string; created_at: string; expires_at: string }[]
    accepted: { id: string; display_name: string; accepted_at: string }[]
  }
  coHosts: { invitation_id: string; display_name: string; is_self: boolean }[]
  places: Member[]
  answer: Partial<Record<Key, Answer>>
  hold: Partial<Record<Key, Gate>>
}

let world: World

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function invalid(...loc: (string | number)[]): Answer {
  return { status: 422, body: { detail: [{ loc: ['body', ...loc], msg: 'Value error, refused', type: 'value_error' }] } }
}

// Hold the request while the test asks, then answer what the test set, or
// the success `ok` gives.
async function reply(key: Key, ok: () => Response): Promise<Response> {
  await world.hold[key]?.promise
  const given = world.answer[key]
  if (given !== undefined) return json(given.status, given.body ?? { detail: 'refused' })
  return ok()
}

function groupBody() {
  return {
    id: GROUP.id,
    name: GROUP.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: 4,
    caller_role: 'admin',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function stubServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const p = String(url).replace(/^https?:\/\/[^/]+/, '')
      const body = () => JSON.parse(String(init?.body)) as Record<string, unknown>
      if (p === '/auth/me') {
        return json(200, {
          id: 'person-ada',
          display_name: 'Ada Test',
          email: 'ada@example.com',
          timezone: 'America/Chicago',
          account_id: 'acct-ada',
        })
      }
      if (p === '/groups') return json(200, { groups: world.detail.group === null ? [] : [groupBody()] })
      if (p === '/gatherings' && method === 'GET') return json(200, { gatherings: [] })
      if (p === '/billing') return json(404, {})
      if (p === '/gatherings/g-1' && method === 'GET') return json(200, world.detail)
      if (p === '/gatherings/g-1' && method === 'PATCH') {
        return reply('edit', () => {
          world.detail = { ...world.detail, ...body() }
          return json(200, world.detail)
        })
      }
      if (p === '/occurrences/occ-1' && method === 'PATCH') {
        return reply('occEdit', () => json(200, (world.detail.occurrences as unknown[])[0]))
      }
      if (p === '/gatherings/g-1/occurrences' && method === 'POST') {
        return reply('occAdd', () => {
          const added = date('occ-2', String(body().starts_at))
          world.detail = { ...world.detail, occurrences: [...(world.detail.occurrences as unknown[]), added] }
          return json(201, added)
        })
      }
      if (p.startsWith('/occurrences/occ-1') && method === 'DELETE') {
        return reply(p.endsWith('?confirm=true') ? 'occConfirm' : 'occRemove', () => {
          world.detail = { ...world.detail, occurrences: [] }
          return new Response(null, { status: 204 })
        })
      }
      if (p === '/occurrences/occ-1/rsvps') {
        return json(200, { visibility: 'INVITEES', own: world.own, rsvps: [] })
      }
      if (p === '/occurrences/occ-1/rsvp' && method === 'PUT') {
        return reply('rsvp', () => {
          const sent = body()
          world.own = {
            response: sent.response,
            stay_included: sent.stay_included,
            companions: sent.companions,
            arrival_time: sent.arrival_time ?? null,
            created_at: '2026-11-12T12:00:00+00:00',
            updated_at: null,
          }
          return json(200, world.own)
        })
      }
      if (p === '/gatherings/g-1/invitations' && method === 'GET') return json(200, world.roster)
      if (p === '/gatherings/g-1/invitations' && method === 'POST') {
        return reply('invite', () => {
          world.roster = {
            ...world.roster,
            pending: [
              ...world.roster.pending,
              {
                id: `inv-p-${world.roster.pending.length + 1}`,
                channel: 'EMAIL',
                destination: String(body().destination),
                created_at: '2026-11-12T12:00:00+00:00',
                expires_at: nextWeek(),
              },
            ],
          }
          return json(201, {})
        })
      }
      if (p.startsWith('/invitations/pending/') && method === 'DELETE') {
        return reply('revoke', () => {
          const id = p.split('/').pop()
          world.roster = { ...world.roster, pending: world.roster.pending.filter((entry) => entry.id !== id) }
          return new Response(null, { status: 204 })
        })
      }
      if (p === '/gatherings/g-1/co-hosts' && method === 'GET') return json(200, { co_hosts: world.coHosts })
      if (p === '/gatherings/g-1/co-hosts' && method === 'POST') {
        return reply('makeCoHost', () => {
          const id = String(body().invitation_id)
          const accepted = world.roster.accepted.find((entry) => entry.id === id)!
          world.coHosts = [...world.coHosts, { invitation_id: id, display_name: accepted.display_name, is_self: false }]
          return json(201, {})
        })
      }
      if (p.startsWith('/gatherings/g-1/co-hosts/') && method === 'DELETE') {
        return reply('removeCoHost', () => {
          const id = p.split('/').pop()
          const gone = world.coHosts.find((row) => row.invitation_id === id)
          world.coHosts = world.coHosts.filter((row) => row.invitation_id !== id)
          if (gone?.is_self) world.detail = { ...world.detail, caller_role: null }
          return new Response(null, { status: 204 })
        })
      }
      if (p === '/gatherings/g-1/places' && method === 'GET') {
        return json(200, { invitees_chosen: true, members: world.places })
      }
      if (p.startsWith('/gatherings/g-1/places/') && method === 'PUT') {
        return reply('place', () => {
          const id = p.split('/').pop()
          const place = String(body().place)
          world.places = world.places.map((member) => (member.membership_id === id ? { ...member, place } : member))
          return json(200, world.places.find((member) => member.membership_id === id))
        })
      }
      if (p.startsWith('/gatherings/g-1/media')) return json(200, { media: [] })
      if (p === `/groups/${GROUP.id}`) return json(200, groupBody())
      return json(404, { detail: 'Not Found' })
    }),
  )
}

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  world = {
    detail: detail(),
    own: null,
    roster: {
      pending: [],
      accepted: [
        { id: 'inv-bea', display_name: 'Bea Test', accepted_at: '2026-11-02T12:00:00+00:00' },
        { id: 'inv-cy', display_name: 'Cy Test', accepted_at: '2026-11-03T12:00:00+00:00' },
      ],
    },
    coHosts: [{ invitation_id: 'inv-cy', display_name: 'Cy Test', is_self: false }],
    places: [
      { membership_id: 'mem-bea', display_name: 'Bea Test', place: 'invited', co_host: false },
      { membership_id: 'mem-dee', display_name: 'Dee Test', place: 'left_out', co_host: false },
      { membership_id: 'mem-eve', display_name: 'Eve Test', place: 'left_out', co_host: false },
    ],
    answer: {},
    hold: {},
  }
  stubServer()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function open(over: Record<string, unknown> = {}) {
  world.detail = detail(over)
  render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  await settle()
}

// A press whose request the server holds on `key`, focus dropped to the body
// (or moved to `movedTo`) while it waits.
async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  world.hold[key] = gate()
  await pressHeld(control, world.hold[key]!, movedTo)
  await settle()
}

// A press on a control that is never disabled (Remove this date, Revoke):
// focus stays on it while the request waits, as it does in Chrome.
async function heldInPlace(key: Key, control: HTMLElement) {
  world.hold[key] = gate()
  control.focus()
  fireEvent.click(control)
  await settle()
  expect(document.activeElement).toBe(control)
  await act(async () => world.hold[key]!.release())
  await settle()
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const when = () => screen.getByRole('region', { name: 'When' })
const editForm = () => screen.getByRole('form', { name: 'Edit gathering' })
const editDate = () => screen.getByRole('group', { name: 'Edit this date' })
const memberRow = (name: string) => screen.getByRole('group', { name: new RegExp(name) })
const coHostList = () => screen.getByRole('list', { name: 'Co-hosts' })
const invitedList = () => screen.getByRole('list', { name: 'Invited' })
const rowOf = (list: HTMLElement, name: string) =>
  within(list).getAllByRole('listitem').find((item) => item.textContent?.includes(name))!

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

async function openRsvp() {
  fireEvent.click(button("RSVP and who's coming"))
  fireEvent.click(await screen.findByRole('radio', { name: 'Going' }))
  fireEvent.change(screen.getByLabelText('Arriving around (optional)'), { target: { value: '18:00' } })
}

test("RSVP's 422 on a field puts focus on that field", async () => {
  await open()
  await openRsvp()
  world.answer.rsvp = invalid('arrival_time')
  await held('rsvp', button('Send RSVP'))
  expect(document.activeElement).toBe(screen.getByLabelText('Arriving around (optional)'))
})

test("RSVP's failure puts focus back on Send RSVP", async () => {
  await open()
  await openRsvp()
  world.answer.rsvp = { status: 500 }
  await held('rsvp', button('Send RSVP'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(button('Send RSVP'))
})

test("RSVP's success puts focus on the checked answer in that date's block", async () => {
  await open()
  await openRsvp()
  await held('rsvp', button('Send RSVP'))
  await screen.findByRole('button', { name: 'Update RSVP' })
  const going = screen.getByRole('radio', { name: 'Going' }) as HTMLInputElement
  expect(going.checked).toBe(true)
  expect(document.activeElement).toBe(going)
  expect((button('Update RSVP') as HTMLButtonElement).disabled).toBe(true)
})

test('a person who moved on while the RSVP waited keeps their place', async () => {
  await open()
  await openRsvp()
  const elsewhere = button('Edit gathering')
  await held('rsvp', button('Send RSVP'), elsewhere)
  await screen.findByRole('button', { name: 'Update RSVP' })
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Edit gathering
// ---------------------------------------------------------------------------

async function openEdit() {
  fireEvent.click(button('Edit gathering'))
  fireEvent.change(within(editForm()).getByLabelText('Title'), { target: { value: 'The Big Party' } })
}

test("Edit gathering's 422 on the title puts focus on the title field", async () => {
  await open()
  await openEdit()
  world.answer.edit = invalid('title')
  await held('edit', within(editForm()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editForm()).getByLabelText('Title'))
})

test("Edit gathering's failure puts focus back on Save", async () => {
  await open()
  await openEdit()
  world.answer.edit = { status: 500 }
  await held('edit', within(editForm()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editForm()).getByRole('button', { name: 'Save' }))
})

test("Edit gathering's success puts focus on Edit gathering", async () => {
  await open()
  await openEdit()
  await held('edit', within(editForm()).getByRole('button', { name: 'Save' }))
  expect(screen.queryByRole('form', { name: 'Edit gathering' })).toBeNull()
  expect(document.activeElement).toBe(button('Edit gathering'))
})

test("a person who moved on while Edit gathering's save waited keeps their place", async () => {
  await open()
  await openEdit()
  const elsewhere = button("RSVP and who's coming")
  await held('edit', within(editForm()).getByRole('button', { name: 'Save' }), elsewhere)
  expect(screen.queryByRole('form', { name: 'Edit gathering' })).toBeNull()
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Edit this date, Add this date
// ---------------------------------------------------------------------------

async function openDateEdit() {
  fireEvent.click(button('Edit this date'))
  fireEvent.change(within(editDate()).getByLabelText('Location (optional)'), { target: { value: 'The park' } })
}

test("Edit this date's 422 puts focus on the field it names", async () => {
  await open()
  await openDateEdit()
  world.answer.occEdit = invalid('ends_at')
  await held('occEdit', within(editDate()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editDate()).getByLabelText('Ends (optional)'))
})

test("Edit this date's failure puts focus back on Save", async () => {
  await open()
  await openDateEdit()
  world.answer.occEdit = { status: 500 }
  await held('occEdit', within(editDate()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editDate()).getByRole('button', { name: 'Save' }))
})

test("Edit this date's success puts focus on that date's Edit this date", async () => {
  await open()
  await openDateEdit()
  await held('occEdit', within(editDate()).getByRole('button', { name: 'Save' }))
  expect(screen.queryByRole('group', { name: 'Edit this date' })).toBeNull()
  expect(document.activeElement).toBe(button('Edit this date'))
})

async function openAdd() {
  fireEvent.click(button('Add another date'))
  fireEvent.change(document.getElementById('add-starts')!, { target: { value: '2026-12-01T18:00' } })
}

test("Add this date's 422 puts focus on the field it names", async () => {
  await open()
  await openAdd()
  world.answer.occAdd = invalid('starts_at')
  await held('occAdd', button('Add this date'))
  expect(document.activeElement).toBe(document.getElementById('add-starts'))
})

test("Add this date's failure puts focus back on Add this date", async () => {
  await open()
  await openAdd()
  world.answer.occAdd = { status: 500 }
  await held('occAdd', button('Add this date'))
  expect(document.activeElement).toBe(button('Add this date'))
})

test("Add this date's success puts focus on Add another date", async () => {
  await open()
  await openAdd()
  await held('occAdd', button('Add this date'))
  expect(document.activeElement).toBe(button('Add another date'))
})

// ---------------------------------------------------------------------------
// Remove this date
// ---------------------------------------------------------------------------

const ANSWERED = { status: 409, body: { detail: { code: 'confirmation_required', rsvp_count: 1 } } }
const answeredStep = () => screen.getByRole('group', { name: /1 person has answered for this date/ })

test('Remove this date on an answered date opens the step and puts focus on it, never its destructive button', async () => {
  await open()
  world.answer.occRemove = ANSWERED
  await heldInPlace('occRemove', button('Remove this date'))
  const step = answeredStep()
  expect(step.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(step)
  expect(within(step).getByRole('button', { name: 'Remove it anyway' })).toBeTruthy()
})

test("the step's Don't remove it puts focus back on Remove this date", async () => {
  await open()
  world.answer.occRemove = ANSWERED
  await heldInPlace('occRemove', button('Remove this date'))
  fireEvent.click(within(answeredStep()).getByRole('button', { name: "Don't remove it" }))
  expect(document.activeElement).toBe(button('Remove this date'))
})

// Remove this date is never disabled, so on a failure focus never left it:
// this holds before CK-94 by design, and is pinned so it stays.
test("Remove this date's failure keeps focus on Remove this date", async () => {
  await open()
  world.answer.occRemove = { status: 500 }
  await heldInPlace('occRemove', button('Remove this date'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(button('Remove this date'))
})

test("Remove this date's success puts focus on When's heading", async () => {
  await open()
  await heldInPlace('occRemove', button('Remove this date'))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove this date' })).toBeNull())
  const heading = within(when()).getByRole('heading', { level: 2, name: 'When' })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

test("Remove it anyway's failure puts focus on Remove this date", async () => {
  await open()
  world.answer.occRemove = ANSWERED
  await heldInPlace('occRemove', button('Remove this date'))
  world.answer.occConfirm = { status: 500 }
  await held('occConfirm', within(answeredStep()).getByRole('button', { name: 'Remove it anyway' }))
  expect(document.activeElement).toBe(button('Remove this date'))
})

test("Remove it anyway's success puts focus on When's heading", async () => {
  await open()
  world.answer.occRemove = ANSWERED
  await heldInPlace('occRemove', button('Remove this date'))
  await held('occConfirm', within(answeredStep()).getByRole('button', { name: 'Remove it anyway' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove this date' })).toBeNull())
  expect(document.activeElement).toBe(within(when()).getByRole('heading', { level: 2, name: 'When' }))
})

// ---------------------------------------------------------------------------
// The prompt to share, and Who it's for
// ---------------------------------------------------------------------------

async function openStarted() {
  await open({ occurrences: [date('occ-1', yesterday())] })
  await screen.findByRole('button', { name: 'Let Dee Test see the photos' })
}

test("the prompt's failure puts focus back on that button", async () => {
  await openStarted()
  world.answer.place = { status: 500 }
  await held('place', button('Let Dee Test see the photos'))
  expect(document.activeElement).toBe(button('Let Dee Test see the photos'))
})

test("the prompt's success puts focus on the next line's button", async () => {
  await openStarted()
  await held('place', button('Let Dee Test see the photos'))
  expect(screen.queryByRole('button', { name: 'Let Dee Test see the photos' })).toBeNull()
  expect(document.activeElement).toBe(button('Let Eve Test see the photos'))
})

test("the prompt's last line's success puts focus on Who it's for's heading", async () => {
  world.places = world.places.filter((member) => member.membership_id !== 'mem-eve')
  await openStarted()
  await held('place', button('Let Dee Test see the photos'))
  const heading = screen.getByRole('heading', { level: 2, name: "Who it's for" })
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
})

test("a place's failure puts focus on that row's checked radio", async () => {
  await open()
  await screen.findByRole('group', { name: /Bea Test/ })
  world.answer.place = { status: 500 }
  await held('place', within(memberRow('Bea Test')).getByRole('radio', { name: 'Sees the photos' }))
  const invited = within(memberRow('Bea Test')).getByRole('radio', { name: 'Invited' }) as HTMLInputElement
  expect(invited.checked).toBe(true)
  expect(document.activeElement).toBe(invited)
})

test("a place's success puts focus on the radio chosen", async () => {
  await open()
  await screen.findByRole('group', { name: /Bea Test/ })
  await held('place', within(memberRow('Bea Test')).getByRole('radio', { name: 'Sees the photos' }))
  const chosen = within(memberRow('Bea Test')).getByRole('radio', { name: 'Sees the photos' }) as HTMLInputElement
  expect(chosen.checked).toBe(true)
  expect(document.activeElement).toBe(chosen)
})

// Not a row of the kickoff's table: Refresh the list goes as it is pressed
// and the row is read again, so the rule's last rung — Who it's for's heading.
test("Refresh the list after a refused place puts focus on Who it's for's heading", async () => {
  await open()
  await screen.findByRole('group', { name: /Bea Test/ })
  world.answer.place = { status: 500 }
  await held('place', within(memberRow('Bea Test')).getByRole('radio', { name: 'Sees the photos' }))
  const refresh = within(memberRow('Bea Test')).getByRole('button', { name: 'Refresh the list' })
  refresh.focus()
  fireEvent.click(refresh)
  await settle()
  expect(screen.queryByRole('button', { name: 'Refresh the list' })).toBeNull()
  const heading = screen.getByRole('heading', { level: 2, name: "Who it's for" })
  expect(document.activeElement).toBe(heading)
})

// ---------------------------------------------------------------------------
// Send invitation and Revoke, in both places
// ---------------------------------------------------------------------------

async function openInvite(address = 'cousin@example.com') {
  await open(STANDALONE)
  fireEvent.click(button('Invite people'))
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: address } })
}

const address = () => screen.getByLabelText('Email address')

test("Send invitation's 422 puts focus on the address field", async () => {
  await openInvite('cousin@example')
  world.answer.invite = invalid('destination')
  await held('invite', button('Send invitation'))
  expect(document.activeElement).toBe(address())
})

test("Send invitation's 429 puts focus back on Send invitation", async () => {
  await openInvite()
  world.answer.invite = { status: 429 }
  await held('invite', button('Send invitation'))
  expect(screen.getByText('Too many invitations just now. Try again in a few minutes.')).toBeTruthy()
  expect(document.activeElement).toBe(button('Send invitation'))
})

test("Send invitation's failure puts focus back on Send invitation", async () => {
  await openInvite()
  world.answer.invite = { status: 500 }
  await held('invite', button('Send invitation'))
  expect(document.activeElement).toBe(button('Send invitation'))
})

test("Send invitation's success puts focus on the address field, cleared", async () => {
  await openInvite()
  await held('invite', button('Send invitation'))
  await screen.findByText(/cousin@example\.com/)
  expect((address() as HTMLInputElement).value).toBe('')
  expect(document.activeElement).toBe(address())
})

test("Send invitation's success in the outside card puts focus on the address field", async () => {
  await open({ outside_invitations: { on: true, since: '2026-11-10T12:00:00+00:00', by: 'Ada Test', may_change: true } })
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'cousin@example.com' } })
  await held('invite', button('Send invitation'))
  await screen.findByText(/cousin@example\.com/)
  expect(document.activeElement).toBe(address())
})

test("a person who moved on while Send invitation waited keeps their place", async () => {
  await openInvite()
  const elsewhere = button('Edit gathering')
  await held('invite', button('Send invitation'), elsewhere)
  await screen.findByText(/cousin@example\.com/)
  expect(document.activeElement).toBe(elsewhere)
})

test("Revoke's success puts focus on the address field", async () => {
  world.roster.pending = [
    {
      id: 'inv-p-1',
      channel: 'EMAIL',
      destination: 'aunt@example.com',
      created_at: '2026-11-11T12:00:00+00:00',
      expires_at: nextWeek(),
    },
  ]
  await open(STANDALONE)
  fireEvent.click(button('Invite people'))
  await screen.findByText(/aunt@example\.com/)
  await heldInPlace('revoke', button('Revoke'))
  await waitFor(() => expect(screen.queryByText(/aunt@example\.com/)).toBeNull())
  expect(document.activeElement).toBe(address())
})

// ---------------------------------------------------------------------------
// Co-hosts
// ---------------------------------------------------------------------------

async function openCoHosts(over: Record<string, unknown> = {}) {
  await open(over)
  fireEvent.click(button('Show co-hosts'))
  await screen.findByRole('list', { name: 'Co-hosts' })
}

const removeStep = () => screen.getByRole('group', { name: removeCoHostSentence('Cy Test') })
const stepDownStep = () => screen.getByRole('group', { name: STEP_DOWN_SENTENCE })

test('Remove as co-host opens the step and puts focus on it, labelled by its sentence', async () => {
  await openCoHosts()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
  const step = removeStep()
  expect(step.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(step)
})

test("the co-host step's Keep as co-host puts focus back on Remove as co-host", async () => {
  await openCoHosts()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
  fireEvent.click(within(removeStep()).getByRole('button', { name: 'Keep as co-host' }))
  expect(document.activeElement).toBe(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
})

test("Remove as co-host's failure puts focus on that row's Remove as co-host", async () => {
  await openCoHosts()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
  world.answer.removeCoHost = { status: 500 }
  await held('removeCoHost', within(removeStep()).getByRole('button', { name: 'Remove as co-host' }))
  expect(document.activeElement).toBe(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
})

test("Remove as co-host's success puts focus on that member's Make co-host", async () => {
  await openCoHosts()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Remove as co-host' }))
  await held('removeCoHost', within(removeStep()).getByRole('button', { name: 'Remove as co-host' }))
  await waitFor(() => expect(within(rowOf(invitedList(), 'Cy Test')).queryByRole('button')).toBeTruthy())
  expect(document.activeElement).toBe(within(rowOf(invitedList(), 'Cy Test')).getByRole('button', { name: 'Make co-host' }))
})

test("Make co-host's failure puts focus back on Make co-host", async () => {
  await openCoHosts()
  world.answer.makeCoHost = { status: 500 }
  await held('makeCoHost', within(rowOf(invitedList(), 'Bea Test')).getByRole('button', { name: 'Make co-host' }))
  expect(document.activeElement).toBe(within(rowOf(invitedList(), 'Bea Test')).getByRole('button', { name: 'Make co-host' }))
})

test("Make co-host's success puts focus on that member's Remove as co-host", async () => {
  await openCoHosts()
  await held('makeCoHost', within(rowOf(invitedList(), 'Bea Test')).getByRole('button', { name: 'Make co-host' }))
  await waitFor(() => expect(rowOf(coHostList(), 'Bea Test')).toBeTruthy())
  expect(document.activeElement).toBe(within(rowOf(coHostList(), 'Bea Test')).getByRole('button', { name: 'Remove as co-host' }))
})

test("a person who moved on while Make co-host waited keeps their place", async () => {
  await openCoHosts()
  const elsewhere = button('Edit gathering')
  await held('makeCoHost', within(rowOf(invitedList(), 'Bea Test')).getByRole('button', { name: 'Make co-host' }), elsewhere)
  await waitFor(() => expect(rowOf(coHostList(), 'Bea Test')).toBeTruthy())
  expect(document.activeElement).toBe(elsewhere)
})

async function openAsCoHost() {
  world.coHosts = [{ invitation_id: 'inv-ada', display_name: 'Ada Test', is_self: true }]
  await openCoHosts({ caller_role: 'co_host' })
}

test('Step down opens the step and puts focus on it, labelled by its sentence', async () => {
  await openAsCoHost()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Step down' }))
  expect(stepDownStep().getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(stepDownStep())
})

test("the step's Stay a co-host puts focus back on Step down", async () => {
  await openAsCoHost()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Step down' }))
  fireEvent.click(within(stepDownStep()).getByRole('button', { name: 'Stay a co-host' }))
  expect(document.activeElement).toBe(within(coHostList()).getByRole('button', { name: 'Step down' }))
})

test("Step down's failure puts focus back on Step down", async () => {
  await openAsCoHost()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Step down' }))
  world.answer.removeCoHost = { status: 500 }
  await held('removeCoHost', within(stepDownStep()).getByRole('button', { name: 'Step down' }))
  expect(document.activeElement).toBe(within(coHostList()).getByRole('button', { name: 'Step down' }))
})

test("Step down's success puts focus on the page's heading", async () => {
  await openAsCoHost()
  fireEvent.click(within(coHostList()).getByRole('button', { name: 'Step down' }))
  await held('removeCoHost', within(stepDownStep()).getByRole('button', { name: 'Step down' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit gathering' })).toBeNull())
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'The Party' }))
})
