// CK-38 upload-surface pins. The value under test: the section is collapsed
// until opened (the detail page stays one request); a HEIC with an EMPTY
// file.type still declares a type and the PUT sends exactly the header R2
// signed — and never Content-Length; a video is refused with the SERVER's
// message rendered inline against the file it names, and no PUT follows;
// every rung renders its own honest line, the ready line read from
// publication_state (the `live` branch exists before anything reaches it);
// a failed row offers exactly one affordance; the list polls while anything
// is in flight and makes no request once everything is terminal; and NO
// presigned URL ever appears anywhere but the one fetch that spends it —
// not in state, not in the DOM, not in an error.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState, type Person } from '../auth/context'
import { GatheringMedia } from '../components/GatheringMedia'
import mediaComponentSource from '../components/GatheringMedia.tsx?raw'
import mediaLibSource from '../lib/media.ts?raw'
import { GatheringDetail } from './GatheringDetail'

const person: Person = {
  id: 'person-1',
  display_name: 'Steven',
  email: 'steven@example.com',
  timezone: 'America/Chicago',
  account_id: 'acct-1',
}

const auth: AuthState = {
  status: 'signedIn',
  person,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function detailBody(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'Test Potluck',
    memorial_decedent_name: null,
    requires_approval: true,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-1',
    host_account_id: 'acct-1',
    created_at: '2026-08-25T12:00:00+00:00',
    updated_at: null,
    occurrences: [
      {
        id: 'occ-1',
        gathering_id: 'g-1',
        starts_at: '2026-09-01T18:00:00+00:00',
        ends_at: null,
        location: null,
        map_url: null,
      },
    ],
    ...over,
  }
}

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
    // The words (CK-39 response-body fields; a shape change): the rows CK-38
    // pinned carry no name, no caption, no tags — as every pre-0018 row does.
    filename: null,
    caption: null,
    tags: [],
    ...over,
  }
}

// A presigned URL the way R2 spells one: the Access Key ID and a signature
// in the query string — the strings the never-leaks assertion looks for.
const PUT_URL =
  'https://r2.invalid/coveykeep-dev-quarantine/uploads/m-new?X-Amz-Credential=UPLOADKEYID%2F20260909&X-Amz-Signature=putsig123'
const GET_URL =
  'https://r2.invalid/coveykeep-dev/media/m-1/thumbnail?X-Amz-Credential=SERVEKEYID%2F20260909&X-Amz-Signature=getsig456'
const WEB_URL =
  'https://r2.invalid/coveykeep-dev/media/m-1/web?X-Amz-Credential=SERVEKEYID%2F20260909&X-Amz-Signature=websig789'

interface StubRoute {
  method: string
  match: (url: string) => boolean
  response: () => Response
}

function stubRoutes(routes: StubRoute[]) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const route = routes.find((r) => r.method === method && r.match(String(url)))
    if (!route) throw new Error(`no stub for ${method} ${String(url)}`)
    return Promise.resolve(route.response())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const endsWith = (suffix: string) => (url: string) => url.endsWith(suffix)
const is = (exact: string) => (url: string) => url === exact

function calls(mock: ReturnType<typeof vi.fn>, method: string, match: (url: string) => boolean) {
  return mock.mock.calls.filter(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET') === method && match(String(url)),
  ) as unknown as [string, RequestInit | undefined][]
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/gatherings/:id" element={<GatheringDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <GatheringMedia
      gatheringId="g-1"
      isHost={false}
      occurrences={detailBody().occurrences}
      zone="America/Chicago"
      pollIntervalMs={20}
      {...over}
    />,
  )
}

const createdObjectUrls: string[] = []
const revokedObjectUrls: string[] = []

