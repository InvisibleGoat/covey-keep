// CK-96 — the rest of focus after an answer, through the app's REAL route
// table with the REAL AuthProvider, against test-support/world96.ts. Chrome
// drops focus to the body from a control the press removes or disables;
// jsdom does not, so each test drops it by hand while the request is held
// (test-support/focus.ts). The values under test (the kickoff's §4):
// - the four reads given a Try again (approved by Steven as written,
//   2026-11-14): the RSVP block → the checked answer, else Going; the
//   invitation list → the section's heading, in the outside card the
//   switch; the co-host list → the Co-hosts heading; Settings' passkeys →
//   Add a passkey, else the section's heading — each failing again on the
//   new Try again, its line an alert, the button's word as a literal;
// - Revoke's failure (approved as written): a line beneath that Revoke, an
//   alert — the house line for a refusal, the network line where the request
//   never arrived — focus on that Revoke, the line gone on the row's next
//   press and on a re-read, on a gathering's page and a group's People page;
// - a gathering's three Cancels → Edit gathering, that date's Edit this date,
//   Add another date;
// - a person who moved outside the section while the read waited keeps their
//   place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { gate, pressHeld, settle } from '../test-support/focus'
import { gatheringDetail, GROUP, resetWorld96, stubWidth, stubWorld96, world96, type Key } from '../test-support/world96'

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

const REFUSED = 'Something went wrong. Nothing changed — try again.'
const UNREACHABLE = "Couldn't reach the server. Check your connection and try again."

beforeEach(() => {
  localStorage.clear()
  resetWorld96()
  stubWorld96()
  stubWidth(false)
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

// Wait for the app to settle (nothing from the first render still in flight),
// then press with the request on `keys` held; `again` keeps it failing.
async function settled() {
  await waitFor(() => expect(world96.inflight).toBe(0))
  await settle()
}

async function press(control: HTMLElement, keys: Key[], again = true, movedTo?: HTMLElement) {
  await settled()
  const hold = gate()
  for (const key of keys) {
    world96.hold[key] = hold
    if (!again) delete world96.fail[key]
  }
  await pressHeld(control, hold, movedTo)
}

// A gathering's Revoke never disables (CK-94), so Chrome keeps focus on it
// while the request waits: press it and hold the answer with focus left there.
async function pressKept(control: HTMLElement, keys: Key[]) {
  await settled()
  const hold = gate()
  for (const key of keys) world96.hold[key] = hold
  control.focus()
  fireEvent.click(control)
  await settle()
  await act(async () => hold.release())
  await settle()
}

const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement

// ------------------------------------------------------------------ the RSVP block

async function rsvpBlock() {
  world96.fail.rsvps = { status: 500 }
  open('/gatherings/g-1')
  const openers = await screen.findAllByRole('button', { name: "RSVP and who's coming" })
  fireEvent.click(openers[0])
  const block = await waitFor(() => document.querySelector('.rsvp-block') as HTMLElement)
  await waitFor(() => within(block).getByRole('button', { name: 'Try again' }))
  return block
}

test('the RSVP block: its line is an alert beside a Try again', async () => {
  const block = await rsvpBlock()
  expect(within(block).getByRole('alert').textContent).toBe("⚠ RSVPs couldn't be loaded just now.")
  expect(within(block).getByRole('button', { name: 'Try again' }).textContent).toBe('Try again')
})

test('the RSVP block: Try again, the read landing, puts focus on the first answer, Going', async () => {
  const block = await rsvpBlock()
  await press(within(block).getByRole('button', { name: 'Try again' }), ['rsvps'], false)
  await waitFor(() => expect(document.activeElement).toBe(within(block).getByRole('radio', { name: 'Going' })))
})

test('the RSVP block: Try again, the read landing with an answer, puts focus on the checked answer', async () => {
  const block = await rsvpBlock()
  world96.own = { response: 'maybe', companions: [], arrival_time: null, note: null, stay_included: false }
  await press(within(block).getByRole('button', { name: 'Try again' }), ['rsvps'], false)
  await waitFor(() => expect(document.activeElement).toBe(within(block).getByRole('radio', { name: 'Maybe' })))
})

test('the RSVP block: Try again, failing again, puts focus on the new Try again', async () => {
  const block = await rsvpBlock()
  await press(within(block).getByRole('button', { name: 'Try again' }), ['rsvps'])
  await waitFor(() => expect(document.activeElement).toBe(within(block).getByRole('button', { name: 'Try again' })))
})

test.each([
  ['a success', false],
  ['a failure', true],
])('the RSVP block: a person who moved outside it keeps their place after %s', async (_name, again) => {
  const block = await rsvpBlock()
  const away = outside()
  await press(within(block).getByRole('button', { name: 'Try again' }), ['rsvps'], again, away)
  await settle(100)
  expect(document.activeElement).toBe(away)
})

// ------------------------------------------------------------ the invitation list

async function invitationsSection() {
  world96.fail.roster = { status: 500 }
  open('/gatherings/g-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
  await waitFor(() => within(section('Invitations')).getByRole('button', { name: 'Try again' }))
  return () => section('Invitations')
}

test('the invitation list (Invitations): its line is an alert, Try again landing on the section’s heading', async () => {
  const scope = await invitationsSection()
  expect(within(scope()).getByRole('alert').textContent).toBe("⚠ The invitation list couldn't be loaded just now.")
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['roster'], false)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Invitations', level: 2 })))
})

test('the invitation list (Invitations): Try again, failing again, puts focus on the new Try again', async () => {
  const scope = await invitationsSection()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['roster'])
  await waitFor(() => expect(document.activeElement).toBe(within(scope()).getByRole('button', { name: 'Try again' })))
})

test.each([
  ['a success', false],
  ['a failure', true],
])('the invitation list: a person who moved outside its section keeps their place after %s', async (_name, again) => {
  const scope = await invitationsSection()
  const away = outside()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['roster'], again, away)
  await settle(100)
  expect(document.activeElement).toBe(away)
})

