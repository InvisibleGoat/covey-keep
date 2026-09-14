// CK-43.1 pins on the review surface, restated at CK-44 (the strand rule,
// the-hosts-review §13). The value under test: the queue and every review
// control are ABSENT where review is off and nothing is waiting — host or
// not — and absent for a non-host member whatever the switch says, whose
// waiting row's line names the host as the one who acts; for the host the
// review renders while review is on OR anything waits — the queue is the
// same list asked for with the flag, holding only ready + pending rows (a
// live row and a removed row both excluded), with its own empty state and
// no polling; THE STRAND is fixed — a host who turned review off keeps the
// queue, both acts and the waiting line until the last waiting row is
// decided, and then all of it goes; the switch's two directions reach the
// section through its prop; the waiting line and the queue share one
// predicate at the render; publishing removes the row from the queue and
// its line becomes the live line; declining takes a second click, says
// what it is, and lands the row in the bin; a refused act renders from its
// CODE and never the server's wording; the batch's item-level 422 lands on
// the row that caused it and nothing is published; and the publication
// stamp is rendered nowhere.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GatheringMedia } from '../components/GatheringMedia'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const occurrences = [
  {
    id: 'occ-1',
    gathering_id: 'g-1',
    starts_at: '2026-09-01T18:00:00+00:00',
    ends_at: null,
    location: null,
    map_url: null,
  },
]

type Row = Record<string, unknown> & { id: string; status: string; publication_state: string; is_own: boolean }

function mediaRow(over: Partial<Row> = {}): Row {
  return {
    id: 'm-1',
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'ready',
    publication_state: 'pending',
    upload_content_type: 'image/heic',
    upload_size_bytes: 1296092,
    uploaded_at: '2026-09-09T12:00:01+00:00',
    created_at: '2026-09-09T12:00:00+00:00',
    uploader_display_name: 'Steven',
    is_own: true,
    removed_at: null,
    filename: null,
    caption: null,
    tags: [],
    published_at: null,
    ...over,
  }
}

interface StubRoute {
  method: string
  match: (url: string) => boolean
  response: (init: RequestInit | undefined, url: string) => Response
}

function stubRoutes(routes: StubRoute[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && r.match(String(url)))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response(init, String(url)))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const endsWith = (suffix: string) => (url: string) => url.endsWith(suffix)

// Thumbnails are not the subject here — a 409 keeps them out of the way.
const notReadyLayers: StubRoute = {
  method: 'GET',
  match: (url) => url.includes('/url?layer='),
  response: () => json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } }),
}

function calls(mock: ReturnType<typeof vi.fn>, method: string, match: (url: string) => boolean) {
  return mock.mock.calls.filter(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET') === method && match(String(url)),
  ) as unknown as [string, RequestInit | undefined][]
}

const listRequests = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'GET', (url) => url.includes('/gatherings/g-1/media'))

// A stand-in for the media router's review half, over an in-memory set of
// rows, following the api-reference (1.19.0) to the letter this surface
// depends on: the list filtered by `awaiting_review` (ready + pending) and
// `q`, inside the audience rule (a removed row is the uploader's alone);
// the single acts as guarded updates refused with a stable code and words
// this surface must never render; the batch refused whole on the first bad
// entry with an item-level 422 carrying the single act's code.
const STAMP = '2026-09-14T00:30:16+00:00'
const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'

