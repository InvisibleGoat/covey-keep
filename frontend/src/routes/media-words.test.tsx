// CK-40 pins on the words surface. The value under test: the intent carries
// the filename trimmed from the File and the size from File.size (the PUT
// signs Content-Length, which the client cannot set — the blob's own size is
// the only one that matches the signature), and the row is called by the
// server's name after a reload — the half of CK-38's finding a person
// experiences, closed; a row is called by its caption, then its filename,
// then "Photo"; a tag is text and never a link; no edit affordance renders
// on a row that is not the caller's own; ADDING A SECOND TAG SENDS BOTH and
// leaves two (the server replaces the set — a partial list is silent data
// loss that reads as a UI bug); blanking a caption sends null and never "";
// an already-empty caption is omitted from the patch; a whitespace-only one
// goes out as typed and the server's 422 renders inline; and the search box
// sets `q` once typing settles, sends none for an empty box, and renders an
// empty result as a state with the way back.
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

function mediaRow(over: Record<string, unknown> = {}) {
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
    ...over,
  }
}

const PUT_URL =
  'https://r2.invalid/coveykeep-dev-quarantine/uploads/m-new?X-Amz-Credential=UPLOADKEYID%2F20260910&X-Amz-Signature=putsig123'

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

function body(call: [string, RequestInit | undefined]): Record<string, unknown> {
  return JSON.parse(call[1]!.body as string) as Record<string, unknown>
}

function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <GatheringMedia
      gatheringId="g-1"
      isHost={false}
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
}

// The rows of the Photos list, and not the tag chips nested inside them.
function photoRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll(':scope > li')) as HTMLElement[]
}

function nameOf(row: HTMLElement): string | undefined {
  return row.querySelector('strong')?.textContent ?? undefined
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

test("the intent carries the filename trimmed from the File and the size from File.size, and the row is called by the server's name — after a reload too", async () => {
  let listed: unknown[] = []
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/gatherings/g-1/media'), response: () => json(200, { media: listed }) },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/intents'),
      response: () => {
        // The server stores the trimmed name and echoes it on every body.
        listed = [mediaRow({ id: 'm-new', status: 'pending_upload', filename: 'IMG_0570.jpg' })]
        return json(201, {
          intents: [
            {
              media: { id: 'm-new', status: 'pending_upload', filename: 'IMG_0570.jpg' },
              upload: {
                url: PUT_URL,
                method: 'PUT',
                headers: { 'Content-Length': '7', 'Content-Type': 'image/jpeg' },
                expires_in: 900,
              },
            },
          ],
        })
      },
    },
    { method: 'PUT', match: is(PUT_URL), response: () => new Response(null, { status: 200 }) },
    {
      method: 'POST',
      match: endsWith('/media/m-new/confirm'),
      response: () => {
        listed = [mediaRow({ id: 'm-new', status: 'uploaded', filename: 'IMG_0570.jpg' })]
        return json(200, mediaRow({ id: 'm-new', status: 'uploaded', filename: 'IMG_0570.jpg' }))
      },
    },
  ])

  renderMedia()
  await openPhotos()
  await screen.findByText('No photos yet.')

  // Seven bytes, and a name carrying whitespace no picker trims for us.
  const file = new File([new Uint8Array(7)], ' IMG_0570.jpg ', { type: 'image/jpeg' })
  fireEvent.change(screen.getByLabelText(/add photos/i), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))
  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/confirm'))).toHaveLength(1)
  })

  expect(body(calls(mock, 'POST', endsWith('/intents'))[0])).toEqual({
    items: [{ content_type: 'image/jpeg', size_bytes: 7, filename: 'IMG_0570.jpg' }],
  })
  // Content-Length is never set by hand; the browser derives it from the
  // body, whose size is the one the intent declared.
  const [, putInit] = calls(mock, 'PUT', () => true)[0]
  expect(putInit!.headers).toEqual({ 'Content-Type': 'image/jpeg' })

  expect(await screen.findByText('IMG_0570.jpg')).toBeTruthy()
  expect(document.body.innerHTML).not.toContain('putsig123')

  // A hard reload: nothing this device remembered survives, and the row is
  // still called by its name, because the list carries it.
  cleanup()
  renderMedia()
  await openPhotos()
  expect(await screen.findByText('IMG_0570.jpg')).toBeTruthy()
  expect(screen.queryByText('Photo')).toBeNull()
})

