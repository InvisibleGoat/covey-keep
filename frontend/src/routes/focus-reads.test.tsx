// CK-96 — focus after a failed read's Try again, everywhere CK-94 and CK-95
// left one, through the app's REAL route table with the REAL AuthProvider,
// against the fake server in test-support/world96.ts. A Try again press
// removes the button it was made on and the read waits; Chrome drops focus
// to the body, and jsdom does not, so each test drops it by hand while the
// read is held (test-support/focus.ts). The values under test (the kickoff's
// §4, "Every other failed read's Try again"):
// - the read lands → the heading of what it read, or the <h1> of the screen
//   it lands on (a not-found or an empty screen included);
// - it fails again → the new Try again;
// - the menu's in both layouts, its Try again described by its line, which is
//   no alert;
// - a person who moved outside the container while it waited keeps their
//   place, for a failure and for a success: a page's <main>, a section, the
//   menu's nav and the calendar's card.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { gate, pressHeld, settle } from '../test-support/focus'
import { GROUP, resetWorld96, stubWidth, stubWorld96, world96, type Key } from '../test-support/world96'

beforeEach(() => {
  localStorage.clear()
  resetWorld96()
  stubWorld96()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.querySelectorAll('[data-outside]').forEach((node) => node.remove())
})

function open(path: string) {
  setToken('tok-ada')
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

function outside(): HTMLElement {
  const stand = document.createElement('button')
  stand.dataset.outside = ''
  stand.textContent = 'elsewhere'
  document.body.append(stand)
  return stand
}

const main = () => document.querySelector('main') as HTMLElement

// Press the scope's Try again with its read held; `again` keeps it failing.
async function retry(scope: () => HTMLElement, keys: Key[], again: boolean, movedTo?: HTMLElement) {
  const button = await waitFor(() => within(scope()).getByRole('button', { name: 'Try again' }))
  // The app settled first: nothing from the first render lands after the
  // press (the menu's reads, the profile), which re-renders the frame.
  await waitFor(() => expect(world96.inflight).toBe(0))
  await settle()
  const hold = gate()
  for (const key of keys) {
    world96.hold[key] = hold
    if (!again) delete world96.fail[key]
  }
  await pressHeld(button, hold, movedTo)
}

interface Row {
  name: string
  path: string
  fail: Key[]
  scope: () => HTMLElement
  landed: () => HTMLElement
  wide?: boolean
  rail?: boolean
  before?: () => void
}

const heading = (name: string, level?: number) => () => screen.getByRole('heading', { name, level })
const section = (name: string) => () => screen.getByRole('heading', { name }).closest('section') as HTMLElement
const menuNav = () => screen.getByRole('navigation', { name: 'Main' })

const ROWS: Row[] = [
  {
    name: "the menu's, in One list",
    path: '/you',
    fail: ['groups', 'gatherings'],
    wide: true,
    scope: menuNav,
    landed: () => within(menuNav()).getByRole('heading', { name: 'Your groups' }),
  },
  {
    name: "the menu's, on Rail and panel's Home panel",
    path: '/you',
    fail: ['groups', 'gatherings'],
    wide: true,
    rail: true,
    scope: menuNav,
    landed: () => within(menuNav()).getByRole('heading', { name: 'Coming up' }),
  },
  {
    name: "the calendar's month",
    path: '/calendar',
    fail: ['calendar'],
    scope: () => document.querySelector('.cal') as HTMLElement,
    landed: () => within(document.querySelector('.cal') as HTMLElement).getByRole('heading', { level: 3 }),
  },
  {
    name: "a group's calendar",
    path: `/calendar?group=${GROUP.id}`,
    fail: ['group'],
    scope: main,
    landed: heading('Calendar', 1),
  },
  {
    name: 'Your gatherings',
    path: '/gatherings',
    fail: ['gatherings'],
    scope: main,
    landed: heading('Your gatherings', 1),
  },
  {
    name: 'Groups',
    path: '/groups',
    fail: ['groups'],
    scope: main,
    landed: heading('Groups', 1),
  },
  {
    name: "a gathering's page",
    path: '/gatherings/g-1',
    fail: ['detail'],
    scope: main,
    landed: heading('The Party', 1),
  },
  {
    name: "Who it's for",
    path: '/gatherings/g-2',
    fail: ['places'],
    scope: section("Who it's for"),
    landed: heading("Who it's for"),
  },
  {
    name: "a group's page",
    path: `/groups/${GROUP.id}`,
    fail: ['group'],
    scope: main,
    landed: heading(GROUP.name, 1),
  },
  {
    name: "a group's strip",
    path: `/groups/${GROUP.id}`,
    fail: ['strip'],
    scope: () => screen.getByRole('heading', { name: 'Gatherings', level: 2 }).closest('section') as HTMLElement,
    landed: heading('Gatherings', 2),
  },
  {
    name: 'the group gathering form',
    path: `/groups/${GROUP.id}/gatherings/new`,
    fail: ['members'],
    scope: main,
    landed: heading(`New gathering in ${GROUP.name}`, 1),
  },
  {
    name: 'the People page',
    path: `/groups/${GROUP.id}/people`,
    fail: ['members'],
    scope: main,
    landed: heading('People', 1),
  },
  {
    name: 'Requests to join',
    path: `/groups/${GROUP.id}/people`,
    fail: ['requests'],
    scope: section('Requests to join'),
    landed: heading('Requests to join'),
  },
  {
    name: "the group's link",
    path: `/groups/${GROUP.id}/people`,
    fail: ['link'],
    scope: section('Invite people'),
    landed: heading('Invite people'),
  },
  {
    name: 'the pending invitations',
    path: `/groups/${GROUP.id}/people`,
    fail: ['groupInvitations'],
    scope: section('Invite people'),
    landed: heading('Waiting on'),
  },
]

function stage(row: Row) {
  stubWidth(row.wide ?? false)
  if (row.rail) localStorage.setItem('covey-keep:menu-layout', 'rail')
  for (const key of row.fail) world96.fail[key] = { status: 500 }
}

test.each(ROWS.map((row) => [row.name, row] as const))('%s: Try again, the read landing, puts focus on its heading', async (_name, row) => {
  stage(row)
  open(row.path)
  await retry(row.scope, row.fail, false)
  await waitFor(() => expect(document.activeElement).toBe(row.landed()))
  expect(row.landed().getAttribute('tabindex')).toBe('-1')
})

test.each(ROWS.map((row) => [row.name, row] as const))('%s: Try again, failing again, puts focus on the new Try again', async (_name, row) => {
  stage(row)
  open(row.path)
  await retry(row.scope, row.fail, true)
  await waitFor(() => expect(document.activeElement).toBe(within(row.scope()).getByRole('button', { name: 'Try again' })))
})

// ------------------------------------------------- the screens a read lands on

test("a group's calendar: Try again landing on a not-found screen puts focus on Nothing here", async () => {
  world96.fail.group = { status: 500 }
  open(`/calendar?group=${GROUP.id}`)
  const button = await screen.findByRole('button', { name: 'Try again' })
  const hold = gate()
  world96.hold.group = hold
  world96.fail.group = { status: 404, body: { detail: 'Not Found' } }
  await pressHeld(button, hold)
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Nothing here' }))
})

test('Your gatherings: Try again landing on the empty screen puts focus on No gatherings yet', async () => {
  world96.fail.gatherings = { status: 500 }
  world96.gatherings = []
  open('/gatherings')
  await retry(main, ['gatherings'], false)
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'No gatherings yet' }))
})