async function groupGathering(outsideOn: boolean) {
  world96.detail['g-2'] = gatheringDetail('g-2', {
    outside_invitations: { on: outsideOn, since: outsideOn ? '2026-11-10T12:00:00+00:00' : null, by: null, may_change: true },
  })
  world96.fail.roster = { status: 500 }
  open('/gatherings/g-2')
  await screen.findByRole('heading', { name: 'The Group Party', level: 1 })
}

test('the invitation list (Co-hosts): Try again landing puts focus on the Co-hosts heading', async () => {
  await groupGathering(false)
  fireEvent.click(await screen.findByRole('button', { name: 'Show co-hosts' }))
  const scope = () => section('Co-hosts')
  await waitFor(() => within(scope()).getByRole('button', { name: 'Try again' }))
  expect(within(scope()).getByRole('alert').textContent).toBe("⚠ The list of who's invited couldn't be loaded just now.")
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['roster'], false)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Co-hosts', level: 2 })))
})

test("the invitation list (the outside card): Try again landing puts focus on the card's switch", async () => {
  await groupGathering(true)
  const card = () => screen.getByRole('heading', { name: `Invite people outside ${GROUP.name}` }).closest('section') as HTMLElement
  await waitFor(() => within(card()).getByRole('button', { name: 'Try again' }))
  expect(within(card()).getByRole('alert').textContent).toBe("⚠ The invitation list couldn't be loaded just now.")
  await press(within(card()).getByRole('button', { name: 'Try again' }), ['roster'], false)
  await waitFor(() => expect(document.activeElement).toBe(within(card()).getByRole('switch')))
})

test('the invitation list shown twice: each Try again lands in its own section', async () => {
  await groupGathering(true)
  fireEvent.click(await screen.findByRole('button', { name: 'Show co-hosts' }))
  const card = () => screen.getByRole('heading', { name: `Invite people outside ${GROUP.name}` }).closest('section') as HTMLElement
  const coHosts = () => section('Co-hosts')
  await waitFor(() => within(coHosts()).getByRole('button', { name: 'Try again' }))
  await waitFor(() => within(card()).getByRole('button', { name: 'Try again' }))
  await press(within(coHosts()).getByRole('button', { name: 'Try again' }), ['roster'])
  await waitFor(() => expect(document.activeElement).toBe(within(coHosts()).getByRole('button', { name: 'Try again' })))
})