test("a row is called by its caption, then its filename, then Photo; a tag is text and never a link; no edit affordance on a row that is not the caller's own, nor on a failed one", async () => {
  stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () =>
        json(200, {
          media: [
            mediaRow({ id: 'm-cap', caption: 'Safety sign at the yard', filename: 'IMG_0569.HEIC' }),
            mediaRow({ id: 'm-name', filename: 'qa-dk-check.jpg', tags: ['qa'] }),
            mediaRow({ id: 'm-none' }),
            mediaRow({
              id: 'm-theirs',
              is_own: false,
              uploader_display_name: 'grandma',
              caption: 'Cake',
              tags: ['birthday', 'https://evil.example'],
            }),
            mediaRow({ id: 'm-fail', status: 'failed', filename: 'blurry.jpg' }),
          ],
        }),
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  const rows = photoRows(await screen.findByRole('list', { name: 'Photos' }))
  expect(rows).toHaveLength(5)

  // The precedence: a person's own words win, the file's name is the
  // fallback, "Photo" is what remains — every pre-CK-39 row, permanently.
  expect(nameOf(rows[0])).toBe('Safety sign at the yard')
  expect(rows[0].textContent).not.toContain('IMG_0569.HEIC')
  expect(nameOf(rows[1])).toBe('qa-dk-check.jpg')
  expect(nameOf(rows[2])).toBe('Photo')
  // The failed row is finally nameable: "Try again" no longer re-uploads blind.
  expect(nameOf(rows[4])).toBe('blurry.jpg')

  // Tags render as text chips — an address-shaped one included — and never
  // as a link (CK-21's discipline: nothing here reaches a navigation sink).
  const ownTags = within(rows[1]).getByRole('list', { name: 'Tags on qa-dk-check.jpg' })
  expect(within(ownTags).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['qa'])
  const theirTags = within(rows[3]).getByRole('list', { name: 'Tags on Cake' })
  expect(within(theirTags).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'birthday',
    'https://evil.example',
  ])
  expect(rows[3].querySelector('a')).toBeNull()
  expect(document.body.querySelector('a')).toBeNull()

  // Only the uploader may edit (the server 404s everyone else, the host
  // included), so no edit affordance renders on a row that is not the
  // caller's own — offering an action that cannot succeed is its own defect.
  expect(within(rows[3]).queryByRole('button', { name: /edit/i })).toBeNull()
  for (const row of rows.slice(0, 3)) {
    expect(within(row).getByRole('button', { name: 'Edit caption and tags' })).toBeTruthy()
  }
  // A failed photograph has nothing to caption: its one affordance stays.
  expect(within(rows[4]).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Try again',
  ])
})

