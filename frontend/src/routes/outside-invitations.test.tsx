// CK-93 — inviting people outside the group, on the surface: the card with
// its switch and two second steps, the email form and *Waiting on* while it
// is on, the line at the top of Photos, the alert, the Co-hosts section's
// outsider row, and an outsider's page — through the app's REAL route table
// with the REAL AuthProvider over the real session store (the CK-76.1
// Gotcha), against a stateful fake server. The values under test:
// - THE BODY DECIDES: the card for `may_change` alone, the line for
//   `caller_in_group` true alone, the alert for `outside_alert` true alone,
//   the outsider's page for `caller_in_group` exactly false — each absent,
//   null or unknown field rendering nothing new;
// - THE SWITCH NEVER MOVES BEFORE THE SERVER HAS ANSWERED, turning it on
//   always asks, and turning it off reads the preview first and asks only
//   when it would name someone or stop an invitation;
// - ONE ROSTER READ per reload, shared by the card's *Waiting on* and the
//   Co-hosts section, and none for anyone the server would refuse;
// - AN OUTSIDER'S PAGE never reaches for the group: the crumb to Gatherings,
//   no group read when the viewer opens, Home's panel in Rail and panel;
// - the words as literals, the approved ones as Steven approved them.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { chooseMenuLayout } from '../lib/menuLayout'
import { setToken } from '../lib/session'

const GROUP = { id: 'grp-lees-1', name: 'The Lees' }
const GROUP_NAME = 'The Lees'
const SWITCH = 'Invite people outside The Lees'
const TURN_ON_SENTENCE =
  "People you invite from outside The Lees will see everything in this gathering, including what's already there. Everyone in it will be told."
const LINE_OFF =
  "Only people in The Lees can see this gathering for now. If people outside The Lees are invited, they'll see everything in it, including what's already there."
const LINE_ON = 'People outside The Lees can see this gathering and everything in it.'
const ALERT_NAMED =
  "Bea Test opened The Party to people outside The Lees. They can see everything in it, including what's already there. If you added something that should stay with The Lees, you can remove it."
const ALERT_PASSIVE =
  "The Party was opened to people outside The Lees. They can see everything in it, including what's already there. If you added something that should stay with The Lees, you can remove it."

const DAY = 24 * 60 * 60 * 1000
const nextWeek = () => new Date(Date.now() + 7 * DAY).toISOString()

const OFF = { on: false, since: null, by: null, may_change: true }
const ON = { on: true, since: '2026-11-10T12:00:00+00:00', by: 'Ada Test', may_change: true }

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
    occurrences: [
      {
        id: 'occ-1',
        gathering_id: 'g-1',
        starts_at: nextWeek(),
        ends_at: null,
        location: null,
        map_url: null,
        caller_response: null,
      },
    ],
    outside_invitations: OFF,
    caller_in_group: true,
    outside_alert: false,
    ...over,
  }
}

// The memory body (CK-77): the dates and the RSVP setting withheld, no role.
function memory(over: Record<string, unknown> = {}) {
  return detail({ caller_role: null, caller_view: 'memory', rsvp_list_visibility: null, occurrences: null, ...over })
}

// The seats, each the body the server answers that caller.
const SEATS = {
  host: () => detail(),
  coHost: () => detail({ caller_role: 'co_host' }),
  // A group admin who is invited but organises nothing: may change it.
  groupAdmin: () => detail({ caller_role: null }),
  // A group co-admin only shared with: the photos-only view, may change it.
  groupCoAdminShared: () => memory(),
  member: () => detail({ caller_role: null, outside_invitations: { ...OFF, may_change: false } }),
  outsider: () =>
    detail({ caller_role: null, outside_invitations: { ...ON, may_change: false }, caller_in_group: false }),
  standalone: () => detail({ group: null, outside_invitations: null, caller_in_group: null, outside_alert: null }),
  absent: () => {
    const body = detail()
    delete body.outside_invitations
    delete body.caller_in_group
    delete body.outside_alert
    return body
  },
}

const PHOTO = {
  id: 'm-photo-1',
  gathering_id: 'g-1',
  occurrence_id: 'occ-1',
  status: 'ready',
  publication_state: 'live',
  upload_content_type: 'image/jpeg',
  upload_size_bytes: 1000,
  uploaded_at: '2026-11-02T15:00:01+00:00',
  created_at: '2026-11-02T15:00:00+00:00',
  uploader_display_name: 'Bea Test',
  is_own: false,
  removed_at: null,
  filename: 'party.jpg',
  caption: null,
  tags: [],
  published_at: '2026-11-02T15:00:05+00:00',
  failure_reason: null,
}

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

