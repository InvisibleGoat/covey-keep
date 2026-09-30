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
//
// Since CK-69 (co-hosts on the surface; co-hosts §4 as amended by two-bins
// §4): the same side for a CO-HOST — the takedown with the co-host's
// sentence in both gate states, the Removed view with the co-host's line,
// Put back with the hint by gate state (a co-host's restore passes through
// the gate), Delete permanently on their own row and never on another's,
// and no review anywhere; an organiser's OWN row that another organiser
// removed reads as the gathering's in the Removed view; and a refusal
// names the bin the act was on. The host's literals moved with the copy
// ("Only you can see it" → "Only you and any co-hosts"; the remove step's
// "Nobody in this gathering will see this photo, grandma included" → who
// will still see it), each with its reason beside it.
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
  // (the personal bin), 'organiser' (the gathering's: the host or a co-host
  // removed it, or the host declined it — 'host' until CK-69), or null (no
  // recorded remover: nobody's view, the pre-0026 rows).
  removed_by: 'uploader' | 'organiser' | null
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
// MOVED at CK-69 (their reason): "Only you can see it" was true while the
// host was the one organiser; co-hosts read the gathering's bin since
// CK-68, so the host's line names them — "you and any co-hosts", true
// whether or not any exist — and a co-host reads "the host and co-hosts".
const HOST_BIN_LINE_28 =
  'Removed from this gathering. Only you and any co-hosts can see it, and you can put it back for 28 more days.'
const HOST_BIN_LINE_30 =
  'Removed from this gathering. Only you and any co-hosts can see it, and you can put it back for 30 more days.'
const CO_HOST_BIN_LINE_28 =
  'Removed from this gathering. Only the host and co-hosts can see it, and you can put it back for 28 more days.'
const CO_HOST_BIN_LINE_30 =
  'Removed from this gathering. Only the host and co-hosts can see it, and you can put it back for 30 more days.'
const PUT_BACK_HINT = 'Everyone in this gathering will see it again.'
// The personal bin's two hints (CK-64), reused on the gathering's bin for a
// co-host in a gated gathering — one constant, never a second copy.
const HOST_LOOKS_HINT = 'The host will look at it again before anyone else sees it.'
const OWN_WAITS_HINT = "It'll wait for you to publish or decline it before anyone else sees it."
const EMPTY_BIN = 'Nothing has been removed from this gathering.'

// The remove step's sentence, pinned as a literal. MOVED at CK-69 (its
// reason): it read "Nobody in this gathering will see this photo, grandma
// included. You can put it back for 30 days." — false once organisers can
// still see it, and false in its "{who} included" where the uploader is an
// organiser — so it now says who WILL still see it, from the reader's seat
// (the host's form here; the co-host's two forms below), and the way back
// the host is promised, which CK-63's window enforces.
const REMOVE_SENTENCE =
  'Only you and any co-hosts will be able to see this photo. You can put it back for 30 days.'
const CO_HOST_REMOVE_OPEN =
  'Only the host and co-hosts will be able to see this photo. You can put it back for 30 days.'
const CO_HOST_REMOVE_GATED =
  'Only the host and co-hosts will be able to see this photo. If you put it back within 30 days, the host will look at it again before anyone else sees it.'

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

