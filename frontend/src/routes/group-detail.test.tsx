// CK-86 — a group's page in the mockup's shape (the mockup's screen 03;
// decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 6;
// Steven's answers of 2026-11-01). The value under test: the page is the
// cover card — the group's name, its <h1>, and *{N} people* over the scrim —
// then **New gathering** and **People**, links for every seat, then the strip
// of the group's gatherings in Your gatherings' order through the one rule,
// each card's one line the line a card's date reads everywhere, the badge on
// a coming-up card alone, a photos-only card with *You can see its photos*
// and no date or badge; its empty line and its failed read keep their words;
// nothing that moved to the People page is here, and nothing unbuilt is
// drawn; and the page reads the group and its gatherings — never the member
// list. The pins that held the members' sections on this page moved with
// them to routes/group-people.test.tsx; the CK-80 Gatherings pins moved here,
// onto the strip, each with its reason.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import appCss from '../App.css?raw'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { clearCoverPictures } from '../lib/covers'
import { formatDay, formatDayWithYear, wallClockToInstant } from '../lib/datetime'
import tokensCss from '../styles/tokens.css?raw'
import { GroupDetail } from './GroupDetail'
import groupDetailSource from './GroupDetail.tsx?raw'

// A profile zone guaranteed to differ from the runner's (CK-85's practice):
// the badge and the lines must read the PROFILE zone. Fixed-offset zones, no
// DST, so the literals hold.
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const profileZone = runnerZone === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
const at = (wallClock: string) => wallClockToInstant(wallClock, profileZone)

const person: Person = {
  id: 'person-viewer-0000',
  display_name: 'Viewer',
  email: 'viewer@example.com',
  timezone: profileZone,
  account_id: 'acct-viewer-0000',
}

const signedIn: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

const created: string[] = []