interface Preview {
  on: boolean
  since: string | null
  by: string | null
  outsiders: { display_name: string | null }[]
  pending: number
}

interface World {
  detail: Record<string, unknown>
  preview: Preview
  roster: {
    pending: { id: string; channel: string; destination: string; created_at: string; expires_at: string }[]
    accepted: { id: string; display_name: string; accepted_at: string; from_outside?: boolean }[]
  }
  memberOfGroup: boolean
  putStatus?: number
  previewStatus?: number
  dismissStatus?: number
  inviteStatus?: number
  hold: { put?: Gate; preview?: Gate; dismiss?: Gate }
}

let world: World
let mock: ReturnType<typeof vi.fn>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function path(url: unknown) {
  return String(url).replace(/^https?:\/\/[^/]+/, '')
}

// The API's requests, as `METHOD /path`.
function log(): string[] {
  return mock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path(url)}`)
}

function count(entry: string): number {
  return log().filter((line) => line === entry).length
}

function bodiesOf(entry: string): unknown[] {
  return mock.mock.calls
    .filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path(url)}` === entry)
    .map(([, init]) => (init as RequestInit).body)
}

function listItem() {
  const body = world.detail
  return {
    ...body,
    occurrences: undefined,
    next_occurrence: body.occurrences === null ? null : { id: 'occ-1', starts_at: nextWeek() },
    occurrence_count: body.occurrences === null ? null : 1,
  }
}

function groupBody() {
  return {
    id: GROUP.id,
    name: GROUP.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-bea',
    member_count: 3,
    caller_role: 'member',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function stubServer() {
  mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const p = path(url)
    if (p === '/auth/me') {
      return json(200, {
        id: 'person-ada',
        display_name: 'Ada Test',
        email: 'ada@example.com',
        timezone: 'America/Chicago',
        account_id: 'acct-ada',
      })
    }
    if (p === '/groups') return json(200, { groups: world.memberOfGroup ? [groupBody()] : [] })
    if (p === '/gatherings') return json(200, { gatherings: [listItem()] })
    if (p === '/billing') return json(404, {})
    if (method === 'GET' && p === '/gatherings/g-1') return json(200, world.detail)
    if (p === '/gatherings/g-1/outside-invitations' && method === 'PUT') {
      await world.hold.put?.promise
      if (world.putStatus !== undefined) return json(world.putStatus, { detail: 'refused' })
      const { on } = JSON.parse(String(init?.body)) as { on: boolean }
      const setting = world.detail.outside_invitations as Record<string, unknown>
      world.detail = {
        ...world.detail,
        outside_invitations: on
          ? { on: true, since: '2026-11-12T12:00:00+00:00', by: 'Ada Test', may_change: setting.may_change }
          : { on: false, since: null, by: null, may_change: setting.may_change },
        outside_alert: false,
      }
      if (!on) {
        world.roster = {
          pending: [],
          accepted: world.roster.accepted.filter((entry) => entry.from_outside !== true),
        }
      }
      return json(200, world.detail)
    }
    if (p === '/gatherings/g-1/outside-invitations' && method === 'GET') {
      await world.hold.preview?.promise
      if (world.previewStatus !== undefined) return json(world.previewStatus, { detail: 'refused' })
      return json(200, world.preview)
    }
    if (p === '/gatherings/g-1/outside-alert/dismiss' && method === 'POST') {
      await world.hold.dismiss?.promise
      if (world.dismissStatus !== undefined) return json(world.dismissStatus, {})
      return new Response(null, { status: 204 })
    }
    if (p === '/gatherings/g-1/invitations' && method === 'GET') return json(200, world.roster)
    if (p === '/gatherings/g-1/invitations' && method === 'POST') {
      const status = world.inviteStatus ?? 201
      if (status === 409) {
        // Someone turned it off meanwhile.
        world.detail = {
          ...world.detail,
          outside_invitations: { on: false, since: null, by: null, may_change: true },
        }
        return json(409, { detail: { code: 'members_only', message: 'the server’s own words' } })
      }
      if (status === 429) return json(429, { detail: 'rate limited' })
      if (status === 422) {
        return json(422, {
          detail: [{ loc: ['body', 'destination'], msg: 'value is not a valid email address', type: 'value_error' }],
        })
      }
      const { destination } = JSON.parse(String(init?.body)) as { destination: string }
      world.roster = {
        ...world.roster,
        pending: [
          ...world.roster.pending,
          {
            id: `inv-p-${world.roster.pending.length + 9}`,
            channel: 'EMAIL',
            destination,
            created_at: '2026-11-12T12:00:00+00:00',
            expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
          },
        ],
      }
      return json(201, {})
    }
    if (method === 'DELETE' && p.startsWith('/invitations/pending/')) {
      const id = p.split('/').pop()
      world.roster = { ...world.roster, pending: world.roster.pending.filter((entry) => entry.id !== id) }
      return new Response(null, { status: 204 })
    }
    if (p === '/gatherings/g-1/co-hosts' && method === 'GET') return json(200, { co_hosts: [] })
    if (p === '/gatherings/g-1/places') {
      return json(200, {
        invitees_chosen: true,
        members: [{ membership_id: 'mem-bea-2222', display_name: 'Bea Test', place: 'invited', co_host: false }],
      })
    }
    if (p.startsWith('/gatherings/g-1/media')) return json(200, { media: [PHOTO] })
    if (p.includes('/url?layer=')) {
      return json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } })
    }
    if (p === `/groups/${GROUP.id}`) return json(200, groupBody())
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', mock)
}

