// CK-67 pins on the host's side (decisions/2026-09-27-two-bins.md §1–§4 —
// the surface for CK-66's backend). The value under test: Remove from
// gathering renders for the host on someone ELSE's live, ready row and on
// no other — not on pending (Decline covers it), not on the host's own
// rows (CK-64's controls), never on a failed or in-flight row, and never
// for a non-host; it takes a second, deliberate step that posts nothing on
// the first click, says exactly what happens, and posts `remove` once on
// "Remove it" with "Leave it" doing nothing; the step shares a row — and a
// screen — with no other step. The gathering's bin is a third view for the
// host only, asked for with `removed=true` and never both view flags, with
// its own empty state; a bin row shows the thumbnail, the name, who added
// it, and the host's line with the days left; Put back is one click that
// posts `restore` beside the hint that everyone will see it again (a host
// restore always goes live since CK-66); Delete permanently is CK-64's
// step with the same constant and the same sentence, posting `destroy` on
// the second click with "Photo deleted." after; refusals render on the row
// from their code with Refresh the list; and none of the host-facing copy
// promises anything at the window's end.
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
  // The test server's own fact, never sent to the component (the remover's
  // person id rides no body): which bin a removed row is in — 'uploader'
  // (the personal bin), 'host' (the gathering's), or null (no recorded
  // remover: nobody's view, the pre-0026 rows).
  removed_by: 'uploader' | 'host' | null
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
    uploader_display_name: 'grandma',
    is_own: false,
    removed_at: null,
    filename: null,
    caption: null,
    tags: [],
    published_at: null,
    removed_by: null,
    ...over,
  }
}

// A removal stamp relative to now (the CK-64 discipline): the bin's line
// counts the days left, so a fixed date would change the line as the
// calendar moved.
const DAY = 86_400_000
const removedDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const HOST_BIN_LINE_28 =
  'Removed from this gathering. Only you can see it, and you can put it back for 28 more days.'
const HOST_BIN_LINE_30 =
  'Removed from this gathering. Only you can see it, and you can put it back for 30 more days.'
const PUT_BACK_HINT = 'Everyone in this gathering will see it again.'
const EMPTY_BIN = 'Nothing has been removed from this gathering.'

// The remove step's sentence, pinned as a literal: what the uploader loses,
// and the way back the host is promised — which CK-63's window enforces.
const REMOVE_SENTENCE =
  'Nobody in this gathering will see this photo, grandma included. You can put it back for 30 days.'

// The permanent delete's sentence, character for character (bin record
// §7.1; two-bins §4) — pinned as a literal here, never through the
// constant that renders it. The gathering's bin uses THE SAME step and the
// same sentence: a second copy would be the drift this pin exists to catch.
const CONFIRMATION =
  'Are you sure? This will permanently remove the photo from CoveyKeep and cannot be recovered.'

// The words the host's side may never use (the kickoff's ban list): each
// promises something at the window's end, or a safety, that nothing
// enforces.
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

