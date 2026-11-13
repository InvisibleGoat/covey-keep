// CK-94 — focus after an answer on a group's People page (routes/GroupPeople.tsx),
// through the app's REAL route table with the REAL AuthProvider, each request
// held on a released promise and focus dropped to the body while it waits, as
// Chrome drops it from a disabled control (test-support/focus.ts). The values
// under test (the kickoff's §3, a group's People page), each section its own
// container — Members, Requests to join, Invite people, Rename the group,
// Leave this group:
// - a 422 puts focus on the field it names;
// - any other failure puts focus back on the control pressed, or on the
//   button that opened the step the failure closed;
// - a success puts focus on the next thing the person acts on: that member's
//   other co-admin act, Share the link, Make a link, the address field, the
//   name field — or the section's heading where the row has left;
// - a press that opens a second step puts focus on the step — a group
//   labelled by its sentence, never its confirm button — and the step's keep
//   button puts it back on the button that opened it;
// - a person who moved elsewhere while it waited keeps their place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { approveSentence, REPLACE_LINK_SENTENCE, TURN_OFF_LINK_SENTENCE } from '../lib/groupJoining'
import {
  leaveSentence,
  makeAdminSentence,
  removeCoAdminSentence,
  removeMemberSentence,
  STEP_DOWN_SENTENCE,
} from '../lib/groups'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle, type Gate } from '../test-support/focus'

type Who = 'ada' | 'bea' | 'cal'
type Role = 'admin' | 'co_admin' | 'member'
type Key =
  | 'rename'
  | 'addCoAdmin'
  | 'removeCoAdmin'
  | 'handOver'
  | 'removeMember'
  | 'leave'
  | 'approve'
  | 'decline'
  | 'readLink'
  | 'makeLink'
  | 'revokeLink'
  | 'invite'
  | 'revokeInvitation'

const ORDER: Who[] = ['ada', 'bea', 'cal']
const NAMES: Record<Who, string> = { ada: 'Ada', bea: 'Bea', cal: 'Cal' }
const MEMBERSHIP: Record<Who, string> = { ada: 'mem-ada', bea: 'mem-bea', cal: 'mem-cal' }

interface Answer {
  status: number
  body?: unknown
}

interface World {
  self: Who
  roles: Record<Who, Role>
  present: Record<Who, boolean>
  name: string
  requests: { id: string; display_name: string; created_at: string }[]
  link: { url: string; expires_at: string } | null
  pending: { id: string; channel: string; destination: string; created_at: string; expires_at: string }[]
  answer: Partial<Record<Key, Answer>>
  hold: Partial<Record<Key, Gate>>
}

let world: World
let where = ''