function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: wide, media: '', addEventListener: () => {}, removeEventListener: () => {} })),
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function settle(ms = 30) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

async function open(seat: Record<string, unknown>, over: Partial<World> = {}) {
  world = { ...world, detail: seat, ...over }
  renderPage()
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  await settle()
}

const card = () => screen.getByRole('region', { name: SWITCH })
const queryCard = () => screen.queryByRole('region', { name: SWITCH })
const theSwitch = () => screen.getByRole('switch', { name: SWITCH })
const photos = () => screen.getByRole('region', { name: 'Photos' })
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  world = {
    detail: detail(),
    preview: { on: true, since: ON.since, by: 'Ada Test', outsiders: [], pending: 0 },
    roster: { pending: [], accepted: [] },
    memberOfGroup: true,
    hold: {},
  }
  stubServer()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
})

afterEach(() => {
  // Never the member list, anywhere on this page.
  expect(log().some((line) => line.includes('/members'))).toBe(false)
  cleanup()
  vi.unstubAllGlobals()
  chooseMenuLayout('list')
  localStorage.clear()
  document.body.classList.remove('menu-open')
})

// ---------------------------------------------------------------------------
// The card, by seat

test('the host gets the card after Who it\'s for and before the Co-hosts section; its heading names the switch, which is off', async () => {
  await open(SEATS.host())
  const region = card()
  expect(within(region).getByRole('heading', { level: 2, name: SWITCH })).toBeTruthy()
  const control = theSwitch()
  expect(control.tagName).toBe('BUTTON')
  expect(control.getAttribute('aria-checked')).toBe('false')
  expect(region.contains(control)).toBe(true)
  // Named by the heading: the words appear once.
  expect(control.textContent?.trim()).toBe('')
  const places = screen.getByRole('region', { name: "Who it's for" })
  const coHosts = screen.getByRole('region', { name: 'Co-hosts' })
  expect(before(photos(), places)).toBe(true)
  expect(before(places, region)).toBe(true)
  expect(before(region, coHosts)).toBe(true)
  // Off, the card holds the heading and the switch alone.
  expect(within(region).queryByLabelText('Email address')).toBeNull()
  expect(within(region).queryByText('Waiting on')).toBeNull()
})

test('a co-host gets the card too, and the switch reads on from the body', async () => {
  await open(detail({ caller_role: 'co_host', outside_invitations: ON }))
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
})