// A stand-in for the media router as one caller sees it (`host` says which
// seat renders), following the api-reference to the letter this surface
// depends on. The DEFAULT list excludes gathering-bin rows and shows a
// personal-bin row to its uploader alone; `removed=true` lists the
// gathering-bin rows — remover recorded and not the uploader — to the host,
// and an EMPTY list to anyone else, never a refusal; a NULL-remover row is
// in nobody's view; each act is a guarded update refused with a stable code
// and words this surface must never render; the HOST's restore goes `live`
// whatever the gate says, the publication stamp kept where it exists.
function gatheringBinServer(initial: Row[], options: { host?: boolean } = {}) {
  const host = options.host ?? true
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const inDestruction = (row: Row) => row.status === 'destroying' || row.status === 'destroyed'
  const visible = (row: Row) => {
    if (inDestruction(row)) return false
    if (row.publication_state !== 'removed') return true
    if (row.is_own && row.removed_by === 'uploader') return true
    return host && row.removed_by === 'host'
  }
  const body = (row: Row) => {
    const { removed_by: _internal, ...sent } = row
    return sent
  }
  const routes: StubRoute[] = [
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const params = new URL(url, 'http://test.invalid').searchParams
        if (params.get('awaiting_review') === 'true' && params.get('removed') === 'true') {
          return json(422, { detail: [{ loc: ['query', 'removed'], msg: SERVER_WORDING, type: 'value_error' }] })
        }
        const bin = params.get('removed') === 'true'
        const q = params.get('q')
        let listed = [...rows.values()].filter(visible)
        listed = bin
          ? listed.filter((row) => host && row.publication_state === 'removed' && row.removed_by === 'host')
          : listed.filter((row) => row.publication_state !== 'removed' || row.is_own)
        if (params.get('awaiting_review') === 'true') {
          listed = listed.filter((row) => row.status === 'ready' && row.publication_state === 'pending')
        }
        if (q) listed = listed.filter((row) => String(row.filename ?? '').toLowerCase().includes(q.toLowerCase()))
        return json(200, { media: listed.map(body) })
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
          json(409, {
            detail: { code, publication_state: row?.publication_state, status: row?.status, message: SERVER_WORDING },
          })
        // The audience rule first, then who may act: everyone else draws
        // the 404 byte-identical to a missing id.
        if (!row || !visible(row)) return json(404, { detail: 'No such photograph.' })
        if (act === 'remove' && !row.is_own && !host) return json(404, { detail: 'No such photograph.' })
        if (act === 'restore') {
          const uploaderRestore = row.is_own && row.removed_by === 'uploader'
          const hostRestore = host && row.removed_by === 'host'
          if (row.publication_state === 'removed' && !uploaderRestore && !hostRestore) {
            return json(404, { detail: 'No such photograph.' })
          }
        }
        if (act === 'destroy' && !row.is_own && !host) return json(404, { detail: 'No such photograph.' })
        if (row.status !== 'ready') return refuse('not_ready')
        if (act === 'remove') {
          if (row.publication_state === 'removed') return refuse('already_removed')
          row.publication_state = 'removed'
          row.removed_at = new Date().toISOString()
          row.removed_by = row.is_own ? 'uploader' : 'host'
        } else if (act === 'restore') {
          if (row.publication_state !== 'removed') return refuse('not_removed')
          // The host's restore: `live`, whatever the gate says (CK-66); an
          // existing publication stamp is kept whole, a never-published row
          // is stamped now.
          row.publication_state = 'live'
          row.removed_at = null
          row.removed_by = null
          row.published_at = row.published_at ?? STAMP
        } else {
          row.status = 'destroying'
        }
        return json(200, body(row))
      },
    },
    // The review's single acts, so Decline can sit beside Remove from
    // gathering on a pending row without a missing-stub error.
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
      isHost={true}
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

// Opening the section when every row is in the gathering's bin: the DEFAULT
// list is empty by design (the bin is a view, never a mixture), so the way
// in is the empty state, not the list.
async function openEmptyPhotos() {
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByText('No photos yet.')
}

// The rows of the Photos list, and not the chips or controls nested inside.
function photoRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll(':scope > li')) as HTMLElement[]
}

const currentRows = () => photoRows(screen.getByRole('list', { name: 'Photos' }))

const binControl = () => screen.getByRole('button', { name: 'Removed from this gathering' })

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

