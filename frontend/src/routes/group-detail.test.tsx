// CK-78 pins on a group's page (Groups 3a; decisions/2026-10-23-joining-a-group-and-co-admins.md
// §5–§7; the classification is CK-75's, one line per check in the
// api-reference's Groups router). The value under test: THE ROLE COMES FROM
// THE GROUP BODY'S `caller_role` AND FROM NOTHING ELSE — the role matrix
// puts every row action exactly where the kickoff's table says, for the
// admin, a co-admin and a member, and nowhere else, with `admin_person_id`
// pointing at someone who is not the caller in every seat but the admin's,
// so no id comparison could produce these results; the hint is the admin's
// and rename the organisers'; Make co-admin is one click and every other
// act a second step whose first click posts nothing and whose keep button
// does nothing; Step down and Make admin re-render the page as a member's;
// each refusal lands on its row from its code, nothing re-read; leaving
// takes its own step, lands on /groups on a 204, and keeps the 409's line in
// its card; a 404 on either read is one not-found screen; a failed read can
// be retried; and nothing identifying — no address, no membership id, no
// person id — is ever on the page.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { networkErrors } from '../lib/formErrors'
import type { ShareDevice } from '../lib/groupJoining'
import {
  CO_ADMIN_HINT,
  LEAVE_COME_BACK,
  LEAVE_EXPLAINER,
  LEAVE_ONLY_MEMBER,
  STEP_DOWN_SENTENCE,
} from '../lib/groups'
import { GroupDetail } from './GroupDetail'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'

// Distinctive ids, so a leak would be found anywhere in the page's markup.
const MEMBERSHIP = {
  ada: 'mem-ada-1111',
  bea: 'mem-bea-2222',
  eve: 'mem-eve-3333',
  cal: 'mem-cal-4444',
}
const PERSON_ADA = 'person-ada-7777'
const PERSON_BEA = 'person-bea-8888'
const ALL_IDS = [...Object.values(MEMBERSHIP), PERSON_ADA, PERSON_BEA, 'g-1']

// CK-79's fixtures. The link's URL and token are distinctive so a leak
// would be found anywhere in the markup; the URL is what the server sends,
// and the page must never render it.
const LINK_TOKEN = 'tok-link-secret-9999'
const LINK_URL = `https://app.example/groups/join#token=${LINK_TOKEN}`
const LINK_EXPIRES = '2026-11-03T18:00:00+00:00'
const NEW_LINK_URL = 'https://app.example/groups/join#token=tok-link-newer-8888'
const NEW_LINK_EXPIRES = '2026-11-10T18:00:00+00:00'
const REQUEST_ZOE = { id: 'req-zoe-5555', display_name: 'Zoe', created_at: '2026-10-26T15:00:00+00:00' }
const REQUEST_YAN = { id: 'req-yan-4444', display_name: 'Yan Lee', created_at: '2026-10-27T15:00:00+00:00' }
const PENDING_DORA = {
  id: 'inv-dora-6666',
  channel: 'EMAIL',
  destination: 'dora@example.com',
  created_at: '2026-10-27T15:00:00+00:00',
  expires_at: '2099-01-02T18:00:00+00:00',
}
const PENDING_OLD = {
  id: 'inv-old-7777',
  channel: 'EMAIL',
  destination: 'old@example.com',
  created_at: '2026-10-01T15:00:00+00:00',
  expires_at: '2026-10-08T15:00:00+00:00',
}

