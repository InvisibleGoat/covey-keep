// CK-84 — the cover component, and the menu reading through the cache. The
// value under test: no cover (null or absent) is the empty cover — the quail
// in the ring mat on a thumbnail, the quail and *No cover photo yet* on the
// card — and asks for nothing; a cover is fetched once, at the variant's
// layer (thumbnail or web, never archival), and drawn from a `blob:` URL
// with `alt=""`; while it loads, and when it fails, the ground shows alone —
// no quail, no words; a 409 `no_cover` is the empty cover; a new `set_at`
// fetches again; the presigned URL is in no markup and no second request;
// and in the menu every row's thumbnail is its cover, a re-read after a
// navigation fetches no picture already held, and a cover act announced by
// a page re-reads the lists at once. Since CK-87.1, the empty cover on the
// wide card is a row in the flow: its markup, Change cover kept the same
// element across a set and a clear, and the rules that lay it with no fixed
// inset.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { announceCoverChange, clearCoverPictures, type CoverBody } from '../lib/covers'
import appCss from '../App.css?raw'
import tokensCss from '../styles/tokens.css?raw'
import { Cover, DateBadge } from './Cover'
import coverSource from './Cover.tsx?raw'
import { Menu } from './Menu'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const signed = (layer: string, n: number) =>
  `https://r2.invalid/coveykeep-dev/covers/ci-${n}/${layer}?X-Amz-Credential=SERVEKEYID%2F20261101&X-Amz-Signature=sig${n}`

const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  created.length = 0
  revoked.length = 0
  Object.assign(URL, {
    createObjectURL: () => {
      const objectUrl = `blob:cover-${created.length + 1}`
      created.push(objectUrl)
      return objectUrl
    },
    revokeObjectURL: (objectUrl: string) => {
      revoked.push(objectUrl)
    },
  })
})

afterEach(() => {
  cleanup()
  clearCoverPictures()
  vi.unstubAllGlobals()
})

type Mint = (path: string, n: number) => Response | Promise<Response>