beforeEach(() => {
  // jsdom has no object URLs; the blob path needs both halves.
  createdObjectUrls.length = 0
  revokedObjectUrls.length = 0
  Object.assign(URL, {
    createObjectURL: () => {
      const objectUrl = `blob:stub-${createdObjectUrls.length + 1}`
      createdObjectUrls.push(objectUrl)
      return objectUrl
    },
    revokeObjectURL: (objectUrl: string) => {
      revokedObjectUrls.push(objectUrl)
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('the photos section is collapsed until opened, and opening it loads the list exactly once when nothing is in flight', async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/gatherings/g-1'), response: () => json(200, detailBody()) },
    { method: 'GET', match: endsWith('/gatherings/g-1/media'), response: () => json(200, { media: [] }) },
  ])

  renderDetail()
  await screen.findByText('Test Potluck')
  // Collapsed: the detail page stays one request.
  expect(calls(mock, 'GET', endsWith('/media'))).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  expect(await screen.findByText('No photos yet.')).toBeTruthy()
  expect(screen.getByLabelText(/add photos/i)).toBeTruthy()
  // Nothing in flight: no polling. (The interval is the product's 3 s here;
  // a poll timer that existed would be visible as a pending re-read once the
  // list settles — none is armed for an empty list.)
  await sleep(50)
  expect(calls(mock, 'GET', endsWith('/media'))).toHaveLength(1)
})

test('a HEIC whose file.type is empty declares image/heic, the PUT sends exactly the signed Content-Type and never Content-Length, and the presigned URL appears in that one call and nowhere else', async () => {
  let listed: unknown[] = []
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/gatherings/g-1/media'), response: () => json(200, { media: listed }) },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/intents'),
      response: () =>
        json(201, {
          intents: [
            {
              media: { id: 'm-new', status: 'pending_upload' },
              upload: {
                url: PUT_URL,
                method: 'PUT',
                headers: { 'Content-Length': '3', 'Content-Type': 'image/heic' },
                expires_in: 900,
              },
            },
          ],
        }),
    },
    { method: 'PUT', match: is(PUT_URL), response: () => new Response(null, { status: 200 }) },
    {
      method: 'POST',
      match: endsWith('/media/m-new/confirm'),
      response: () => {
        // The server echoes the name it stored (CK-39); the row is called by
        // it from the list, not from anything this device remembered.
        listed = [mediaRow({ id: 'm-new', status: 'uploaded', filename: 'IMG_0569.HEIC' })]
        return json(200, mediaRow({ id: 'm-new', status: 'uploaded', filename: 'IMG_0569.HEIC' }))
      },
    },
  ])

  renderMedia()
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByText('No photos yet.')

  // The iPhone default, as the browser hands it over: no type at all.
  const file = new File([new Uint8Array([1, 2, 3])], 'IMG_0569.HEIC', { type: '' })
  fireEvent.change(screen.getByLabelText(/add photos/i), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))

  await waitFor(() => {
    expect(calls(mock, 'POST', endsWith('/confirm'))).toHaveLength(1)
  })

  // The intent declared the type the extension names.
  const [, intentInit] = calls(mock, 'POST', endsWith('/intents'))[0]
  expect(JSON.parse(intentInit!.body as string)).toEqual({
    items: [{ content_type: 'image/heic', size_bytes: 3, filename: 'IMG_0569.HEIC' }],
  })

  // The PUT: the file as the body, the signed Content-Type exactly, no
  // Content-Length (forbidden in fetch — the browser sets it from the
  // body, which is what makes the signature match), and no Authorization
  // (R2 is not our API; the JWT never travels there).
  const puts = calls(mock, 'PUT', () => true)
  expect(puts).toHaveLength(1)
  const [putUrl, putInit] = puts[0]
  expect(putUrl).toBe(PUT_URL)
  expect(putInit!.body).toBe(file)
  expect(putInit!.headers).toEqual({ 'Content-Type': 'image/heic' })

  // The URL was spent on that one call and exists nowhere else: not in the
  // DOM, not in any other request, not in an error.
  const appearances = mock.mock.calls.filter(([url]) => String(url).includes('X-Amz-Signature=putsig123'))
  expect(appearances).toHaveLength(1)
  expect(document.body.innerHTML).not.toContain('putsig123')
  expect(document.body.innerHTML).not.toContain('UPLOADKEYID')

  // The row the upload created is listed under the name this device chose,
  // at the rung the server reports.
  expect(await screen.findByText('IMG_0569.HEIC')).toBeTruthy()
  expect(screen.getByText('Uploaded — waiting to be prepared.')).toBeTruthy()
})