test('a group admin who is invited but organises nothing gets the switch alone — no form, no Waiting on, no roster read', async () => {
  await open(detail({ caller_role: null, outside_invitations: ON }))
  const region = card()
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  expect(within(region).queryByLabelText('Email address')).toBeNull()
  expect(within(region).queryByText('Waiting on')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Co-hosts' })).toBeNull()
  // The card follows Photos (no Who it's for, no Co-hosts for this seat).
  expect(before(photos(), region)).toBe(true)
  expect(count('GET /gatherings/g-1/invitations')).toBe(0)
})

test('a group co-admin only shared with gets the card in the photos-only view, after Photos', async () => {
  await open(SEATS.groupCoAdminShared())
  const region = card()
  expect(before(photos(), region)).toBe(true)
  expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  // The photos-only view: no When, and no roster.
  expect(screen.queryByRole('heading', { name: 'When' })).toBeNull()
  expect(count('GET /gatherings/g-1/invitations')).toBe(0)
})

test('the card is the body\'s may_change, never the role: a host the body refuses gets none', async () => {
  await open(detail({ outside_invitations: { ...OFF, may_change: false } }))
  expect(queryCard()).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

test.each([
  ['a member', SEATS.member],
  ['an outsider', SEATS.outsider],
  ['a standalone gathering', SEATS.standalone],
  ['a body without the three fields', SEATS.absent],
])('no card for %s', async (_name, seat) => {
  await open(seat())
  expect(queryCard()).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

// ---------------------------------------------------------------------------
// Turning it on

test('turning it on: the press opens the step and moves focus to it; Not now posts nothing and gives focus back', async () => {
  await open(SEATS.host())
  fireEvent.click(theSwitch())
  const step = await screen.findByRole('group', { name: TURN_ON_SENTENCE })
  expect(within(step).getByText(TURN_ON_SENTENCE)).toBeTruthy()
  expect(within(step).getByRole('button', { name: 'Turn it on' })).toBeTruthy()
  expect(within(step).getByRole('button', { name: 'Not now' })).toBeTruthy()
  expect(document.activeElement).toBe(step)
  expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  fireEvent.click(within(step).getByRole('button', { name: 'Not now' }))
  await waitFor(() => expect(screen.queryByRole('group', { name: TURN_ON_SENTENCE })).toBeNull())
  expect(document.activeElement).toBe(theSwitch())
  await settle()
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
})

test('Turn it on: one PUT with exactly {"on": true}, the switch unmoved until it lands, the body replacing the page\'s, focus back on the switch', async () => {
  world.hold.put = gate()
  await open(SEATS.host())
  fireEvent.click(theSwitch())
  const step = await screen.findByRole('group', { name: TURN_ON_SENTENCE })
  fireEvent.click(within(step).getByRole('button', { name: 'Turn it on' }))
  const busy = await within(step).findByRole('button', { name: 'Turning it on…' })
  expect((busy as HTMLButtonElement).disabled).toBe(true)
  expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  expect(photos().querySelector('.gline')?.textContent).toBe(LINE_OFF)
  await act(async () => world.hold.put?.release())
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('true'))
  expect(screen.queryByRole('group', { name: TURN_ON_SENTENCE })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(theSwitch()))
  expect(bodiesOf('PUT /gatherings/g-1/outside-invitations')).toEqual(['{"on":true}'])
  // The body replaced the page's — the on line and the form — with no re-read.
  expect(photos().querySelector('.gline')?.textContent).toBe(LINE_ON)
  expect(within(card()).getByLabelText('Email address')).toBeTruthy()
  expect(count('GET /gatherings/g-1')).toBe(1)
})

test('a refused turn-on leaves the switch as it was: the generic line, and a 404\'s line with Refresh re-reading the gathering', async () => {
  world.putStatus = 500
  await open(SEATS.host())
  fireEvent.click(theSwitch())
  fireEvent.click(within(await screen.findByRole('group', { name: TURN_ON_SENTENCE })).getByRole('button', { name: 'Turn it on' }))
  await within(card()).findByText('Something went wrong. Nothing was changed — try again.')
  expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  world.putStatus = 404
  fireEvent.click(within(screen.getByRole('group', { name: TURN_ON_SENTENCE })).getByRole('button', { name: 'Turn it on' }))
  await within(card()).findByText("You can't change this setting any more.")
  expect(theSwitch().getAttribute('aria-checked')).toBe('false')
  const reads = count('GET /gatherings/g-1')
  fireEvent.click(within(card()).getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(count('GET /gatherings/g-1')).toBe(reads + 1))
})

// ---------------------------------------------------------------------------
// Turning it off

test('no preview is read before a turn-off press; with nobody from outside and nothing pending, one press turns it off', async () => {
  await open(detail({ outside_invitations: ON }))
  expect(count('GET /gatherings/g-1/outside-invitations')).toBe(0)
  fireEvent.click(theSwitch())
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('false'))
  const order = log().filter((line) => line.includes('/outside-invitations'))
  expect(order).toEqual(['GET /gatherings/g-1/outside-invitations', 'PUT /gatherings/g-1/outside-invitations'])
  expect(bodiesOf('PUT /gatherings/g-1/outside-invitations')).toEqual(['{"on":false}'])
  expect(screen.queryByRole('group', { name: /will no longer see|stop working/ })).toBeNull()
  expect(photos().querySelector('.gline')?.textContent).toBe(LINE_OFF)
  await waitFor(() => expect(document.activeElement).toBe(theSwitch()))
})

test('while the preview is read the switch is busy and disabled, and still on', async () => {
  world.hold.preview = gate()
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(theSwitch())
  await waitFor(() => expect(theSwitch().getAttribute('aria-busy')).toBe('true'))
  expect((theSwitch() as HTMLButtonElement).disabled).toBe(true)
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  await act(async () => world.hold.preview?.release())
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('false'))
})

test.each([
  [['Joe Smith'], 0, 'Joe Smith will no longer see this gathering.'],
  [['Joe Smith', 'Ann Lee'], 0, 'Joe Smith and 1 other will no longer see this gathering.'],
  [
    ['Joe Smith', 'Ann Lee', 'Bo Park'],
    1,
    'Joe Smith and 2 others will no longer see this gathering. Invitations not yet accepted will stop working.',
  ],
  [[], 2, 'Invitations not yet accepted will stop working.'],
])('the turn-off step for %j with %i pending reads its sentence, takes focus, and posts nothing yet', async (names, pending, sentence) => {
  world.preview = { ...world.preview, outsiders: names.map((display_name) => ({ display_name })), pending }
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(theSwitch())
  const step = await screen.findByRole('group', { name: sentence })
  expect(within(step).getByText(sentence)).toBeTruthy()
  const turnOff = within(step).getByRole('button', { name: 'Turn it off' })
  expect(turnOff.classList.contains('danger-button')).toBe(true)
  expect(within(step).getByRole('button', { name: 'Keep it on' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(step))
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
})

test('Keep it on posts nothing and gives focus back to the switch', async () => {
  world.preview = { ...world.preview, outsiders: [{ display_name: 'Joe Smith' }] }
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(theSwitch())
  const step = await screen.findByRole('group', { name: 'Joe Smith will no longer see this gathering.' })
  fireEvent.click(within(step).getByRole('button', { name: 'Keep it on' }))
  await waitFor(() => expect(document.activeElement).toBe(theSwitch()))
  expect(screen.queryByRole('group', { name: 'Joe Smith will no longer see this gathering.' })).toBeNull()
  await settle()
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
})

test('Turn it off: exactly {"on": false}, Turning it off… while in flight, then the roster re-read and focus on the switch', async () => {
  world.preview = { ...world.preview, outsiders: [{ display_name: 'Joe Smith' }], pending: 1 }
  world.roster = {
    pending: [
      {
        id: 'inv-p-1',
        channel: 'EMAIL',
        destination: 'joe.two@example.com',
        created_at: '2026-11-11T12:00:00+00:00',
        expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
      },
    ],
    accepted: [{ id: 'inv-joe', display_name: 'Joe Smith', accepted_at: '2026-11-11T12:00:00+00:00', from_outside: true }],
  }
  world.hold.put = gate()
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(screen.getByRole('button', { name: 'Show co-hosts' }))
  await screen.findByRole('list', { name: 'Invited' })
  const rosterReads = count('GET /gatherings/g-1/invitations')
  fireEvent.click(theSwitch())
  const sentence =
    'Joe Smith will no longer see this gathering. Invitations not yet accepted will stop working.'
  const step = await screen.findByRole('group', { name: sentence })
  fireEvent.click(within(step).getByRole('button', { name: 'Turn it off' }))
  expect(await within(step).findByRole('button', { name: 'Turning it off…' })).toBeTruthy()
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  await act(async () => world.hold.put?.release())
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('false'))
  expect(bodiesOf('PUT /gatherings/g-1/outside-invitations')).toEqual(['{"on":false}'])
  await waitFor(() => expect(count('GET /gatherings/g-1/invitations')).toBe(rosterReads + 1))
  await waitFor(() => expect(document.activeElement).toBe(theSwitch()))
  // Waiting on is gone with the form; the outsider has left the Invited list.
  expect(within(card()).queryByText('Waiting on')).toBeNull()
  await waitFor(() => expect(screen.queryByText(/From outside/)).toBeNull())
})

test('a preview that says it is already off re-reads the gathering and posts nothing', async () => {
  world.preview = { on: false, since: null, by: null, outsiders: [], pending: 0 }
  await open(detail({ outside_invitations: ON }))
  // Someone else turned it off meanwhile.
  world.detail = detail({ outside_invitations: OFF })
  fireEvent.click(theSwitch())
  await waitFor(() => expect(count('GET /gatherings/g-1')).toBe(2))
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('false'))
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
})

test('a failed preview: its line and Try again, which reads it again — and nothing is turned off without one', async () => {
  world.previewStatus = 500
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(theSwitch())
  await within(card()).findByText("Who would lose access couldn't be checked just now.")
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
  world.previewStatus = undefined
  world.preview = { ...world.preview, outsiders: [{ display_name: 'Joe Smith' }] }
  fireEvent.click(within(card()).getByRole('button', { name: 'Try again' }))
  await screen.findByRole('group', { name: 'Joe Smith will no longer see this gathering.' })
  expect(count('GET /gatherings/g-1/outside-invitations')).toBe(2)
  expect(screen.queryByText("Who would lose access couldn't be checked just now.")).toBeNull()
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
})

test('a 404 on the preview: You can\'t change this setting any more, with Refresh re-reading the gathering', async () => {
  world.previewStatus = 404
  await open(detail({ outside_invitations: ON }))
  fireEvent.click(theSwitch())
  await within(card()).findByText("You can't change this setting any more.")
  expect(theSwitch().getAttribute('aria-checked')).toBe('true')
  world.detail = detail({ caller_role: null, outside_invitations: { ...ON, may_change: false } })
  fireEvent.click(within(card()).getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(queryCard()).toBeNull())
  expect(count('PUT /gatherings/g-1/outside-invitations')).toBe(0)
})

// ---------------------------------------------------------------------------
// The email form and Waiting on, while on, for organisers alone

const PENDING_ONE = {
  id: 'inv-p-1',
  channel: 'EMAIL',
  destination: 'cousin.joe@example.com',
  created_at: '2026-11-11T12:00:00+00:00',
  expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
}

test('on, the host gets the email form and Waiting on in the card: sending, and revoking, each re-read the roster', async () => {
  world.roster = { pending: [PENDING_ONE], accepted: [] }
  await open(detail({ outside_invitations: ON }))
  const region = card()
  await within(region).findByText('cousin.joe@example.com', { exact: false })
  expect(within(region).getByRole('heading', { level: 3, name: 'Waiting on' })).toBeTruthy()
  expect(
    within(region).getByText("They'll get an email with a link to this gathering. Invitations expire after 7 days."),
  ).toBeTruthy()
  const reads = count('GET /gatherings/g-1/invitations')
  expect(reads).toBe(1)
  fireEvent.change(within(region).getByLabelText('Email address'), { target: { value: '  ann.lee@example.com ' } })
  fireEvent.click(within(region).getByRole('button', { name: 'Send invitation' }))
  await within(region).findByText('ann.lee@example.com', { exact: false })
  expect(bodiesOf('POST /gatherings/g-1/invitations')).toEqual([
    JSON.stringify({ channel: 'EMAIL', destination: 'ann.lee@example.com' }),
  ])
  expect(count('GET /gatherings/g-1/invitations')).toBe(reads + 1)
  expect((within(region).getByLabelText('Email address') as HTMLInputElement).value).toBe('')
  const row = within(region).getByText('cousin.joe@example.com', { exact: false }).closest('li') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(within(region).queryByText('cousin.joe@example.com', { exact: false })).toBeNull())
  expect(count('DELETE /invitations/pending/inv-p-1')).toBe(1)
  expect(count('GET /gatherings/g-1/invitations')).toBe(reads + 2)
})

test('a co-host gets the form too; the 429 and the mapper\'s 422 read as on a standalone gathering', async () => {
  await open(detail({ caller_role: 'co_host', outside_invitations: ON }))
  const region = card()
  world.inviteStatus = 429
  fireEvent.change(within(region).getByLabelText('Email address'), { target: { value: 'ann.lee@example.com' } })
  fireEvent.click(within(region).getByRole('button', { name: 'Send invitation' }))
  await within(region).findByText('Too many invitations just now. Try again in a few minutes.')
  world.inviteStatus = 422
  fireEvent.click(within(region).getByRole('button', { name: 'Send invitation' }))
  await within(region).findByText(/not a valid email address/i)
})

test('a 409 members_only from the form: its line, the gathering re-read, the card off', async () => {
  await open(detail({ outside_invitations: ON }))
  const region = card()
  world.inviteStatus = 409
  fireEvent.change(within(region).getByLabelText('Email address'), { target: { value: 'ann.lee@example.com' } })
  fireEvent.click(within(region).getByRole('button', { name: 'Send invitation' }))
  await within(card()).findByText('Inviting people outside The Lees was turned off. Nothing was sent.')
  await waitFor(() => expect(count('GET /gatherings/g-1')).toBe(2))
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('false'))
  expect(within(card()).queryByLabelText('Email address')).toBeNull()
  expect(within(card()).getByText('Inviting people outside The Lees was turned off. Nothing was sent.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('the server’s own words')
})

test('off, the host gets no form and no roster read', async () => {
  await open(SEATS.host())
  expect(within(card()).queryByLabelText('Email address')).toBeNull()
  expect(count('GET /gatherings/g-1/invitations')).toBe(0)
})

test('one roster request per reload with the Co-hosts section open as well', async () => {
  world.roster = { pending: [PENDING_ONE], accepted: [{ id: 'inv-bea', display_name: 'Bea Test', accepted_at: '2026-11-11T12:00:00+00:00' }] }
  await open(detail({ outside_invitations: ON }))
  await within(card()).findByText('cousin.joe@example.com', { exact: false })
  fireEvent.click(screen.getByRole('button', { name: 'Show co-hosts' }))
  await screen.findByRole('list', { name: 'Invited' })
  await settle()
  expect(count('GET /gatherings/g-1/invitations')).toBe(1)
  // The Co-hosts section stays the group's: no email form of its own.
  const coHosts = screen.getByRole('region', { name: 'Co-hosts' })
  expect(within(coHosts).queryByLabelText('Email address')).toBeNull()
  expect(within(coHosts).queryByText('Waiting on')).toBeNull()
  // The address shows in Waiting on alone.
  expect(document.body.textContent?.split('cousin.joe@example.com').length).toBe(2)
})

// ---------------------------------------------------------------------------
// The line

test('the line at the top of Photos, off and on, for a member', async () => {
  await open(SEATS.member())
  const line = photos().querySelector('.sect-head + .gline') as HTMLElement
  expect(line.tagName).toBe('P')
  expect(line.textContent).toBe(LINE_OFF)
  cleanup()
  await open(detail({ caller_role: null, outside_invitations: { ...ON, may_change: false } }))
  expect(photos().querySelector('.sect-head + .gline')?.textContent).toBe(LINE_ON)
})

test('the line in the photos-only view too', async () => {
  await open(memory({ outside_invitations: { ...ON, may_change: false } }))
  expect(photos().querySelector('.sect-head + .gline')?.textContent).toBe(LINE_ON)
})

test.each([
  ['an outsider', SEATS.outsider],
  ['a standalone gathering', SEATS.standalone],
  ['a body without the three fields', SEATS.absent],
])('no line for %s', async (_name, seat) => {
  await open(seat())
  expect(photos().querySelector('.gline')).toBeNull()
  expect(document.body.textContent).not.toContain('people outside')
  expect(document.body.textContent).not.toContain('people in The Lees')
})

// ---------------------------------------------------------------------------
// The alert

test('the alert names the opener, beneath the cover card and before the actions, with no live role', async () => {
  await open(detail({ caller_role: null, outside_invitations: { ...ON, by: 'Bea Test', may_change: false }, outside_alert: true }))
  const sentence = screen.getByText(ALERT_NAMED)
  const alert = sentence.closest('.outside-alert') as HTMLElement
  expect(alert).toBeTruthy()
  expect(within(alert).getByRole('button', { name: 'Got it' })).toBeTruthy()
  const heading = screen.getByRole('heading', { level: 1, name: 'The Party' })
  const actions = document.querySelector('.gathering-actions') as HTMLElement
  expect(before(heading, alert)).toBe(true)
  expect(before(alert, actions)).toBe(true)
  expect(alert.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull()
  expect(alert.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull()
})

test('with the opener\'s account deleted the alert reads the passive form, never null', async () => {
  await open(detail({ caller_role: null, outside_invitations: { ...ON, by: null, may_change: false }, outside_alert: true }))
  expect(screen.getByText(ALERT_PASSIVE)).toBeTruthy()
  expect(document.querySelector('.outside-alert')?.textContent).not.toMatch(/null/)
})

test('the alert in the photos-only view, beneath the cover card', async () => {
  await open(memory({ outside_invitations: { ...ON, by: 'Bea Test' }, outside_alert: true }))
  const alert = screen.getByText(ALERT_NAMED).closest('.outside-alert') as HTMLElement
  expect(before(screen.getByRole('heading', { level: 1, name: 'The Party' }), alert)).toBe(true)
  expect(before(alert, photos())).toBe(true)
})

test('Got it posts the dismissal once, removes the alert with nothing re-read, and moves focus to the <h1>', async () => {
  world.hold.dismiss = gate()
  await open(detail({ caller_role: null, outside_invitations: { ...ON, by: 'Bea Test', may_change: false }, outside_alert: true }))
  const got = screen.getByRole('button', { name: 'Got it' })
  fireEvent.click(got)
  await waitFor(() => expect((got as HTMLButtonElement).disabled).toBe(true))
  fireEvent.click(got)
  await act(async () => world.hold.dismiss?.release())
  await waitFor(() => expect(screen.queryByText(ALERT_NAMED)).toBeNull())
  expect(count('POST /gatherings/g-1/outside-alert/dismiss')).toBe(1)
  expect(bodiesOf('POST /gatherings/g-1/outside-alert/dismiss')).toEqual([undefined])
  expect(count('GET /gatherings/g-1')).toBe(1)
  const heading = screen.getByRole('heading', { level: 1, name: 'The Party' })
  expect(document.activeElement).toBe(heading)
  expect(heading.getAttribute('tabindex')).toBe('-1')
  // Nothing on the device.
  expect(Object.keys(localStorage).filter((key) => key.includes('alert') || key.includes('outside'))).toEqual([])
})

test('a failed dismissal keeps the alert, with its line beside Got it', async () => {
  world.dismissStatus = 500
  await open(detail({ caller_role: null, outside_invitations: { ...ON, by: 'Bea Test', may_change: false }, outside_alert: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
  const alert = screen.getByText(ALERT_NAMED).closest('.outside-alert') as HTMLElement
  await within(alert).findByText('Something went wrong. Try again.')
  expect(screen.getByText(ALERT_NAMED)).toBeTruthy()
  expect((within(alert).getByRole('button', { name: 'Got it' }) as HTMLButtonElement).disabled).toBe(false)
})

test.each([
  ['false', { outside_alert: false }],
  ['absent', { outside_alert: undefined }],
])('no alert when outside_alert is %s', async (_name, over) => {
  await open(detail({ caller_role: null, outside_invitations: { ...ON, by: 'Bea Test', may_change: false }, ...over }))
  expect(document.querySelector('.outside-alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull()
})

// ---------------------------------------------------------------------------
// The Co-hosts section

test('an outsider\'s row in the Invited list reads From outside the group and offers no Make co-host; a member\'s row still does', async () => {
  world.roster = {
    pending: [],
    accepted: [
      { id: 'inv-bea', display_name: 'Bea Test', accepted_at: '2026-11-11T12:00:00+00:00', from_outside: false },
      { id: 'inv-joe', display_name: 'Joe Smith', accepted_at: '2026-11-11T13:00:00+00:00', from_outside: true },
    ],
  }
  await open(SEATS.host())
  fireEvent.click(screen.getByRole('button', { name: 'Show co-hosts' }))
  const list = await screen.findByRole('list', { name: 'Invited' })
  await within(list).findAllByRole('button', { name: 'Make co-host' })
  const [bea, joe] = within(list).getAllByRole('listitem')
  expect(joe.textContent).toBe(`Joe Smith · From outside ${GROUP_NAME}`)
  expect(within(joe).queryByRole('button')).toBeNull()
  expect(bea.textContent).toContain('Bea Test')
  expect(bea.textContent).not.toContain('From outside')
  expect(within(bea).getByRole('button', { name: 'Make co-host' })).toBeTruthy()
})

// ---------------------------------------------------------------------------
// An outsider's page

test('an outsider\'s crumb is Gatherings, to /gatherings — never the group', async () => {
  world.memberOfGroup = false
  await open(SEATS.outsider())
  const crumb = document.querySelector('.crumb a') as HTMLAnchorElement
  expect(crumb.getAttribute('href')).toBe('/gatherings')
  expect(crumb.textContent).toBe('Gatherings')
  expect(document.querySelector(`a[href="/groups/${GROUP.id}"]`)).toBeNull()
  expect(document.body.textContent).not.toContain('From outside')
})

test('a member\'s crumb still names the group', async () => {
  await open(SEATS.member())
  const crumb = document.querySelector('.crumb a') as HTMLAnchorElement
  expect(crumb.getAttribute('href')).toBe(`/groups/${GROUP.id}`)
  expect(crumb.textContent).toBe(GROUP_NAME)
})

test('opening a photo in the viewer reads no group for an outsider — and does for a member, the control', async () => {
  world.memberOfGroup = false
  await open(SEATS.outsider())
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 1 of 1 in The Party' }))
  await screen.findByRole('dialog')
  await settle(60)
  expect(count(`GET /groups/${GROUP.id}`)).toBe(0)
  expect(screen.queryByRole('button', { name: "Use as the group's cover" })).toBeNull()
  cleanup()
  mock.mockClear()
  world.memberOfGroup = true
  await open(SEATS.member())
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 1 of 1 in The Party' }))
  await screen.findByRole('dialog')
  await waitFor(() => expect(count(`GET /groups/${GROUP.id}`)).toBe(1))
})

test('an outsider in Rail and panel gets Home\'s panel', async () => {
  world.memberOfGroup = false
  stubWidth(true)
  chooseMenuLayout('rail')
  await open(SEATS.outsider())
  await settle(60)
  const panel = document.getElementById('frame-menu')?.querySelector('.panel') as HTMLElement
  expect(panel).toBeTruthy()
  expect(panel.querySelector('.nav-head')).toBeTruthy()
  expect(panel.querySelector('.dcover, .backrow')).toBeNull()
})

// ---------------------------------------------------------------------------
// The request log

test('the page asks for nothing new for a member: no preview, no roster, no group', async () => {
  await open(detail({ caller_role: null, outside_invitations: { ...ON, may_change: false }, outside_alert: true }))
  expect(log().filter((line) => line.includes('/outside-invitations'))).toEqual([])
  expect(count('GET /gatherings/g-1/invitations')).toBe(0)
  expect(count(`GET /groups/${GROUP.id}`)).toBe(0)
})
