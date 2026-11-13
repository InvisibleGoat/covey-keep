// CK-94 — focus after an answer on the forms that create: a gathering
// (/gatherings/new), a group (/groups/new) and a gathering in a group
// (/groups/:id/gatherings/new), through the app's REAL route table with the
// REAL AuthProvider, the create held on a released promise and focus dropped
// to the body while it waits (test-support/focus.ts). The values under test
// (the kickoff's §3, the forms):
// - a 422 puts focus on the first field with an error, in the order the form
//   draws its fields;
// - a 422 on a gathering in a group's list puts focus on that member's
//   checked radio;
// - any other failure, and a 422 with no field on screen, puts focus back on
//   the submit button;
// - a success navigates, and needs nothing;
// - a person who moved elsewhere while it waited keeps their place.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { gate, pressHeld, settle, type Gate } from '../test-support/focus'

const PERSON = {
  id: 'person-ada',
  display_name: 'Ada Test',
  email: 'ada@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-ada',
}

const GROUP = {
  id: 'g-94',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-ada',
  member_count: 3,
  caller_role: 'admin',
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
  cover: null,
}

const MEMBERS = [
  { membership_id: 'mem-ada', display_name: 'Ada Test', role: 'admin', is_self: true },
  { membership_id: 'mem-bea', display_name: 'Bea Test', role: 'member', is_self: false },
  { membership_id: 'mem-dee', display_name: 'Dee Test', role: 'member', is_self: false },
]

interface Answer {
  status: number
  detail?: unknown
}

let createGathering: Answer
let createGroup: Answer
let hold: Gate | undefined
let where = ''

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function field(loc: (string | number)[], code?: string) {
  return { loc: ['body', ...loc], msg: 'Value error, refused', type: 'value_error', ...(code ? { code } : {}) }
}

async function answer(given: Answer, created: unknown): Promise<Response> {
  await hold?.promise
  if (given.status === 201) return json(201, created)
  return json(given.status, { detail: given.detail ?? 'refused' })
}

beforeEach(() => {
  localStorage.clear()
  setToken('token-ada')
  createGathering = { status: 500 }
  createGroup = { status: 500 }
  hold = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const p = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (p === '/auth/me') return json(200, PERSON)
      if (p === '/groups' && method === 'GET') return json(200, { groups: [] })
      if (p === '/gatherings' && method === 'GET') return json(200, { gatherings: [] })
      if (p === '/groups/g-94') return json(200, GROUP)
      if (p === '/groups/g-94/members') return json(200, { members: MEMBERS })
      if (p === '/gatherings' && method === 'POST') return answer(createGathering, { id: 'gath-new' })
      if (p === '/groups' && method === 'POST') return answer(createGroup, { ...GROUP, id: 'g-new' })
      return json(404, { detail: 'Not Found' })
    }),
  )
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

async function open(path: string, heading: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: heading })
  await settle()
}

async function held(control: HTMLElement, movedTo?: HTMLElement) {
  hold = gate()
  await pressHeld(control, hold, movedTo)
  await settle()
}

function fillGathering(type = 'potluck') {
  fireEvent.change(screen.getByLabelText('Type of gathering'), { target: { value: type } })
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Party' } })
  fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-14T18:00' } })
}

const createButton = () => screen.getByRole('button', { name: 'Create gathering' })

// ---------------------------------------------------------------------------
// A gathering
// ---------------------------------------------------------------------------

test("a gathering's 422 on the title puts focus on the title field", async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  createGathering = { status: 422, detail: [field(['title'])] }
  await held(createButton())
  expect(document.activeElement).toBe(screen.getByLabelText('Title'))
})

test("a gathering's 422 on two fields puts focus on the first the form draws", async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  createGathering = {
    status: 422,
    detail: [field(['occurrences', 0, 'map_url']), field(['occurrences', 0, 'ends_at'])],
  }
  await held(createButton())
  expect(document.activeElement).toBe(screen.getByLabelText('Ends (optional)'))
})

test("a memorial's 422 on the decedent's name puts focus on that field", async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering('memorial')
  createGathering = { status: 422, detail: [field(['memorial_decedent_name'])] }
  await held(createButton())
  expect(document.activeElement).toBe(screen.getByLabelText("Decedent's name"))
})

test('a 422 with no field on screen puts focus back on Create gathering', async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  createGathering = { status: 422, detail: [field(['occurrences'])] }
  await held(createButton())
  expect(document.activeElement).toBe(createButton())
})

test('a failed create puts focus back on Create gathering', async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  await held(createButton())
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(createButton())
})

test('a landed create navigates to the gathering', async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  createGathering = { status: 201 }
  await held(createButton())
  await waitFor(() => expect(where).toBe('/gatherings/gath-new'))
})

test('a person who moved on while the create waited keeps their place', async () => {
  await open('/gatherings/new', 'New gathering')
  fillGathering()
  createGathering = { status: 422, detail: [field(['title'])] }
  const elsewhere = screen.getByRole('link', { name: 'Back to your gatherings' })
  await held(createButton(), elsewhere)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// A group
// ---------------------------------------------------------------------------

test("a group's 422 on the name puts focus on the name field", async () => {
  await open('/groups/new', 'New group')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   x' } })
  createGroup = { status: 422, detail: [field(['name'])] }
  await held(screen.getByRole('button', { name: 'Start group' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Name'))
})

test('a failed Start group puts focus back on Start group', async () => {
  await open('/groups/new', 'New group')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'The Lees' } })
  await held(screen.getByRole('button', { name: 'Start group' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start group' }))
})

test('a person who moved on while Start group waited keeps their place', async () => {
  await open('/groups/new', 'New group')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'The Lees' } })
  const elsewhere = screen.getByRole('link', { name: 'Back to your groups' })
  await held(screen.getByRole('button', { name: 'Start group' }), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
})

// ---------------------------------------------------------------------------
// A gathering in a group
// ---------------------------------------------------------------------------

test("a group gathering's list refusal puts focus on that member's checked radio", async () => {
  await open('/groups/g-94/gatherings/new', 'New gathering in The Lees')
  fillGathering()
  fireEvent.click(within(screen.getByRole('group', { name: 'Dee Test' })).getByRole('radio', { name: 'Kept a surprise' }))
  // invited = [Bea], left_out = [Dee]
  createGathering = { status: 422, detail: [field(['left_out', 0], 'not_a_member')] }
  await held(createButton())
  const dee = within(screen.getByRole('group', { name: 'Dee Test' }))
  expect(dee.getByText("Dee Test isn't in this group any more — go back to the group and start again.")).toBeTruthy()
  expect(document.activeElement).toBe(dee.getByRole('radio', { name: 'Kept a surprise' }))
})

test("a group gathering's 422 on a field puts focus on the field before any row", async () => {
  await open('/groups/g-94/gatherings/new', 'New gathering in The Lees')
  fillGathering()
  fireEvent.click(within(screen.getByRole('group', { name: 'Dee Test' })).getByRole('radio', { name: 'Kept a surprise' }))
  createGathering = { status: 422, detail: [field(['left_out', 0], 'not_a_member'), field(['title'])] }
  await held(createButton())
  expect(document.activeElement).toBe(screen.getByLabelText('Title'))
})

test("a group gathering's failed create puts focus back on Create gathering", async () => {
  await open('/groups/g-94/gatherings/new', 'New gathering in The Lees')
  fillGathering()
  await held(createButton())
  expect(document.activeElement).toBe(createButton())
})
