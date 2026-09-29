// CK-64 pins on the personal bin's surface (decisions/2026-09-27-two-bins.md
// §1, §2, §4). The value under test: Send to bin, Put back and Delete
// permanently render on the caller's OWN ready rows and nowhere else — not
// on someone else's row, the host included (the host gains none of these
// three personal acts on anyone else's row, ever; their own controls there
// are CK-67's, pinned in media-gathering-bin.test.tsx, and binActsOn below
// checks exactly the three names so those pins hold either way), not on a
// failed or in-flight row; Send to bin
// is one click that posts once and re-reads, with no confirmation; Delete
// permanently posts NOTHING on the first click, shows the bin record §7.1's
// sentence verbatim, posts once on the second, and "Keep it" posts nothing;
// the editor and the delete step never share a row; a destroyed row leaves
// the list and "Photo deleted." says why; Put back lets the server decide
// where the photograph goes, with the hint from the reader's seat where the
// gathering requires approval and nothing where it does not; a refusal
// renders on its row from its CODE, never the server's wording, with the
// refresh control as the way on; one act at a time; and none of the bin's
// copy — the row, either confirmation — promises deletion on a date, an
// emptying, or a safety.
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

type Row = Record<string, unknown> & {
  id: string
  status: string
  publication_state: string
  is_own: boolean
  removed_at: string | null
  published_at: string | null
}

function mediaRow(over: Partial<Row> = {}): Row {
  return {
    id: 'm-1',
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
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

// A removal stamp relative to now: the bin's line counts the days left in
// the window, so a fixed date would change the line as the calendar moved.
const DAY = 86_400_000
const removedDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const BIN_LINE_28 = 'In your bin. Only you can see it, and you can put it back for 28 more days.'
const BIN_LINE_30 = 'In your bin. Only you can see it, and you can put it back for 30 more days.'

// The record's sentence, character for character (bin record §7.1; two-bins
// §4) — pinned as a literal here, never through the constant that renders it.
const CONFIRMATION = 'Are you sure? This will permanently remove the photo from CoveyKeep and cannot be recovered.'

// The words the bin's surface may never use (the kickoff's ban list): each
// promises something at the window's end, or a safety, that nothing enforces.
const BIN_BAN = /deleted after|emptied|cleared|forever|safe|backed up/i

const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'
const STAMP = '2026-09-14T00:30:16+00:00'

interface StubRoute {
  method: string
  match: (url: string) => boolean
  response: (init: RequestInit | undefined, url: string) => Response | Promise<Response>
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

const actRequests = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'POST', (url) => /\/media\/[^/]+\/(remove|restore|destroy)$/.test(url))

// A stand-in for the media router's three removal paths over an in-memory
// set of rows, following the api-reference to the letter this surface
// depends on: the list shows a removed row to its uploader alone (CK-63)
// and a row in destruction to nobody (CK-54); each act is a guarded update
// refused with a stable code and words this surface must never render;
// restore lands where the GATE says — pending where the gathering requires
// approval, live where it does not — and never where the caller asks.
function binServer(initial: Row[], options: { gated?: boolean } = {}) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const inDestruction = (row: Row) => row.status === 'destroying' || row.status === 'destroyed'
  const routes: StubRoute[] = [
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const params = new URL(url, 'http://test.invalid').searchParams
        const queue = params.get('awaiting_review') === 'true'
        let listed = [...rows.values()].filter(
          (row) => !inDestruction(row) && (row.publication_state !== 'removed' || row.is_own),
        )
        if (queue) listed = listed.filter((row) => row.status === 'ready' && row.publication_state === 'pending')
        return json(200, { media: listed })
      },
    },
    {
      method: 'POST',
      match: (url) => /\/media\/[^/]+\/(remove|restore|destroy)$/.test(url),
      response: (_init, url) => {
        const [, id, act] = url.match(/\/media\/([^/]+)\/(remove|restore|destroy)$/)! as unknown as [
          string,
          string,
          'remove' | 'restore' | 'destroy',
        ]
        const row = rows.get(id)
        const refuse = (code: string) =>
          json(409, { detail: { code, publication_state: row?.publication_state, status: row?.status, message: SERVER_WORDING } })
        // The audience rule first: a row not the caller's to see, or to
        // restore, draws the 404 byte-identical to a missing id.
        if (!row || inDestruction(row)) return json(404, { detail: 'No such photograph.' })
        if (act === 'restore' && !row.is_own) return json(404, { detail: 'No such photograph.' })
        if (row.status !== 'ready') return refuse('not_ready')
        if (act === 'remove') {
          if (row.publication_state === 'removed') return refuse('already_removed')
          row.publication_state = 'removed'
          row.removed_at = new Date().toISOString()
        } else if (act === 'restore') {
          if (row.publication_state !== 'removed') return refuse('not_removed')
          row.removed_at = null
          if (options.gated) {
            row.publication_state = 'pending'
            row.published_at = null
          } else {
            row.publication_state = 'live'
            row.published_at = row.published_at ?? STAMP
          }
        } else {
          row.status = 'destroying'
        }
        return json(200, row)
      },
    },
    // The review's single acts, so the host's unchanged controls can be
    // exercised beside the bin's without a missing-stub error.
    {
      method: 'POST',
      match: (url) => /\/media\/[^/]+\/(publish|decline)$/.test(url),
      response: () => json(409, { detail: { code: 'not_pending', message: SERVER_WORDING } }),
    },
    notReadyLayers,
  ]
  return { routes, rows }
}