const LINK = { url: 'https://app.example/groups/join#token=tok-1', expires_at: '2099-01-02T18:00:00+00:00' }
const NEWER = { url: 'https://app.example/groups/join#token=tok-2', expires_at: '2099-01-09T18:00:00+00:00' }
const ZOE = { id: 'req-zoe', display_name: 'Zoe', created_at: '2026-10-26T15:00:00+00:00' }
const DORA = {
  id: 'inv-dora',
  channel: 'EMAIL',
  destination: 'dora@example.com',
  created_at: '2026-10-27T15:00:00+00:00',
  expires_at: '2099-01-02T18:00:00+00:00',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const noContent = () => new Response(null, { status: 204 })

function invalid(...loc: (string | number)[]): Answer {
  return { status: 422, body: { detail: [{ loc: ['body', ...loc], msg: 'Value error, refused', type: 'value_error' }] } }
}

async function reply(key: Key, ok: () => Response): Promise<Response> {
  await world.hold[key]?.promise
  const given = world.answer[key]
  if (given !== undefined) return json(given.status, given.body ?? { detail: 'refused' })
  return ok()
}

const live = () => ORDER.filter((who) => world.present[who])
const whoOf = (membershipId: string) => ORDER.find((w) => MEMBERSHIP[w] === membershipId) as Who

function groupBody() {
  return {
    id: 'g-1',
    name: world.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: live().length,
    caller_role: world.roles[world.self],
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
      const body = () => JSON.parse(String(init?.body)) as Record<string, string>
      if (p === '/auth/me') {
        return json(200, {
          id: 'person-viewer',
          display_name: NAMES[world.self],
          email: 'viewer@example.com',
          timezone: 'America/Chicago',
          account_id: 'acct-viewer',
        })
      }
      if (p === '/groups' && method === 'GET') return json(200, { groups: [] })
      if (p === '/gatherings' && method === 'GET') return json(200, { gatherings: [] })
      if (p === '/groups/g-1' && method === 'GET') return json(200, groupBody())
      if (p === '/groups/g-1' && method === 'PATCH') {
        return reply('rename', () => {
          world.name = body().name.trim()
          return json(200, groupBody())
        })
      }
      if (p === '/groups/g-1/members') {
        return json(200, {
          members: live().map((who) => ({
            membership_id: MEMBERSHIP[who],
            display_name: NAMES[who],
            role: world.roles[who],
            is_self: who === world.self,
          })),
        })
      }
      if (p === '/groups/g-1/co-admins' && method === 'POST') {
        return reply('addCoAdmin', () => {
          world.roles[whoOf(body().membership_id)] = 'co_admin'
          return json(201, {})
        })
      }
      const coAdmin = p.match(/^\/groups\/g-1\/co-admins\/(.+)$/)
      if (coAdmin && method === 'DELETE') {
        return reply('removeCoAdmin', () => {
          world.roles[whoOf(coAdmin[1])] = 'member'
          return noContent()
        })
      }
      if (p === '/groups/g-1/hand-over' && method === 'POST') {
        return reply('handOver', () => {
          for (const w of ORDER) if (world.roles[w] === 'admin') world.roles[w] = 'member'
          world.roles[whoOf(body().membership_id)] = 'admin'
          return json(200, groupBody())
        })
      }
      const member = p.match(/^\/groups\/g-1\/members\/(.+)$/)
      if (member && method === 'DELETE') {
        return reply('removeMember', () => {
          world.present[whoOf(member[1])] = false
          return noContent()
        })
      }
      if (p === '/groups/g-1/leave') return reply('leave', noContent)
      if (p === '/groups/g-1/link' && method === 'GET') {
        return reply('readLink', () => json(200, world.link ?? { url: null, expires_at: null }))
      }
      if (p === '/groups/g-1/link' && method === 'POST') {
        return reply('makeLink', () => {
          world.link = world.link === null ? LINK : NEWER
          return json(201, world.link)
        })
      }
      if (p === '/groups/g-1/link' && method === 'DELETE') {
        return reply('revokeLink', () => {
          world.link = null
          return noContent()
        })
      }
      if (p === '/groups/g-1/join-requests') return json(200, { join_requests: world.requests })
      const decided = p.match(/^\/groups\/g-1\/join-requests\/([^/]+)\/(approve|decline)$/)
      if (decided) {
        return reply(decided[2] as Key, () => {
          world.requests = world.requests.filter((r) => r.id !== decided[1])
          if (decided[2] === 'approve') world.present.cal = true
          return json(200, {})
        })
      }
      if (p === '/groups/g-1/invitations' && method === 'GET') return json(200, { pending: world.pending })
      if (p === '/groups/g-1/invitations' && method === 'POST') {
        return reply('invite', () => {
          const added = { ...DORA, id: 'inv-new', destination: body().destination }
          world.pending = [...world.pending, added]
          return json(201, added)
        })
      }
      const invitation = p.match(/^\/groups\/g-1\/invitations\/([^/]+)$/)
      if (invitation && method === 'DELETE') {
        return reply('revokeInvitation', () => {
          world.pending = world.pending.filter((i) => i.id !== invitation[1])
          return noContent()
        })
      }
      return json(404, { detail: 'Not Found' })
    }),
  )
}

