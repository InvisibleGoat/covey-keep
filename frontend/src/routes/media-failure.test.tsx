// CK-71 pins on the surface for a photograph that cannot be kept (pipeline
// record §6.5 as amended). The value under test: a failed row's line and
// controls follow its failure_reason — the too-large line with "A smaller
// copy will work." and Choose a smaller copy, the unreadable line with no
// retry at all, the upload-incomplete and interrupted lines with Try again,
// the fallback line for a row carrying no reason — and every control is the
// UPLOADER's: a failed row that is not the caller's gets the line and nothing
// to press, however the row arrived; both retry labels open the picker (the
// re-upload is from the device); Dismiss posts once with no body and the row
// leaves the list on the re-read, one act at a time, with no notice line and
// no confirmation; a refusal renders on the row from its CODE, never the
// server's wording, with Refresh the list beside it; the ban list holds on
// every rendered failed row; and the device-side line for a PUT that failed
// from here is untouched — "This upload didn't finish." with Try again alone
// and no Dismiss, because that row is not `failed` on the server.
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
  failure_reason: string | null
}

function mediaRow(over: Partial<Row> = {}): Row {
  return {
    id: 'm-1',
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'failed',
    publication_state: 'pending',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1807499,
    uploaded_at: '2026-09-30T12:00:01+00:00',
    created_at: '2026-09-30T12:00:00+00:00',
    uploader_display_name: 'Steven',
    is_own: true,
    removed_at: null,
    filename: 'IMG_1721.jpeg',
    caption: null,
    tags: [],
    published_at: null,
    failure_reason: null,
    ...over,
  }
}

const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'

// The record's rule, as the kickoff's ban list, on every rendered failed row.
const FAILURE_BAN = /deleted|corrupt|damaged|virus|error/i

// The controls a failed row can carry, and the names this file counts.
const FAILED_CONTROLS = ['Try again', 'Choose a smaller copy', 'Dismiss'] as const

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
const is = (exact: string) => (url: string) => url === exact

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

const dismissRequests = (mock: ReturnType<typeof vi.fn>) =>
  calls(mock, 'POST', (url) => /\/media\/[^/]+\/dismiss$/.test(url))