test('adding a second tag to a photograph that already has one sends both and leaves it with two; removing one sends the set minus one', async () => {
  let tags = ['qa']
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ tags })] }),
    },
    {
      method: 'PATCH',
      match: endsWith('/media/m-1'),
      response: (init) => {
        // The server REPLACES the set with what it receives and answers with
        // it alphabetical — whatever the client sent is what remains.
        const sent = (JSON.parse(init!.body as string) as { tags: string[] }).tags
        tags = [...sent].sort()
        return json(200, mediaRow({ tags }))
      },
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  const list = await screen.findByRole('list', { name: 'Photos' })
  const chips = () =>
    within(within(list).getByRole('list', { name: 'Tags on Photo' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
  expect(chips()).toEqual(['qa'])

  // Add one. The patch must carry BOTH — sending only the new tag would
  // delete `qa` with no error and no warning.
  fireEvent.click(screen.getByRole('button', { name: 'Edit caption and tags' }))
  fireEvent.change(screen.getByLabelText('Add a tag'), { target: { value: ' cake ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => {
    expect(calls(mock, 'PATCH', endsWith('/media/m-1'))).toHaveLength(1)
  })
  expect(body(calls(mock, 'PATCH', endsWith('/media/m-1'))[0])).toEqual({ tags: ['qa', 'cake'] })
  await waitFor(() => {
    expect(chips()).toEqual(['cake', 'qa'])
  })
  // The editor closed on success; the list is the server's body.
  expect(screen.queryByLabelText('Caption')).toBeNull()

  // Remove one: the set minus one, never an instruction to delete one.
  fireEvent.click(screen.getByRole('button', { name: 'Edit caption and tags' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove tag qa' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => {
    expect(calls(mock, 'PATCH', endsWith('/media/m-1'))).toHaveLength(2)
  })
  expect(body(calls(mock, 'PATCH', endsWith('/media/m-1'))[1])).toEqual({ tags: ['cake'] })
  await waitFor(() => {
    expect(chips()).toEqual(['cake'])
  })
  // No caption key ever went: the caption was untouched.
  for (const call of calls(mock, 'PATCH', endsWith('/media/m-1'))) {
    expect('caption' in body(call)).toBe(false)
  }
})

test('blanking a saved caption sends null — never "" — and the row falls back to its filename; a no-op edit sends nothing', async () => {
  let caption: string | null = 'Safety sign at the yard'
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ caption, filename: 'IMG_0569.HEIC' })] }),
    },
    {
      method: 'PATCH',
      match: endsWith('/media/m-1'),
      response: (init) => {
        const sent = JSON.parse(init!.body as string) as { caption?: string | null }
        if ('caption' in sent) caption = sent.caption ?? null
        return json(200, mediaRow({ caption, filename: 'IMG_0569.HEIC' }))
      },
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  const list = await screen.findByRole('list', { name: 'Photos' })
  expect(nameOf(photoRows(list)[0])).toBe('Safety sign at the yard')

  fireEvent.click(screen.getByRole('button', { name: 'Edit caption and tags' }))
  const input = screen.getByLabelText('Caption') as HTMLInputElement
  expect(input.value).toBe('Safety sign at the yard')
  // Dirty-tracking: nothing differs, so Save is disabled and no PATCH goes —
  // the same value with whitespace around it is still no change.
  const save = () => screen.getByRole('button', { name: 'Save' })
  expect(save().hasAttribute('disabled')).toBe(true)
  fireEvent.change(input, { target: { value: '  Safety sign at the yard  ' } })
  expect(save().hasAttribute('disabled')).toBe(true)
  // The hint says what the row is called once the caption is gone.
  expect(screen.getByText(/the photo is then called IMG_0569\.HEIC/)).toBeTruthy()

  // Blank it: the CK-22 gesture. Explicit null goes, never "".
  fireEvent.change(input, { target: { value: '' } })
  expect(save().hasAttribute('disabled')).toBe(false)
  fireEvent.click(save())
  await waitFor(() => {
    expect(calls(mock, 'PATCH', endsWith('/media/m-1'))).toHaveLength(1)
  })
  const [, init] = calls(mock, 'PATCH', endsWith('/media/m-1'))[0]
  expect(init!.body).toBe('{"caption":null}')
  expect(String(init!.body)).not.toContain('""')
  await waitFor(() => {
    expect(nameOf(photoRows(list)[0])).toBe('IMG_0569.HEIC')
  })
})