// ----------------------------------------------------------------- the co-host list

async function coHostList() {
  world96.fail.coHosts = { status: 500 }
  open('/gatherings/g-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
  const scope = () => section('Invitations')
  await waitFor(() => within(scope()).getByRole('button', { name: 'Try again' }))
  return scope
}

test('the co-host list: its line is an alert, Try again landing on the Co-hosts heading', async () => {
  const scope = await coHostList()
  expect(within(scope()).getByRole('alert').textContent).toBe("⚠ The co-host list couldn't be loaded just now.")
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['coHosts'], false)
  await waitFor(() => expect(document.activeElement).toBe(within(scope()).getByRole('heading', { name: 'Co-hosts', level: 3 })))
})

test('the co-host list: Try again, failing again, puts focus on the new Try again', async () => {
  const scope = await coHostList()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['coHosts'])
  await waitFor(() => expect(document.activeElement).toBe(within(scope()).getByRole('button', { name: 'Try again' })))
})

// ------------------------------------------------------------------- the passkeys

async function passkeys() {
  world96.fail.passkeys = { status: 500 }
  open('/settings')
  const scope = () => section('Passkeys')
  await waitFor(() => within(scope()).getByRole('button', { name: 'Try again' }))
  return scope
}

test("Settings' passkeys: the line is an alert beside a Try again", async () => {
  const scope = await passkeys()
  expect(within(scope()).getByRole('alert').textContent).toBe("Your passkeys couldn't be loaded just now.")
})

test("Settings' passkeys: Try again, the read landing, puts focus on Add a passkey", async () => {
  const scope = await passkeys()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['passkeys'], false)
  await waitFor(() => expect(document.activeElement).toBe(within(scope()).getByRole('button', { name: 'Add a passkey' })))
})

test("Settings' passkeys: Try again, failing again, puts focus on the new Try again", async () => {
  const scope = await passkeys()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['passkeys'])
  await waitFor(() => expect(document.activeElement).toBe(within(scope()).getByRole('button', { name: 'Try again' })))
})

test.each([
  ['a success', false],
  ['a failure', true],
])("Settings' passkeys: a person who moved outside the section keeps their place after %s", async (_name, again) => {
  const scope = await passkeys()
  const away = outside()
  await press(within(scope()).getByRole('button', { name: 'Try again' }), ['passkeys'], again, away)
  await settle(100)
  expect(document.activeElement).toBe(away)
})

// ----------------------------------------------------------------------- Revoke