// A stand-in for the media router's dismiss over an in-memory set of rows,
// following the api-reference to the letter this surface depends on: the
// list carries every row the fixture names (the fixture decides `is_own`);
// dismiss on a row that is gone is the media 404; on a row that has not
// failed the 409 `not_failed` carrying the rung, in words this surface must
// never render; on a failed row a hard delete and a 204 with no body.
function failureServer(initial: Row[], options: { refuse?: 'not_failed' | 'not_found' } = {}) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]))
  const routes: StubRoute[] = [
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: () => json(200, { media: [...rows.values()] }),
    },
    {
      method: 'POST',
      match: (url) => /\/media\/[^/]+\/dismiss$/.test(url),
      response: (_init, url) => {
        const [, id] = url.match(/\/media\/([^/]+)\/dismiss$/)! as unknown as [string, string]
        const row = rows.get(id)
        if (options.refuse === 'not_found' || !row) return json(404, { detail: 'No such photograph.' })
        if (options.refuse === 'not_failed' || row.status !== 'failed') {
          return json(409, {
            detail: { code: 'not_failed', publication_state: row.publication_state, status: row.status, message: SERVER_WORDING },
          })
        }
        rows.delete(id)
        return new Response(null, { status: 204 })
      },
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

function controlsOn(row: HTMLElement): string[] {
  return FAILED_CONTROLS.filter((name) => within(row).queryByRole('button', { name }) !== null)
}

const rowFor = (rows: HTMLElement[], name: string) =>
  rows.find((row) => row.textContent?.includes(name)) as HTMLElement

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// One own row per reason, the null fallback, and a row that is not the
// caller's — named by filename so the pins read by name, not position.
function theMatrix(): Row[] {
  return [
    mediaRow({ id: 'm-large', filename: 'pano.jpg', failure_reason: 'too_large' }),
    mediaRow({ id: 'm-unreadable', filename: 'IMG_1721.jpeg', failure_reason: 'unreadable' }),
    mediaRow({ id: 'm-incomplete', filename: 'cake.heic', failure_reason: 'upload_incomplete' }),
    mediaRow({ id: 'm-interrupted', filename: 'yard.jpg', failure_reason: 'interrupted' }),
    mediaRow({ id: 'm-unknown', filename: 'old.jpg', failure_reason: null }),
    mediaRow({
      id: 'm-theirs',
      filename: 'grandma-pano.jpg',
      failure_reason: 'too_large',
      is_own: false,
      uploader_display_name: 'grandma',
    }),
  ]
}

test("each reason renders its line and its controls for the uploader; a failed row that is not the caller's gets the line and nothing to press", async () => {
  stubRoutes(failureServer(theMatrix()).routes)
  // The host's seat: the one most tempted to be offered a Try again on
  // someone else's failure (the defect this phase retires).
  renderMedia({ isHost: true })
  const rows = await openPhotos()
  expect(rows).toHaveLength(6)

  const large = rowFor(rows, 'pano.jpg')
  expect(large.textContent).toContain(
    "This photo is too large to keep here — it's over 50 megapixels. A smaller copy will work.",
  )
  expect(controlsOn(large)).toEqual(['Choose a smaller copy', 'Dismiss'])

  const unreadable = rowFor(rows, 'IMG_1721.jpeg')
  expect(unreadable.textContent).toContain("This file isn't a photo we can read.")
  // No retry that could succeed — Dismiss alone, and no Try again anywhere on it.
  expect(controlsOn(unreadable)).toEqual(['Dismiss'])

  const incomplete = rowFor(rows, 'cake.heic')
  expect(incomplete.textContent).toContain("This upload didn't finish.")
  expect(controlsOn(incomplete)).toEqual(['Try again', 'Dismiss'])

  const interrupted = rowFor(rows, 'yard.jpg')
  expect(interrupted.textContent).toContain("We couldn't finish preparing this photo.")
  expect(controlsOn(interrupted)).toEqual(['Try again', 'Dismiss'])

  const unknown = rowFor(rows, 'old.jpg')
  expect(unknown.textContent).toContain("We couldn't process this photo.")
  expect(controlsOn(unknown)).toEqual(['Try again', 'Dismiss'])

  // Someone else's failure: the first sentence, never the second, and
  // nothing to press — not a retry, not Dismiss, not an editor.
  const theirs = rowFor(rows, 'grandma-pano.jpg')
  expect(theirs.textContent).toContain("This photo is too large to keep here — it's over 50 megapixels.")
  expect(theirs.textContent).not.toContain('A smaller copy will work.')
  expect(controlsOn(theirs)).toEqual([])
  expect(within(theirs).queryAllByRole('button')).toHaveLength(0)

  // No editor on any failed row — a failed photograph has nothing to caption.
  for (const row of rows) {
    expect(within(row).queryByRole('button', { name: /edit/i })).toBeNull()
    expect(row.textContent).not.toMatch(FAILURE_BAN)
  }
})

test('both retry labels open the picker — the re-upload is from the device, never a re-queue', async () => {
  stubRoutes(failureServer(theMatrix()).routes)
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  renderMedia()
  const rows = await openPhotos()

  fireEvent.click(within(rowFor(rows, 'pano.jpg')).getByRole('button', { name: 'Choose a smaller copy' }))
  expect(click).toHaveBeenCalledTimes(1)
  fireEvent.click(within(rowFor(rows, 'yard.jpg')).getByRole('button', { name: 'Try again' }))
  expect(click).toHaveBeenCalledTimes(2)
  // And neither posted anything: the server has nothing to retry.
  expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST')).toHaveLength(0)
})

test('Dismiss posts once with no body, one act at a time, and the row leaves the list on the re-read — no confirmation, no notice', async () => {
  const mock = stubRoutes(failureServer(theMatrix()).routes)
  renderMedia()
  const rows = await openPhotos()
  expect(rows).toHaveLength(6)

  const dismiss = within(rowFor(rows, 'IMG_1721.jpeg')).getByRole('button', { name: 'Dismiss' })
  fireEvent.click(dismiss)
  fireEvent.click(dismiss) // the guard: one act at a time
  await waitFor(() => {
    expect(dismissRequests(mock)).toHaveLength(1)
  })
  const [url, init] = dismissRequests(mock)[0]
  expect(url.endsWith('/media/m-unreadable/dismiss')).toBe(true)
  expect(init?.body).toBeUndefined()

  // The row is gone from the next read; the other five stay.
  await waitFor(() => {
    expect(currentRows()).toHaveLength(5)
  })
  expect(screen.queryByText('IMG_1721.jpeg')).toBeNull()
  expect(currentRows().map((row) => controlsOn(row).includes('Dismiss'))).toEqual([true, true, true, true, false])
  // No second step was asked, and no status line follows — the row leaving
  // is the whole of what the person asked for.
  expect(screen.queryByText(/Are you sure/)).toBeNull()
  expect(screen.queryByText('Photo deleted.')).toBeNull()
  expect(document.body.textContent).not.toMatch(FAILURE_BAN)
})

test("a refusal renders on the row from its CODE — never the server's wording — with Refresh the list, and the row stays", async () => {
  const mock = stubRoutes(failureServer(theMatrix(), { refuse: 'not_failed' }).routes)
  renderMedia()
  let rows = await openPhotos()
  fireEvent.click(within(rowFor(rows, 'cake.heic')).getByRole('button', { name: 'Dismiss' }))
  const refusal = await screen.findByText(
    "This photo didn't fail, so there's nothing to dismiss — refresh the list to see where it is.",
  )
  expect(refusal.closest('li')?.textContent).toContain('cake.heic')
  expect(document.body.textContent).not.toContain(SERVER_WORDING)
  expect(within(refusal.closest('li') as HTMLElement).getByRole('button', { name: 'Refresh the list' })).toBeTruthy()
  // A refusal re-reads nothing: the list request count is where it was.
  expect(calls(mock, 'GET', (url) => url.includes('/gatherings/g-1/media'))).toHaveLength(1)
  expect(currentRows()).toHaveLength(6)

  cleanup()
  vi.unstubAllGlobals()
  stubRoutes(failureServer(theMatrix(), { refuse: 'not_found' }).routes)
  renderMedia()
  rows = await openPhotos()
  fireEvent.click(within(rowFor(rows, 'yard.jpg')).getByRole('button', { name: 'Dismiss' }))
  const gone = await screen.findByText("This photo isn't here any more — refresh the list to see what is.")
  expect(gone.closest('li')?.textContent).toContain('yard.jpg')
  expect(gone.textContent).not.toMatch(FAILURE_BAN)
})

test('the device-side line is untouched: a PUT that fails from here reads "This upload didn\'t finish." with Try again alone and no Dismiss', async () => {
  // The row is `pending_upload` on the server — it is reaped at 24 hours,
  // never `failed` — so none of the failed row's controls apply to it.
  const PUT_URL =
    'https://r2.invalid/coveykeep-dev-quarantine/uploads/m-new?X-Amz-Credential=UPLOADKEYID%2F20260909&X-Amz-Signature=putsig123'
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ id: 'm-new', status: 'pending_upload', filename: 'photo.jpg' })] }),
    },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/intents'),
      response: () =>
        json(201, {
          intents: [
            {
              media: { id: 'm-new', status: 'pending_upload', filename: 'photo.jpg', failure_reason: null },
              upload: { url: PUT_URL, method: 'PUT', headers: { 'Content-Length': '1', 'Content-Type': 'image/jpeg' }, expires_in: 900 },
            },
          ],
        }),
    },
    { method: 'PUT', match: is(PUT_URL), response: () => new Response(null, { status: 403 }) },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  fireEvent.change(screen.getByLabelText(/add photos/i), {
    target: { files: [new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })] },
  })
  fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))

  const message = await screen.findByText("This upload didn't finish.")
  const row = message.closest('li') as HTMLElement
  expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['Try again'])
  expect(controlsOn(row)).toEqual(['Try again'])
  expect(dismissRequests(mock)).toHaveLength(0)
})