function reviewServer(initial: Row[]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const refusal = (row: Row, act: 'publish' | 'decline') => {
    if (row.publication_state === 'live') {
      return { code: act === 'publish' ? 'already_live' : 'not_pending', publication_state: 'live', status: row.status, message: SERVER_WORDING }
    }
    if (row.publication_state === 'removed') {
      return { code: 'not_pending', publication_state: 'removed', status: row.status, message: SERVER_WORDING }
    }
    if (row.status !== 'ready') {
      return { code: 'not_ready', publication_state: row.publication_state, status: row.status, message: SERVER_WORDING }
    }
    return null
  }
  const routes: StubRoute[] = [
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const params = new URL(url, 'http://test.invalid').searchParams
        const queue = params.get('awaiting_review') === 'true'
        const q = params.get('q')
        let listed = [...rows.values()].filter(
          (row) => row.publication_state !== 'removed' || row.is_own,
        )
        if (queue) listed = listed.filter((row) => row.status === 'ready' && row.publication_state === 'pending')
        if (q) listed = listed.filter((row) => String(row.filename ?? '').toLowerCase().includes(q.toLowerCase()))
        return json(200, { media: listed })
      },
    },
    {
      method: 'POST',
      match: (url) => /\/media\/[^/]+\/(publish|decline)$/.test(url),
      response: (_init, url) => {
        const [, id, act] = url.match(/\/media\/([^/]+)\/(publish|decline)$/)! as unknown as [string, string, 'publish' | 'decline']
        const row = rows.get(id)
        if (!row || (row.publication_state === 'removed' && !row.is_own)) {
          return json(404, { detail: 'No such photograph.' })
        }
        const refused = refusal(row, act)
        if (refused) return json(409, { detail: refused })
        if (act === 'publish') {
          row.publication_state = 'live'
          row.published_at = STAMP
        } else {
          row.publication_state = 'removed'
          row.removed_at = '2026-09-14T00:31:22+00:00'
        }
        return json(200, row)
      },
    },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/publish'),
      response: (init) => {
        const ids = (JSON.parse(init!.body as string) as { media_ids: string[] }).media_ids
        for (const [index, id] of ids.entries()) {
          const row = rows.get(id)
          const item = (msg: string, code: string) =>
            json(422, { detail: [{ loc: ['body', 'media_ids', index], msg, type: 'value_error', code }] })
          if (!row || (row.publication_state === 'removed' && !row.is_own)) return item('no such photograph', 'not_found')
          const refused = refusal(row, 'publish')
          if (refused) return item(SERVER_WORDING, refused.code)
        }
        for (const id of ids) {
          const row = rows.get(id)!
          row.publication_state = 'live'
          row.published_at = STAMP
        }
        return json(200, { media: ids.map((id) => rows.get(id)) })
      },
    },
    notReadyLayers,
  ]
  return { routes, rows }
}

// The element itself, so a test can re-render it with the switch flipped
// — the way the detail page hands the section a new `requiresApproval`
// after the host saves the edit form (CK-44).
function mediaElement(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return (
    <GatheringMedia
      gatheringId="g-1"
      isHost={true}
      requiresApproval={true}
      occurrences={occurrences}
      zone="America/Chicago"
      pollIntervalMs={20}
      searchDebounceMs={20}
      {...over}
    />
  )
}

function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(mediaElement(over))
}

async function openPhotos() {
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
}

// The rows of the Photos list, and not the chips or controls nested inside.
function photoRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll(':scope > li')) as HTMLElement[]
}

function nameOf(row: HTMLElement): string | undefined {
  return row.querySelector('strong')?.textContent ?? undefined
}

// What must not reach the page where review is off and nothing is waiting:
// a reviewer, an approval, a queue, an act, or what a photograph waits on.
const NOTHING_WAITING_BAN = /approv|review|queue|publish|declin|waiting for/i