function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <GatheringMedia
      gatheringId="g-1"
      isHost={false}
      requiresApproval={false}
      occurrences={occurrences}
      zone="America/Chicago"
      pollIntervalMs={20}
      searchDebounceMs={20}
      {...over}
    />,
  )
}

async function openPhotos() {
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  return photoRows(await screen.findByRole('list', { name: 'Photos' }))
}

// The rows of the Photos list, and not the chips or controls nested inside.
function photoRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll(':scope > li')) as HTMLElement[]
}

const currentRows = () => photoRows(screen.getByRole('list', { name: 'Photos' }))

const BIN_ACTS = ['Send to bin', 'Put back', 'Delete permanently'] as const

function binActsOn(row: HTMLElement): string[] {
  return BIN_ACTS.filter((name) => within(row).queryByRole('button', { name }) !== null)
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

test("the three acts render on the caller's own ready rows and nowhere else — not on someone else's row, the host included, not on a failed or in-flight row — and the bin's line counts the days", async () => {
  const server = binServer([
    mediaRow({ id: 'm-live', filename: 'mine-live.jpg' }),
    mediaRow({ id: 'm-pending', filename: 'mine-pending.jpg', publication_state: 'pending' }),
    mediaRow({ id: 'm-bin', filename: 'mine-bin.jpg', publication_state: 'removed', removed_at: removedDaysAgo(2) }),
    mediaRow({ id: 'm-theirs-live', filename: 'theirs-live.jpg', is_own: false, uploader_display_name: 'grandma' }),
    mediaRow({ id: 'm-theirs-pending', filename: 'theirs-pending.jpg', is_own: false, uploader_display_name: 'grandma', publication_state: 'pending' }),
    mediaRow({ id: 'm-fail', filename: 'mine-fail.jpg', status: 'failed', publication_state: 'pending' }),
    mediaRow({ id: 'm-proc', filename: 'mine-proc.jpg', status: 'processing', publication_state: 'pending' }),
  ])
  const mock = stubRoutes(server.routes)

  // The host: the seat with a view of everyone's photographs, and the one
  // that must gain nothing here. (Rows are waiting, so the host's review —
  // unchanged — renders beside the bin's acts.)
  renderMedia({ isHost: true })
  let rows = await openPhotos()
  expect(rows).toHaveLength(7)

  // An own live or pending row: to the bin, and delete permanently.
  expect(binActsOn(rows[0])).toEqual(['Send to bin', 'Delete permanently'])
  expect(binActsOn(rows[1])).toEqual(['Send to bin', 'Delete permanently'])
  // The review's own acts on the waiting row, exactly as before.
  expect(within(rows[1]).getByRole('button', { name: 'Publish' })).toBeTruthy()
  expect(within(rows[1]).getByRole('button', { name: 'Decline' })).toBeTruthy()
  // An own row in the bin: back from it, and delete permanently — with the
  // line that says whose it is and how long the way back stays open.
  expect(binActsOn(rows[2])).toEqual(['Put back', 'Delete permanently'])
  expect(rows[2].textContent).toContain(BIN_LINE_28)
  expect(rows[2].textContent).not.toMatch(BIN_BAN)
  expect(rows[2].textContent).not.toMatch(/30 days after removal/)
  // Someone else's row, to the host: none of the three. The waiting one
  // keeps the review's acts and gains nothing.
  expect(binActsOn(rows[3])).toEqual([])
  expect(binActsOn(rows[4])).toEqual([])
  expect(within(rows[4]).getByRole('button', { name: 'Publish' })).toBeTruthy()
  // A failed or in-flight own row: nothing stored to act on.
  expect(binActsOn(rows[5])).toEqual([])
  expect(binActsOn(rows[6])).toEqual([])
  // No delete step is open anywhere, and nothing was posted.
  expect(screen.queryByRole('group', { name: /^Delete / })).toBeNull()
  expect(actRequests(mock)).toHaveLength(0)

  // The host's decline confirmation on their own waiting row — the other
  // confirmation the ban list covers — promises nothing at the window's end.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline' }))
  const decline = within(rows[1]).getByRole('group', { name: /^Decline / })
  expect(decline.textContent).not.toMatch(BIN_BAN)
  fireEvent.click(within(decline).getByRole('button', { name: 'Leave it waiting' }))

  // A non-host member: their own rows carry the acts, grandma's do not.
  cleanup()
  renderMedia({ isHost: false })
  rows = await openPhotos()
  expect(binActsOn(rows[0])).toEqual(['Send to bin', 'Delete permanently'])
  expect(binActsOn(rows[2])).toEqual(['Put back', 'Delete permanently'])
  expect(binActsOn(rows[3])).toEqual([])
  expect(binActsOn(rows[4])).toEqual([])
  expect(actRequests(mock)).toHaveLength(0)
})

test('Send to bin is one click — no confirmation — that posts once and re-reads, the row becoming the bin\'s line with Put back; one act at a time while it runs', async () => {
  const server = binServer([
    mediaRow({ id: 'm-a', filename: 'beach.jpg' }),
    mediaRow({ id: 'm-b', filename: 'cake.jpg' }),
  ])
  // Hold the first act's response so the in-flight state can be seen.
  const actRoute = server.routes.find((route) => route.method === 'POST' && route.match('/media/m-a/remove'))!
  const original = actRoute.response
  let release: () => void = () => {}
  let held = true
  actRoute.response = (init, url) => {
    if (!held) return original(init, url)
    held = false
    return new Promise<Response>((resolve) => {
      release = () => resolve(original(init, url) as Response)
    })
  }
  const mock = stubRoutes(server.routes)

  renderMedia()
  let rows = await openPhotos()
  const reads = listRequests(mock).length

  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Send to bin' }))
  // Posted at once — no step in between — and, while it runs, the row says
  // so and every other act on the page waits.
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-a/remove')).toBe(true)
  expect(screen.queryByRole('group', { name: /^Delete / })).toBeNull()
  expect(within(rows[0]).getByRole('button', { name: 'Sending to bin…' })).toBeTruthy()
  expect(within(rows[0]).getByRole('button', { name: 'Delete permanently' }).hasAttribute('disabled')).toBe(true)
  expect(within(rows[1]).getByRole('button', { name: 'Send to bin' }).hasAttribute('disabled')).toBe(true)
  expect(within(rows[1]).getByRole('button', { name: 'Delete permanently' }).hasAttribute('disabled')).toBe(true)
  // A second click while it runs posts nothing more.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Send to bin' }))
  expect(actRequests(mock)).toHaveLength(1)

  release()
  // Optimistic-free: one re-read, and the server's row is what renders —
  // the bin's line, with the way back.
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(currentRows()[0].textContent).toContain(BIN_LINE_30)
  })
  rows = currentRows()
  expect(binActsOn(rows[0])).toEqual(['Put back', 'Delete permanently'])
  expect(server.rows.get('m-a')!.publication_state).toBe('removed')
  // Nothing was destroyed, and nothing says it was.
  expect(screen.queryByText('Photo deleted.')).toBeNull()
  expect(server.rows.get('m-a')!.status).toBe('ready')
  expect(binActsOn(rows[1])).toEqual(['Send to bin', 'Delete permanently'])
  expect(within(rows[1]).getByRole('button', { name: 'Send to bin' }).hasAttribute('disabled')).toBe(false)
})