test("Remove from gathering renders for the host on someone else's live ready row and on no other — not on pending (Decline instead), own, failed or in-flight rows — and never for a non-host, who gets no Removed view either", async () => {
  const initial = () => [
    mediaRow({ id: 'm-theirs-live', filename: 'theirs-live.jpg' }),
    mediaRow({ id: 'm-theirs-pending', filename: 'theirs-pending.jpg', publication_state: 'pending' }),
    mediaRow({ id: 'm-mine-live', filename: 'mine-live.jpg', is_own: true, uploader_display_name: 'Steven' }),
    mediaRow({
      id: 'm-mine-bin',
      filename: 'mine-bin.jpg',
      is_own: true,
      uploader_display_name: 'Steven',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'uploader',
    }),
    mediaRow({ id: 'm-theirs-fail', filename: 'theirs-fail.jpg', status: 'failed', publication_state: 'pending' }),
    mediaRow({ id: 'm-theirs-proc', filename: 'theirs-proc.jpg', status: 'processing', publication_state: 'pending' }),
  ]
  const mock = stubRoutes(gatheringBinServer(initial(), { host: true }).routes)

  renderMedia({ isHost: true })
  let rows = await openPhotos()
  expect(rows).toHaveLength(6)
  const removeOn = (row: HTMLElement) =>
    within(row).queryByRole('button', { name: 'Remove from gathering' }) !== null
  // Someone else's live, ready row: the takedown, and none of CK-64's acts.
  expect(removeOn(rows[0])).toBe(true)
  expect(within(rows[0]).queryByRole('button', { name: 'Send to bin' })).toBeNull()
  expect(within(rows[0]).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  expect(within(rows[0]).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  // Someone else's pending row keeps Decline — same result, one act per
  // state — and gains nothing.
  expect(removeOn(rows[1])).toBe(false)
  expect(within(rows[1]).getByRole('button', { name: 'Decline' })).toBeTruthy()
  // The host's own rows keep CK-64's controls and gain nothing.
  expect(removeOn(rows[2])).toBe(false)
  expect(within(rows[2]).getByRole('button', { name: 'Send to bin' })).toBeTruthy()
  expect(removeOn(rows[3])).toBe(false)
  expect(within(rows[3]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  // Failed and in-flight rows: nothing stored (or settled) to take down.
  expect(removeOn(rows[4])).toBe(false)
  expect(removeOn(rows[5])).toBe(false)
  // The Removed view's control is on the page for the host.
  expect(binControl()).toBeTruthy()
  expect(actRequests(mock)).toHaveLength(0)

  // A non-host member: no Remove from gathering anywhere, no Removed view,
  // no view switch at all — and their default list never held grandma's
  // removed row to begin with.
  cleanup()
  const nonHost = stubRoutes(gatheringBinServer(initial(), { host: false }).routes)
  renderMedia({ isHost: false })
  rows = await openPhotos()
  expect(rows).toHaveLength(6)
  expect(screen.queryByRole('button', { name: 'Remove from gathering' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Removed from this gathering' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
  expect(actRequests(nonHost)).toHaveLength(0)
})

test('the remove step: nothing posted on the first click, the exact sentence, Leave it posts nothing, Remove it posts once and the row moves to the Removed view; the step shares the screen with no other step', async () => {
  const server = gatheringBinServer([
    mediaRow({ id: 'm-theirs', filename: 'beach.jpg' }),
    mediaRow({ id: 'm-theirs-waiting', filename: 'waiting.jpg', publication_state: 'pending' }),
    mediaRow({ id: 'm-mine', filename: 'mine.jpg', is_own: true, uploader_display_name: 'Steven' }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia({ isHost: true })
  let rows = await openPhotos()
  const reads = listRequests(mock).length

  // The first click asks, and nothing is sent.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  const step = within(rows[0]).getByRole('group', { name: 'Remove beach.jpg from this gathering' })
  expect(step.textContent).toContain(REMOVE_SENTENCE)
  expect(step.textContent).not.toMatch(BIN_BAN)
  expect(step.textContent).not.toMatch(/cancel|delet|destroy/i)
  expect(within(step).getByRole('button', { name: 'Remove it' })).toBeTruthy()
  expect(within(step).getByRole('button', { name: 'Leave it' })).toBeTruthy()
  expect(actRequests(mock)).toHaveLength(0)

  // The do-nothing: the step closes, nothing was sent, nothing moved.
  fireEvent.click(within(step).getByRole('button', { name: 'Leave it' }))
  expect(within(rows[0]).queryByRole('group', { name: /^Remove / })).toBeNull()
  expect(actRequests(mock)).toHaveLength(0)
  expect(server.rows.get('m-theirs')!.publication_state).toBe('live')

  // The step shares the screen with no other step. The editor open on the
  // host's own row closes when the remove step opens, and vice versa.
  fireEvent.click(within(rows[2]).getByRole('button', { name: 'Edit caption and tags' }))
  expect(within(rows[2]).getByRole('form', { name: 'Edit mine.jpg' })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  expect(within(rows[2]).queryByRole('form', { name: 'Edit mine.jpg' })).toBeNull()
  fireEvent.click(within(rows[2]).getByRole('button', { name: 'Edit caption and tags' }))
  expect(within(rows[0]).queryByRole('group', { name: /^Remove / })).toBeNull()
  fireEvent.click(within(rows[2]).getByRole('button', { name: 'Cancel' }))
  // The delete step on the host's own row closes it too, and vice versa.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  fireEvent.click(within(rows[2]).getByRole('button', { name: 'Delete permanently' }))
  expect(within(rows[0]).queryByRole('group', { name: /^Remove / })).toBeNull()
  expect(within(rows[2]).getByRole('group', { name: 'Delete mine.jpg' })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  expect(within(rows[2]).queryByRole('group', { name: 'Delete mine.jpg' })).toBeNull()
  // And the decline step on someone else's waiting row.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Decline' }))
  expect(within(rows[0]).queryByRole('group', { name: /^Remove / })).toBeNull()
  expect(within(rows[1]).getByRole('group', { name: /^Decline / })).toBeTruthy()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  expect(within(rows[1]).queryByRole('group', { name: /^Decline / })).toBeNull()
  expect(actRequests(mock)).toHaveLength(0)

  // The second click, deliberately: one POST to `remove`, then the re-read
  // — the row leaves the host's default list (it is in the gathering's bin,
  // which the default list excludes) and the Removed view holds it.
  fireEvent.click(
    within(within(rows[0]).getByRole('group', { name: /^Remove / })).getByRole('button', {
      name: 'Remove it',
    }),
  )
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-theirs/remove')).toBe(true)
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(currentRows()).toHaveLength(2)
  })
  expect(server.rows.get('m-theirs')!.publication_state).toBe('removed')
  expect(screen.queryByText('beach.jpg')).toBeNull()
  // Nothing was destroyed, and nothing says it was.
  expect(screen.queryByText('Photo deleted.')).toBeNull()
  expect(server.rows.get('m-theirs')!.status).toBe('ready')

  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  rows = currentRows()
  expect(rows[0].textContent).toContain('beach.jpg')
  expect(rows[0].textContent).toContain(HOST_BIN_LINE_30)
  expect(actRequests(mock)).toHaveLength(1)
})

test('the Removed view: removed=true and never both flags, the host line with the days left on each row, the thumbnail and who added it, search composing inside the view, and neither the personal-bin row nor a NULL-remover row in it', async () => {
  const server = gatheringBinServer([
    mediaRow({ id: 'm-live', filename: 'live.jpg' }),
    mediaRow({
      id: 'm-bin',
      filename: 'binned.jpg',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'host',
      published_at: STAMP,
    }),
    mediaRow({
      id: 'm-mine-bin',
      filename: 'mine-bin.jpg',
      is_own: true,
      uploader_display_name: 'Steven',
      publication_state: 'removed',
      removed_at: removedDaysAgo(1),
      removed_by: 'uploader',
    }),
    // No recorded remover (a pre-0026 row): in nobody's view, the host's
    // bin view included.
    mediaRow({
      id: 'm-null',
      filename: 'null-remover.jpg',
      publication_state: 'removed',
      removed_at: removedDaysAgo(3),
      removed_by: null,
    }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia({ isHost: true })
  let rows = await openPhotos()
  // The default list: the live row and the host's own personal-bin row —
  // never a gathering-bin row mixed in, never the NULL-remover row.
  expect(rows).toHaveLength(2)
  expect(screen.queryByText('binned.jpg')).toBeNull()
  expect(screen.queryByText('null-remover.jpg')).toBeNull()

  fireEvent.click(binControl())
  await waitFor(() => {
    expect(listRequests(mock).at(-1)![0]).toContain('removed=true')
  })
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  rows = currentRows()
  // Exactly the gathering-bin row: not the personal one, not the
  // NULL-remover one.
  expect(rows[0].textContent).toContain('binned.jpg')
  expect(rows[0].textContent).toContain('added by grandma')
  expect(rows[0].textContent).toContain(HOST_BIN_LINE_28)
  expect(rows[0].textContent).not.toMatch(BIN_BAN)
  expect(screen.queryByText('mine-bin.jpg')).toBeNull()
  expect(screen.queryByText('null-remover.jpg')).toBeNull()
  // The thumbnail is openable, as elsewhere.
  expect(within(rows[0]).getByRole('button', { name: 'Open photo added by grandma' })).toBeTruthy()
  // Put back with its hint, and Delete permanently, sit on the row.
  expect(within(rows[0]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  expect(rows[0].textContent).toContain(PUT_BACK_HINT)
  expect(within(rows[0]).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Removed from this gathering' }).getAttribute('aria-pressed')).toBe('true')

  // Search composes inside the view: the term rides `q` beside the flag.
  fireEvent.change(screen.getByLabelText(/find a photo/i), { target: { value: 'nothing-matches' } })
  await waitFor(() => {
    expect(listRequests(mock).at(-1)![0]).toContain('removed=true')
  })
  await waitFor(() => {
    expect(listRequests(mock).at(-1)![0]).toContain('q=nothing-matches')
  })
  await screen.findByText('No removed photos match “nothing-matches”.')

  // No list request ever carried both view flags (the server's 422).
  for (const [url] of listRequests(mock)) {
    expect(url.includes('awaiting_review=true') && url.includes('removed=true')).toBe(false)
  }
})

test('the empty state: with nothing removed, the Removed view says so — never "No photos yet." — with the way back', async () => {
  stubRoutes(gatheringBinServer([mediaRow({ id: 'm-live', filename: 'live.jpg' })]).routes)

  renderMedia({ isHost: true })
  await openPhotos()
  fireEvent.click(binControl())
  expect(await screen.findByText(EMPTY_BIN)).toBeTruthy()
  expect(screen.queryByText('No photos yet.')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Photos' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  expect(await screen.findByRole('list', { name: 'Photos' })).toBeTruthy()
  expect(screen.queryByText(EMPTY_BIN)).toBeNull()
})

test('Put back is one click that posts restore — the hint beside it says everyone will see it again — and the row leaves the bin view; the stamp is kept and rendered nowhere', async () => {
  const server = gatheringBinServer([
    mediaRow({
      id: 'm-bin',
      filename: 'binned.jpg',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'host',
      published_at: STAMP,
    }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia({ isHost: true })
  await openEmptyPhotos()
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  const rows = currentRows()
  expect(rows[0].textContent).toContain(PUT_BACK_HINT)

  // One click — no confirmation step in between — and one POST.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-bin/restore')).toBe(true)
  // The re-read: the row is live again and out of the bin view.
  expect(await screen.findByText(EMPTY_BIN)).toBeTruthy()
  expect(server.rows.get('m-bin')!.publication_state).toBe('live')
  // The publication pair was kept, not re-stamped, and is rendered nowhere.
  expect(server.rows.get('m-bin')!.published_at).toBe(STAMP)
  expect(document.body.innerHTML).not.toContain(STAMP)
  // Back in the full list it reads as any live photograph.
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  await waitFor(() => {
    expect(currentRows()[0].textContent).toContain('Everyone in this gathering can see it.')
  })
})

test(`Delete permanently in the bin view is CK-64's step — the same sentence, Keep it inert, the second click posts destroy once — and "Photo deleted." explains the empty view`, async () => {
  const server = gatheringBinServer([
    mediaRow({
      id: 'm-bin',
      filename: 'binned.jpg',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'host',
    }),
  ])
  const mock = stubRoutes(server.routes)

  renderMedia({ isHost: true })
  await openEmptyPhotos()
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  let rows = currentRows()
  const reads = listRequests(mock).length

  // The first click only opens the step: the sentence verbatim, nothing
  // posted, and the word CK-30 keeps out of a warning nowhere in it.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete permanently' }))
  const step = within(rows[0]).getByRole('group', { name: 'Delete binned.jpg' })
  expect(within(step).getByText(CONFIRMATION)).toBeTruthy()
  expect(step.textContent).not.toMatch(BIN_BAN)
  expect(step.textContent).not.toMatch(/cancel/i)
  expect(actRequests(mock)).toHaveLength(0)

  // Keep it: inert — the step closes, nothing posted, nothing moved.
  fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
  expect(within(rows[0]).queryByRole('group', { name: 'Delete binned.jpg' })).toBeNull()
  expect(actRequests(mock)).toHaveLength(0)
  expect(server.rows.get('m-bin')!.status).toBe('ready')

  // The second click, deliberately: one POST to destroy, the row leaves
  // the view — a row in destruction is visible to nobody — and the status
  // line says why.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete permanently' }))
  fireEvent.click(
    within(within(rows[0]).getByRole('group', { name: 'Delete binned.jpg' })).getByRole('button', {
      name: 'Delete permanently',
    }),
  )
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-bin/destroy')).toBe(true)
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  expect(await screen.findByText(EMPTY_BIN)).toBeTruthy()
  expect(server.rows.get('m-bin')!.status).toBe('destroying')
  // Two polite status lines share the screen here — the bin view's own
  // state, and the one that explains the disappearance.
  expect(screen.getAllByRole('status').map((line) => line.textContent)).toContain('Photo deleted.')
  expect(document.body.textContent).not.toMatch(BIN_BAN)
})

test("a refused act in the bin view renders on its row from its code — never the server's wording — re-reads nothing, and Refresh the list is the way on", async () => {
  // A row the view still shows, that the server has since moved: the lost
  // race (`not_pending` — the sweep marked it, or another act landed
  // first), answered with words this surface must never render.
  const mock = stubRoutes([
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const params = new URL(url, 'http://test.invalid').searchParams
        const row = mediaRow({
          id: 'm-raced',
          filename: 'binned.jpg',
          publication_state: 'removed',
          removed_at: removedDaysAgo(2),
          removed_by: 'host',
        })
        const { removed_by: _internal, ...sent } = row
        return json(200, { media: params.get('removed') === 'true' ? [sent] : [] })
      },
    },
    {
      method: 'POST',
      match: endsWith('/media/m-raced/restore'),
      response: () => json(409, { detail: { code: 'not_pending', message: SERVER_WORDING } }),
    },
    notReadyLayers,
  ])

  renderMedia({ isHost: true })
  await openEmptyPhotos()
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  const rows = currentRows()
  const reads = listRequests(mock).length

  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  const alert = await within(rows[0]).findByRole('alert')
  expect(alert.textContent).toContain(
    'This photo changed while you were looking at it — refresh the list and try again.',
  )
  expect(within(rows[0]).getByRole('button', { name: 'Refresh the list' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  expect(listRequests(mock)).toHaveLength(reads)

  // The refresh control: one re-read, the message cleared.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Refresh the list' }))
  await waitFor(() => {
    expect(listRequests(mock)).toHaveLength(reads + 1)
  })
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