function expectNoReviewSurface() {
  expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
  expect(screen.queryByRole('button', { name: /awaiting your review|all photos/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('form', { name: /publish selected/i })).toBeNull()
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const openGatheringRows = () => [
  mediaRow({ id: 'm-mine' }),
  mediaRow({ id: 'm-theirs', is_own: false, uploader_display_name: 'grandma' }),
  mediaRow({ id: 'm-live', publication_state: 'live', published_at: STAMP }),
  mediaRow({ id: 'm-gone', publication_state: 'removed', removed_at: '2026-09-10T12:00:00+00:00' }),
  mediaRow({ id: 'm-fail', status: 'failed' }),
]

// Review off, nothing waiting: a live row, a removed row, a failed row —
// every state but the one that waits.
const nothingWaitingRows = () => [
  mediaRow({ id: 'm-live', publication_state: 'live', published_at: STAMP }),
  mediaRow({ id: 'm-gone', publication_state: 'removed', removed_at: '2026-09-10T12:00:00+00:00' }),
  mediaRow({ id: 'm-fail', status: 'failed' }),
]

test('where review is off and nothing is waiting there is no queue and no review control — host or not — and no line names what a photograph waits on', async () => {
  // (Rewritten at CK-44: CK-43.1's version rendered an OPEN gathering with
  // two waiting rows and expected nothing — under the strand rule those
  // rows are exactly what makes the review render, so the "nothing" case
  // is now the one with nothing waiting; the waiting case is pinned below.)
  const mock = stubRoutes(reviewServer(nothingWaitingRows()).routes)

  // The host, with review off: the seat with the most to be tempted by.
  renderMedia({ isHost: true, requiresApproval: false })
  await openPhotos()
  let rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(3)
  expectNoReviewSurface()
  // Every line exactly as CK-38 wrote it — and nothing about waiting.
  expect(rows[0].textContent).toContain('Everyone in this gathering can see it.')
  expect(rows[1].textContent).toContain('Removed. Only you can still see it, for 30 days after removal.')
  expect(rows[2].textContent).toContain("We couldn't process this photo.")
  expect(document.body.textContent).not.toMatch(NOTHING_WAITING_BAN)
  // No request ever asked for the queue.
  expect(listRequests(mock).every(([url]) => !url.includes('awaiting_review'))).toBe(true)

  // A non-host member, uploader of the same rows.
  cleanup()
  renderMedia({ isHost: false, requiresApproval: false })
  await openPhotos()
  rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(3)
  expectNoReviewSurface()
  expect(document.body.textContent).not.toMatch(NOTHING_WAITING_BAN)
  expect(listRequests(mock).every(([url]) => !url.includes('awaiting_review'))).toBe(true)
})

test('THE STRAND, fixed: with review off and rows waiting, the host still gets the queue, both acts and the waiting line — and all of it goes when the last one is decided', async () => {
  const server = reviewServer(openGatheringRows())
  const mock = stubRoutes(server.routes)

  // The exact state CK-43.1's deploy run observed as orphaned: review off,
  // two rows still ready + pending.
  renderMedia({ isHost: true, requiresApproval: false })
  await openPhotos()
  let rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(5)
  // ONE PREDICATE at the render: the rows that say they are waiting are
  // exactly the rows that carry the acts, and the queue exists because
  // they do — none of it keyed on the switch.
  const waiting = rows.filter((row) =>
    /Waiting for you to publish or decline it\./.test(row.textContent ?? ''),
  )
  expect(waiting).toHaveLength(2)
  expect(rows[0].textContent).toContain('Only you can see this. Waiting for you to publish or decline it.')
  expect(rows[1].textContent).toContain(
    'Only grandma and you can see this. Waiting for you to publish or decline it.',
  )
  for (const row of waiting) {
    expect(within(row).getByRole('button', { name: 'Publish' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Decline' })).toBeTruthy()
  }
  for (const row of rows.slice(2)) {
    expect(row.textContent).not.toMatch(/waiting for/i)
    expect(within(row).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  }
  expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()

  // The queue: the same list with the flag, holding the two waiting rows.
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await screen.findByText('Showing 2 photos awaiting your review.')
  expect(listRequests(mock).at(-1)![0]).toContain('awaiting_review=true')
  rows = photoRows(screen.getByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(2)

  // Decide them — one published, one declined on the second click.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Publish' }))
  await screen.findByText('Showing 1 photo awaiting your review.')
  rows = photoRows(screen.getByRole('list', { name: 'Photos' }))
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Decline' }))
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Decline it' }))
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/media/m-theirs/decline'))).toHaveLength(1)
  })
  expect(server.rows.get('m-mine')!.publication_state).toBe('live')
  expect(server.rows.get('m-theirs')!.publication_state).toBe('removed')

  // Nothing waits any more, and review is off: the review closes by itself
  // — back to the full list (grandma's declined row is in her bin, not the
  // host's list), no switch, no act, no checkbox, no "nothing is waiting",
  // and no line naming what a photograph waits on. Nothing was published
  // by the switch: the two rows moved by the host's own acts alone.
  await waitFor(() => {
    expect(photoRows(screen.getByRole('list', { name: 'Photos' }))).toHaveLength(4)
  })
  expectNoReviewSurface()
  expect(screen.queryByText('Nothing is waiting for your review.')).toBeNull()
  expect(screen.queryByText('No photos yet.')).toBeNull()
  expect(document.body.textContent).not.toMatch(NOTHING_WAITING_BAN)
  expect(listRequests(mock).at(-1)![0]).not.toContain('awaiting_review')
})

test("a non-host uploader whose row waits on a gathering with review off reads that it waits for the host — who can act on it — and gets no control", async () => {
  const mock = stubRoutes(reviewServer([mediaRow({ id: 'm-mine' })]).routes)

  renderMedia({ isHost: false, requiresApproval: false })
  await openPhotos()
  const rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(1)
  // True, not a promise: the host's queue renders while this row waits.
  expect(rows[0].textContent).toContain(
    'Only you and the host can see this. Waiting for the host to publish or decline it.',
  )
  expectNoReviewSurface()
  expect(listRequests(mock).every(([url]) => !url.includes('awaiting_review'))).toBe(true)
  expect(document.body.textContent).not.toMatch(/approv|shared|screen/i)
})

test("the switch, from the section's side: turning review on makes the queue appear with nothing waiting; turning it off with nothing waiting removes everything", async () => {
  stubRoutes(reviewServer(nothingWaitingRows()).routes)
  const view = renderMedia({ isHost: true, requiresApproval: false })
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })
  expectNoReviewSurface()

  // The host turns review on: the detail re-reads and hands the section the
  // new effective value. The queue appears, with its own empty state.
  view.rerender(mediaElement({ isHost: true, requiresApproval: true }))
  expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  expect(await screen.findByText('Nothing is waiting for your review.')).toBeTruthy()

  // And off again, with nothing waiting: everything goes, and the view
  // falls back to the full list on its own.
  view.rerender(mediaElement({ isHost: true, requiresApproval: false }))
  await waitFor(() => {
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
  })
  expect(screen.queryByText('Nothing is waiting for your review.')).toBeNull()
  expect(photoRows(await screen.findByRole('list', { name: 'Photos' }))).toHaveLength(3)
  expectNoReviewSurface()
  expect(document.body.textContent).not.toMatch(NOTHING_WAITING_BAN)
})

test('a non-host member of a gated gathering gets the waiting line and no control — the queue is the host\'s alone', async () => {
  const mock = stubRoutes(reviewServer([mediaRow({ id: 'm-mine' })]).routes)

  renderMedia({ isHost: false, requiresApproval: true })
  await openPhotos()
  const rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(1)
  // THE STRING, gated, from the uploader's seat: who can see it, and that
  // it waits for the host — never "waiting for approval", never "shared".
  expect(rows[0].textContent).toContain(
    'Only you and the host can see this. Waiting for the host to publish or decline it.',
  )
  expectNoReviewSurface()
  // The row's own affordances are exactly CK-40's: open it, and edit the
  // words — no act of any kind. (The thumbnail placeholder's own retry
  // control, which arrives whenever the stubbed 409 lands, is not a row
  // affordance and is left out of the count.)
  expect(
    within(rows[0])
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
      .filter((label) => label !== 'Retry'),
  ).toEqual(['Open photo added by You', 'Edit caption and tags'])
  // The queue was never asked for — the server would answer 404 to this
  // caller, and the surface never invites that.
  expect(listRequests(mock).every(([url]) => !url.includes('awaiting_review'))).toBe(true)
  expect(document.body.textContent).not.toMatch(/approv|shared|screen/i)
})

test('the host of a gated gathering gets the queue: the same list with the flag, only ready+pending rows, no polling', async () => {
  const mock = stubRoutes(reviewServer(openGatheringRows()).routes)

  renderMedia({ isHost: true, requiresApproval: true })
  await openPhotos()
  let rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(5)
  // THE STRING, gated, from the host's seat: their own photograph waits for
  // THEM (they are host and uploader — the family case), and so does
  // grandma's.
  expect(rows[0].textContent).toContain(
    'Only you can see this. Waiting for you to publish or decline it.',
  )
  expect(rows[1].textContent).toContain(
    'Only grandma and you can see this. Waiting for you to publish or decline it.',
  )
  // The other states read exactly as CK-38 wrote them, gate or no gate.
  expect(rows[2].textContent).toContain('Everyone in this gathering can see it.')
  expect(rows[3].textContent).toContain('Removed. Only you can still see it, for 30 days after removal.')
  expect(rows[4].textContent).toContain("We couldn't process this photo.")
  // The acts sit on the two rows the server would accept them on, and on
  // no other: not the live row, not the removed one, not the failed one.
  for (const row of rows.slice(0, 2)) {
    expect(within(row).getByRole('button', { name: 'Publish' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Decline' })).toBeTruthy()
  }
  for (const row of rows.slice(2)) {
    expect(within(row).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  }
  // The full list carries no checkbox: the batch is built in the queue.
  expect(screen.queryByRole('checkbox')).toBeNull()

  // The queue: the same list, asked for with the flag.
  const before = listRequests(mock).length
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await screen.findByText('Showing 2 photos awaiting your review.')
  const queueRequests = listRequests(mock).slice(before)
  expect(queueRequests).toHaveLength(1)
  expect(queueRequests[0][0]).toContain('/gatherings/g-1/media?awaiting_review=true')
  rows = photoRows(screen.getByRole('list', { name: 'Photos' }))
  expect(rows.map(nameOf)).toEqual(['Photo', 'Photo'])
  expect(rows).toHaveLength(2)
  // The live row and the removed row are gone from the queue, and so is
  // the failed one: only what the host can decide on.
  expect(screen.queryByText('Everyone in this gathering can see it.')).toBeNull()
  expect(screen.queryByText(/Removed\./)).toBeNull()
  expect(screen.queryByText(/couldn't process/)).toBeNull()
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Awaiting your review' }).getAttribute('aria-pressed')).toBe('true')
  // No polling: every row in the queue is terminal, and nothing but the
  // host's own act moves one — the request count stops dead.
  await sleep(120)
  expect(listRequests(mock)).toHaveLength(before + 1)

  // The way back: the full list, with no flag on the request.
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  await waitFor(() => {
    expect(photoRows(screen.getByRole('list', { name: 'Photos' }))).toHaveLength(5)
  })
  expect(listRequests(mock).at(-1)![0]).not.toContain('awaiting_review')
})

test('the queue\'s empty state is its own — "nothing is waiting", never "no photos yet" — with the way back', async () => {
  stubRoutes(
    reviewServer([
      mediaRow({ id: 'm-live', publication_state: 'live', published_at: STAMP }),
      mediaRow({ id: 'm-gone', publication_state: 'removed', removed_at: '2026-09-10T12:00:00+00:00' }),
    ]).routes,
  )

  renderMedia()
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  expect(await screen.findByText('Nothing is waiting for your review.')).toBeTruthy()
  expect(screen.queryByText('No photos yet.')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Photos' })).toBeNull()
  expect(screen.queryByRole('form', { name: /publish selected/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  expect(await screen.findByRole('list', { name: 'Photos' })).toBeTruthy()
  expect(screen.queryByText('Nothing is waiting for your review.')).toBeNull()
})

test('publishing from the queue removes the row from it and its line becomes the live line; the stamp is rendered nowhere', async () => {
  const server = reviewServer([mediaRow({ id: 'm-mine' })])
  const mock = stubRoutes(server.routes)

  renderMedia()
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await screen.findByText('Showing 1 photo awaiting your review.')

  fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/media/m-mine/publish'))).toHaveLength(1)
  })
  // Optimistic-free: the queue re-reads, and the row is no longer in it.
  expect(await screen.findByText('Nothing is waiting for your review.')).toBeTruthy()
  expect(server.rows.get('m-mine')!.publication_state).toBe('live')

  // In the full list its line is the live line, and it carries no act.
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  const rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows[0].textContent).toContain('Everyone in this gathering can see it.')
  expect(rows[0].textContent).not.toMatch(/waiting for/i)
  expect(within(rows[0]).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  // The publication stamp rides the body and is rendered nowhere (record
  // §7: consent evidence, never row furniture) — not raw, not formatted.
  expect(document.body.innerHTML).not.toContain(STAMP)
  expect(document.body.textContent).not.toMatch(/Sep 1[34], 2026/)
  expect(document.body.textContent).not.toMatch(/published (at|on)/i)
})

test('declining takes a second click, says what it is, and lands the row in the bin — out of the queue, with the bin line for its uploader', async () => {
  const server = reviewServer([
    mediaRow({ id: 'm-mine' }),
    mediaRow({ id: 'm-theirs', is_own: false, uploader_display_name: 'grandma' }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia()
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await screen.findByText('Showing 2 photos awaiting your review.')
  let rows = photoRows(screen.getByRole('list', { name: 'Photos' }))

  // grandma's: the first click asks; nothing is sent.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline' }))
  const confirm = within(rows[1]).getByRole('group', { name: /^Decline/ })
  expect(confirm.textContent).toContain(
    "The gathering won't see this photo. grandma can still see it for 30 days; you won't see it again here.",
  )
  // It reads as what it is — removal with the contributor's bin — never
  // as a delete key, and never the word CK-30 keeps out of a warning.
  expect(confirm.textContent).not.toMatch(/delet|destroy|cancel|permanent/i)
  expect(calls(mock, 'POST', () => true)).toHaveLength(0)
  // The do-nothing: back to the two acts, still nothing sent.
  fireEvent.click(within(confirm).getByRole('button', { name: 'Leave it waiting' }))
  expect(within(rows[1]).queryByRole('group', { name: /^Decline/ })).toBeNull()
  expect(within(rows[1]).getByRole('button', { name: 'Decline' })).toBeTruthy()
  expect(calls(mock, 'POST', () => true)).toHaveLength(0)

  // The second click, deliberately.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline' }))
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline it' }))
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/media/m-theirs/decline'))).toHaveLength(1)
  })
  await screen.findByText('Showing 1 photo awaiting your review.')
  rows = photoRows(screen.getByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(1)
  expect(server.rows.get('m-theirs')!.publication_state).toBe('removed')

  // The host's own: the confirm addresses them as the one who keeps it.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Decline' }))
  expect(within(rows[0]).getByRole('group', { name: /^Decline/ }).textContent).toContain(
    "The gathering won't see this photo. You can still see it yourself for 30 days.",
  )
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Decline it' }))
  expect(await screen.findByText('Nothing is waiting for your review.')).toBeTruthy()

  // In the full list: the host's own declined photograph reads the bin line
  // (they uploaded it); grandma's is not in their list at all — the bin is
  // the uploader's alone (CK-37), and the server's list says so.
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(1)
  expect(rows[0].textContent).toContain('Removed. Only you can still see it, for 30 days after removal.')
  expect(within(rows[0]).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
})

test("a refused act renders from its code and never the server's wording, stays on its row, and re-reads nothing", async () => {
  // A row the list still shows as pending, that the server has since moved:
  // the guarded update's case. The stub answers the act from a different
  // state than the list, with words this surface must never render.
  const mock = stubRoutes([
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ id: 'm-moved' }), mediaRow({ id: 'm-broke' })] }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-moved/publish'),
      response: () =>
        json(409, { detail: { code: 'already_live', publication_state: 'live', status: 'ready', message: SERVER_WORDING } }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-broke/decline'),
      response: () =>
        json(409, { detail: { code: 'not_ready', publication_state: 'pending', status: 'failed', message: SERVER_WORDING } }),
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  const rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  const reads = listRequests(mock).length

  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Publish' }))
  const first = await within(rows[0]).findByRole('alert')
  expect(first.textContent).toContain('This photo is already published — everyone in this gathering can see it.')
  expect(within(rows[0]).getByRole('button', { name: 'Refresh the list' })).toBeTruthy()

  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline' }))
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline it' }))
  const second = await within(rows[1]).findByRole('alert')
  expect(second.textContent).toContain("This photo couldn't be processed, so there's nothing to publish.")

  // The server's words reached the page nowhere; the rows were not re-read
  // (a re-read could drop the row the message is about); the first row's
  // message survived the second act.
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  expect(listRequests(mock)).toHaveLength(reads)
  expect(within(rows[0]).getByRole('alert').textContent).toContain('already published')

  // The refresh control is the way on: one re-read, the messages cleared.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Refresh the list' }))
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

test('a batch refusal lands on the row that caused it and publishes nothing; the batch then lands whole with one stamp', async () => {
  const server = reviewServer([
    mediaRow({ id: 'm-a', filename: 'a.jpg' }),
    mediaRow({ id: 'm-b', filename: 'b.jpg' }),
  ])
  // The first batch meets a row another session declined after this one
  // read the queue: the server refuses the batch WHOLE on that entry. The
  // second batch, after the host re-reads, lands.
  let declinedElsewhere = true
  const batchRoute = server.routes.find((route) => route.match('/gatherings/g-1/media/publish') && route.method === 'POST')!
  const original = batchRoute.response
  batchRoute.response = (init, url) => {
    if (declinedElsewhere) {
      declinedElsewhere = false
      return json(422, {
        detail: [
          {
            loc: ['body', 'media_ids', 1],
            msg: "this photo has been removed and can't be published",
            type: 'value_error',
            code: 'not_pending',
          },
        ],
      })
    }
    return original(init, url)
  }
  const mock = stubRoutes(server.routes)

  renderMedia()
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })
  fireEvent.click(screen.getByRole('button', { name: 'Awaiting your review' }))
  await screen.findByText('Showing 2 photos awaiting your review.')
  const reads = listRequests(mock).length

  // Nothing selected: the batch cannot go.
  const publish = () => screen.getByRole('button', { name: /^Publish \d+ selected/ })
  expect(publish().hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  expect(publish().textContent).toBe('Publish 2 selected photos')
  fireEvent.click(publish())
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/gatherings/g-1/media/publish'))).toHaveLength(1)
  })
  const [, batchInit] = calls(mock, 'POST', endsWith('/gatherings/g-1/media/publish'))[0]
  expect(JSON.parse(batchInit!.body as string)).toEqual({ media_ids: ['m-a', 'm-b'] })

  // The refusal is on the second row — the one the server named by index —
  // through the one mapper, in the server's words, and on no other row.
  const rows = photoRows(screen.getByRole('list', { name: 'Photos' }))
  const message = await within(rows[1]).findByRole('alert')
  expect(message.textContent).toContain("This photo has been removed and can't be published")
  expect(message.getAttribute('id')).toBe('error-publish-media_ids.1')
  expect(within(rows[1]).getByRole('checkbox').getAttribute('aria-describedby')).toBe('error-publish-media_ids.1')
  expect(within(rows[0]).queryByRole('alert')).toBeNull()
  // Nothing was published, and the page says so; the rows were not re-read,
  // so the row the message is about is still on the screen.
  expect(screen.getByText(/Nothing was published/)).toBeTruthy()
  expect(server.rows.get('m-a')!.publication_state).toBe('pending')
  expect(server.rows.get('m-b')!.publication_state).toBe('pending')
  expect(listRequests(mock)).toHaveLength(reads)
  expect(rows).toHaveLength(2)

  // The way on: re-read and publish — the selection survives a re-read that
  // still lists both rows (an id the re-read no longer returned would be
  // dropped), the batch lands whole, both rows carry the one stamp, and the
  // queue is empty.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh the list' }))
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  expect(screen.queryByText(/Nothing was published/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy()
  expect(publish().textContent).toBe('Publish 2 selected photos')
  fireEvent.click(publish())
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/gatherings/g-1/media/publish'))).toHaveLength(2)
  })
  expect(await screen.findByText('Nothing is waiting for your review.')).toBeTruthy()
  expect(server.rows.get('m-a')!.publication_state).toBe('live')
  expect(server.rows.get('m-b')!.publication_state).toBe('live')
  expect(server.rows.get('m-a')!.published_at).toBe(server.rows.get('m-b')!.published_at)
  expect(document.body.innerHTML).not.toContain(STAMP)
})