test("a video is refused with the server's message rendered against the file it names, and no PUT follows", async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/gatherings/g-1/media'), response: () => json(200, { media: [] }) },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/intents'),
      response: () =>
        json(422, {
          detail: [
            {
              loc: ['body', 'items', 1, 'content_type'],
              msg: "Value error, video isn't accepted yet — a Live Photo's video half is what this usually is; the still (HEIC or JPEG) can be added",
            },
          ],
        }),
    },
  ])

  renderMedia()
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByText('No photos yet.')

  const still = new File([new Uint8Array([1])], 'IMG_0569.HEIC', { type: '' })
  const video = new File([new Uint8Array([1, 2])], 'IMG_0569.MOV', { type: 'video/quicktime' })
  fireEvent.change(screen.getByLabelText(/add photos/i), { target: { files: [still, video] } })
  fireEvent.click(screen.getByRole('button', { name: /upload 2 photos/i }))

  // The server's words, capitalised by the mapper, on the second file.
  const message = await screen.findByText(/^Video isn't accepted yet/)
  expect(message.getAttribute('id')).toBe('error-items.1.content_type')
  const chosen = screen.getByRole('list', { name: 'Chosen files' })
  const rows = within(chosen).getAllByRole('listitem')
  expect(rows[1].textContent).toContain('IMG_0569.MOV')
  expect(rows[1].textContent).toContain("Video isn't accepted yet")
  expect(rows[0].textContent).not.toContain("isn't accepted")
  // Batch refused whole: nothing went to R2, nothing was confirmed, and the
  // person is told so.
  expect(calls(mock, 'PUT', () => true)).toHaveLength(0)
  expect(calls(mock, 'POST', endsWith('/confirm'))).toHaveLength(0)
  expect(screen.getByText(/Nothing was uploaded/)).toBeTruthy()
  // The declared type for the video was the browser's own — the client did
  // not pre-empt the allowlist; the server did the refusing.
  const [, intentInit] = calls(mock, 'POST', endsWith('/intents'))[0]
  expect(JSON.parse(intentInit!.body as string).items[1].content_type).toBe('video/quicktime')
})

test('every rung renders its own line; the ready line is read from publication_state; a failed row offers exactly one affordance', async () => {
  stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () =>
        json(200, {
          media: [
            mediaRow({ id: 'm-up', status: 'pending_upload' }),
            mediaRow({ id: 'm-uploaded', status: 'uploaded' }),
            mediaRow({ id: 'm-proc', status: 'processing', occurrence_id: 'occ-1' }),
            mediaRow({ id: 'm-fail', status: 'failed' }),
            mediaRow({ id: 'm-live', status: 'ready', publication_state: 'live' }),
          ],
        }),
    },
    // The one ready row's thumbnail.
    {
      method: 'GET',
      match: endsWith('/media/m-live/url?layer=thumbnail'),
      response: () =>
        json(200, { media_id: 'm-live', layer: 'thumbnail', content_type: 'image/webp', size_bytes: 3, url: GET_URL, method: 'GET', expires_in: 900 }),
    },
    { method: 'GET', match: is(GET_URL), response: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }) },
  ])

  renderMedia({ isHost: false })
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  const list = await screen.findByRole('list', { name: 'Photos' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows).toHaveLength(5)

  expect(rows[0].textContent).toContain('On its way — still being uploaded.')
  expect(rows[1].textContent).toContain('Uploaded — waiting to be prepared.')
  expect(rows[2].textContent).toContain('Being prepared — usually within a minute, longer for a big batch.')
  // The date label renders in the profile zone.
  expect(rows[2].textContent).toContain('for ')
  expect(rows[3].textContent).toContain("We couldn't process this photo.")
  // §6.5: retries are invisible, and the ONE affordance is "try again" —
  // re-uploading from the device. Exactly one button on the failed row.
  const failedButtons = within(rows[3]).getAllByRole('button')
  expect(failedButtons).toHaveLength(1)
  expect(failedButtons[0].textContent).toBe('Try again')
  // The branch nothing reaches yet, rendered from the row, not from a
  // constant: when the publication phase moves rows to live, this is the
  // line they get, with no copy rewrite.
  expect(rows[4].textContent).toContain('Everyone in this gathering can see it.')
  // No in-flight row carries a thumbnail; the ready row does, over a blob:
  // URL — the presigned GET is not in the DOM. (The thumbnail's alt is
  // empty — its button carries the name — so it is queried as an element,
  // not by role.)
  expect(rows[0].querySelector('img')).toBeNull()
  await waitFor(() => {
    expect(rows[4].querySelector('img')?.getAttribute('src')).toBe('blob:stub-1')
  })
  expect(document.body.innerHTML).not.toContain('getsig456')
  expect(document.body.innerHTML).not.toContain('SERVEKEYID')
  // No "try again" on a photograph that worked, or on one still on its way
  // (the regression the first run of this test found); the ready row's open
  // control is there. Since CK-40 an own row also carries its edit control,
  // so the pin names the affordance it excludes rather than counting.
  expect(within(rows[4]).queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(within(rows[4]).getByRole('button', { name: 'Open photo added by You' })).toBeTruthy()
  for (const row of rows.slice(0, 3)) {
    expect(within(row).queryByRole('button', { name: 'Try again' })).toBeNull()
  }
})