// A stand-in for the media router as one caller sees it (`role` says which
// seat renders — the host, a co-host, or a member who organises nothing),
// following the api-reference to the letter this surface depends on. The
// DEFAULT list excludes gathering-bin rows — an organiser's OWN row that
// another organiser removed included — and shows a personal-bin row to its
// uploader alone; `removed=true` lists the gathering-bin rows — remover
// recorded and not the uploader — to the ORGANISERS (the host, and since
// CK-68 a co-host), and an EMPTY list to anyone else, never a refusal; a
// NULL-remover row is in nobody's view; each act is a guarded update
// refused with a stable code and words this surface must never render; the
// takedown is an organiser's; the HOST's restore goes `live` whatever the
// gate says, the publication stamp kept where it exists, and a CO-HOST's —
// like the uploader's — goes where the GATE says (CK-68): `pending` with
// the stamp cleared where `gated`, `live` otherwise; destroy is the host's
// or the uploader's, never a co-host's on someone else's. (The `pending`
// audience is not modelled: no test here lists someone else's pending row
// to a non-host, as the server never would.)
function gatheringBinServer(
  initial: Row[],
  options: { role?: 'host' | 'co_host' | 'member'; gated?: boolean } = {},
) {
  const role = options.role ?? 'host'
  const host = role === 'host'
  const organises = host || role === 'co_host'
  const gated = options.gated ?? false
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const inDestruction = (row: Row) => row.status === 'destroying' || row.status === 'destroyed'
  const visible = (row: Row) => {
    if (inDestruction(row)) return false
    if (row.publication_state !== 'removed') return true
    if (row.is_own && row.removed_by === 'uploader') return true
    return organises && row.removed_by === 'organiser'
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
          ? listed.filter(
              (row) => organises && row.publication_state === 'removed' && row.removed_by === 'organiser',
            )
          : listed.filter((row) => row.publication_state !== 'removed' || row.removed_by === 'uploader')
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
        if (act === 'remove' && !row.is_own && !organises) return json(404, { detail: 'No such photograph.' })
        if (act === 'restore') {
          const uploaderRestore = row.is_own && row.removed_by === 'uploader'
          const organiserRestore = organises && row.removed_by === 'organiser'
          if (row.publication_state === 'removed' && !uploaderRestore && !organiserRestore) {
            return json(404, { detail: 'No such photograph.' })
          }
        }
        if (act === 'destroy' && !row.is_own && !host) return json(404, { detail: 'No such photograph.' })
        if (row.status !== 'ready') return refuse('not_ready')
        if (act === 'remove') {
          if (row.publication_state === 'removed') return refuse('already_removed')
          row.publication_state = 'removed'
          row.removed_at = new Date().toISOString()
          row.removed_by = row.is_own ? 'uploader' : 'organiser'
        } else if (act === 'restore') {
          if (row.publication_state !== 'removed') return refuse('not_removed')
          const hostRestore = host && row.removed_by === 'organiser'
          row.removed_at = null
          row.removed_by = null
          if (hostRestore || !gated) {
            // The host's restore: `live`, whatever the gate says (CK-66);
            // any restore in an open gathering likewise. An existing
            // publication stamp is kept whole, a never-published row is
            // stamped now.
            row.publication_state = 'live'
            row.published_at = row.published_at ?? STAMP
          } else {
            // An uploader's or a co-host's restore in a gated gathering
            // passes through the gate (CK-63; CK-68): back to the host's
            // queue, both stamps cleared.
            row.publication_state = 'pending'
            row.published_at = null
          }
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

// The element itself, so a test can re-render it with the gate flipped —
// the way the detail page hands the section a new `requiresApproval`.
function mediaElement(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return (
    <GatheringMedia
      gatheringId="g-1"
      isHost={true}
      requiresApproval={false}
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
  const mock = stubRoutes(gatheringBinServer(initial(), { role: 'host' }).routes)

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
  const nonHost = stubRoutes(gatheringBinServer(initial(), { role: 'member' }).routes)
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
      removed_by: 'organiser',
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
      removed_by: 'organiser',
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
      removed_by: 'organiser',
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
          removed_by: 'organiser',
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

// ---- CK-69: co-hosts on the surface ----

test("a co-host's side: Remove from gathering on someone else's live ready row with the co-host's sentence in both gate states, the Removed view's control, own rows keeping the personal acts — and no queue, Publish or Decline anywhere", async () => {
  // The rows a co-host's list can hold: someone else's live row, and their
  // own rows (live, and waiting — `pending` is the host's and the
  // uploader's, so their own waiting row is the only waiting row they see).
  const initial = () => [
    mediaRow({ id: 'm-theirs-live', filename: 'theirs-live.jpg' }),
    mediaRow({ id: 'm-mine-live', filename: 'mine-live.jpg', is_own: true, uploader_display_name: 'peter' }),
    mediaRow({
      id: 'm-mine-waiting',
      filename: 'mine-waiting.jpg',
      is_own: true,
      uploader_display_name: 'peter',
      publication_state: 'pending',
    }),
  ]
  const server = gatheringBinServer(initial(), { role: 'co_host' })
  const mock = stubRoutes(server.routes)

  const view = render(mediaElement({ isHost: false, organises: true, requiresApproval: false }))
  let rows = await openPhotos()
  expect(rows).toHaveLength(3)
  // Someone else's live row: the takedown, and none of the personal acts.
  expect(within(rows[0]).getByRole('button', { name: 'Remove from gathering' })).toBeTruthy()
  expect(within(rows[0]).queryByRole('button', { name: 'Send to bin' })).toBeNull()
  expect(within(rows[0]).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  // Their own rows keep CK-64's acts and gain nothing; their own waiting
  // row reads the uploader's line — the host is the one who decides — and
  // carries no review act.
  expect(within(rows[1]).getByRole('button', { name: 'Send to bin' })).toBeTruthy()
  expect(within(rows[1]).queryByRole('button', { name: 'Remove from gathering' })).toBeNull()
  expect(rows[2].textContent).toContain(
    'Only you and the host can see this. Waiting for the host to publish or decline it.',
  )
  expect(within(rows[2]).queryByRole('button', { name: /^publish|^decline/i })).toBeNull()
  // The reserved review: nowhere. The delegable Removed view: on the page.
  expect(screen.queryByRole('button', { name: 'Awaiting your review' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('form', { name: /publish selected/i })).toBeNull()
  expect(screen.getByRole('group', { name: 'Show' })).toBeTruthy()
  expect(binControl()).toBeTruthy()

  // The step, open gathering: the co-host's sentence — never the host's
  // "you and any co-hosts", never "nobody", never the uploader's name.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  let step = within(rows[0]).getByRole('group', { name: 'Remove theirs-live.jpg from this gathering' })
  expect(step.textContent).toContain(CO_HOST_REMOVE_OPEN)
  expect(step.textContent).not.toMatch(/nobody|grandma|any co-hosts|included/i)
  expect(step.textContent).not.toMatch(BIN_BAN)
  expect(actRequests(mock)).toHaveLength(0)
  fireEvent.click(within(step).getByRole('button', { name: 'Leave it' }))
  expect(within(rows[0]).queryByRole('group', { name: /^Remove / })).toBeNull()

  // The step, gated: a co-host's Put back passes through the gate, and the
  // sentence says what putting it back does — the host looks at it again.
  view.rerender(mediaElement({ isHost: false, organises: true, requiresApproval: true }))
  rows = currentRows()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  step = within(rows[0]).getByRole('group', { name: /^Remove / })
  expect(step.textContent).toContain(CO_HOST_REMOVE_GATED)
  expect(step.textContent).not.toMatch(BIN_BAN)
  expect(step.textContent).not.toMatch(/approv|shared|screen|nobody|included/i)
  expect(actRequests(mock)).toHaveLength(0)

  // Remove it: one POST, the row leaves the co-host's default list — it is
  // in the gathering's bin, with the co-host recorded as the remover.
  fireEvent.click(within(step).getByRole('button', { name: 'Remove it' }))
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-theirs-live/remove')).toBe(true)
  await waitFor(() => {
    expect(currentRows()).toHaveLength(2)
  })
  expect(server.rows.get('m-theirs-live')!.publication_state).toBe('removed')
  expect(server.rows.get('m-theirs-live')!.status).toBe('ready')
  // In the Removed view it reads the co-host's line, the window just opened.
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  expect(currentRows()[0].textContent).toContain('theirs-live.jpg')
  expect(currentRows()[0].textContent).toContain(CO_HOST_BIN_LINE_30)
  // The queue was never asked for: the server would 404 a co-host there.
  expect(listRequests(mock).every(([url]) => !url.includes('awaiting_review'))).toBe(true)
})

test("the Removed view for a co-host: the co-host's line, Put back with the hint by gate state, no Delete permanently on another's row and Delete permanently on their own — and a gated Put back leaves their sight", async () => {
  const binned = () => [
    mediaRow({
      id: 'm-theirs-bin',
      filename: 'theirs-bin.jpg',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'organiser',
      published_at: STAMP,
    }),
    // The co-host's OWN photograph, which the host removed: in the
    // gathering's bin, so the Removed view lists it and the default list
    // does not.
    mediaRow({
      id: 'm-mine-bin',
      filename: 'mine-bin.jpg',
      is_own: true,
      uploader_display_name: 'peter',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'organiser',
    }),
  ]

  // Open gathering.
  let server = gatheringBinServer(binned(), { role: 'co_host' })
  let mock = stubRoutes(server.routes)
  renderMedia({ isHost: false, organises: true, requiresApproval: false })
  await openEmptyPhotos()
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(2)
  })
  let rows = currentRows()
  // Someone else's row: the co-host's line, Put back with the open-gathering
  // hint, and NO Delete permanently — the reserved act.
  expect(rows[0].textContent).toContain('theirs-bin.jpg')
  expect(rows[0].textContent).toContain(CO_HOST_BIN_LINE_28)
  expect(rows[0].textContent).not.toMatch(BIN_BAN)
  expect(rows[0].textContent).not.toMatch(/only you\b|in your bin|any co-hosts/i)
  expect(within(rows[0]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  expect(rows[0].textContent).toContain(PUT_BACK_HINT)
  expect(within(rows[0]).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  // Their own row IN THE REMOVED VIEW is a gathering-bin row: the same
  // line and the gathering-bin controls — never "In your bin", never Send
  // to bin — and Delete permanently, because it is their own.
  expect(rows[1].textContent).toContain('mine-bin.jpg')
  expect(rows[1].textContent).toContain(CO_HOST_BIN_LINE_28)
  expect(rows[1].textContent).not.toMatch(/in your bin/i)
  expect(within(rows[1]).queryByRole('button', { name: 'Send to bin' })).toBeNull()
  expect(within(rows[1]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  expect(within(rows[1]).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/approv|shared|screen|awaiting your review/i)
  // Put back, open: one POST, live again, the stamp kept.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-theirs-bin/restore')).toBe(true)
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  expect(server.rows.get('m-theirs-bin')!.publication_state).toBe('live')
  expect(server.rows.get('m-theirs-bin')!.published_at).toBe(STAMP)

  // Gated: the hint says the host will look at it again — the personal
  // bin's constant, and never the host-seat line — and Put back lands the
  // photograph in the host's queue, out of the co-host's own sight.
  cleanup()
  server = gatheringBinServer(binned(), { role: 'co_host', gated: true })
  mock = stubRoutes(server.routes)
  renderMedia({ isHost: false, organises: true, requiresApproval: true })
  await openEmptyPhotos()
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(2)
  })
  rows = currentRows()
  expect(rows[0].textContent).toContain(HOST_LOOKS_HINT)
  expect(rows[0].textContent).not.toContain(PUT_BACK_HINT)
  expect(rows[0].textContent).not.toContain(OWN_WAITS_HINT)
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  expect(actRequests(mock)).toHaveLength(1)
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  expect(server.rows.get('m-theirs-bin')!.publication_state).toBe('pending')
  expect(server.rows.get('m-theirs-bin')!.published_at).toBeNull()
  expect(document.body.textContent).not.toMatch(BIN_BAN)
})

test("the Removed view's own row for the host — a photograph of theirs a co-host removed: the gathering-bin line and controls, never \"In your bin\" and never the personal controls; absent from the default list", async () => {
  const server = gatheringBinServer([
    mediaRow({
      id: 'm-mine-taken',
      filename: 'mine-taken.jpg',
      is_own: true,
      uploader_display_name: 'Steven',
      publication_state: 'removed',
      removed_at: removedDaysAgo(2),
      removed_by: 'organiser',
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
  ])
  const mock = stubRoutes(server.routes)

  renderMedia({ isHost: true })
  let rows = await openPhotos()
  // The default list: the personal-bin row alone, with the personal line
  // and the personal acts — the row a co-host removed is not mixed in.
  expect(rows).toHaveLength(1)
  expect(rows[0].textContent).toContain('mine-bin.jpg')
  expect(rows[0].textContent).toContain(
    'In your bin. Only you can see it, and you can put it back for 29 more days.',
  )
  expect(within(rows[0]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  expect(screen.queryByText('mine-taken.jpg')).toBeNull()

  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  rows = currentRows()
  // In the Removed view the host's own row is the gathering's: the host's
  // line, Put back with the everyone hint, Delete permanently — and never
  // "In your bin", never Send to bin.
  expect(rows[0].textContent).toContain('mine-taken.jpg')
  expect(rows[0].textContent).toContain(HOST_BIN_LINE_28)
  expect(rows[0].textContent).not.toMatch(/in your bin/i)
  expect(within(rows[0]).queryByRole('button', { name: 'Send to bin' })).toBeNull()
  expect(within(rows[0]).getByRole('button', { name: 'Put back' })).toBeTruthy()
  expect(rows[0].textContent).toContain(PUT_BACK_HINT)
  expect(within(rows[0]).getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
  expect(screen.queryByText('mine-bin.jpg')).toBeNull()
  // Put back from here posts restore; a host restore goes live.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  expect(actRequests(mock)).toHaveLength(1)
  expect(actRequests(mock)[0][0].endsWith('/media/m-mine-taken/restore')).toBe(true)
  expect(await screen.findByText(EMPTY_BIN)).toBeTruthy()
  expect(server.rows.get('m-mine-taken')!.publication_state).toBe('live')
})

test("a refusal names the bin the act was on: already_removed on the takedown and not_removed on a Removed-view Put back say the gathering's, and a personal Send to bin keeps CK-64's line", async () => {
  // Rows the lists still show one way, that the server has since moved:
  // another organiser removed the first before this one did, put the
  // third back before this one did — the races several organisers make
  // real — and the host's own row is already in their bin.
  const mock = stubRoutes([
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const params = new URL(url, 'http://test.invalid').searchParams
        const bin = params.get('removed') === 'true'
        const listed = bin
          ? [mediaRow({ id: 'm-raced-back', filename: 'binned.jpg', publication_state: 'removed', removed_at: removedDaysAgo(2), removed_by: 'organiser' })]
          : [
              mediaRow({ id: 'm-raced-take', filename: 'theirs.jpg' }),
              mediaRow({ id: 'm-mine', filename: 'mine.jpg', is_own: true, uploader_display_name: 'Steven' }),
            ]
        return json(200, { media: listed.map(({ removed_by: _internal, ...sent }) => sent) })
      },
    },
    {
      method: 'POST',
      match: endsWith('/media/m-raced-take/remove'),
      response: () =>
        json(409, { detail: { code: 'already_removed', publication_state: 'removed', status: 'ready', message: SERVER_WORDING } }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-mine/remove'),
      response: () =>
        json(409, { detail: { code: 'already_removed', publication_state: 'removed', status: 'ready', message: SERVER_WORDING } }),
    },
    {
      method: 'POST',
      match: endsWith('/media/m-raced-back/restore'),
      response: () =>
        json(409, { detail: { code: 'not_removed', publication_state: 'live', status: 'ready', message: SERVER_WORDING } }),
    },
    notReadyLayers,
  ])

  renderMedia({ isHost: true })
  let rows = await openPhotos()
  // The takedown: the gathering's bin.
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove from gathering' }))
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove it' }))
  const takedown = await within(rows[0]).findByRole('alert')
  expect(takedown.textContent).toContain(
    'This photo has already been removed — refresh the list to see where it is.',
  )
  expect(takedown.textContent).not.toMatch(/your bin/i)
  // A personal act on the host's own row: CK-64's line, unchanged.
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Send to bin' }))
  const personal = await within(rows[1]).findByRole('alert')
  expect(personal.textContent).toContain('This photo is already in your bin.')
  // The Removed view's Put back: the gathering's bin.
  fireEvent.click(binControl())
  await waitFor(() => {
    expect(currentRows()).toHaveLength(1)
  })
  rows = currentRows()
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Put back' }))
  const putBack = await within(rows[0]).findByRole('alert')
  expect(putBack.textContent).toContain(
    "This photo isn't in the gathering's bin any more — refresh the list to see where it is.",
  )
  expect(putBack.textContent).not.toMatch(/your bin/i)
  expect(document.body.textContent).not.toContain('SERVER WORDING')
  expect(document.body.textContent).not.toMatch(BIN_BAN)
  expect(actRequests(mock)).toHaveLength(3)
})