// The cover URL routes and the bucket. `mint` answers a cover URL request;
// by default a fresh presigned GET each time.
function stubServer(over: { mint?: Mint; routes?: Record<string, () => Response> } = {}) {
  let mints = 0
  const mock = vi.fn(async (url: string, _init?: RequestInit) => {
    const full = String(url)
    if (full.startsWith('https://r2.invalid/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    const path = full.replace(/^https?:\/\/[^/]+/, '')
    if (path.includes('/cover/url?layer=')) {
      mints += 1
      if (over.mint) return over.mint(path, mints)
      const layer = path.endsWith('web') ? 'web' : 'thumbnail'
      return json(200, { layer, content_type: 'image/webp', size_bytes: 3, url: signed(layer, mints), method: 'GET', expires_in: 300 })
    }
    const route = over.routes?.[path]
    if (route) return route()
    return json(404, {})
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function paths(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([url]) => String(url).replace(/^https?:\/\/[^/]+/, ''))
}

const COVER: CoverBody = { source: 'upload', set_at: '2026-11-01T10:00:00+00:00' }

// ---------------------------------------------------------------------------
// The component.
//
// MOVED AT CK-87, with its reason: the five tests below drew the page's
// cover card as the `card` variant, the column-width card a gathering's page
// used until CK-87 put that page at the mockup's measure; the `card` variant
// went with its last user, and the page card is the `wide` variant alone. The
// card's states are the same on it — the empty cover, the picture at the web
// layer, the ground, a 409 — so each test now draws the `wide` card and
// asserts what it asserted.
// ---------------------------------------------------------------------------

test('no cover — null or absent — is the empty cover: the quail in the ring mat on a thumbnail, the quail and its line on the card; nothing is asked for', async () => {
  const mock = stubServer()
  for (const cover of [null, undefined]) {
    const thumb = render(<Cover subject="group" id="grp-1" cover={cover} variant="thumb" />)
    const empty = thumb.container.querySelector('.noimg.nthumb')
    expect(empty?.getAttribute('aria-hidden')).toBe('true')
    expect(empty?.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(empty?.querySelector('img')?.getAttribute('src')).toBe('/img/covey-keep-quail-640.webp')
    thumb.unmount()

    const card = render(
      <Cover subject="gathering" id="g-1" cover={cover} variant="wide">
        <h1>The Party</h1>
      </Cover>,
    )
    const line = card.getByText('No cover photo yet')
    expect(line.closest('.cover-empty')?.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(card.getByRole('heading', { level: 1, name: 'The Party' })).toBeTruthy()
    card.unmount()
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mock).not.toHaveBeenCalled()
})

test('a set cover is fetched once at the variant’s layer — thumbnail for the thumbnail, web for the card — and drawn from a blob: URL with alt=""', async () => {
  const mock = stubServer()
  const thumb = render(<Cover subject="group" id="grp-1" cover={COVER} variant="thumb" />)
  await waitFor(() => expect(thumb.container.querySelector('img.nthumb')).toBeTruthy())
  const img = thumb.container.querySelector('img.nthumb')
  expect(img?.getAttribute('src')).toBe('blob:cover-1')
  expect(img?.getAttribute('alt')).toBe('')
  expect(thumb.container.querySelector('.noimg')).toBeNull()

  const card = render(
    <Cover subject="gathering" id="g-1" cover={COVER} variant="wide">
      <h1>The Party</h1>
    </Cover>,
  )
  await waitFor(() => expect(card.container.querySelector('.cover-photo > img')).toBeTruthy())
  expect(card.container.querySelector('.cover-photo > img')?.getAttribute('src')).toBe('blob:cover-2')
  expect(card.container.querySelector('.cover-photo > img')?.getAttribute('alt')).toBe('')
  expect(card.queryByText('No cover photo yet')).toBeNull()
  expect(paths(mock).filter((p) => p.includes('/cover/url'))).toEqual([
    '/groups/grp-1/cover/url?layer=thumbnail',
    '/gatherings/g-1/cover/url?layer=web',
  ])
})

test('while a set cover loads, and when it fails, the ground shows alone — no quail and no words', async () => {
  const gate: { release?: () => void } = {}
  stubServer({
    mint: async (_path, n) => {
      if (n === 1) await new Promise<void>((resolve) => (gate.release = resolve))
      return json(500, {})
    },
  })
  const thumb = render(<Cover subject="group" id="grp-1" cover={COVER} variant="thumb" />)
  const card = render(
    <Cover subject="gathering" id="g-1" cover={COVER} variant="wide">
      <h1>The Party</h1>
    </Cover>,
  )
  // Loading.
  expect(thumb.container.querySelector('.cover-ground.nthumb')).toBeTruthy()
  expect(thumb.container.querySelector('img')).toBeNull()
  await waitFor(() => expect(card.container.querySelector('.cover-photo')).toBeTruthy())
  expect(card.container.querySelector('.cover-photo img')).toBeNull()
  expect(card.queryByText('No cover photo yet')).toBeNull()
  // Failed (the card's 500 lands first; the thumbnail's when released).
  await act(async () => {
    gate.release?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(thumb.container.querySelector('.cover-ground.nthumb')).toBeTruthy()
  expect(thumb.container.querySelector('img')).toBeNull()
  expect(card.container.querySelector('.cover-photo img')).toBeNull()
  expect(card.queryByText('No cover photo yet')).toBeNull()
  expect(card.getByRole('heading', { level: 1, name: 'The Party' })).toBeTruthy()
})

test('a picture the browser cannot draw falls back to the ground', async () => {
  stubServer()
  const thumb = render(<Cover subject="group" id="grp-1" cover={COVER} variant="thumb" />)
  await waitFor(() => expect(thumb.container.querySelector('img.nthumb')).toBeTruthy())
  fireEvent.error(thumb.container.querySelector('img.nthumb') as HTMLImageElement)
  expect(thumb.container.querySelector('img')).toBeNull()
  expect(thumb.container.querySelector('.cover-ground')).toBeTruthy()
})

test('a 409 no_cover — cleared since the body was read — is the empty cover', async () => {
  stubServer({ mint: () => json(409, { detail: { code: 'no_cover', message: "there's no cover to show yet" } }) })
  const thumb = render(<Cover subject="group" id="grp-1" cover={COVER} variant="thumb" />)
  const card = render(
    <Cover subject="group" id="grp-1" cover={COVER} variant="wide">
      <h1>The Lees</h1>
    </Cover>,
  )
  await waitFor(() => expect(thumb.container.querySelector('.noimg.nthumb')).toBeTruthy())
  expect(await card.findByText('No cover photo yet')).toBeTruthy()
})

test('a new set_at fetches again, and the older picture is revoked', async () => {
  const mock = stubServer()
  const view = render(<Cover subject="gathering" id="g-1" cover={COVER} variant="thumb" />)
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1'))
  view.rerender(
    <Cover subject="gathering" id="g-1" cover={{ source: 'photo', media_id: 'm-9', set_at: '2026-11-01T11:00:00+00:00' }} variant="thumb" />,
  )
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-2'))
  expect(revoked).toEqual(['blob:cover-1'])
  expect(paths(mock).filter((p) => p.includes('/cover/url'))).toHaveLength(2)
  // The same version again: nothing fetched.
  view.rerender(
    <Cover subject="gathering" id="g-1" cover={{ source: 'photo', media_id: 'm-9', set_at: '2026-11-01T11:00:00+00:00' }} variant="thumb" />,
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(paths(mock).filter((p) => p.includes('/cover/url'))).toHaveLength(2)
})

test('THE PRESIGNED URL is spent on one fetch: it appears in no markup and no other request, and the bucket fetch sends no credentials', async () => {
  const mock = stubServer()
  const view = render(
    <>
      <Cover subject="group" id="grp-1" cover={COVER} variant="thumb" />
      <Cover subject="group" id="grp-1" cover={COVER} variant="wide">
        <h1>The Lees</h1>
      </Cover>
    </>,
  )
  await waitFor(() => expect(view.container.querySelectorAll('img[src^="blob:"]')).toHaveLength(2))
  expect(view.container.innerHTML).not.toMatch(/X-Amz|r2\.invalid|Signature/)
  for (const n of [1, 2]) {
    const url = mock.mock.calls.filter(([u]) => String(u).includes(`ci-${n}/`))
    expect(url).toHaveLength(1)
    expect((url[0][1] as RequestInit).credentials).toBe('omit')
    expect(new Headers((url[0][1] as RequestInit).headers).has('Authorization')).toBe(false)
  }
  for (const [u, init] of mock.mock.calls) {
    if (String(u).startsWith('https://r2.invalid/')) continue
    expect(`${String(u)} ${JSON.stringify(init ?? {})}`).not.toMatch(/X-Amz|r2\.invalid/)
  }
})

test('the component asks only for the two served layers and keeps no presigned URL — its source names neither archival nor a url field', () => {
  const code = coverSource.replace(/\/\/.*$/gm, '')
  expect(code).not.toMatch(/archival/)
  expect(code).not.toMatch(/\.url\b/)
  // MOVED AT CK-85, with its reason: two variants joined — the featured card
  // (`hero`) and the grid card (`tile`) — so the layer is read from one table
  // by the variant, rather than one comparison. The rule is the same: the
  // web layer for a card or a hero, the thumbnail for a thumb or a tile.
  // MOVED AT CK-86, with its reason: the `wide` card joined — a group page's
  // cover card at the mockup's measure — and it reads the web layer, as the
  // card does. The rule is the same.
  // MOVED AT CK-87, with its reason: the `card` variant is retired — a
  // gathering's page, its last user, takes the `wide` card — so its row
  // left the table. The rule is the same; the pin also holds that no `card`
  // variant is left to draw.
  expect(code).toMatch(/const LAYER: Record<CoverVariant, ServableLayer> = \{/)
  expect(code).toMatch(/thumb: 'thumbnail',\s*tile: 'thumbnail',\s*wide: 'web',\s*hero: 'web',\s*\}/)
  expect(code).toMatch(/export type CoverVariant = 'thumb' \| 'wide' \| 'hero' \| 'tile'$/m)
  expect(code).not.toMatch(/'card'/)
  expect(code).toMatch(/const layer = LAYER\[variant\]/)
})

test('the covers’ styles name no colour and add no token: every var() they read is one the token file already defines', () => {
  const start = appCss.indexOf('/* ---------- covers (CK-84')
  expect(start).toBeGreaterThan(-1)
  const end = appCss.indexOf('/* ----------', start + 10)
  const section = appCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  expect(section).toMatch(/\.cover-card\b/)
  expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  const used = [...new Set([...section.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  expect(used).toEqual(
    expect.arrayContaining(['--ck-empty', '--ck-scrim', '--ck-on-photo', '--ck-frost', '--ck-frost-ink', '--mat']),
  )
  for (const name of used) expect(tokensCss, name).toMatch(new RegExp(`${name}\\s*:`))
})

// ---------------------------------------------------------------------------
// The empty cover on the wide card, a row in the flow (CK-87.1). jsdom lays
// nothing out, so the layout's proof is the report's matrix — every width
// from 320 to 1440, each box measured in Chrome; these pin the markup the
// layout stands on and the rules that lay it.
// ---------------------------------------------------------------------------

const BADGE_AT = '2035-03-01T12:00:00+00:00'

function wideCard(cover: CoverBody | null, { badge = true, action = true } = {}) {
  return (
    <Cover
      subject="gathering"
      id="g-1"
      cover={cover}
      variant="wide"
      badge={badge ? <DateBadge startsAt={BADGE_AT} zone="UTC" /> : undefined}
      action={action ? <button type="button" className="cover-change">Change cover</button> : undefined}
    >
      <h1>The Party</h1>
    </Cover>
  )
}

const shape = (parent: Element) =>
  Array.from(parent.children).map((child) => `${child.tagName.toLowerCase()}${child.className ? `.${child.className}` : ''}`)

test('THE EMPTY COVER’S ROW: with no cover the badge and the empty cover share .cover-lead, Change cover is the picture’s last child, and the words read first; with a cover set there is no lead — the picture, the badge and Change cover each the picture’s own', async () => {
  stubServer()
  const empty = render(wideCard(null))
  const photo = empty.container.querySelector('.cover-card-wide > .cover-photo') as HTMLElement
  expect(shape(photo)).toEqual(['div.cover-over', 'div.cover-lead', 'button.cover-change'])
  const lead = photo.querySelector(':scope > .cover-lead') as HTMLElement
  expect(shape(lead)).toEqual(['span.cover-date', 'span.cover-empty'])
  expect(lead.querySelector('.cover-date')?.getAttribute('aria-hidden')).toBe('true')
  expect(lead.querySelector('.cover-empty img')?.getAttribute('alt')).toBe('')
  expect(lead.querySelector('.cover-empty > span')?.textContent).toBe('No cover photo yet')
  // Nothing of the card sits outside the picture now (Change cover followed
  // it in the card until CK-87.1).
  expect(shape(empty.container.querySelector('.cover-card-wide') as HTMLElement)).toEqual(['div.cover-photo'])
  // The reading order: the heading, the line, Change cover — the badge and
  // the quail are decorative.
  expect(photo.textContent).toBe('The PartyMar1No cover photo yetChange cover')
  empty.unmount()

  // No badge and no Change cover (a member, the photos-only view): the lead
  // holds the empty cover alone.
  const bare = render(wideCard(null, { badge: false, action: false }))
  const barePhoto = bare.container.querySelector('.cover-photo') as HTMLElement
  expect(shape(barePhoto)).toEqual(['div.cover-over', 'div.cover-lead'])
  expect(shape(barePhoto.querySelector('.cover-lead') as HTMLElement)).toEqual(['span.cover-empty'])
  bare.unmount()

  // A cover set: the CK-86 and CK-87 shape — the picture, the badge over its
  // corner, Change cover — with no lead and no empty cover.
  const set = render(wideCard(COVER))
  await waitFor(() => expect(set.container.querySelector('.cover-photo > img')).toBeTruthy())
  expect(shape(set.container.querySelector('.cover-photo') as HTMLElement)).toEqual([
    'div.cover-over',
    'img',
    'span.cover-date',
    'button.cover-change',
  ])
  expect(set.container.querySelector('.cover-lead')).toBeNull()
  expect(set.queryByText('No cover photo yet')).toBeNull()
})

test('Change cover is the same element, keeping the person’s focus, when a cover is set or cleared — the empty cover’s row never remounts it', async () => {
  stubServer()
  const card = render(wideCard(null))
  const button = card.getByRole('button', { name: 'Change cover' })
  button.focus()
  card.rerender(wideCard(COVER))
  await waitFor(() => expect(card.container.querySelector('.cover-photo > img')).toBeTruthy())
  expect(card.getByRole('button', { name: 'Change cover' })).toBe(button)
  expect(document.activeElement).toBe(button)
  card.rerender(wideCard(null))
  expect(card.getByText('No cover photo yet')).toBeTruthy()
  expect(card.getByRole('button', { name: 'Change cover' })).toBe(button)
  expect(document.activeElement).toBe(button)
})

test('the empty cover’s row is laid by the flow, never by fixed insets — the 72px, 148px and 56px are gone — and its rules name no colour and add no token; Change cover keeps its 44px', () => {
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
  // Until CK-87.1: the row laid over the picture (`position: absolute`), 72px
  // in beside the badge, 148px clear of Change cover, the words 56px down.
  expect(css).not.toMatch(/padding-right: 148px/)
  expect(css).not.toMatch(/padding-left: 72px/)
  expect(css).not.toMatch(/padding-top: 56px/)
  expect(css).not.toMatch(/\.cover-card-wide \.cover-empty\s*\{/)
  expect(css).not.toMatch(/:has\(> \.cover-empty\)/)
  // The badge's 64px keeps the words below it over a cover alone: it reads
  // the badge as the picture's own child, which on an empty cover it is not.
  expect(css).toMatch(/\.cover-card-wide \.cover-photo:has\(> \.cover-date\) > \.cover-over \{\s*padding-top: 64px;\s*\}/)

  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start) + 1)
  }
  // The picture is two rows — the empty cover's row, then the words — and the
  // row two columns, the lead and Change cover's own.
  const photo = rule('.cover-card-wide .cover-photo:has(> .cover-lead)')
  expect(photo).toMatch(/display: grid;/)
  expect(photo).toMatch(/grid-template-columns: minmax\(0, 1fr\) auto;/)
  expect(photo).toMatch(/grid-template-rows: auto 1fr;/)
  // The scrim drawn on the picture itself, over the empty ground.
  expect(photo).toMatch(
    /background:\s*linear-gradient\(to top, var\(--ck-scrim\) 0%, var\(--ck-scrim-mid\) 45%, var\(--ck-scrim-0\) 80%\),\s*var\(--ck-empty\);/,
  )
  const over = rule('.cover-card-wide .cover-photo:has(> .cover-lead) > .cover-over')
  expect(over).toMatch(/grid-row: 2;/)
  expect(over).toMatch(/grid-column: 1 \/ -1;/)
  expect(over).toMatch(/background: none;/)
  const lead = rule('.cover-lead')
  expect(lead).toMatch(/grid-row: 1;/)
  expect(lead).toMatch(/grid-column: 1;/)
  expect(lead).toMatch(/flex-wrap: wrap;/)
  expect(lead).not.toMatch(/position:/)
  expect(rule('.cover-lead > .cover-empty')).toMatch(/display: contents;/)
  expect(rule('.cover-lead > .cover-date')).toMatch(/position: static;/)
  const change = rule('.auth-screen .cover-photo:has(> .cover-lead) > .cover-change')
  expect(change).toMatch(/position: static;/)
  expect(change).toMatch(/grid-column: 2;/)
  expect(rule('.auth-screen .cover-change')).toMatch(/min-height: 44px;/)

  const block = [
    photo,
    over,
    lead,
    rule('.cover-lead > .cover-empty'),
    rule('.cover-lead:has(> .cover-date)'),
    rule('.cover-lead > .cover-date'),
    change,
  ].join('\n')
  expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  const used = [...new Set([...block.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  expect(used).toEqual(expect.arrayContaining(['--ck-scrim', '--ck-scrim-mid', '--ck-scrim-0', '--ck-empty']))
  for (const name of used) expect(tokensCss, name).toMatch(new RegExp(`${name}\\s*:`))
})

// ---------------------------------------------------------------------------
// The menu, through the cache.
// ---------------------------------------------------------------------------

const person: Person = {
  id: 'person-1',
  display_name: 'Ada Lee',
  email: 'ada@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const auth: AuthState = { status: 'signedIn', person, signIn: () => {}, signOut: async () => {}, updatePerson: () => {} }

const DAY = 24 * 60 * 60 * 1000
const soon = new Date(Date.now() + 3 * DAY).toISOString()

function groupBody(id: string, name: string, cover: CoverBody | null) {
  return {
    id,
    name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-1',
    member_count: 3,
    caller_role: 'member',
    cover,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function gatheringBody(id: string, title: string, cover: CoverBody | null) {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    caller_role: null,
    group: null,
    caller_view: 'full',
    cover,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: null,
    next_occurrence: { id: `o-${id}`, starts_at: soon },
    occurrence_count: 1,
  }
}

function renderMenu() {
  return render(
    <MemoryRouter initialEntries={['/groups']}>
      <AuthContext.Provider value={auth}>
        <Menu />
        <Routes>
          <Route path="*" element={<Link to="/somewhere-else">elsewhere</Link>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

test('in the menu every row’s thumbnail is its cover at the thumbnail layer — the empty cover where none is set — and a re-read after a navigation fetches no picture it holds', async () => {
  const groups = [
    groupBody('grp-1', 'The Lees', { source: 'photo', set_at: '2026-11-01T10:00:00+00:00' }),
    groupBody('grp-2', 'Cousins', null),
  ]
  const gatherings = [gatheringBody('g-1', 'The Party', { source: 'upload', set_at: '2026-11-01T10:00:00+00:00' })]
  const mock = stubServer({
    routes: {
      '/groups': () => json(200, { groups }),
      '/gatherings': () => json(200, { gatherings }),
    },
  })
  renderMenu()
  const groupList = await screen.findByRole('list', { name: 'Your groups' })
  await waitFor(() => expect(groupList.querySelectorAll('img[src^="blob:"]')).toHaveLength(1))
  const [lees, cousins] = within(groupList).getAllByRole('link')
  expect(lees.querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/)
  expect(lees.querySelector('img.nthumb')?.getAttribute('alt')).toBe('')
  expect(cousins.querySelector('.noimg.nthumb')).toBeTruthy()
  const upcoming = screen.getByRole('list', { name: 'Gatherings coming up' })
  await waitFor(() => expect(upcoming.querySelector('img.nthumb')?.getAttribute('src')).toMatch(/^blob:/))
  const coverReads = () => paths(mock).filter((p) => p.includes('/cover/url'))
  expect(coverReads().sort()).toEqual([
    '/gatherings/g-1/cover/url?layer=thumbnail',
    '/groups/grp-1/cover/url?layer=thumbnail',
  ])

  // A navigation: the menu re-reads both lists — and fetches no picture.
  fireEvent.click(screen.getByRole('link', { name: 'elsewhere' }))
  await waitFor(() => expect(paths(mock).filter((p) => p === '/groups')).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(coverReads()).toHaveLength(2)
  expect(mock.mock.calls.filter(([u]) => String(u).startsWith('https://r2.invalid/'))).toHaveLength(2)
  expect(revoked).toEqual([])
})

test('a cover act announced by a page re-reads the menu’s lists at once, and a new version there fetches the new picture and revokes the old', async () => {
  let version = '2026-11-01T10:00:00+00:00'
  const mock = stubServer({
    routes: {
      '/groups': () => json(200, { groups: [groupBody('grp-1', 'The Lees', { source: 'upload', set_at: version })] }),
      '/gatherings': () => json(200, { gatherings: [] }),
    },
  })
  renderMenu()
  const groupList = await screen.findByRole('list', { name: 'Your groups' })
  await waitFor(() => expect(groupList.querySelector('img.nthumb')?.getAttribute('src')).toBe('blob:cover-1'))
  version = '2026-11-01T12:00:00+00:00'
  act(() => announceCoverChange())
  await waitFor(() => expect(groupList.querySelector('img.nthumb')?.getAttribute('src')).toBe('blob:cover-2'))
  expect(paths(mock).filter((p) => p === '/groups')).toHaveLength(2)
  expect(revoked).toEqual(['blob:cover-1'])
})