test('a ready pending photograph says who can see it — from the viewer\'s seat — and opening it fetches the web layer, never archival', async () => {
  const mock = stubRoutes([
    { method: 'GET', match: endsWith('/gatherings/g-1/media'), response: () => json(200, { media: [mediaRow()] }) },
    {
      method: 'GET',
      match: endsWith('/media/m-1/url?layer=thumbnail'),
      response: () => json(200, { media_id: 'm-1', layer: 'thumbnail', content_type: 'image/webp', size_bytes: 3, url: GET_URL, method: 'GET', expires_in: 900 }),
    },
    {
      method: 'GET',
      match: endsWith('/media/m-1/url?layer=web'),
      response: () => json(200, { media_id: 'm-1', layer: 'web', content_type: 'image/webp', size_bytes: 3, url: WEB_URL, method: 'GET', expires_in: 900 }),
    },
    { method: 'GET', match: is(GET_URL), response: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }) },
    { method: 'GET', match: is(WEB_URL), response: () => new Response(new Uint8Array([4, 5, 6]), { status: 200 }) },
  ])

  renderMedia({ isHost: false })
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  expect(await screen.findByText('Only you and the host can see this.')).toBeTruthy()
  // Never "shared", never "waiting for approval".
  expect(screen.queryByText(/shared|approv|review/i)).toBeNull()

  fireEvent.click(await screen.findByRole('button', { name: /open photo added by you/i }))
  const viewer = await screen.findByRole('dialog')
  const web = await within(viewer).findByRole('img')
  expect(web.getAttribute('src')).toBe('blob:stub-2')
  const layerRequests = calls(mock, 'GET', (url) => url.includes('/url?layer='))
  expect(layerRequests.map(([url]) => url.slice(url.indexOf('layer=')))).toEqual([
    'layer=thumbnail',
    'layer=web',
  ])
  expect(calls(mock, 'GET', (url) => url.includes('archival'))).toHaveLength(0)
  // Presigned GETs: one fetch each, nowhere in the DOM.
  expect(mock.mock.calls.filter(([url]) => url === GET_URL)).toHaveLength(1)
  expect(mock.mock.calls.filter(([url]) => url === WEB_URL)).toHaveLength(1)
  expect(document.body.innerHTML).not.toContain('X-Amz-Signature')

  // Closing revokes the web layer's object URL — the bytes leave with it.
  fireEvent.click(within(viewer).getByRole('button', { name: /close/i }))
  await waitFor(() => {
    expect(revokedObjectUrls).toContain('blob:stub-2')
  })
})