beforeEach(() => {
  created.length = 0
  Object.assign(URL, {
    createObjectURL: () => {
      const objectUrl = `blob:cover-${created.length + 1}`
      created.push(objectUrl)
      return objectUrl
    },
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  cleanup()
  clearCoverPictures()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    name: 'The Lees',
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada-7777',
    member_count: 4,
    caller_role: 'member',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    ...over,
  }
}

// The list item shape `GET /groups/{id}/gatherings` sends (the list's own).
function item(id: string, title: string, startsAt: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-a',
    host_account_id: 'acct-a',
    group: { id: 'g-1', name: 'The Lees' },
    caller_role: null,
    caller_view: 'full',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    next_occurrence: startsAt === null ? null : { id: `o-${id}`, starts_at: startsAt },
    occurrence_count: startsAt === null ? null : 1,
    ...over,
  }
}

// The photos-only item: the summary withheld — null, never 0 or a date.
function photosOnly(id: string, title: string, over: Record<string, unknown> = {}) {
  return item(id, title, null, { rsvp_list_visibility: null, caller_view: 'memory', ...over })
}

const startedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

// The server's order (newest first) is not the strip's: the strip sorts.
const STRIP = [
  item('past-2', 'Sunday Supper', at('2026-09-20T18:00')),
  photosOnly('photos-1', 'Grandpa’s birthday'),
  item('up-season', 'Spring Season', at('2035-05-06T13:00'), { gathering_type: 'season', occurrence_count: 12 }),
  item('in-progress', 'The Long Lunch', startedAnHourAgo, { gathering_type: 'hosted' }),
  item('up-biscuit', 'Biscuit Turns One', at('2035-03-01T00:30'), { gathering_type: 'simple' }),
  photosOnly('photos-2', 'The Party'),
  item('past-1', 'Fall Camping Trip', at('2026-10-03T09:00'), { gathering_type: 'simple', occurrence_count: 3 }),
]

type Responder = (init: RequestInit | undefined, path: string) => Response

// The group's page reads two things — the group and its gatherings — and the
// fake refuses anything else loudly, so a read of the member list, the link
// or anything of the People page's fails the test that made it.
function stubServer(over: { group?: Responder; gatherings?: Responder } = {}) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const full = String(url)
    if (full.startsWith('https://r2.invalid/')) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    }
    const path = full.replace(/^https?:\/\/[^/]+/, '')
    if (method === 'GET' && path === '/groups/g-1') {
      return Promise.resolve((over.group ?? (() => json(200, group())))(init, path))
    }
    if (method === 'GET' && path === '/groups/g-1/gatherings') {
      return Promise.resolve((over.gatherings ?? (() => json(200, { gatherings: [] })))(init, path))
    }
    if (method === 'GET' && path.includes('/cover/url?layer=')) {
      return Promise.resolve(
        json(200, {
          layer: 'thumbnail',
          content_type: 'image/webp',
          size_bytes: 3,
          url: 'https://r2.invalid/coveykeep-dev/covers/x/thumbnail?X-Amz-Signature=sig1',
          method: 'GET',
          expires_in: 300,
        }),
      )
    }
    throw new Error(`no stub for ${method} ${path}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function paths(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
}

const GET_GATHERINGS = (mock: ReturnType<typeof vi.fn>) =>
  paths(mock).filter((path) => path === '/groups/g-1/gatherings').length
const GET_GROUP = (mock: ReturnType<typeof vi.fn>) => paths(mock).filter((path) => path === '/groups/g-1').length

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/groups/g-1']}>
      <AuthContext.Provider value={signedIn}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'The Lees' })
}

function coverCard(): HTMLElement {
  const card = document.querySelector('.cover-card')
  if (!(card instanceof HTMLElement)) throw new Error('no cover card')
  return card
}

function stripRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Gatherings' })
}

async function strip(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: "The group's gatherings" })
}

const titles = (list: HTMLElement) => within(list).getAllByRole('link').map((link) => link.textContent)
const cardOf = (title: string) => screen.getByRole('link', { name: title }).closest('article') as HTMLElement
const linesOf = (card: Element) => [...card.querySelectorAll('p')].map((line) => line.textContent)

const FORBIDDEN = /\bsafe|secure|private|forever|backed up|\bevents?\b|claim/i

// ---------------------------------------------------------------------------
// The cover card.
// ---------------------------------------------------------------------------

test('the cover card at the mockup’s measure: the group’s name, the page’s <h1>, and {N} people over the scrim — the count’s line gone from beneath it', async () => {
  stubServer()
  renderPage()
  const heading = await loaded()
  const card = coverCard()
  expect(card.classList.contains('cover-card-wide')).toBe(true)
  expect(heading.closest('.cover-over')).toBe(card.querySelector('.cover-over'))
  const meta = within(card).getByText('4 people')
  expect(meta.closest('.cover-over')).toBe(card.querySelector('.cover-over'))
  expect(meta.classList.contains('cover-card-meta')).toBe(true)
  // The heading reads first; the count after it.
  expect(heading.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // Nothing about the count, or the caller's role, beneath the card.
  expect(screen.getAllByText('4 people')).toHaveLength(1)
  expect(screen.queryByText(/You're the admin\.|You're a co-admin\./)).toBeNull()
  // No cover set: the empty cover and its line on the card.
  expect(within(card).getByText('No cover photo yet')).toBeTruthy()
})

test('one person: the meta line reads 1 person', async () => {
  stubServer({ group: () => json(200, group({ member_count: 1 })) })
  renderPage()
  await loaded()
  expect(within(coverCard()).getByText('1 person')).toBeTruthy()
})

test('a set cover is drawn on the card at the web layer, from a blob: URL', async () => {
  const mock = stubServer({
    group: () => json(200, group({ cover: { source: 'upload', set_at: '2026-11-01T10:00:00+00:00' } })),
  })
  renderPage()
  await loaded()
  await waitFor(() => expect(coverCard().querySelector('.cover-photo > img')?.getAttribute('src')).toMatch(/^blob:/))
  expect(paths(mock).filter((path) => path.includes('/cover/url'))).toEqual(['/groups/g-1/cover/url?layer=web'])
  expect(document.body.innerHTML).not.toMatch(/X-Amz|r2\.invalid/)
})

// ---------------------------------------------------------------------------
// The actions.
// ---------------------------------------------------------------------------

for (const [seat, role] of [
  ['the admin', 'admin'],
  ['a co-admin', 'co_admin'],
  ['a member', 'member'],
  ['an unknown role', 'owner'],
] as const) {
  test(`${seat}: New gathering, the primary pill, and People, the quiet one, beneath the card — both links`, async () => {
    stubServer({ group: () => json(200, group({ caller_role: role })) })
    renderPage()
    await loaded()
    await screen.findByText('No gatherings in this group yet.')
    const newGathering = screen.getByRole('link', { name: 'New gathering' })
    const people = screen.getByRole('link', { name: 'People' })
    expect(newGathering.getAttribute('href')).toBe('/groups/g-1/gatherings/new')
    expect(people.getAttribute('href')).toBe('/groups/g-1/people')
    expect(newGathering.classList.contains('btn-primary')).toBe(true)
    expect(people.classList.contains('btn')).toBe(true)
    expect(people.classList.contains('btn-primary')).toBe(false)
    // Each with its icon, decorative.
    for (const link of [newGathering, people]) {
      expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }
    // Side by side, after the card and before the strip.
    expect(newGathering.parentElement).toBe(people.parentElement)
    expect(newGathering.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(coverCard().compareDocumentPosition(newGathering) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(newGathering.compareDocumentPosition(stripRegion()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
}

// ---------------------------------------------------------------------------
// The strip.
// ---------------------------------------------------------------------------

test('the strip’s order is the one rule’s: coming up soonest first, then past most recent first — a date in progress past — then the photos-only cards in the server’s order', async () => {
  const mock = stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  renderPage()
  await loaded()
  const list = await strip()
  expect(titles(list)).toEqual([
    'Biscuit Turns One',
    'Spring Season',
    'The Long Lunch',
    'Fall Camping Trip',
    'Sunday Supper',
    'Grandpa’s birthday',
    'The Party',
  ])
  expect(GET_GATHERINGS(mock)).toBe(1)
  expect(stripRegion().querySelector('h2')?.textContent).toBe('Gatherings')
})

test('each card: its title an <h3> holding the card’s one link, and ONE line — the line a card’s date reads everywhere — with no group line', async () => {
  stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  renderPage()
  await loaded()
  await strip()
  expect(linesOf(cardOf('Biscuit Turns One'))).toEqual(['Thu, Mar 1 · 12:30 AM'])
  expect(linesOf(cardOf('Spring Season'))).toEqual(['12 dates · next Sun, May 6'])
  expect(linesOf(cardOf('Fall Camping Trip'))).toEqual(['Oct 3, 2026'])
  expect(linesOf(cardOf('Sunday Supper'))).toEqual(['Sep 20, 2026'])
  expect(linesOf(cardOf('The Long Lunch'))).toEqual([formatDayWithYear(startedAnHourAgo, profileZone)])
  expect(linesOf(cardOf('The Party'))).toEqual(['You can see its photos'])
  for (const title of ['Biscuit Turns One', 'The Party']) {
    const card = cardOf(title)
    const links = within(card).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].closest('h3')).toBeTruthy()
    expect(card.classList.contains('cover-tile')).toBe(true)
  }
  expect(screen.getByRole('link', { name: 'Biscuit Turns One' }).getAttribute('href')).toBe('/gatherings/up-biscuit')
  // Every card is this group's: no card names it, nor *Not in a group*.
  expect((await strip()).textContent).not.toMatch(/The Lees|Not in a group/)
})

// CK-87's rider (Steven): a card in the strip is 168px wide, and its date
// line broke inside a date — *3 dates · next Thu, Dec* / *24* in CK-86's
// screenshot. Each date and each time is in an element that does not wrap;
// the line's text is unchanged, character for character.
test('every date and time on a strip card is kept whole — in a no-wrap element — and every line reads exactly as before', async () => {
  stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  renderPage()
  await loaded()
  await strip()
  const line = (title: string) => cardOf(title).querySelector('.cover-meta') as HTMLElement
  const kept = (title: string) => [...line(title).querySelectorAll('.nowrap')].map((piece) => piece.textContent)
  expect(line('Biscuit Turns One').textContent).toBe('Thu, Mar 1 · 12:30 AM')
  expect(kept('Biscuit Turns One')).toEqual(['Thu, Mar 1', '12:30 AM'])
  expect(line('Spring Season').textContent).toBe('12 dates · next Sun, May 6')
  expect(kept('Spring Season')).toEqual(['Sun, May 6'])
  expect(kept('Fall Camping Trip')).toEqual(['Oct 3, 2026'])
  expect(line('The Party').textContent).toBe('You can see its photos')
  expect(kept('The Party')).toEqual([])
})

test('the date badge on a coming-up card alone, its month and day in the profile zone — forced to differ from the runner’s', async () => {
  stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  renderPage()
  await loaded()
  await strip()
  const badge = cardOf('Biscuit Turns One').querySelector('.cover-date') as HTMLElement
  expect(badge.getAttribute('aria-hidden')).toBe('true')
  expect([badge.querySelector('.cover-date-m')?.textContent, badge.querySelector('.cover-date-d')?.textContent]).toEqual(['Mar', '1'])
  expect(formatDay(at('2035-03-01T00:30'), runnerZone)).not.toBe('Mar 1')
  expect(cardOf('Spring Season').querySelector('.cover-date')).toBeTruthy()
  for (const title of ['The Long Lunch', 'Fall Camping Trip', 'Sunday Supper', 'Grandpa’s birthday', 'The Party']) {
    expect(cardOf(title).querySelector('.cover-date'), title).toBeNull()
  }
})

test('a photos-only card says You can see its photos and carries no date and no badge — even one whose body carries a date it should not', async () => {
  // A view this build does not know reads as photos-only, and its date is
  // never read (the CK-80 Gotcha).
  const carried = item('photos-3', 'Kept a surprise', at('2035-04-01T12:00'), { caller_view: 'later' })
  stubServer({ gatherings: () => json(200, { gatherings: [carried] }) })
  renderPage()
  await loaded()
  await strip()
  const card = cardOf('Kept a surprise')
  expect(linesOf(card)).toEqual(['You can see its photos'])
  expect(card.querySelector('.cover-date')).toBeNull()
  expect(card.textContent).not.toMatch(/Apr|\d{4}|AM|PM/)
  // No date on screen: no times hint.
  expect(within(stripRegion()).queryByText(/Times in/)).toBeNull()
})

test('Times in {zone}. beneath the strip’s label while a date is on screen', async () => {
  stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  renderPage()
  await loaded()
  await strip()
  const hint = within(stripRegion()).getByText(`Times in ${profileZone}.`)
  expect(stripRegion().querySelector('h2')?.compareDocumentPosition(hint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

test('every card at the thumbnail layer, the empty cover where none is set — never the web layer, never archival', async () => {
  const mock = stubServer({
    gatherings: () =>
      json(200, {
        gatherings: [
          item('up-biscuit', 'Biscuit Turns One', at('2035-03-01T00:30'), {
            cover: { source: 'photo', media_id: 'm-1', set_at: '2026-11-01T10:00:00+00:00' },
          }),
          photosOnly('photos-1', 'The Party', { cover: { source: 'upload', set_at: '2026-11-01T10:00:00+00:00' } }),
          item('past-1', 'Fall Camping Trip', at('2026-10-03T09:00')),
        ],
      }),
  })
  renderPage()
  await loaded()
  await strip()
  await waitFor(() => expect(cardOf('Biscuit Turns One').querySelector('.cover-frame > img')?.getAttribute('src')).toMatch(/^blob:/))
  await waitFor(() => expect(cardOf('The Party').querySelector('.cover-frame > img')?.getAttribute('src')).toMatch(/^blob:/))
  expect(within(cardOf('Fall Camping Trip')).getByText('No cover photo yet')).toBeTruthy()
  expect(paths(mock).filter((path) => path.includes('/cover/url')).sort()).toEqual([
    '/gatherings/photos-1/cover/url?layer=thumbnail',
    '/gatherings/up-biscuit/cover/url?layer=thumbnail',
  ])
  expect(document.body.innerHTML).not.toMatch(/X-Amz|r2\.invalid|archival/)
})

// MOVED AT CK-86 from the group page's CK-80 Gatherings section, with its
// reason: the section is the strip now — the same read, the same words in the
// strip's place — and New gathering stands in the actions above it.
for (const [seat, role] of [
  ['the admin', 'admin'],
  ['a co-admin', 'co_admin'],
  ['a member', 'member'],
] as const) {
  test(`with none: "No gatherings in this group yet." in the strip’s place, and no list — for ${seat} too`, async () => {
    stubServer({ group: () => json(200, group({ caller_role: role })) })
    renderPage()
    await loaded()
    const region = stripRegion()
    expect(await within(region).findByText('No gatherings in this group yet.')).toBeTruthy()
    expect(within(region).queryByRole('list')).toBeNull()
    expect(within(region).queryByText(/Times in/)).toBeNull()
  })
}

// MOVED AT CK-86, with its reason: the same failed read and Try again, in the
// strip's place; the rest of the page — the card and the actions — stands.
test('a failed read fails in the strip’s place: the line and Try again, which re-reads once per press, and a read that succeeds renders the strip — the rest of the page untouched', async () => {
  let fail = true
  const mock = stubServer({
    gatherings: () => (fail ? json(500, {}) : json(200, { gatherings: [item('past-1', 'Fall Camping Trip', at('2026-10-03T09:00'))] })),
  })
  renderPage()
  await loaded()
  const region = stripRegion()
  const alert = await within(region).findByRole('alert')
  expect(alert.textContent).toBe("⚠ The group's gatherings couldn't be loaded just now.")
  expect(screen.getByRole('link', { name: 'New gathering' })).toBeTruthy()
  expect(GET_GATHERINGS(mock)).toBe(1)
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(GET_GATHERINGS(mock)).toBe(2))
  expect(await within(region).findByRole('alert')).toBeTruthy()
  fail = false
  fireEvent.click(within(region).getByRole('button', { name: 'Try again' }))
  await strip()
  expect(GET_GATHERINGS(mock)).toBe(3)
  expect(within(region).queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(GET_GROUP(mock)).toBe(1)
})

// ---------------------------------------------------------------------------
// What is not here.
// ---------------------------------------------------------------------------

test('none of what moved to the People page — no Members, no requests, no link, no rename, no leave, no role line — and nothing unbuilt: no Add photos, chat, Kept by, pin, faces, Active or Photos', async () => {
  for (const role of ['admin', 'co_admin', 'member']) {
    stubServer({ group: () => json(200, group({ caller_role: role })), gatherings: () => json(200, { gatherings: STRIP }) })
    const view = renderPage()
    await loaded()
    await strip()
    const text = document.body.textContent ?? ''
    for (const moved of [
      'Members',
      'Requests to join',
      'Invite people',
      'Share the link',
      'Rename the group',
      'Leave this group',
      "You're the admin.",
      "You're a co-admin.",
      'Back to your groups',
    ]) {
      expect(text, `${role}: ${moved}`).not.toContain(moved)
    }
    expect(screen.queryByLabelText('Group name')).toBeNull()
    expect(text).not.toMatch(/Add photos|Open chat|\bChat\b|Message |Kept by|Offer to keep|Active .* ago|\bPin\b|Unpin|No photos yet|newest first/)
    expect(screen.queryByRole('heading', { name: 'Photos' })).toBeNull()
    expect(document.querySelector('.faces, .avatar, .member-initials')).toBeNull()
    // The page's headings: the name, then the strip's label.
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['The Lees', 'Gatherings']),
    )
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Gatherings'])
    expect(text).not.toMatch(FORBIDDEN)
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('no member read: the page reads the group and its gatherings and nothing else — never the member list, the link or the requests', async () => {
  for (const role of ['admin', 'member']) {
    const mock = stubServer({ group: () => json(200, group({ caller_role: role })), gatherings: () => json(200, { gatherings: STRIP }) })
    const view = renderPage()
    await loaded()
    await strip()
    expect(paths(mock).sort()).toEqual(['/groups/g-1', '/groups/g-1/gatherings'])
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('the page’s source asks for no member list and none of the People page’s reads, and spells no product name', () => {
  const code = groupDetailSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  expect(code).not.toMatch(/readMembers|readLink|readJoinRequests|readGroupInvitations|membership_id/)
  expect(groupDetailSource).not.toMatch(/covey ?keep/i)
})

test('nothing identifying in the markup: the group’s id only in the two actions’ hrefs, and no person or account id anywhere', async () => {
  stubServer({ gatherings: () => json(200, { gatherings: STRIP }) })
  const view = renderPage()
  await loaded()
  await strip()
  let markup = view.container.innerHTML
  for (const href of ['href="/groups/g-1/gatherings/new"', 'href="/groups/g-1/people"']) {
    expect(markup.split(href)).toHaveLength(2)
    markup = markup.replace(href, '')
  }
  for (const id of ['g-1', 'person-ada-7777', 'acct-a', 'acct-viewer-0000', 'person-viewer-0000']) {
    expect(markup).not.toContain(id)
  }
})

// ---------------------------------------------------------------------------
// Not found, and a failed read — the page's own screens, word for word.
// ---------------------------------------------------------------------------

async function notFoundMarkup(respond: Responder): Promise<string> {
  stubServer({ group: respond })
  const view = renderPage()
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  const markup = view.container.innerHTML
  cleanup()
  vi.unstubAllGlobals()
  return markup
}

test('a 404 on the group is the one not-found screen — a path 422 the same — and asks for no member list', async () => {
  const missing = await notFoundMarkup(() => json(404, { detail: 'No such group.' }))
  const notAnId = await notFoundMarkup(() => json(422, { detail: [] }))
  expect(notAnId).toBe(missing)

  const mock = stubServer({ group: () => json(404, { detail: 'No such group.' }) })
  renderPage()
  await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
  expect(screen.getByText("There's no group to show at this address.")).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  expect(screen.queryByRole('button')).toBeNull()
  expect(paths(mock)).not.toContain('/groups/g-1/members')
})

test('a failed read says so and can be retried: Try again re-reads the group once per press, and a read that succeeds renders the page', async () => {
  let fail = true
  const mock = stubServer({ group: () => (fail ? json(500, {}) : json(200, group())) })
  renderPage()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Something went wrong loading this group.')
  expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
  expect(GET_GROUP(mock)).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(GET_GROUP(mock)).toBe(2))
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong loading this group.')
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await loaded()
  expect(GET_GROUP(mock)).toBe(3)
})

// ---------------------------------------------------------------------------
// The page column and the styles.
// ---------------------------------------------------------------------------

test('the page takes the mockup’s page column', async () => {
  stubServer()
  renderPage()
  const heading = await loaded()
  expect(heading.closest('main')?.classList.contains('page-column')).toBe(true)
})

test('the group page’s styles name no colour and add no token, and hold the mockup’s measures — the strip at every width', () => {
  const start = appCss.indexOf("/* ---------- a group's page and its People page (CK-86")
  expect(start).toBeGreaterThan(-1)
  const end = appCss.indexOf('/* ----------', start + 10)
  const section = appCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const selector of ['.cover-card-wide', '.group-actions', '.strip-label', '.cover-strip', '.crumb', '.people-screen']) {
    expect(section).toContain(selector)
  }
  expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  const used = [...new Set([...section.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  for (const name of used) expect(tokensCss, name).toMatch(new RegExp(`${name}\\s*:`))
  // The card's three measures — 3:1 from 640px, the title's clamp, the
  // scrim's padding — the strip's 168px cards and scroll snap, the People
  // page's reading width.
  expect(section).toMatch(/aspect-ratio: 3 \/ 1/)
  expect(section).toMatch(/font-size: clamp\(2rem, 1\.4rem \+ 2\.6vw, 3\.25rem\)/)
  expect(section).toMatch(/padding: clamp\(16px, 4vw, 32px\)/)
  expect(section).toMatch(/flex: 0 0 168px/)
  expect(section).toMatch(/scroll-snap-type: x mandatory/)
  expect(section).toMatch(/max-width: 720px/)
  // The mockup hides its strip from 900px; this app shows it at every width.
  expect(section).not.toMatch(/display: none/)
})