// No URL and no token, anywhere in the markup — the link never leaves its
// call (lib/groupJoining.ts).
function expectNoLinkOrToken(container: HTMLElement) {
  const markup = container.innerHTML
  expect(markup).not.toContain(LINK_TOKEN)
  expect(markup).not.toContain('tok-link-newer')
  expect(markup).not.toContain('#token=')
  expect(markup).not.toMatch(/https?:\/\//)
}

type Who = keyof typeof MEMBERSHIP
type Role = 'admin' | 'co_admin' | 'member'

const NAMES: Record<Who, string> = { ada: 'Ada', bea: 'Bea', eve: 'Eve', cal: 'Cal' }

// A stateful fake of the group's routes: the roles move when an act lands,
// so a re-read shows what the server would.
function makeServer(self: Who, init: Partial<Record<Who, Role>> = {}) {
  const state = {
    roles: { ada: 'admin', bea: 'co_admin', eve: 'co_admin', cal: 'member', ...init } as Record<
      Who,
      Role
    >,
    present: { ada: true, bea: true, eve: true, cal: true } as Record<Who, boolean>,
    name: 'The Lees',
    adminPersonId: PERSON_ADA as string | null,
  }
  const order: Who[] = ['ada', 'bea', 'eve', 'cal']
  const live = () => order.filter((who) => state.present[who])
  return {
    state,
    group: () => ({
      id: 'g-1',
      name: state.name,
      group_type: 'HOUSEHOLD',
      admin_person_id: state.adminPersonId,
      member_count: live().length,
      caller_role: state.roles[self],
      created_at: '2026-10-27T12:00:00+00:00',
      updated_at: null,
    }),
    members: () => ({
      members: live().map((who) => ({
        membership_id: MEMBERSHIP[who],
        display_name: NAMES[who],
        role: state.roles[who],
        is_self: who === self,
      })),
    }),
    who: (membershipId: string) => order.find((w) => MEMBERSHIP[w] === membershipId) as Who,
  }
}

type Responder = (init: RequestInit | undefined, url: string) => Response

interface Overrides {
  getGroup?: Responder
  getMembers?: Responder
  addCoAdmin?: Responder
  removeCoAdmin?: Responder
  removeMember?: Responder
  handOver?: Responder
  leave?: Responder
  rename?: Responder
  // CK-79's routes: the page reads the link for every member and the
  // requests and invitations for organisers, so the fake answers them — by
  // default with no link, no request and no invitation, which is the page
  // CK-78 pinned.
  getLink?: Responder
  makeLink?: Responder
  revokeLink?: Responder
  getRequests?: Responder
  approve?: Responder
  decline?: Responder
  getInvitations?: Responder
  invite?: Responder
  revokeInvitation?: Responder
}

const NO_LINK = { url: null, expires_at: null }

function stubServer(server: ReturnType<typeof makeServer>, over: Overrides = {}) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const respond = (r: Responder | undefined, fallback: Responder) =>
      Promise.resolve((r ?? fallback)(init, path))
    if (method === 'GET' && path === '/groups/g-1') {
      return respond(over.getGroup, () => json(200, server.group()))
    }
    if (method === 'GET' && path === '/groups/g-1/members') {
      return respond(over.getMembers, () => json(200, server.members()))
    }
    if (method === 'PATCH' && path === '/groups/g-1') {
      return respond(over.rename, (i) => {
        server.state.name = (JSON.parse(String(i?.body)) as { name: string }).name.trim()
        return json(200, server.group())
      })
    }
    if (method === 'POST' && path === '/groups/g-1/co-admins') {
      return respond(over.addCoAdmin, (i) => {
        const who = server.who((JSON.parse(String(i?.body)) as { membership_id: string }).membership_id)
        server.state.roles[who] = 'co_admin'
        return json(201, {})
      })
    }
    const coAdmin = path.match(/^\/groups\/g-1\/co-admins\/(.+)$/)
    if (method === 'DELETE' && coAdmin) {
      return respond(over.removeCoAdmin, () => {
        server.state.roles[server.who(coAdmin[1])] = 'member'
        return new Response(null, { status: 204 })
      })
    }
    const member = path.match(/^\/groups\/g-1\/members\/(.+)$/)
    if (method === 'DELETE' && member) {
      return respond(over.removeMember, () => {
        server.state.present[server.who(member[1])] = false
        return new Response(null, { status: 204 })
      })
    }
    if (method === 'POST' && path === '/groups/g-1/hand-over') {
      return respond(over.handOver, (i) => {
        const who = server.who((JSON.parse(String(i?.body)) as { membership_id: string }).membership_id)
        for (const w of Object.keys(server.state.roles) as Who[]) {
          if (server.state.roles[w] === 'admin') server.state.roles[w] = 'member'
        }
        server.state.roles[who] = 'admin'
        server.state.adminPersonId = who === 'bea' ? PERSON_BEA : 'person-other'
        return json(200, server.group())
      })
    }
    if (method === 'POST' && path === '/groups/g-1/leave') {
      return respond(over.leave, () => new Response(null, { status: 204 }))
    }
    if (method === 'GET' && path === '/groups/g-1/link') {
      return respond(over.getLink, () => json(200, NO_LINK))
    }
    if (method === 'POST' && path === '/groups/g-1/link') {
      return respond(over.makeLink, () => json(500, {}))
    }
    if (method === 'DELETE' && path === '/groups/g-1/link') {
      return respond(over.revokeLink, () => new Response(null, { status: 204 }))
    }
    if (method === 'GET' && path === '/groups/g-1/join-requests') {
      return respond(over.getRequests, () => json(200, { join_requests: [] }))
    }
    if (method === 'POST' && /^\/groups\/g-1\/join-requests\/[^/]+\/approve$/.test(path)) {
      return respond(over.approve, () => json(500, {}))
    }
    if (method === 'POST' && /^\/groups\/g-1\/join-requests\/[^/]+\/decline$/.test(path)) {
      return respond(over.decline, () => json(500, {}))
    }
    if (method === 'GET' && path === '/groups/g-1/invitations') {
      return respond(over.getInvitations, () => json(200, { pending: [] }))
    }
    if (method === 'POST' && path === '/groups/g-1/invitations') {
      return respond(over.invite, () => json(500, {}))
    }
    if (method === 'DELETE' && /^\/groups\/g-1\/invitations\/[^/]+$/.test(path)) {
      return respond(over.revokeInvitation, () => new Response(null, { status: 204 }))
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function calls(mock: ReturnType<typeof vi.fn>, method: string, path: string | RegExp) {
  return mock.mock.calls.filter(([url, init]) => {
    const m = (init as RequestInit | undefined)?.method ?? 'GET'
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    return m === method && (typeof path === 'string' ? p === path : path.test(p))
  }) as unknown as [string, RequestInit | undefined][]
}

const GET_GROUP = (mock: ReturnType<typeof vi.fn>) => calls(mock, 'GET', '/groups/g-1').length
const GET_MEMBERS = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'GET', '/groups/g-1/members').length
const WRITES = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')
    .length

// The page reads the profile zone since CK-79 (the day a request was made,
// the day the link and an invitation stop working), so it renders inside a
// signed-in context — a shape change to this helper, nothing the CK-78 pins
// assert. The person's ids are never the group's: the role still comes from
// `caller_role` alone.
const viewer: Person = {
  id: 'person-viewer-0000',
  display_name: 'Viewer',
  email: 'viewer@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-viewer-0000',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person: viewer,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

function renderPage(device?: ShareDevice) {
  return render(
    <MemoryRouter initialEntries={['/groups/g-1']}>
      <AuthContext.Provider value={signedIn}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail device={device} />} />
          <Route path="/groups" element={<p data-testid="groups-list">your groups</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function loaded() {
  return screen.findByRole('list', { name: 'Members' })
}

function rowOf(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Members' })
  const row = within(list)
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.member-name')?.textContent === name)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

function requestRow(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Requests to join' })
  const row = within(list)
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.member-name')?.textContent === name)
  if (!row) throw new Error(`no request row for ${name}`)
  return row
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function buttonsIn(element: HTMLElement): string[] {
  return within(element)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '')
}

const FORBIDDEN = /\bsafe|secure|private|forever|backed up|\bevents?\b|claim/i

// ---------------------------------------------------------------------------
// The role matrix.
// ---------------------------------------------------------------------------

test('the admin: the reserved and delegable acts on every row the table names, nothing on their own row, the hint, rename', async () => {
  stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The Lees')
  expect(screen.getByText('4 members')).toBeTruthy()
  expect(screen.getByText("You're the admin.")).toBeTruthy()
  expect(screen.queryByText("You're a co-admin.")).toBeNull()
  expect(screen.getByText(CO_ADMIN_HINT)).toBeTruthy()
  expect(screen.getByLabelText('Group name')).toBeTruthy()

  expect(buttonsIn(rowOf('Ada'))).toEqual([])
  expect(buttonsIn(rowOf('Bea'))).toEqual(['Remove as co-admin', 'Make admin', 'Remove from group'])
  expect(buttonsIn(rowOf('Eve'))).toEqual(['Remove as co-admin', 'Make admin', 'Remove from group'])
  expect(buttonsIn(rowOf('Cal'))).toEqual(['Make co-admin', 'Make admin', 'Remove from group'])
  expect(screen.queryByRole('button', { name: 'Step down' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Leave this group' })).toBeTruthy()
})

test('a co-admin: Remove from group on a member’s row, Step down on their own, nothing on the admin’s or another co-admin’s; rename and no hint', async () => {
  stubServer(makeServer('bea'))
  renderPage()
  await loaded()
  expect(screen.getByText("You're a co-admin.")).toBeTruthy()
  expect(screen.queryByText("You're the admin.")).toBeNull()
  expect(screen.queryByText(CO_ADMIN_HINT)).toBeNull()
  expect(screen.getByLabelText('Group name')).toBeTruthy()

  expect(buttonsIn(rowOf('Ada'))).toEqual([])
  expect(buttonsIn(rowOf('Bea'))).toEqual(['Step down'])
  expect(buttonsIn(rowOf('Eve'))).toEqual([])
  expect(buttonsIn(rowOf('Cal'))).toEqual(['Remove from group'])
  for (const reserved of ['Make co-admin', 'Make admin', 'Remove as co-admin']) {
    expect(screen.queryByRole('button', { name: reserved })).toBeNull()
  }
  expect(screen.getByRole('button', { name: 'Leave this group' })).toBeTruthy()
})

test('a member: no act on any row, no rename, no hint, no role line — the leave card alone', async () => {
  stubServer(makeServer('cal'))
  renderPage()
  await loaded()
  for (const name of ['Ada', 'Bea', 'Eve', 'Cal']) expect(buttonsIn(rowOf(name))).toEqual([])
  expect(screen.queryByLabelText('Group name')).toBeNull()
  expect(screen.queryByText(CO_ADMIN_HINT)).toBeNull()
  expect(screen.queryByText("You're the admin.")).toBeNull()
  expect(screen.queryByText("You're a co-admin.")).toBeNull()
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Leave this group'])
})

test('an unknown role gates closed: nothing but leaving, whatever admin_person_id says', async () => {
  const server = makeServer('ada')
  stubServer(server, { getGroup: () => json(200, { ...server.group(), caller_role: 'owner' }) })
  renderPage()
  await loaded()
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Leave this group'])
  expect(screen.queryByLabelText('Group name')).toBeNull()
  expect(screen.queryByText(CO_ADMIN_HINT)).toBeNull()
})

test('each row: the initials aria-hidden beside the name, (you) on the caller’s own row, Admin or Co-admin beside the name', async () => {
  stubServer(makeServer('bea'))
  renderPage()
  await loaded()
  const bea = rowOf('Bea')
  const badge = bea.querySelector('.member-initials')
  expect(badge?.textContent).toBe('B')
  expect(badge?.getAttribute('aria-hidden')).toBe('true')
  expect(bea.textContent).toContain('Bea (you) · Co-admin')
  expect(rowOf('Ada').textContent).toContain('Ada · Admin')
  expect(rowOf('Eve').textContent).toContain('Eve · Co-admin')
  // An ordinary member's line: the initials, the name, and nothing beside it.
  expect(rowOf('Cal').querySelector('p')?.textContent).toBe('C Cal')
  for (const name of ['Ada', 'Eve', 'Cal']) expect(rowOf(name).textContent).not.toContain('(you)')
})

test('a group with no admin: nobody’s row says Admin and the reserved acts render for nobody; a co-admin still organises', async () => {
  const server = makeServer('bea', { ada: 'member' })
  server.state.adminPersonId = null
  stubServer(server)
  renderPage()
  await loaded()
  const list = screen.getByRole('list', { name: 'Members' })
  expect(list.textContent).not.toMatch(/Admin(?!.)|· Admin/)
  for (const name of ['Ada', 'Bea', 'Eve', 'Cal']) {
    expect(rowOf(name).querySelector('.member-role')?.textContent ?? '').not.toBe('Admin')
  }
  for (const reserved of ['Make co-admin', 'Make admin', 'Remove as co-admin']) {
    expect(screen.queryByRole('button', { name: reserved })).toBeNull()
  }
  // The ordinary members are still a co-admin's to remove, and Bea can step down.
  expect(buttonsIn(rowOf('Ada'))).toEqual(['Remove from group'])
  expect(buttonsIn(rowOf('Cal'))).toEqual(['Remove from group'])
  expect(buttonsIn(rowOf('Bea'))).toEqual(['Step down'])
  expect(document.body.textContent).not.toMatch(FORBIDDEN)
})

// MOVED AT CK-79, with its reason: until CK-79 this pinned that the page
// offered nothing of 3b OR 3c — no button that invites, shares, copies or
// handles a request. CK-79 IS 3b: Make a link, Share the link, Send
// invitation and the request queue's acts are now the page's on purpose
// (their own pins are below). What stays pinned is 3c's absence: no
// gathering, no places, no "shared with" or "left out" anywhere on the page,
// in a button or in its text, and still one link — back to the list.
test('the page offers nothing of 3c: its one link is back to the list, and nothing names a gathering or a place', async () => {
  stubServer(makeServer('ada'), {
    getLink: () => json(200, { url: LINK_URL, expires_at: LINK_EXPIRES }),
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
  })
  renderPage()
  await loaded()
  await screen.findByRole('button', { name: 'Share the link' })
  await screen.findByRole('list', { name: 'Requests to join' })
  expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Back to your groups'])
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  for (const name of screen.getAllByRole('button').map((b) => b.textContent ?? '')) {
    expect(name).not.toMatch(/gathering|place|shared with|left out/i)
  }
  // No section of 3c's: no heading names a gathering or a place. (The leave
  // card's CK-78 sentence — gatherings you're already part of don't change —
  // is about leaving, not a list of them.)
  for (const heading of screen.getAllByRole('heading').map((h) => h.textContent ?? '')) {
    expect(heading).not.toMatch(/gathering|place/i)
  }
  expect(document.body.textContent).not.toMatch(/shared with|left out/i)
})

// ---------------------------------------------------------------------------
// Rename.
// ---------------------------------------------------------------------------

test('rename: the field holds the name, Save waits for a change, a blank goes out as "" and the server’s 422 lands on it, a success re-reads the group', async () => {
  const server = makeServer('bea')
  let refuse = true
  const mock = stubServer(server, {
    rename: (init) => {
      if (refuse) {
        return json(422, {
          detail: [{ loc: ['body', 'name'], msg: 'Value error, name cannot be empty', type: 'value_error' }],
        })
      }
      server.state.name = (JSON.parse(String(init?.body)) as { name: string }).name.trim()
      return json(200, server.group())
    },
  })
  renderPage()
  await loaded()
  const input = screen.getByLabelText('Group name') as HTMLInputElement
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  expect(input.value).toBe('The Lees')
  expect(input.maxLength).toBe(200)
  expect(save.disabled).toBe(true)

  fireEvent.change(input, { target: { value: 'The Lees' } })
  expect(save.disabled).toBe(true)
  fireEvent.change(input, { target: { value: '' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('Name cannot be empty')
  expect(input.getAttribute('aria-describedby')).toBe('error-name')
  const [, firstInit] = calls(mock, 'PATCH', '/groups/g-1')[0]
  expect(JSON.parse(String(firstInit?.body))).toEqual({ name: '' })

  refuse = false
  const groupReadsBefore = GET_GROUP(mock)
  fireEvent.change(input, { target: { value: 'The Lee Family' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The Lee Family'),
  )
  await waitFor(() => expect(GET_GROUP(mock)).toBe(groupReadsBefore + 1))
  expect(JSON.parse(String(calls(mock, 'PATCH', '/groups/g-1')[1][1]?.body))).toEqual({
    name: 'The Lee Family',
  })
  expect((screen.getByLabelText('Group name') as HTMLInputElement).value).toBe('The Lee Family')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
})

// ---------------------------------------------------------------------------
// The acts.
// ---------------------------------------------------------------------------

test('Make co-admin: one click posts {"membership_id"} once, then re-reads the members and not the group', async () => {
  const mock = stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  expect(GET_GROUP(mock)).toBe(1)
  expect(GET_MEMBERS(mock)).toBe(1)
  fireEvent.click(within(rowOf('Cal')).getByRole('button', { name: 'Make co-admin' }))
  await waitFor(() => expect(rowOf('Cal').textContent).toContain('Cal · Co-admin'))
  const posts = calls(mock, 'POST', '/groups/g-1/co-admins')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ membership_id: MEMBERSHIP.cal })
  expect(GET_MEMBERS(mock)).toBe(2)
  expect(GET_GROUP(mock)).toBe(1)
  expect(buttonsIn(rowOf('Cal'))).toEqual(['Remove as co-admin', 'Make admin', 'Remove from group'])
})

test('Remove as co-admin: the first click asks, Keep as co-admin does nothing, the confirm deletes once and re-reads the members', async () => {
  const mock = stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Remove as co-admin' }))
  const step = screen.getByRole('group', { name: 'Remove Bea as co-admin' })
  expect(within(step).getByText(
    'Bea will no longer be able to rename the group, invite people, approve requests to join or remove members.',
  )).toBeTruthy()
  expect(WRITES(mock)).toBe(0)

  fireEvent.click(within(step).getByRole('button', { name: 'Keep as co-admin' }))
  expect(screen.queryByRole('group', { name: 'Remove Bea as co-admin' })).toBeNull()
  expect(WRITES(mock)).toBe(0)
  expect(buttonsIn(rowOf('Bea'))).toEqual(['Remove as co-admin', 'Make admin', 'Remove from group'])

  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Remove as co-admin' }))
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Remove Bea as co-admin' })).getByRole('button', {
      name: 'Remove as co-admin',
    }),
  )
  await waitFor(() => expect(rowOf('Bea').querySelector('.member-role')).toBeNull())
  const deletes = calls(mock, 'DELETE', /\/co-admins\//)
  expect(deletes).toHaveLength(1)
  expect(deletes[0][0]).toMatch(new RegExp(`/groups/g-1/co-admins/${MEMBERSHIP.bea}$`))
  expect(WRITES(mock)).toBe(1)
  expect(GET_MEMBERS(mock)).toBe(2)
  expect(GET_GROUP(mock)).toBe(1)
})

test('Step down: the first click asks, Stay a co-admin does nothing, the confirm deletes once and the page re-renders as a member’s', async () => {
  const mock = stubServer(makeServer('bea'))
  renderPage()
  await loaded()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Step down' }))
  const step = screen.getByRole('group', { name: 'Step down as co-admin' })
  expect(within(step).getByText(STEP_DOWN_SENTENCE)).toBeTruthy()
  expect(STEP_DOWN_SENTENCE).toBe(
    "You'll no longer be able to rename the group, invite people, approve requests to join or remove members. Only the admin can make you a co-admin again.",
  )
  fireEvent.click(within(step).getByRole('button', { name: 'Stay a co-admin' }))
  expect(WRITES(mock)).toBe(0)
  expect(screen.queryByRole('group', { name: 'Step down as co-admin' })).toBeNull()

  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Step down' }))
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Step down as co-admin' })).getByRole('button', {
      name: 'Step down',
    }),
  )
  await waitFor(() => expect(screen.queryByText("You're a co-admin.")).toBeNull())
  await waitFor(() => expect(screen.queryByLabelText('Group name')).toBeNull())
  const deletes = calls(mock, 'DELETE', /\/co-admins\//)
  expect(deletes).toHaveLength(1)
  expect(deletes[0][0]).toMatch(new RegExp(`/co-admins/${MEMBERSHIP.bea}$`))
  expect(GET_GROUP(mock)).toBe(2)
  expect(GET_MEMBERS(mock)).toBe(2)
  for (const name of ['Ada', 'Bea', 'Eve', 'Cal']) expect(buttonsIn(rowOf(name))).toEqual([])
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Leave this group'])
})

test('Make admin: the first click asks, Keep the role does nothing, the confirm hands over once and the page re-renders as a member’s', async () => {
  const mock = stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Make admin' }))
  const step = screen.getByRole('group', { name: 'Make Bea the admin' })
  expect(within(step).getByText(
    "Bea will be the admin at once, and you'll be a member. Only Bea can make you the admin again.",
  )).toBeTruthy()
  fireEvent.click(within(step).getByRole('button', { name: 'Keep the role' }))
  expect(WRITES(mock)).toBe(0)
  expect(screen.queryByRole('group', { name: 'Make Bea the admin' })).toBeNull()

  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Make admin' }))
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Make Bea the admin' })).getByRole('button', {
      name: 'Make Bea the admin',
    }),
  )
  await waitFor(() => expect(screen.queryByText("You're the admin.")).toBeNull())
  await waitFor(() => expect(rowOf('Bea').textContent).toContain('Bea · Admin'))
  const posts = calls(mock, 'POST', '/groups/g-1/hand-over')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ membership_id: MEMBERSHIP.bea })
  expect(GET_GROUP(mock)).toBe(2)
  expect(GET_MEMBERS(mock)).toBe(2)
  expect(rowOf('Ada').textContent).toContain('Ada (you)')
  expect(rowOf('Ada').querySelector('.member-role')).toBeNull()
  expect(screen.queryByText(CO_ADMIN_HINT)).toBeNull()
  expect(screen.queryByLabelText('Group name')).toBeNull()
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Leave this group'])
})

for (const seat of ['ada', 'bea'] as const) {
  test(`Remove from group (as ${seat === 'ada' ? 'the admin' : 'a co-admin'}): the first click asks, Keep Cal does nothing, the confirm deletes once and the row goes on the re-read`, async () => {
    const mock = stubServer(makeServer(seat))
    renderPage()
    await loaded()
    fireEvent.click(within(rowOf('Cal')).getByRole('button', { name: 'Remove from group' }))
    const step = screen.getByRole('group', { name: 'Remove Cal from the group' })
    expect(within(step).getByText(
      "Cal will no longer be a member of this group. Gatherings they're already part of don't change.",
    )).toBeTruthy()
    fireEvent.click(within(step).getByRole('button', { name: 'Keep Cal' }))
    expect(WRITES(mock)).toBe(0)
    expect(screen.queryByRole('group', { name: 'Remove Cal from the group' })).toBeNull()

    fireEvent.click(within(rowOf('Cal')).getByRole('button', { name: 'Remove from group' }))
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Cal from the group' })).getByRole('button', {
        name: 'Remove from group',
      }),
    )
    await waitFor(() => expect(() => rowOf('Cal')).toThrow())
    const deletes = calls(mock, 'DELETE', /\/members\//)
    expect(deletes).toHaveLength(1)
    expect(deletes[0][0]).toMatch(new RegExp(`/groups/g-1/members/${MEMBERSHIP.cal}$`))
    expect(GET_MEMBERS(mock)).toBe(2)
    expect(GET_GROUP(mock)).toBe(2)
    await waitFor(() => expect(screen.getByText('3 members')).toBeTruthy())
  })
}