test('Groups: Try again landing on the empty screen puts focus on No groups yet', async () => {
  world96.fail.groups = { status: 500 }
  world96.groups = []
  open('/groups')
  await retry(main, ['groups'], false)
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'No groups yet' }))
})

// ------------------------------------------------------------- the menu's line

test("the menu's Try again is described by its line, which is no alert", async () => {
  stubWidth(true)
  world96.fail.groups = { status: 500 }
  open('/you')
  const button = await waitFor(() => within(menuNav()).getByRole('button', { name: 'Try again' }))
  const line = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  expect(line?.textContent).toBe("Your groups and gatherings couldn't be loaded just now.")
  expect(line?.getAttribute('role')).toBeNull()
  expect(line?.closest('[role="alert"], [aria-live]')).toBeNull()
})

test("the menu's Try again, nothing to list, puts focus on the Groups section link", async () => {
  stubWidth(true)
  world96.fail.groups = { status: 500 }
  world96.groups = []
  world96.gatherings = []
  open('/you')
  await retry(menuNav, ['groups'], false)
  expect(document.activeElement).toBe(within(menuNav()).getByRole('link', { name: 'Groups' }))
})

// ------------------------------------------- a person who moved on keeps their place

const MOVED_ON: [string, Row][] = [
  ["a page's main (Groups)", ROWS.find((row) => row.name === 'Groups')!],
  ["a section (a group's strip)", ROWS.find((row) => row.name === "a group's strip")!],
  ["the menu's nav", ROWS.find((row) => row.name === "the menu's, in One list")!],
  ["the calendar's card", ROWS.find((row) => row.name === "the calendar's month")!],
]

test.each(MOVED_ON.flatMap(([kind, row]) => [[kind, 'a success', row, false], [kind, 'a failure', row, true]] as const))(
  '%s: a person who moved outside it while the read waited keeps their place after %s',
  async (_kind, _outcome, row, again) => {
    stage(row)
    open(row.path)
    const away = outside()
    await retry(row.scope, row.fail, again, away)
    expect(document.activeElement).toBe(away)
  },
)