test("an already-empty caption is omitted from the patch, and a whitespace-only one goes out as typed and renders the server's 422 inline", async () => {
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ tags: ['qa'] })] }),
    },
    {
      method: 'PATCH',
      match: endsWith('/media/m-1'),
      response: (init) => {
        const sent = JSON.parse(init!.body as string) as { caption?: string | null; tags?: string[] }
        if (typeof sent.caption === 'string' && sent.caption.trim() === '') {
          // Blank is never a clear: the server refuses it in its own words.
          return json(422, {
            detail: [{ loc: ['body', 'caption'], msg: 'Value error, a caption can be cleared but not left blank' }],
          })
        }
        return json(200, mediaRow({ tags: sent.tags ?? ['qa'] }))
      },
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  await screen.findByRole('list', { name: 'Photos' })

  // A tag change with the caption left empty: no caption key at all — a
  // null for an already-null field would be a no-op write.
  fireEvent.click(screen.getByRole('button', { name: 'Edit caption and tags' }))
  fireEvent.change(screen.getByLabelText('Add a tag'), { target: { value: 'cake' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => {
    expect(calls(mock, 'PATCH', endsWith('/media/m-1'))).toHaveLength(1)
  })
  const first = body(calls(mock, 'PATCH', endsWith('/media/m-1'))[0])
  expect(first).toEqual({ tags: ['qa', 'cake'] })
  expect('caption' in first).toBe(false)
  await waitFor(() => {
    expect(screen.queryByLabelText('Caption')).toBeNull()
  })

  // Whitespace only: sent as typed, and the server's refusal lands on the
  // caption input through the one mapper — never pre-empted client-side.
  fireEvent.click(screen.getByRole('button', { name: 'Edit caption and tags' }))
  const input = screen.getByLabelText('Caption') as HTMLInputElement
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const message = await screen.findByText(/^A caption can be cleared but not left blank/)
  expect(message.getAttribute('id')).toBe('error-media-m-1-caption')
  expect(input.getAttribute('aria-describedby')).toBe('error-media-m-1-caption')
  expect(body(calls(mock, 'PATCH', endsWith('/media/m-1'))[1])).toEqual({ caption: '   ' })
  // The editor stays open with the person's entry, for them to fix.
  expect(input.value).toBe('   ')
})

test('the search box sets q once typing settles — one request for several keystrokes, none for an empty box — and an empty result is a state with the way back', async () => {
  const matching = mediaRow({ caption: 'Safety sign at the yard' })
  const mock = stubRoutes([
    {
      method: 'GET',
      match: (url) => url.includes('/gatherings/g-1/media'),
      response: (_init, url) => {
        const q = new URL(url).searchParams.get('q')
        return json(200, { media: q === null || q === 'yard' ? [matching] : [] })
      },
    },
    notReadyLayers,
  ])

  renderMedia()
  await openPhotos()
  await screen.findByText('Safety sign at the yard')
  const listRequests = () => calls(mock, 'GET', (url) => url.includes('/gatherings/g-1/media'))
  const withQ = () => listRequests().filter(([url]) => url.includes('q='))
  expect(listRequests()).toHaveLength(1)
  expect(withQ()).toHaveLength(0)

  // Four keystrokes, one request, carrying the settled term.
  const box = screen.getByLabelText('Find a photo') as HTMLInputElement
  for (const typed of ['z', 'zz', 'zzq', 'zzqx']) {
    fireEvent.change(box, { target: { value: typed } })
  }
  expect(await screen.findByText(/No photos match “zzqx”\./)).toBeTruthy()
  expect(withQ()).toHaveLength(1)
  expect(withQ()[0][0]).toContain('/gatherings/g-1/media?q=zzqx')
  // An empty result is a state, not a blank area — and not "No photos yet."
  expect(screen.queryByRole('list', { name: 'Photos' })).toBeNull()
  expect(screen.queryByText('No photos yet.')).toBeNull()

  // The way back: the box empties and the request carries no q at all.
  fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }))
  expect(await screen.findByText('Safety sign at the yard')).toBeTruthy()
  expect(box.value).toBe('')
  expect(listRequests().at(-1)![0]).not.toContain('q=')
  expect(withQ()).toHaveLength(1)

  // A match: the filtered view says it is one, with the term trimmed. (The
  // status line renders the moment the term settles; the request it
  // provokes follows in the effect, so it is awaited rather than assumed.)
  fireEvent.change(box, { target: { value: ' yard ' } })
  expect(await screen.findByText(/Showing 1 photo matching “yard”\./)).toBeTruthy()
  await waitFor(() => {
    expect(withQ()).toHaveLength(2)
  })
  expect(withQ()[1][0]).toContain('/gatherings/g-1/media?q=yard')
  expect(screen.getByRole('list', { name: 'Photos' })).toBeTruthy()

  // Whitespace alone is an empty box: no q, no filtered state.
  fireEvent.change(box, { target: { value: '   ' } })
  await waitFor(() => {
    expect(screen.queryByText(/matching/)).toBeNull()
  })
  await waitFor(() => {
    // initial, zzqx, show all, yard, and this one.
    expect(listRequests()).toHaveLength(5)
  })
  expect(listRequests()[4][0]).not.toContain('q=')
  expect(withQ()).toHaveLength(2)
})
