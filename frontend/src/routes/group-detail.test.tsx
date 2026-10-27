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
import { networkErrors } from '../lib/formErrors'
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
}

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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/groups/g-1']}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/groups" element={<p data-testid="groups-list">your groups</p>} />
      </Routes>
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

test('the page offers nothing of 3b or 3c: its one link is back to the list, and no button invites, shares or copies', async () => {
  stubServer(makeServer('ada'))
  renderPage()
  await loaded()
  expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Back to your groups'])
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  for (const name of screen.getAllByRole('button').map((b) => b.textContent ?? '')) {
    expect(name).not.toMatch(/invit|share|copy|link|gathering|request/i)
  }
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

test('nothing identifying on screen: no address, and no membership, person or group id anywhere in the markup — every step open in turn', async () => {
  stubServer(makeServer('ada'))
  const view = renderPage()
  await loaded()
  const check = () => {
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('@')
    for (const id of ALL_IDS) expect(view.container.innerHTML).not.toContain(id)
    expect(text).not.toMatch(FORBIDDEN)
  }
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