test('one step at a time on the whole page: opening another row’s step, or the leave step, closes the first', async () => {
  stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  fireEvent.click(within(rowOf('Cal')).getByRole('button', { name: 'Remove from group' }))
  expect(screen.getByRole('group', { name: 'Remove Cal from the group' })).toBeTruthy()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Make admin' }))
  expect(screen.queryByRole('group', { name: 'Remove Cal from the group' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Make Bea the admin' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Leave this group' }))
  expect(screen.queryByRole('group', { name: 'Make Bea the admin' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Leave The Lees' })).toBeTruthy()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Remove as co-admin' }))
  expect(screen.queryByRole('group', { name: 'Leave The Lees' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Leave this group' })).toBeTruthy()
})

// ---------------------------------------------------------------------------
// Refusals: on the row they name, from the code, nothing re-read.
// ---------------------------------------------------------------------------

function refusal422(code: string): Response {
  return json(422, {
    detail: [{ loc: ['body', 'membership_id'], msg: SERVER_WORDING, type: 'value_error', code }],
  })
}

const REFUSALS: {
  title: string
  seat: Who
  row: string
  over: Overrides
  open: string
  confirm?: string
  expected: string
}[] = [
  {
    title: 'not_a_member on Make co-admin',
    seat: 'ada',
    row: 'Cal',
    over: { addCoAdmin: () => refusal422('not_a_member') },
    open: 'Make co-admin',
    expected: "Cal isn't in this group any more — refresh the list.",
  },
  {
    title: 'is_admin on Make co-admin',
    seat: 'ada',
    row: 'Cal',
    over: { addCoAdmin: () => refusal422('is_admin') },
    open: 'Make co-admin',
    expected: 'Cal is the admin.',
  },
  {
    title: 'already_co_admin on Make co-admin',
    seat: 'ada',
    row: 'Cal',
    over: { addCoAdmin: () => refusal422('already_co_admin') },
    open: 'Make co-admin',
    expected: 'Cal is already a co-admin — refresh the list.',
  },
  {
    title: 'account_deleted on Make co-admin',
    seat: 'ada',
    row: 'Cal',
    over: { addCoAdmin: () => refusal422('account_deleted') },
    open: 'Make co-admin',
    expected: 'Cal has deleted their account — refresh the list.',
  },
  {
    title: 'is_admin on Make admin',
    seat: 'ada',
    row: 'Bea',
    over: { handOver: () => refusal422('is_admin') },
    open: 'Make admin',
    confirm: 'Make Bea the admin',
    expected: "That's you — you're already the admin.",
  },
  {
    title: 'account_deleted on Make admin',
    seat: 'ada',
    row: 'Bea',
    over: { handOver: () => refusal422('account_deleted') },
    open: 'Make admin',
    confirm: 'Make Bea the admin',
    expected: 'Bea has deleted their account — refresh the list.',
  },
  {
    title: 'not_a_member on Make admin',
    seat: 'ada',
    row: 'Cal',
    over: { handOver: () => refusal422('not_a_member') },
    open: 'Make admin',
    confirm: 'Make Cal the admin',
    expected: "Cal isn't in this group any more — refresh the list.",
  },
  {
    title: 'a 404 on Remove from group',
    seat: 'bea',
    row: 'Cal',
    over: { removeMember: () => json(404, { detail: 'No such member.' }) },
    open: 'Remove from group',
    confirm: 'Remove from group',
    expected: "You can't make that change any more — refresh the page.",
  },
  {
    title: 'a 404 on Remove as co-admin',
    seat: 'ada',
    row: 'Bea',
    over: { removeCoAdmin: () => json(404, { detail: 'No such member.' }) },
    open: 'Remove as co-admin',
    confirm: 'Remove as co-admin',
    expected: "You can't make that change any more — refresh the page.",
  },
  {
    title: 'a 404 on Step down',
    seat: 'bea',
    row: 'Bea',
    over: { removeCoAdmin: () => json(404, { detail: 'No such group.' }) },
    open: 'Step down',
    confirm: 'Step down',
    expected: "You can't make that change any more — refresh the page.",
  },
  {
    title: 'a network failure on Make co-admin',
    seat: 'ada',
    row: 'Cal',
    over: {
      addCoAdmin: () => {
        throw new TypeError('network')
      },
    },
    open: 'Make co-admin',
    expected: networkErrors().form[0],
  },
  {
    title: 'a 500 on Remove from group',
    seat: 'ada',
    row: 'Cal',
    over: { removeMember: () => json(500, { detail: SERVER_WORDING }) },
    open: 'Remove from group',
    confirm: 'Remove from group',
    expected: 'Something went wrong. Nothing changed — try again.',
  },
]

for (const refusal of REFUSALS) {
  test(`${refusal.title}: the line lands on ${refusal.row}’s row, from the code, and nothing is re-read`, async () => {
    const mock = stubServer(makeServer(refusal.seat), refusal.over)
    renderPage()
    await loaded()
    fireEvent.click(within(rowOf(refusal.row)).getByRole('button', { name: refusal.open }))
    if (refusal.confirm) {
      const step = screen.getByRole('group')
      fireEvent.click(within(step).getByRole('button', { name: refusal.confirm }))
    }
    const alert = await within(rowOf(refusal.row)).findByRole('alert')
    expect(alert.textContent).toBe(`⚠ ${refusal.expected}`)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.body.textContent).not.toContain(SERVER_WORDING)
    expect(GET_GROUP(mock)).toBe(1)
    expect(GET_MEMBERS(mock)).toBe(1)
    // The step closed; the row is there with its controls, ready to try again.
    expect(screen.queryByRole('group')).toBeNull()
  })
}

// ---------------------------------------------------------------------------
// Leaving.
// ---------------------------------------------------------------------------

function leaveCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Leave this group' })
}

test('leaving: its own card for every member, a second step that names the group, Stay does nothing, and a 204 lands on /groups', async () => {
  const mock = stubServer(makeServer('cal'))
  renderPage()
  await loaded()
  const card = leaveCard()
  expect(within(card).getByRole('heading', { level: 2 }).textContent).toBe('Leave this group')
  expect(within(card).getByText(LEAVE_EXPLAINER)).toBeTruthy()
  expect(within(card).getByText(LEAVE_COME_BACK)).toBeTruthy()
  expect(within(card).queryByText(LEAVE_ONLY_MEMBER)).toBeNull()
  // Not inside the rename form, and not type-to-confirm.
  expect(card.closest('form')).toBeNull()
  expect(within(card).queryByRole('textbox')).toBeNull()

  fireEvent.click(within(card).getByRole('button', { name: 'Leave this group' }))
  const step = within(card).getByRole('group', { name: 'Leave The Lees' })
  expect(within(step).getByText('Leave The Lees?')).toBeTruthy()
  expect(WRITES(mock)).toBe(0)
  fireEvent.click(within(step).getByRole('button', { name: 'Stay' }))
  expect(WRITES(mock)).toBe(0)
  expect(within(card).queryByRole('group')).toBeNull()

  fireEvent.click(within(card).getByRole('button', { name: 'Leave this group' }))
  fireEvent.click(within(within(card).getByRole('group')).getByRole('button', { name: 'Leave' }))
  expect(await screen.findByTestId('groups-list')).toBeTruthy()
  expect(calls(mock, 'POST', '/groups/g-1/leave')).toHaveLength(1)
  expect(WRITES(mock)).toBe(1)
})

test('leaving as the admin with other members: the 409 hand_over_first line in the card, nothing navigated, nothing re-read', async () => {
  const mock = stubServer(makeServer('ada'), {
    leave: () => json(409, { detail: { code: 'hand_over_first', message: SERVER_WORDING } }),
  })
  renderPage()
  await loaded()
  fireEvent.click(screen.getByRole('button', { name: 'Leave this group' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Leave The Lees' })).getByRole('button', { name: 'Leave' }))
  const alert = await within(leaveCard()).findByRole('alert')
  expect(alert.textContent).toBe(
    "⚠ You're the admin, so someone else needs the role before you leave. Choose Make admin beside a member's name.",
  )
  expect(screen.queryByTestId('groups-list')).toBeNull()
  expect(document.body.textContent).not.toContain(SERVER_WORDING)
  expect(GET_GROUP(mock)).toBe(1)
  expect(GET_MEMBERS(mock)).toBe(1)
  // The page is as it was: the admin's controls and the leave button.
  expect(screen.getByText("You're the admin.")).toBeTruthy()
  expect(within(leaveCard()).getByRole('button', { name: 'Leave this group' })).toBeTruthy()
})

test('the only member: the card says the group will be left with nobody in it, and promises no way back', async () => {
  const server = makeServer('ada')
  server.state.present = { ada: true, bea: false, eve: false, cal: false }
  stubServer(server)
  renderPage()
  await loaded()
  expect(screen.getByText('1 member')).toBeTruthy()
  const card = leaveCard()
  expect(within(card).getByText(LEAVE_EXPLAINER)).toBeTruthy()
  expect(within(card).getByText(LEAVE_ONLY_MEMBER)).toBeTruthy()
  expect(within(card).queryByText(LEAVE_COME_BACK)).toBeNull()
})

// ---------------------------------------------------------------------------
// Not found, and a failed read.
// ---------------------------------------------------------------------------

async function notFoundMarkup(over: Overrides): Promise<string> {
  stubServer(makeServer('ada'), over)
  const view = renderPage()
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  const markup = view.container.innerHTML
  cleanup()
  vi.unstubAllGlobals()
  return markup
}

test('a 404 on either read is the one not-found screen, identical for both — and a path 422 is the same screen', async () => {
  const groupMissing = await notFoundMarkup({ getGroup: () => json(404, { detail: 'No such group.' }) })
  const membersMissing = await notFoundMarkup({
    getMembers: () => json(404, { detail: 'No such group.' }),
  })
  const notAnId = await notFoundMarkup({
    getGroup: () => json(422, { detail: [] }),
    getMembers: () => json(422, { detail: [] }),
  })
  expect(membersMissing).toBe(groupMissing)
  expect(notAnId).toBe(groupMissing)

  stubServer(makeServer('ada'), { getGroup: () => json(404, { detail: 'No such group.' }) })
  renderPage()
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(screen.getByText("There's no group to show at this address.")).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  expect(screen.queryByRole('button')).toBeNull()
})

test('a failed read says so and can be retried: Try again re-reads both once per press, and a read that succeeds renders the page', async () => {
  const server = makeServer('ada')
  let fail = true
  const mock = stubServer(server, {
    getMembers: () => (fail ? json(500, {}) : json(200, server.members())),
  })
  renderPage()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Something went wrong loading this group.')
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  expect(GET_GROUP(mock)).toBe(1)
  expect(GET_MEMBERS(mock)).toBe(1)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(GET_MEMBERS(mock)).toBe(2))
  expect(GET_GROUP(mock)).toBe(2)
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong loading this group.')

  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await loaded()
  expect(GET_GROUP(mock)).toBe(3)
  expect(GET_MEMBERS(mock)).toBe(3)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

// ---------------------------------------------------------------------------
// Nothing identifying on screen.
// ---------------------------------------------------------------------------

// NARROWED AT CK-79, with its reason: until CK-79 this pinned NO address
// anywhere on the page. Since CK-79 an organiser's Invite people section
// lists the pending emailed invitations by the address an organiser typed
// — to organisers alone, the one place an address shows (CK-25's
// precedent; the joining record's DATA-HANDLING). So the address rule now
// holds everywhere OUTSIDE that list — the member list, the request queue,
// every other line — and a member's page holds no address at all (below,
// and in the CK-79 tests). Every id rule is unchanged, the request and
// invitation ids added to it, and every step is still opened in turn —
// CK-79's three among them.
test('nothing identifying on screen: no address outside an organiser’s pending list, and no membership, person, group, request or invitation id anywhere in the markup — every step open in turn', async () => {
  stubServer(makeServer('ada'), {
    getLink: () => json(200, { url: LINK_URL, expires_at: LINK_EXPIRES }),
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
    getInvitations: () => json(200, { pending: [PENDING_DORA] }),
  })
  const view = renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Pending invitations' })
  await screen.findByRole('list', { name: 'Requests to join' })
  const check = () => {
    const pendingList = screen.getByRole('list', { name: 'Pending invitations' })
    // The one place an address shows — and only the address typed.
    expect(pendingList.textContent).toContain(PENDING_DORA.destination)
    const outside = (document.body.textContent ?? '').replace(pendingList.textContent ?? '', '')
    expect(outside).not.toContain('@')
    for (const id of [...ALL_IDS, REQUEST_ZOE.id, PENDING_DORA.id]) {
      expect(view.container.innerHTML).not.toContain(id)
    }
    expectNoLinkOrToken(view.container)
    expect(document.body.textContent).not.toMatch(FORBIDDEN)
  }
  check()
  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  check()
  fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
  check()
  fireEvent.click(screen.getByRole('button', { name: 'Keep this link' }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn off the link' }))
  check()
  for (const [row, open] of [
    ['Bea', 'Remove as co-admin'],
    ['Cal', 'Make admin'],
    ['Eve', 'Remove from group'],
  ] as const) {
    fireEvent.click(within(rowOf(row)).getByRole('button', { name: open }))
    check()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Leave this group' }))
  check()
  cleanup()
  vi.unstubAllGlobals()

  // A co-admin's seat, with the step-down step open.
  stubServer(makeServer('bea'))
  const coAdminView = renderPage()
  await loaded()
  fireEvent.click(within(rowOf('Bea')).getByRole('button', { name: 'Step down' }))
  expect(document.body.textContent).not.toContain('@')
  for (const id of ALL_IDS) expect(coAdminView.container.innerHTML).not.toContain(id)
})

// ===========================================================================
// CK-79 — joining on the surface: requests to join, invite people, the link
// that never leaves its call, and invite by email
// (decisions/2026-10-23-joining-a-group-and-co-admins.md §2, §3; Steven's
// answers of 2026-10-27 — approving takes a second step, declining one
// click, nobody is told).
// ===========================================================================

const GET_REQUESTS = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'GET', '/groups/g-1/join-requests').length
const GET_LINK = (mock: ReturnType<typeof vi.fn>) => calls(mock, 'GET', '/groups/g-1/link').length
const GET_INVITATIONS = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'GET', '/groups/g-1/invitations').length

const REQUESTS_HINT_TEXT =
  "People who ask with the group's link wait here. They aren't told if you decline, and they can ask again with the link."
const LINK_HINT_TEXT = 'Anyone you send it to can ask to join. An admin or co-admin approves each request.'
const NO_LINK_MEMBER_TEXT = "There's no link to share right now. An admin or co-admin can make one."

function withLink(url = LINK_URL, expires = LINK_EXPIRES): Responder {
  return () => json(200, { url, expires_at: expires })
}

// ---------------------------------------------------------------------------
// Requests to join.
// ---------------------------------------------------------------------------

test('requests to join, by seat: the admin and a co-admin read the queue — initials, name, the day asked, Approve and Decline — and a member reads none and asks for none', async () => {
  for (const seat of ['ada', 'bea'] as const) {
    const mock = stubServer(makeServer(seat), {
      getRequests: () => json(200, { join_requests: [REQUEST_ZOE, REQUEST_YAN] }),
    })
    renderPage()
    await loaded()
    const requests = await screen.findByRole('list', { name: 'Requests to join' })
    expect(region('Requests to join').querySelector('h2')?.textContent).toBe('Requests to join')
    expect(within(region('Requests to join')).getByText(REQUESTS_HINT_TEXT)).toBeTruthy()
    const rows = requests.querySelectorAll(':scope > li')
    expect(rows).toHaveLength(2)
    // The day asked, in the profile zone; nothing else about the person.
    expect(requestRow('Zoe').querySelector('p')?.textContent).toBe('Z Zoe · asked Oct 26')
    expect(requestRow('Yan Lee').querySelector('p')?.textContent).toBe('YL Yan Lee · asked Oct 27')
    expect(requestRow('Zoe').querySelector('.member-initials')?.getAttribute('aria-hidden')).toBe('true')
    expect(buttonsIn(requestRow('Zoe'))).toEqual(['Approve', 'Decline'])
    expect(GET_REQUESTS(mock)).toBe(1)
    cleanup()
    vi.unstubAllGlobals()
  }

  const mock = stubServer(makeServer('cal'), {
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
  })
  renderPage()
  await loaded()
  await screen.findByText(NO_LINK_MEMBER_TEXT)
  expect(screen.queryByRole('heading', { name: 'Requests to join' })).toBeNull()
  expect(screen.queryByText('Zoe')).toBeNull()
  // The organiser reads are the group's 404 for a member, and never asked.
  expect(GET_REQUESTS(mock)).toBe(0)
  expect(GET_INVITATIONS(mock)).toBe(0)
})

test('requests to join, empty: "No one is waiting to join." beneath the hint', async () => {
  stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  expect(await within(region('Requests to join')).findByText('No one is waiting to join.')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Requests to join' })).toBeNull()
})

test('Approve takes a second step: the first click posts nothing, Not yet does nothing, the confirm posts once and re-reads the requests, the members and the group', async () => {
  const server = makeServer('ada')
  let approved = false
  const mock = stubServer(server, {
    getRequests: () => json(200, { join_requests: approved ? [] : [REQUEST_ZOE] }),
    getMembers: () => {
      const body = server.members()
      if (approved) {
        body.members.push({ membership_id: 'mem-zoe-9999', display_name: 'Zoe', role: 'member', is_self: false })
      }
      return json(200, body)
    },
    getGroup: () => json(200, { ...server.group(), member_count: approved ? 5 : 4 }),
    approve: () => {
      approved = true
      return json(200, {
        id: REQUEST_ZOE.id,
        display_name: 'Zoe',
        created_at: REQUEST_ZOE.created_at,
        outcome: 'approved',
        decided_at: '2026-10-27T16:00:00+00:00',
      })
    },
  })
  renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Requests to join' })
  const groupsBefore = GET_GROUP(mock)
  const membersBefore = GET_MEMBERS(mock)
  const requestsBefore = GET_REQUESTS(mock)

  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  const step = screen.getByRole('group', { name: 'Approve Zoe' })
  expect(within(step).getByText(
    "Zoe will join The Lees and see its members. The group's upcoming gatherings will include them.",
  )).toBeTruthy()
  expect(buttonsIn(step)).toEqual(['Approve Zoe', 'Not yet'])
  expect(WRITES(mock)).toBe(0)

  fireEvent.click(within(step).getByRole('button', { name: 'Not yet' }))
  expect(screen.queryByRole('group', { name: 'Approve Zoe' })).toBeNull()
  expect(buttonsIn(requestRow('Zoe'))).toEqual(['Approve', 'Decline'])
  expect(WRITES(mock)).toBe(0)

  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Approve Zoe' })).getByRole('button', { name: 'Approve Zoe' }))
  await within(region('Requests to join')).findByText('No one is waiting to join.')
  await waitFor(() => expect(rowOf('Zoe')).toBeTruthy())
  expect(await screen.findByText('5 members')).toBeTruthy()

  const posts = calls(mock, 'POST', /\/join-requests\//)
  expect(posts).toHaveLength(1)
  expect(posts[0][0]).toMatch(/\/groups\/g-1\/join-requests\/req-zoe-5555\/approve$/)
  expect(posts[0][1]?.body).toBeUndefined()
  expect(GET_REQUESTS(mock)).toBe(requestsBefore + 1)
  expect(GET_MEMBERS(mock)).toBe(membersBefore + 1)
  expect(GET_GROUP(mock)).toBe(groupsBefore + 1)
})

test('Decline is one click: it posts once, re-reads the requests and neither the members nor the group, and asks nothing first', async () => {
  let declined = false
  const mock = stubServer(makeServer('bea'), {
    getRequests: () => json(200, { join_requests: declined ? [] : [REQUEST_ZOE] }),
    decline: () => {
      declined = true
      return json(200, {
        id: REQUEST_ZOE.id,
        display_name: 'Zoe',
        created_at: REQUEST_ZOE.created_at,
        outcome: 'declined',
        decided_at: '2026-10-27T16:00:00+00:00',
      })
    },
  })
  renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Requests to join' })
  const groupsBefore = GET_GROUP(mock)
  const membersBefore = GET_MEMBERS(mock)

  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Decline' }))
  expect(screen.queryByRole('group')).toBeNull()
  await within(region('Requests to join')).findByText('No one is waiting to join.')
  const posts = calls(mock, 'POST', /\/join-requests\//)
  expect(posts).toHaveLength(1)
  expect(posts[0][0]).toMatch(/\/join-requests\/req-zoe-5555\/decline$/)
  expect(GET_MEMBERS(mock)).toBe(membersBefore)
  expect(GET_GROUP(mock)).toBe(groupsBefore)
})

const DECISION_REFUSALS: { title: string; act: 'Approve' | 'Decline'; respond: Responder; expected: string }[] = [
  {
    title: 'already approved',
    act: 'Approve',
    respond: () =>
      json(409, { detail: { code: 'already_decided', outcome: 'approved', message: SERVER_WORDING } }),
    expected: 'Someone already approved this request — refresh the list.',
  },
  {
    title: 'already declined',
    act: 'Decline',
    respond: () =>
      json(409, { detail: { code: 'already_decided', outcome: 'declined', message: SERVER_WORDING } }),
    expected: 'Someone already declined this request — refresh the list.',
  },
  {
    title: 'a 404',
    act: 'Decline',
    respond: () => json(404, { detail: SERVER_WORDING }),
    expected: "This request isn't here any more — refresh the list.",
  },
  {
    title: 'a 500',
    act: 'Approve',
    respond: () => json(500, { detail: SERVER_WORDING }),
    expected: 'Something went wrong. Nothing changed — try again.',
  },
]

for (const refusal of DECISION_REFUSALS) {
  test(`${refusal.title} on ${refusal.act}: the line lands on Zoe’s row from the code, nothing re-read, and Refresh the list re-reads the requests`, async () => {
    const mock = stubServer(makeServer('ada'), {
      getRequests: () => json(200, { join_requests: [REQUEST_ZOE, REQUEST_YAN] }),
      approve: refusal.respond,
      decline: refusal.respond,
    })
    renderPage()
    await loaded()
    await screen.findByRole('list', { name: 'Requests to join' })
    const requestsBefore = GET_REQUESTS(mock)
    const membersBefore = GET_MEMBERS(mock)
    fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: refusal.act }))
    if (refusal.act === 'Approve') {
      fireEvent.click(within(screen.getByRole('group', { name: 'Approve Zoe' })).getByRole('button', { name: 'Approve Zoe' }))
    }
    const alert = await within(requestRow('Zoe')).findByRole('alert')
    expect(alert.textContent).toContain(refusal.expected)
    expect(document.body.textContent).not.toContain(SERVER_WORDING)
    expect(within(requestRow('Yan Lee')).queryByRole('alert')).toBeNull()
    expect(GET_REQUESTS(mock)).toBe(requestsBefore)
    expect(GET_MEMBERS(mock)).toBe(membersBefore)

    fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Refresh the list' }))
    await waitFor(() => expect(GET_REQUESTS(mock)).toBe(requestsBefore + 1))
    await waitFor(() => expect(within(requestRow('Zoe')).queryByRole('alert')).toBeNull())
  })
}

test('a network failure on Decline: the app’s own line on the row', async () => {
  stubServer(makeServer('ada'), {
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
    decline: () => {
      throw new TypeError('Failed to fetch')
    },
  })
  renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Requests to join' })
  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Decline' }))
  const alert = await within(requestRow('Zoe')).findByRole('alert')
  expect(alert.textContent).toContain(networkErrors().form[0])
})

// ---------------------------------------------------------------------------
// Invite people: the link, by seat and by link state.
// ---------------------------------------------------------------------------

test('no live link: the admin and a co-admin read the hint and Make a link; a member reads why there is nothing to share, and has nothing to press', async () => {
  for (const seat of ['ada', 'bea'] as const) {
    stubServer(makeServer(seat))
    renderPage()
    await loaded()
    const invite = region('Invite people')
    expect(await within(invite).findByRole('button', { name: 'Make a link' })).toBeTruthy()
    expect(within(invite).getByText(LINK_HINT_TEXT)).toBeTruthy()
    expect(within(invite).queryByRole('button', { name: 'Share the link' })).toBeNull()
    expect(within(invite).queryByText(NO_LINK_MEMBER_TEXT)).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
  }

  stubServer(makeServer('cal'))
  renderPage()
  await loaded()
  const invite = region('Invite people')
  expect(await within(invite).findByText(NO_LINK_MEMBER_TEXT)).toBeTruthy()
  expect(buttonsIn(invite)).toEqual([])
  expect(within(invite).queryByText(LINK_HINT_TEXT)).toBeNull()
  expect(within(invite).queryByRole('heading', { name: 'Invite by email' })).toBeNull()
})

test('a live link: everyone reads Share the link, the day it stops working and the hint; organisers also get Make a new link, Turn off the link and Invite by email; a member gets none of those', async () => {
  for (const seat of ['ada', 'bea'] as const) {
    stubServer(makeServer(seat), { getLink: withLink() })
    renderPage()
    await loaded()
    const invite = region('Invite people')
    await within(invite).findByRole('button', { name: 'Share the link' })
    expect(within(invite).getByText('Works until Nov 3')).toBeTruthy()
    expect(within(invite).getByText(LINK_HINT_TEXT)).toBeTruthy()
    expect(buttonsIn(invite).slice(0, 3)).toEqual(['Share the link', 'Make a new link', 'Turn off the link'])
    expect(within(invite).getByRole('heading', { name: 'Invite by email' })).toBeTruthy()
    expect(within(invite).queryByRole('button', { name: 'Make a link' })).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
  }

  const mock = stubServer(makeServer('cal'), { getLink: withLink() })
  const view = renderPage()
  await loaded()
  const invite = region('Invite people')
  await within(invite).findByRole('button', { name: 'Share the link' })
  expect(buttonsIn(invite)).toEqual(['Share the link'])
  expect(within(invite).getByText('Works until Nov 3')).toBeTruthy()
  expect(within(invite).getByText(LINK_HINT_TEXT)).toBeTruthy()
  expect(within(invite).queryByRole('heading', { name: 'Invite by email' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Waiting on' })).toBeNull()
  expect(GET_LINK(mock)).toBe(1)
  // A member's page holds no address at all, and no URL or token.
  expect(document.body.textContent).not.toContain('@')
  expectNoLinkOrToken(view.container)
})

test('Make a link: one click posts once with no body, and the new link renders — Share the link and the day it stops working — with no URL anywhere', async () => {
  const mock = stubServer(makeServer('ada'), {
    makeLink: () => json(201, { url: LINK_URL, expires_at: LINK_EXPIRES }),
  })
  const view = renderPage()
  await loaded()
  fireEvent.click(await within(region('Invite people')).findByRole('button', { name: 'Make a link' }))
  await within(region('Invite people')).findByRole('button', { name: 'Share the link' })
  expect(within(region('Invite people')).getByText('Works until Nov 3')).toBeTruthy()
  const posts = calls(mock, 'POST', '/groups/g-1/link')
  expect(posts).toHaveLength(1)
  expect(posts[0][1]?.body).toBeUndefined()
  expectNoLinkOrToken(view.container)
})

test('Make a new link: the first click asks with its sentence, Keep this link does nothing, the confirm posts once and the new day renders', async () => {
  const mock = stubServer(makeServer('bea'), {
    getLink: withLink(),
    makeLink: () => json(201, { url: NEW_LINK_URL, expires_at: NEW_LINK_EXPIRES }),
  })
  const view = renderPage()
  await loaded()
  fireEvent.click(await screen.findByRole('button', { name: 'Make a new link' }))
  let step = screen.getByRole('group', { name: 'Make a new link' })
  expect(within(step).getByText(
    "The current link will stop working, and anyone who hasn't used it yet will need the new one.",
  )).toBeTruthy()
  expect(buttonsIn(step)).toEqual(['Make a new link', 'Keep this link'])
  expect(WRITES(mock)).toBe(0)
  fireEvent.click(within(step).getByRole('button', { name: 'Keep this link' }))
  expect(screen.queryByRole('group', { name: 'Make a new link' })).toBeNull()
  expect(WRITES(mock)).toBe(0)

  fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
  step = screen.getByRole('group', { name: 'Make a new link' })
  fireEvent.click(within(step).getByRole('button', { name: 'Make a new link' }))
  expect(await within(region('Invite people')).findByText('Works until Nov 10')).toBeTruthy()
  expect(calls(mock, 'POST', '/groups/g-1/link')).toHaveLength(1)
  expect(screen.queryByRole('group', { name: 'Make a new link' })).toBeNull()
  expectNoLinkOrToken(view.container)
})

test('Turn off the link: the first click asks with its sentence, Keep the link does nothing, the confirm deletes once and the re-read leaves an organiser Make a link', async () => {
  let live = true
  const mock = stubServer(makeServer('ada'), {
    getLink: () => json(200, live ? { url: LINK_URL, expires_at: LINK_EXPIRES } : NO_LINK),
    revokeLink: () => {
      live = false
      return new Response(null, { status: 204 })
    },
  })
  renderPage()
  await loaded()
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off the link' }))
  let step = screen.getByRole('group', { name: 'Turn off the link' })
  expect(within(step).getByText(
    'The link will stop working. Requests already made stay in Requests to join.',
  )).toBeTruthy()
  expect(buttonsIn(step)).toEqual(['Turn off the link', 'Keep the link'])
  fireEvent.click(within(step).getByRole('button', { name: 'Keep the link' }))
  expect(WRITES(mock)).toBe(0)

  fireEvent.click(screen.getByRole('button', { name: 'Turn off the link' }))
  step = screen.getByRole('group', { name: 'Turn off the link' })
  fireEvent.click(within(step).getByRole('button', { name: 'Turn off the link' }))
  await within(region('Invite people')).findByRole('button', { name: 'Make a link' })
  expect(calls(mock, 'DELETE', '/groups/g-1/link')).toHaveLength(1)
  expect(GET_LINK(mock)).toBe(2)
  expect(screen.queryByRole('button', { name: 'Share the link' })).toBeNull()
})

test('a refused link act lands in the section from its code: withdrawn_meanwhile, a 404, a network failure', async () => {
  for (const [respond, expected] of [
    [() => json(409, { detail: { code: 'withdrawn_meanwhile', message: SERVER_WORDING } }), 'The link changed just now — try again.'],
    [() => json(404, { detail: SERVER_WORDING }), "You can't change this group's link any more — refresh the page."],
    [() => { throw new TypeError('Failed to fetch') }, networkErrors().form[0]],
  ] as [Responder, string][]) {
    stubServer(makeServer('ada'), { makeLink: respond })
    renderPage()
    await loaded()
    fireEvent.click(await screen.findByRole('button', { name: 'Make a link' }))
    const alert = await within(region('Invite people')).findByRole('alert')
    expect(alert.textContent).toContain(expected)
    expect(document.body.textContent).not.toContain(SERVER_WORDING)
    expect(screen.getByRole('button', { name: 'Make a link' })).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()
  }
})

// ---------------------------------------------------------------------------
// Share the link: the URL goes to the device and nowhere else.
// ---------------------------------------------------------------------------

function abortError(): Error {
  const error = new Error('Share canceled')
  error.name = 'AbortError'
  return error
}

const SHARE_CASES: { title: string; device: () => ShareDevice; line: string; viaClipboard: boolean }[] = [
  { title: 'the share sheet takes it', device: () => ({ share: vi.fn(() => Promise.resolve()), writeText: vi.fn(() => Promise.resolve()) }), line: '', viaClipboard: false },
  { title: 'the person closes the share sheet', device: () => ({ share: vi.fn(() => Promise.reject(abortError())), writeText: vi.fn(() => Promise.resolve()) }), line: '', viaClipboard: false },
  { title: 'the share sheet refuses and the clipboard takes it', device: () => ({ share: vi.fn(() => Promise.reject(new Error('NotAllowedError'))), writeText: vi.fn(() => Promise.resolve()) }), line: 'Link copied. Paste it into a message to the people you want to invite.', viaClipboard: true },
  { title: 'no share sheet, the clipboard takes it', device: () => ({ writeText: vi.fn(() => Promise.resolve()) }), line: 'Link copied. Paste it into a message to the people you want to invite.', viaClipboard: true },
  { title: 'the clipboard refuses', device: () => ({ writeText: vi.fn(() => Promise.reject(new Error('denied'))) }), line: "This browser couldn't share or copy the link — try again.", viaClipboard: true },
  { title: 'neither exists', device: () => ({}), line: "This browser can't share or copy the link. Open this page on your phone to share it.", viaClipboard: false },
]

for (const shareCase of SHARE_CASES) {
  test(`Share the link — ${shareCase.title}: the device is called inside the click with the URL, no request is made, and the status region says what happened`, async () => {
    const device = shareCase.device()
    const mock = stubServer(makeServer('cal'), { getLink: withLink() })
    const view = renderPage(device)
    await loaded()
    const share = await within(region('Invite people')).findByRole('button', { name: 'Share the link' })
    const requestsBefore = mock.mock.calls.length
    fireEvent.click(share)
    // Inside the click, before anything is awaited — the share sheet and the
    // clipboard need the click's user activation.
    if (device.share) {
      expect(device.share).toHaveBeenCalledTimes(1)
      expect(device.share).toHaveBeenCalledWith({
        title: 'Join The Lees on CoveyKeep',
        text: 'Join The Lees on CoveyKeep',
        url: LINK_URL,
      })
    } else if (device.writeText) {
      expect(device.writeText).toHaveBeenCalledTimes(1)
    }
    const status = screen.getByRole('status')
    await waitFor(() => expect(status.textContent).toBe(shareCase.line))
    if (shareCase.viaClipboard) {
      expect(device.writeText).toHaveBeenCalledTimes(1)
      expect(device.writeText).toHaveBeenCalledWith(LINK_URL)
    } else if (device.writeText) {
      expect(device.writeText).not.toHaveBeenCalled()
    }
    expect(mock.mock.calls.length).toBe(requestsBefore)
    expectNoLinkOrToken(view.container)
  })
}

// ---------------------------------------------------------------------------
// Invite by email (organisers): CK-25's section on the group.
// ---------------------------------------------------------------------------

test('Invite by email: the form and its hint; Send invitation posts {"channel":"EMAIL","destination"} once, trimmed, clears the field and re-reads Waiting on', async () => {
  let sent = false
  const mock = stubServer(makeServer('bea'), {
    getInvitations: () => json(200, { pending: sent ? [PENDING_DORA] : [] }),
    invite: () => {
      sent = true
      return json(201, PENDING_DORA)
    },
  })
  renderPage()
  await loaded()
  const invite = region('Invite people')
  expect(within(invite).getByText(
    "They'll get an email with a link to join this group. Invitations expire after 7 days.",
  )).toBeTruthy()
  expect(await within(invite).findByText('No pending invitations.')).toBeTruthy()
  const field = within(invite).getByLabelText('Email address') as HTMLInputElement
  const send = within(invite).getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '  dora@example.com ' } })
  expect(send.disabled).toBe(false)
  const before = GET_INVITATIONS(mock)
  fireEvent.click(send)
  const pending = await within(invite).findByRole('list', { name: 'Pending invitations' })
  expect(pending.textContent).toContain('dora@example.com — expires Jan 2')
  expect(field.value).toBe('')
  const posts = calls(mock, 'POST', '/groups/g-1/invitations')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ channel: 'EMAIL', destination: 'dora@example.com' })
  expect(GET_INVITATIONS(mock)).toBe(before + 1)
})

test('Invite by email: the server’s 422 lands on the field, the 429 says so, and nothing re-reads', async () => {
  for (const [respond, check] of [
    [
      () => json(422, { detail: [{ loc: ['body', 'destination'], msg: 'Value error, that is not an email address', type: 'value_error' }] }),
      async () => {
        const error = await screen.findByText('That is not an email address')
        expect(error.closest('[id]')?.id).toBe('error-destination')
        expect(screen.getByLabelText('Email address').getAttribute('aria-describedby')).toBe('error-destination')
      },
    ],
    [
      () => json(422, { detail: [{ loc: ['body', 'channel'], msg: "Value error, text-message invitations aren't available yet", type: 'value_error' }] }),
      async () => {
        const error = await screen.findByText("Text-message invitations aren't available yet")
        expect(error.closest('[id]')?.id).toBe('error-channel')
      },
    ],
    [
      () => json(429, { detail: SERVER_WORDING }),
      async () => {
        const alert = await within(region('Invite people')).findByRole('alert')
        expect(alert.textContent).toContain('Too many invitations just now — try again in a few minutes.')
      },
    ],
  ] as [Responder, () => Promise<void>][]) {
    const mock = stubServer(makeServer('ada'), { invite: respond })
    renderPage()
    await loaded()
    await within(region('Invite people')).findByText('No pending invitations.')
    const before = GET_INVITATIONS(mock)
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'someone@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
    await check()
    expect(document.body.textContent).not.toContain(SERVER_WORDING)
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('someone@example.com')
    expect(GET_INVITATIONS(mock)).toBe(before)
    cleanup()
    vi.unstubAllGlobals()
  }
})

test('Waiting on: each address with the day it expires, an expired one says so, and Revoke is one click that deletes once and re-reads', async () => {
  let revoked = false
  const mock = stubServer(makeServer('ada'), {
    getInvitations: () => json(200, { pending: revoked ? [PENDING_OLD] : [PENDING_DORA, PENDING_OLD] }),
    revokeInvitation: () => {
      revoked = true
      return new Response(null, { status: 204 })
    },
  })
  renderPage()
  await loaded()
  const pending = await screen.findByRole('list', { name: 'Pending invitations' })
  const rows = [...pending.querySelectorAll(':scope > li')].map((li) => li.textContent)
  expect(rows).toEqual(['dora@example.com — expires Jan 2 Revoke', 'old@example.com — expired Revoke'])

  fireEvent.click(within(pending.querySelectorAll(':scope > li')[0] as HTMLElement).getByRole('button', { name: 'Revoke' }))
  await waitFor(() =>
    expect([...screen.getByRole('list', { name: 'Pending invitations' }).querySelectorAll(':scope > li')]).toHaveLength(1),
  )
  const deletes = calls(mock, 'DELETE', /\/groups\/g-1\/invitations\//)
  expect(deletes).toHaveLength(1)
  expect(deletes[0][0]).toMatch(/\/invitations\/inv-dora-6666$/)
})

test('a section read that fails says so in its own card with Try again, and the rest of the page stands', async () => {
  let fail = true
  const mock = stubServer(makeServer('ada'), {
    getRequests: () => (fail ? json(500, {}) : json(200, { join_requests: [REQUEST_ZOE] })),
    getLink: () => (fail ? json(500, {}) : json(200, { url: LINK_URL, expires_at: LINK_EXPIRES })),
    getInvitations: () => (fail ? json(500, {}) : json(200, { pending: [] })),
  })
  renderPage()
  await loaded()
  expect(await within(region('Requests to join')).findByText("The requests to join couldn't be loaded just now.")).toBeTruthy()
  expect(await within(region('Invite people')).findByText("The group's link couldn't be loaded just now.")).toBeTruthy()
  expect(await within(region('Invite people')).findByText("The invitation list couldn't be loaded just now.")).toBeTruthy()
  // The members, the leave card and the rename form are untouched.
  expect(rowOf('Cal')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Leave this group' })).toBeTruthy()

  fail = false
  fireEvent.click(within(region('Requests to join')).getByRole('button', { name: 'Try again' }))
  await screen.findByRole('list', { name: 'Requests to join' })
  const tryAgains = within(region('Invite people')).getAllByRole('button', { name: 'Try again' })
  for (const button of tryAgains) fireEvent.click(button)
  await within(region('Invite people')).findByRole('button', { name: 'Share the link' })
  await within(region('Invite people')).findByText('No pending invitations.')
  expect(GET_REQUESTS(mock)).toBe(2)
  expect(GET_LINK(mock)).toBe(2)
  expect(GET_INVITATIONS(mock)).toBe(2)
})

test('one step at a time on the whole page, with CK-79’s: opening an approval, a link step or a member’s step closes whichever was open', async () => {
  stubServer(makeServer('ada'), {
    getLink: withLink(),
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
  })
  renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Requests to join' })
  await screen.findByRole('button', { name: 'Share the link' })
  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  expect(screen.getByRole('group', { name: 'Approve Zoe' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
  expect(screen.queryByRole('group', { name: 'Approve Zoe' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Make a new link' })).toBeTruthy()
  fireEvent.click(within(rowOf('Cal')).getByRole('button', { name: 'Remove from group' }))
  expect(screen.queryByRole('group', { name: 'Make a new link' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Remove Cal from the group' })).toBeTruthy()
  // The link step's openers are back once its step closed.
  fireEvent.click(screen.getByRole('button', { name: 'Turn off the link' }))
  expect(screen.queryByRole('group', { name: 'Remove Cal from the group' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Turn off the link' })).toBeTruthy()
  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  expect(screen.queryByRole('group', { name: 'Turn off the link' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Make a new link' })).toBeTruthy()
})

test('the new copy names nothing it should not: no ban word, no promise of a notification, and the product name only in the share text', async () => {
  stubServer(makeServer('ada'), {
    getLink: withLink(),
    getRequests: () => json(200, { join_requests: [REQUEST_ZOE] }),
    getInvitations: () => json(200, { pending: [PENDING_DORA] }),
  })
  renderPage()
  await loaded()
  await screen.findByRole('list', { name: 'Requests to join' })
  await screen.findByRole('list', { name: 'Pending invitations' })
  fireEvent.click(within(requestRow('Zoe')).getByRole('button', { name: 'Approve' }))
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(FORBIDDEN)
  expect(text).not.toMatch(/notif|we'll let you know|you'll hear|you will be told/i)
  expect(text).not.toMatch(/CoveyKeep/)
})