beforeEach(() => {
  localStorage.clear()
  setToken('token-viewer')
  world = {
    self: 'ada',
    roles: { ada: 'admin', bea: 'co_admin', cal: 'member' },
    present: { ada: true, bea: true, cal: true },
    name: 'The Lees',
    requests: [ZOE],
    link: null,
    pending: [DORA],
    answer: {},
    hold: {},
  }
  stubServer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function Where() {
  where = useLocation().pathname
  return null
}

async function open(over: Partial<World> = {}) {
  Object.assign(world, over)
  render(
    <MemoryRouter initialEntries={['/groups/g-1/people']}>
      <AuthProvider>
        <App />
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('list', { name: 'Members' })
  await settle()
}

async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  world.hold[key] = gate()
  await pressHeld(control, world.hold[key]!, movedTo)
  await settle()
}

// A press that opens a step: no request, so nothing to hold.
async function press(control: HTMLElement) {
  control.focus()
  fireEvent.click(control)
  await settle()
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const crumb = () => screen.getByRole('link', { name: 'The Lees' })
const heading = (name: string) => screen.getByRole('heading', { level: 2, name })

function rowOf(listName: string, name: string): HTMLElement {
  const row = within(screen.getByRole('list', { name: listName }))
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.member-name')?.textContent === name)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

const member = (name: string) => within(rowOf('Members', name))
const request = (name: string) => within(rowOf('Requests to join', name))

function expectStep(sentence: string) {
  const step = screen.getByRole('group', { name: sentence })
  expect(document.activeElement).toBe(step)
  expect(step.getAttribute('tabindex')).toBe('-1')
  return step
}

function expectHeading(name: string) {
  const h2 = heading(name)
  expect(document.activeElement).toBe(h2)
  expect(h2.getAttribute('tabindex')).toBe('-1')
}

test('opening the People page moves no focus', async () => {
  await open()
  expect(document.activeElement).toBe(document.body)
})

// ---------------------------------------------------------------------------
// Rename the group
// ---------------------------------------------------------------------------

test("rename's 422 on the name puts focus on the name field", async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: '' } })
  world.answer.rename = invalid('name')
  await held('rename', button('Save'))
  expect(document.activeElement).toBe(screen.getByLabelText('Group name'))
})

test("a failed rename puts focus back on Save", async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'The Lee Family' } })
  world.answer.rename = { status: 500 }
  await held('rename', button('Save'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(button('Save'))
})

test('a landed rename puts focus on the name field, Save disabled until it changes', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'The Lee Family' } })
  await held('rename', button('Save'))
  expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
  expect(document.activeElement).toBe(screen.getByLabelText('Group name'))
})

test('a person who moved on while the rename waited keeps their place', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'The Lee Family' } })
  world.answer.rename = { status: 500 }
  const elsewhere = crumb()
  await held('rename', button('Save'), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

test("Remove as co-admin opens its step with focus on it, and Keep as co-admin puts focus back on the opener", async () => {
  await open()
  await press(member('Bea').getByRole('button', { name: 'Remove as co-admin' }))
  expectStep(removeCoAdminSentence('Bea'))
  await press(member('Bea').getByRole('button', { name: 'Keep as co-admin' }))
  expect(document.activeElement).toBe(member('Bea').getByRole('button', { name: 'Remove as co-admin' }))
})

test('Make admin opens its step with focus on it, and Keep the role puts focus back on Make admin', async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Make admin' }))
  expectStep(makeAdminSentence('Cal'))
  await press(member('Cal').getByRole('button', { name: 'Keep the role' }))
  expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Make admin' }))
})

test('Remove from group opens its step with focus on it, and Keep puts focus back on Remove from group', async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Remove from group' }))
  expectStep(removeMemberSentence('Cal'))
  await press(member('Cal').getByRole('button', { name: 'Keep Cal' }))
  expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Remove from group' }))
})

test('Step down opens its step with focus on it, and Stay a co-admin puts focus back on Step down', async () => {
  await open({ self: 'bea' })
  await press(member('Bea').getByRole('button', { name: 'Step down' }))
  expectStep(STEP_DOWN_SENTENCE)
  await press(member('Bea').getByRole('button', { name: 'Stay a co-admin' }))
  expect(document.activeElement).toBe(member('Bea').getByRole('button', { name: 'Step down' }))
})