test('the host sees a pending photograph of theirs as visible to them alone, and someone else\'s as visible to the two of them', async () => {
  stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () =>
        json(200, {
          media: [
            mediaRow({ id: 'm-mine' }),
            mediaRow({ id: 'm-theirs', is_own: false, uploader_display_name: 'grandma' }),
          ],
        }),
    },
    // Thumbnails: not the subject here — a 409 keeps them out of the way.
    {
      method: 'GET',
      match: (url) => url.includes('/url?layer=thumbnail'),
      response: () => json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } }),
    },
  ])

  renderMedia({ isHost: true })
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  expect(await screen.findByText('Only you can see this.')).toBeTruthy()
  expect(screen.getByText('Only grandma and you can see this.')).toBeTruthy()
})

test('the list polls while a photograph is being prepared and stops the moment everything is terminal', async () => {
  let reads = 0
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => {
        reads += 1
        // First two reads: still processing. Third: ready.
        return json(200, {
          media: [mediaRow({ id: 'm-1', status: reads < 3 ? 'processing' : 'ready' })],
        })
      },
    },
    {
      method: 'GET',
      match: endsWith('/media/m-1/url?layer=thumbnail'),
      response: () => json(200, { media_id: 'm-1', layer: 'thumbnail', content_type: 'image/webp', size_bytes: 3, url: GET_URL, method: 'GET', expires_in: 900 }),
    },
    { method: 'GET', match: is(GET_URL), response: () => new Response(new Uint8Array([1]), { status: 200 }) },
  ])

  renderMedia({ pollIntervalMs: 20 })
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByText('Being prepared — usually within a minute, longer for a big batch.')

  // Without a manual refresh the row becomes ready.
  await screen.findByText('Only you and the host can see this.')
  await waitFor(() => {
    expect(calls(mock, 'GET', endsWith('/media'))).toHaveLength(3)
  })
  // Everything terminal: no further list request, however long we wait.
  await sleep(120)
  expect(calls(mock, 'GET', endsWith('/media'))).toHaveLength(3)
})

test('a PUT that fails leaves an honest row: not "on its way", with the one try-again affordance, and no URL in the message', async () => {
  const mock = stubRoutes([
    {
      method: 'GET',
      match: endsWith('/gatherings/g-1/media'),
      response: () => json(200, { media: [mediaRow({ id: 'm-new', status: 'pending_upload' })] }),
    },
    {
      method: 'POST',
      match: endsWith('/gatherings/g-1/media/intents'),
      response: () =>
        json(201, {
          intents: [
            {
              media: { id: 'm-new', status: 'pending_upload' },
              upload: { url: PUT_URL, method: 'PUT', headers: { 'Content-Length': '1', 'Content-Type': 'image/jpeg' }, expires_in: 900 },
            },
          ],
        }),
    },
    { method: 'PUT', match: is(PUT_URL), response: () => new Response(null, { status: 403 }) },
  ])

  renderMedia()
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  await screen.findByRole('list', { name: 'Photos' })

  fireEvent.change(screen.getByLabelText(/add photos/i), {
    target: { files: [new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })] },
  })
  fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))

  const message = await screen.findByText("This upload didn't finish.")
  expect(message).toBeTruthy()
  // No confirm for an object that never landed.
  expect(calls(mock, 'POST', endsWith('/confirm'))).toHaveLength(0)
  const row = message.closest('li')!
  const buttons = within(row).getAllByRole('button')
  expect(buttons).toHaveLength(1)
  expect(buttons[0].textContent).toBe('Try again')
  expect(document.body.innerHTML).not.toContain('putsig123')
})

test('no source in the upload surface names a reviewer, an approval, or calls a pending photograph shared', () => {
  // The copy rule, pinned at the source (the brand.test.tsx discipline):
  // for a private family gathering nobody will ever review a photograph
  // (consent-gate-defaults §1), so copy that teaches a family to expect
  // review is wrong today and wrong after the fix. The words are banned
  // from the strings this surface can render; a comment may explain the
  // rule, so comments are stripped before the scan.
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const source of [mediaComponentSource, mediaLibSource]) {
    const code = stripComments(source)
    expect(code).not.toMatch(/waiting for approval/i)
    expect(code).not.toMatch(/['"`][^'"`\n]*\b(approv|review|shared|screen)\w*[^'"`\n]*['"`]/i)
  }
})