async function gatheringRevoke() {
  open('/gatherings/g-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
  return waitFor(() => within(section('Invitations')).getByRole('button', { name: 'Revoke' }))
}

async function peopleRevoke() {
  open(`/groups/${GROUP.id}/people`)
  return waitFor(() => within(section('Invite people')).getByRole('button', { name: 'Revoke' }))
}

type Press = (control: HTMLElement, keys: Key[]) => Promise<void>
const REVOKE: [string, () => Promise<HTMLElement>, Key, () => HTMLElement, Press][] = [
  ["a gathering's page", gatheringRevoke, 'revoke', () => section('Invitations'), pressKept],
  // The People page's Revoke disables while it waits, so focus drops.
  ["a group's People page", peopleRevoke, 'groupRevoke', () => section('Invite people'), (control, keys) => press(control, keys)],
]

test.each(
  REVOKE.flatMap(([page, start, key, scope, act_]) => [
    [page, 'a refusal', start, key, scope, act_, { status: 500 as const }, REFUSED],
    [page, 'no server', start, key, scope, act_, { status: 'network' as const }, UNREACHABLE],
  ]),
)('Revoke on %s: %s draws its line beneath that Revoke, an alert, and keeps focus on that Revoke', async (_page, _kind, start, key, scope, pressIt, answer, line) => {
  const revoke = await start()
  world96.answer[key] = answer
  await pressIt(revoke, [key])
  const again = within(scope()).getByRole('button', { name: 'Revoke' })
  await waitFor(() => expect(document.activeElement).toBe(again))
  const alert = again.closest('li')!.querySelector('[role="alert"]')
  expect(alert?.textContent).toBe(`⚠ ${line}`)
})

test.each(REVOKE)('Revoke on %s: the line goes on the row’s next press', async (_page, start, key, scope, pressIt) => {
  const revoke = await start()
  world96.answer[key] = { status: 500 }
  await pressIt(revoke, [key])
  await waitFor(() => expect(within(scope()).getByRole('alert').textContent).toBe(`⚠ ${REFUSED}`))
  const hold = gate()
  world96.hold[key] = hold
  fireEvent.click(within(scope()).getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(within(scope()).queryByText(REFUSED)).toBeNull())
  hold.release()
  await settle()
})

test.each(REVOKE)('Revoke on %s: the line goes on a re-read of the list, the row gone', async (_page, start, key, scope, pressIt) => {
  const revoke = await start()
  world96.answer[key] = { status: 500 }
  await pressIt(revoke, [key])
  await waitFor(() => expect(within(scope()).getByRole('alert').textContent).toBe(`⚠ ${REFUSED}`))
  delete world96.answer[key]
  fireEvent.click(within(scope()).getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(within(scope()).queryByRole('button', { name: 'Revoke' })).toBeNull())
  expect(within(scope()).queryByText(REFUSED)).toBeNull()
})

test.each(REVOKE)('Revoke on %s: a success draws no line, the row still listed until its re-read lands', async (_page, start, key, scope, pressIt) => {
  const revoke = await start()
  // The list's re-read held, so the row is still there to carry a line.
  const list: Key = key === 'revoke' ? 'roster' : 'groupInvitations'
  const reread = gate()
  world96.hold[list] = reread
  await pressIt(revoke, [key])
  await waitFor(() => expect(world96.log.filter((entry) => entry === list).length).toBeGreaterThan(1))
  expect(within(scope()).getByRole('button', { name: 'Revoke' })).toBeTruthy()
  expect(within(scope()).queryByRole('alert')).toBeNull()
  await act(async () => reread.release())
  await waitFor(() => expect(within(scope()).queryByRole('button', { name: 'Revoke' })).toBeNull())
  expect(within(scope()).queryByRole('alert')).toBeNull()
})

// --------------------------------------------------------------- the three Cancels

async function gathering() {
  open('/gatherings/g-1')
  await screen.findByRole('heading', { name: 'The Party', level: 1 })
  await settled()
}

function cancelFrom(form: HTMLElement) {
  const cancel = within(form).getByRole('button', { name: 'Cancel' })
  cancel.focus()
  fireEvent.click(cancel)
}

test("a gathering's page: Edit gathering's Cancel puts focus on Edit gathering", async () => {
  await gathering()
  fireEvent.click(screen.getByRole('button', { name: 'Edit gathering' }))
  const form = screen.getByRole('heading', { name: 'Edit gathering', level: 2 }).closest('section, form') as HTMLElement
  cancelFrom(form)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit gathering' })))
})

test("a gathering's page: Edit this date's Cancel puts focus on that date's Edit this date", async () => {
  await gathering()
  const edits = screen.getAllByRole('button', { name: 'Edit this date' })
  fireEvent.click(edits[1])
  const form = screen.getByRole('group', { name: 'Edit this date' }).closest('form') as HTMLElement
  cancelFrom(form)
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Edit this date' })[1]))
})

test("a gathering's page: Add a date's Cancel puts focus on Add another date", async () => {
  await gathering()
  fireEvent.click(screen.getByRole('button', { name: 'Add another date' }))
  const form = screen.getByRole('group', { name: 'New date' }).closest('form') as HTMLElement
  cancelFrom(form)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add another date' })))
})