test('Delete permanently takes a second, deliberate step: nothing posted on the first click, the sentence verbatim, Keep it posts nothing, the second click posts once, the row goes and "Photo deleted." says why; the editor and the step never share a row', async () => {
  const server = binServer([
    mediaRow({ id: 'm-a', filename: 'beach.jpg' }),
    mediaRow({ id: 'm-b', filename: 'cake.jpg' }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia()
  let rows = await openPhotos()

  // The editor is open on the row; opening the delete step closes it.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Edit caption and tags' }))
  expect(within(rows[0]).getByRole('form', { name: 'Edit beach.jpg' })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete permanently' }))
  expect(within(rows[0]).queryByRole('form', { name: 'Edit beach.jpg' })).toBeNull()

  // The first click asks, and nothing is sent.
  const step = within(rows[0]).getByRole('group', { name: 'Delete beach.jpg' })
  expect(within(step).getByText(CONFIRMATION)).toBeTruthy()
  expect(step.textContent).not.toMatch(BIN_BAN)
  // Never the word CK-30 keeps out of a warning, and no browser dialog.
  expect(step.textContent).not.toMatch(/cancel/i)
  expect(within(step).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
  expect(within(step).getByRole('button', { name: 'Keep it' })).toBeTruthy()
  expect(actRequests(mock)).toHaveLength(0)
  // The controls it replaced are not on the row beside it.
  expect(within(rows[0]).queryByRole('button', { name: 'Send to bin' })).toBeNull()
  expect(within(rows[0]).getAllByRole('button', { name: 'Delete permanently' })).toHaveLength(1)
  // The other row is untouched.
  expect(binActsOn(rows[1])).toEqual(['Send to bin', 'Delete permanently'])

  // The do-nothing: the step closes, the controls return, nothing is sent.
  fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
  expect(within(rows[0]).queryByRole('group', { name: 'Delete beach.jpg' })).toBeNull()
  expect(binActsOn(rows[0])).toEqual(['Send to bin', 'Delete permanently'])
  expect(actRequests(mock)).toHaveLength(0)
  expect(server.rows.get('m-a')!.status).toBe('ready')

  // And the other way round: opening the editor closes the step.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete permanently' }))
  expect(within(rows[0]).getByRole('group', { name: 'Delete beach.jpg' })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Edit caption and tags' }))
  expect(within(rows[0]).queryByRole('group', { name: 'Delete beach.jpg' })).toBeNull()
  expect(within(rows[0]).getByRole('form', { name: 'Edit beach.jpg' })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Cancel' }))
  expect(actRequests(mock)).toHaveLength(0)

  // The second click, deliberately: one POST, and the step says so while it
  // runs.
  const reads = listRequests(mock).length
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete permanently' }))
  fireEvent.click(
    within(within(rows[0]).getByRole('group', { name: 'Delete beach.jpg' })).getByRole('button', {
      name: 'Delete permanently',
    }),
  )
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-a/destroy')).toBe(true)
  // The server marked it; a row in destruction is visible to nobody, so the
  // re-read drops it — and the line explains the disappearance.
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  expect(server.rows.get('m-a')!.status).toBe('destroying')
  const notice = screen.getByRole('status')
  expect(notice.textContent).toBe('Photo deleted.')
  expect(screen.queryByText('beach.jpg')).toBeNull()
  expect(screen.queryByRole('group', { name: /^Delete / })).toBeNull()
  expect(document.body.textContent).not.toMatch(BIN_BAN)
  expect(actRequests(mock)).toHaveLength(1)

  // The line goes with the next act.
  rows = currentRows()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Send to bin' }))
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 2)
  })
  await waitFor(() => {
    expect(currentRows()[0].textContent).toContain(BIN_LINE_30)
  })
  expect(screen.queryByText('Photo deleted.')).toBeNull()
})

test('Put back lets the server decide where the photograph goes: where the gathering requires approval a hint says so from the reader\'s seat, and in an open gathering nothing does', async () => {
  const HOST_HINT = 'The host will look at it again before anyone else sees it.'
  const OWN_HINT = "It'll wait for you to publish or decline it before anyone else sees it."
  const binned = () => [mediaRow({ id: 'm-a', filename: 'beach.jpg', publication_state: 'removed', removed_at: removedDaysAgo(2) })]

  // Gated, read by the uploader who is not the host: the host is named as
  // the one who looks again. The row comes back waiting for the host.
  let server = binServer(binned(), { gated: true })
  let mock = stubRoutes(server.routes)
  renderMedia({ isHost: false, requiresApproval: true })
  let rows = await openPhotos()
  expect(rows[0].textContent).toContain(BIN_LINE_28)
  expect(rows[0].textContent).toContain(HOST_HINT)
  expect(rows[0].textContent).not.toContain(OWN_HINT)
  expect(rows[0].textContent).not.toMatch(BIN_BAN)
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  await waitFor(() => {
    expect(actRequests(mock)).toHaveLength(1)
  })
  expect(actRequests(mock)[0][0].endsWith('/media/m-a/restore')).toBe(true)
  await waitFor(() => {
    expect(currentRows()[0].textContent).toContain(
      'Only you and the host can see this. Waiting for the host to publish or decline it.',
    )
  })
  rows = currentRows()
  expect(binActsOn(rows[0])).toEqual(['Send to bin', 'Delete permanently'])
  expect(server.rows.get('m-a')!.publication_state).toBe('pending')
  expect(screen.queryByText(HOST_HINT)).toBeNull()

  // Gated, read by the host on their own binned photograph: told it waits
  // for THEM — never a person waiting on "the host".
  cleanup()
  server = binServer(binned(), { gated: true })
  mock = stubRoutes(server.routes)
  renderMedia({ isHost: true, requiresApproval: true })
  rows = await openPhotos()
  expect(rows[0].textContent).toContain(OWN_HINT)
  expect(rows[0].textContent).not.toContain(HOST_HINT)
  expect(actRequests(mock)).toHaveLength(0)

  // Open: no hint at all, and the row comes back live.
  cleanup()
  server = binServer(binned())
  mock = stubRoutes(server.routes)
  renderMedia({ isHost: false, requiresApproval: false })
  rows = await openPhotos()
  expect(rows[0].textContent).toContain(BIN_LINE_28)
  expect(screen.queryByText(HOST_HINT)).toBeNull()
  expect(screen.queryByText(OWN_HINT)).toBeNull()
  expect(document.body.textContent).not.toMatch(/approv|review|queue|publish|declin|waiting for/i)
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  await waitFor(() => {
    expect(currentRows()[0].textContent).toContain('Everyone in this gathering can see it.')
  })
  expect(server.rows.get('m-a')!.publication_state).toBe('live')
  expect(actRequests(mock)).toHaveLength(1)
})

test("a refused act renders on its row from its code and never the server's wording, re-reads nothing, and the refresh control is the way on", async () => {
  // Rows the list still shows one way, that the server has since moved: the
  // guarded update's case, answered with words this surface must never
  // render. The first is the lost race (`not_pending`, on any of the three
  // acts); the second a row already in the bin.
  const mock = stubRoutes([
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: () =>
        json(200, {
          media: [
            mediaRow({ id: 'm-raced', filename: 'beach.jpg', publication_state: 'removed', removed_at: removedDaysAgo(29.5) }),
            mediaRow({ id: 'm-binned', filename: 'cake.jpg' }),
          ],
        }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-raced/restore'),
      response: () => json(409, { detail: { code: 'not_pending', message: SERVER_WORDING } }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-binned/remove'),
      response: () =>
        json(409, { detail: { code: 'already_removed', publication_state: 'removed', status: 'ready', message: SERVER_WORDING } }),
    },
    notReadyLayers,
  ])

  renderMedia()
  const rows = await openPhotos()
  const reads = listRequests(mock).length
  // The last day of the window reads as such, and the ban still holds.
  expect(rows[0].textContent).toContain('In your bin. Only you can see it, and you can put it back for less than a day.')
  expect(rows[0].textContent).not.toMatch(BIN_BAN)

  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  const first = await within(rows[0]).findByRole('alert')
  expect(first.textContent).toContain('This photo changed while you were looking at it — refresh the list and try again.')
  expect(within(rows[0]).getByRole('button', { name: 'Refresh the list' })).toBeTruthy()

  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Send to bin' }))
  const second = await within(rows[1]).findByRole('alert')
  expect(second.textContent).toContain('This photo is already in your bin.')

  // The server's words reached the page nowhere; the rows were not re-read;
  // the first row's message survived the second act; nothing claims a
  // photograph was put back or deleted.
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  expect(listRequests(mock)).toHaveLength(reads)
  expect(within(rows[0]).getByRole('alert').textContent).toContain('changed while you were looking')
  expect(screen.queryByText('Photo deleted.')).toBeNull()
  expect(document.body.textContent).not.toMatch(BIN_BAN)

  // The refresh control: one re-read, the messages cleared.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Refresh the list' }))
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