test('a failed Make co-admin puts focus back on Make co-admin', async () => {
  await open()
  world.answer.addCoAdmin = { status: 500 }
  await held('addCoAdmin', member('Cal').getByRole('button', { name: 'Make co-admin' }))
  expect(member('Cal').getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Make co-admin' }))
})

test("a landed Make co-admin puts focus on that member's Remove as co-admin", async () => {
  await open()
  await held('addCoAdmin', member('Cal').getByRole('button', { name: 'Make co-admin' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Remove as co-admin' })),
  )
})

test("a failed Remove as co-admin puts focus back on that row's Remove as co-admin", async () => {
  await open()
  await press(member('Bea').getByRole('button', { name: 'Remove as co-admin' }))
  world.answer.removeCoAdmin = { status: 500 }
  const step = screen.getByRole('group', { name: removeCoAdminSentence('Bea') })
  await held('removeCoAdmin', within(step).getByRole('button', { name: 'Remove as co-admin' }))
  expect(member('Bea').getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(member('Bea').getByRole('button', { name: 'Remove as co-admin' }))
})

test("a landed Remove as co-admin puts focus on that member's Make co-admin", async () => {
  await open()
  await press(member('Bea').getByRole('button', { name: 'Remove as co-admin' }))
  const step = screen.getByRole('group', { name: removeCoAdminSentence('Bea') })
  await held('removeCoAdmin', within(step).getByRole('button', { name: 'Remove as co-admin' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(member('Bea').getByRole('button', { name: 'Make co-admin' })),
  )
})

test('a failed Step down puts focus back on Step down', async () => {
  await open({ self: 'bea' })
  await press(member('Bea').getByRole('button', { name: 'Step down' }))
  world.answer.removeCoAdmin = { status: 500 }
  const step = screen.getByRole('group', { name: STEP_DOWN_SENTENCE })
  await held('removeCoAdmin', within(step).getByRole('button', { name: 'Step down' }))
  expect(document.activeElement).toBe(member('Bea').getByRole('button', { name: 'Step down' }))
})

test("a landed Step down puts focus on Members' heading", async () => {
  await open({ self: 'bea' })
  await press(member('Bea').getByRole('button', { name: 'Step down' }))
  const step = screen.getByRole('group', { name: STEP_DOWN_SENTENCE })
  await held('removeCoAdmin', within(step).getByRole('button', { name: 'Step down' }))
  await waitFor(() => expect(member('Bea').queryByRole('button', { name: 'Step down' })).toBeNull())
  expectHeading('Members')
})

test('a failed Make admin puts focus back on Make admin', async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Make admin' }))
  world.answer.handOver = { status: 500 }
  await held('handOver', button('Make Cal the admin'))
  expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Make admin' }))
})

test("a landed Make admin puts focus on Members' heading", async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Make admin' }))
  await held('handOver', button('Make Cal the admin'))
  expectHeading('Members')
})

test('a failed Remove from group puts focus back on Remove from group', async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Remove from group' }))
  world.answer.removeMember = { status: 500 }
  const step = screen.getByRole('group', { name: removeMemberSentence('Cal') })
  await held('removeMember', within(step).getByRole('button', { name: 'Remove from group' }))
  expect(document.activeElement).toBe(member('Cal').getByRole('button', { name: 'Remove from group' }))
})

test("a landed Remove from group puts focus on Members' heading", async () => {
  await open()
  await press(member('Cal').getByRole('button', { name: 'Remove from group' }))
  const step = screen.getByRole('group', { name: removeMemberSentence('Cal') })
  await held('removeMember', within(step).getByRole('button', { name: 'Remove from group' }))
  await waitFor(() => expect(screen.queryByText('Cal')).toBeNull())
  expectHeading('Members')
})

test('a person who moved on while Make co-admin waited keeps their place', async () => {
  await open()
  world.answer.addCoAdmin = { status: 500 }
  const elsewhere = crumb()
  await held('addCoAdmin', member('Cal').getByRole('button', { name: 'Make co-admin' }), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Requests to join
// ---------------------------------------------------------------------------

test('Approve opens its step with focus on it, and Not yet puts focus back on Approve', async () => {
  await open()
  await press(request('Zoe').getByRole('button', { name: 'Approve' }))
  expectStep(approveSentence('Zoe', 'The Lees'))
  await press(request('Zoe').getByRole('button', { name: 'Not yet' }))
  expect(document.activeElement).toBe(request('Zoe').getByRole('button', { name: 'Approve' }))
})

test("a failed Approve puts focus back on that request's Approve", async () => {
  await open()
  await press(request('Zoe').getByRole('button', { name: 'Approve' }))
  world.answer.approve = { status: 500 }
  await held('approve', button('Approve Zoe'))
  expect(request('Zoe').getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(request('Zoe').getByRole('button', { name: 'Approve' }))
})

test("a landed Approve puts focus on Requests to join's heading", async () => {
  await open()
  await press(request('Zoe').getByRole('button', { name: 'Approve' }))
  await held('approve', button('Approve Zoe'))
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Requests to join' })).toBeNull())
  expectHeading('Requests to join')
})

test('a failed Decline puts focus back on Decline', async () => {
  await open()
  world.answer.decline = { status: 500 }
  await held('decline', request('Zoe').getByRole('button', { name: 'Decline' }))
  expect(document.activeElement).toBe(request('Zoe').getByRole('button', { name: 'Decline' }))
})

test("a landed Decline puts focus on Requests to join's heading", async () => {
  await open()
  await held('decline', request('Zoe').getByRole('button', { name: 'Decline' }))
  expectHeading('Requests to join')
})

// Not a row of the kickoff's table: Refresh the list goes as it is pressed,
// and the row may go with the re-read, so the rule's last rung — the
// section's heading.
test("Refresh the list after a refused request puts focus on Requests to join's heading", async () => {
  await open()
  world.answer.decline = { status: 500 }
  await held('decline', request('Zoe').getByRole('button', { name: 'Decline' }))
  await press(button('Refresh the list'))
  expect(screen.queryByRole('button', { name: 'Refresh the list' })).toBeNull()
  expectHeading('Requests to join')
})

// ---------------------------------------------------------------------------
// Invite people: the link
// ---------------------------------------------------------------------------

test('a failed Make a link puts focus back on Make a link', async () => {
  await open()
  world.answer.makeLink = { status: 500 }
  await held('makeLink', button('Make a link'))
  expect(document.activeElement).toBe(button('Make a link'))
})

test('a landed Make a link puts focus on Share the link', async () => {
  await open()
  await held('makeLink', button('Make a link'))
  expect(document.activeElement).toBe(button('Share the link'))
})

test('Make a new link opens its step with focus on it, and Keep this link puts focus back on the opener', async () => {
  await open({ link: LINK })
  await press(button('Make a new link'))
  expectStep(REPLACE_LINK_SENTENCE)
  await press(button('Keep this link'))
  expect(document.activeElement).toBe(button('Make a new link'))
})

test('a failed Make a new link puts focus back on Make a new link', async () => {
  await open({ link: LINK })
  await press(button('Make a new link'))
  world.answer.makeLink = { status: 500 }
  const step = screen.getByRole('group', { name: REPLACE_LINK_SENTENCE })
  await held('makeLink', within(step).getByRole('button', { name: 'Make a new link' }))
  expect(document.activeElement).toBe(button('Make a new link'))
})

test('a landed Make a new link puts focus on Share the link', async () => {
  await open({ link: LINK })
  await press(button('Make a new link'))
  const step = screen.getByRole('group', { name: REPLACE_LINK_SENTENCE })
  await held('makeLink', within(step).getByRole('button', { name: 'Make a new link' }))
  expect(document.activeElement).toBe(button('Share the link'))
})

test('Turn off the link opens its step with focus on it, and Keep the link puts focus back on the opener', async () => {
  await open({ link: LINK })
  await press(button('Turn off the link'))
  expectStep(TURN_OFF_LINK_SENTENCE)
  await press(button('Keep the link'))
  expect(document.activeElement).toBe(button('Turn off the link'))
})

test('a failed Turn off the link puts focus back on Turn off the link', async () => {
  await open({ link: LINK })
  await press(button('Turn off the link'))
  world.answer.revokeLink = { status: 500 }
  const step = screen.getByRole('group', { name: TURN_OFF_LINK_SENTENCE })
  await held('revokeLink', within(step).getByRole('button', { name: 'Turn off the link' }))
  expect(document.activeElement).toBe(button('Turn off the link'))
})

test('a landed Turn off the link puts focus on Make a link', async () => {
  await open({ link: LINK })
  await press(button('Turn off the link'))
  const step = screen.getByRole('group', { name: TURN_OFF_LINK_SENTENCE })
  await held('revokeLink', within(step).getByRole('button', { name: 'Turn off the link' }))
  await waitFor(() => expect(document.activeElement).toBe(button('Make a link')))
})

test("a landed Turn off the link whose re-read fails puts focus on the link's Try again", async () => {
  await open({ link: LINK })
  await press(button('Turn off the link'))
  const step = screen.getByRole('group', { name: TURN_OFF_LINK_SENTENCE })
  // The DELETE lands (204); the re-read it starts is held, then refused.
  world.hold.readLink = gate()
  world.answer.readLink = { status: 500 }
  await held('revokeLink', within(step).getByRole('button', { name: 'Turn off the link' }))
  expect(world.link).toBeNull()
  dropFocusToBody()
  expect(document.activeElement).toBe(document.body)
  await act(async () => world.hold.readLink!.release())
  await settle()
  const invite = within(screen.getByRole('region', { name: 'Invite people' }))
  expect(invite.getByRole('alert').textContent).toContain("The group's link couldn't be loaded just now.")
  await waitFor(() => expect(document.activeElement).toBe(invite.getByRole('button', { name: 'Try again' })))
})

// ---------------------------------------------------------------------------
// Invite people: by email
// ---------------------------------------------------------------------------

const address = () => screen.getByLabelText('Email address')

function typeAddress(value = 'cousin@example.com') {
  fireEvent.change(address(), { target: { value } })
}

test('Send invitation refused with a 422 on the address puts focus on the address field', async () => {
  await open()
  typeAddress()
  world.answer.invite = invalid('destination')
  await held('invite', button('Send invitation'))
  expect(document.activeElement).toBe(address())
})

test('Send invitation refused with a 429 puts focus back on Send invitation', async () => {
  await open()
  typeAddress()
  world.answer.invite = { status: 429 }
  await held('invite', button('Send invitation'))
  expect(document.activeElement).toBe(button('Send invitation'))
})

test('a failed Send invitation puts focus back on Send invitation', async () => {
  await open()
  typeAddress()
  world.answer.invite = { status: 500 }
  await held('invite', button('Send invitation'))
  expect(document.activeElement).toBe(button('Send invitation'))
})

test('a landed Send invitation puts focus on the cleared address field', async () => {
  await open()
  typeAddress()
  await held('invite', button('Send invitation'))
  expect((address() as HTMLInputElement).value).toBe('')
  expect(document.activeElement).toBe(address())
})

test('a landed Revoke puts focus on the address field', async () => {
  await open()
  const pending = within(screen.getByRole('list', { name: 'Pending invitations' }))
  await held('revokeInvitation', pending.getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(screen.queryByText(/dora@example\.com/)).toBeNull())
  expect(document.activeElement).toBe(address())
})

// Not a row of the kickoff's table: a failed Revoke says nothing (found,
// reported, not fixed — it would need new words), and the row stays, so the
// rule's second rung — the control pressed, enabled again.
test('a failed Revoke puts focus back on that Revoke, the row still there', async () => {
  await open()
  world.answer.revokeInvitation = { status: 500 }
  const pending = within(screen.getByRole('list', { name: 'Pending invitations' }))
  await held('revokeInvitation', pending.getByRole('button', { name: 'Revoke' }))
  const revoke = within(screen.getByRole('list', { name: 'Pending invitations' })).getByRole('button', {
    name: 'Revoke',
  })
  expect(screen.getByText(/dora@example\.com/)).toBeTruthy()
  expect((revoke as HTMLButtonElement).disabled).toBe(false)
  expect(document.activeElement).toBe(revoke)
})

test('a person who moved on while Send invitation waited keeps their place', async () => {
  await open()
  typeAddress()
  const elsewhere = crumb()
  await held('invite', button('Send invitation'), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// Leave this group
// ---------------------------------------------------------------------------

test('Leave this group opens its step with focus on it, and Stay puts focus back on Leave this group', async () => {
  await open()
  await press(button('Leave this group'))
  expectStep(leaveSentence('The Lees'))
  await press(button('Stay'))
  expect(document.activeElement).toBe(button('Leave this group'))
})

test('a failed Leave puts focus back on Leave this group', async () => {
  await open()
  await press(button('Leave this group'))
  world.answer.leave = { status: 409, body: { detail: { code: 'hand_over_first' } } }
  await held('leave', button('Leave'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(button('Leave this group'))
})

test('a landed Leave navigates to your groups', async () => {
  await open()
  await press(button('Leave this group'))
  await held('leave', button('Leave'))
  await waitFor(() => expect(where).toBe('/groups'))
})
