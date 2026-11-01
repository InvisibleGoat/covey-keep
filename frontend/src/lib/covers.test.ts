// CK-84 — the cover module. The value under test: a cover's picture is
// minted through the subject's cover URL route and spent on ONE fetch with
// no credentials, coming back as a `blob:` object URL and never the
// presigned URL; the cache shares one fetch between concurrent asks, fetches
// nothing for a version it holds, revokes the older object URL when a newer
// version arrives, answers an older version from the newer entry, keeps no
// refusal, and empties itself — every object URL revoked — when the session
// ends or begins; the upload's intent body is exactly `{content_type,
// size_bytes}` (the HEIC fallback, the size from the File), its PUT carries
// the signed type and no Authorization, and the confirm follows; every
// refusal is a code mapped to an approved line, never the server's words;
// and every approved line is pinned as a literal.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  announceCoverChange,
  clearCover,
  clearCoverPictures,
  COVER_GETTING_READY,
  COVER_HINT_GATHERING,
  COVER_HINT_GROUP,
  COVER_REFUSED,
  COVER_UPLOADING,
  coverFailureLine,
  coverImageProgress,
  EMPTY_COVER_LINE,
  fetchCoverObjectUrl,
  forgetCoverPicture,
  groupCoverConfirmSentence,
  groupCoverSetLine,
  loadCoverPicture,
  onCoverChange,
  readCoverImage,
  REMOVE_PHOTO_SENTENCE_GROUP,
  REMOVE_UPLOADED_SENTENCE,
  removePhotoSentence,
  setCoverFromPhoto,
  uploadCoverPicture,
} from './covers'
import coversSource from './covers.ts?raw'
import { clearToken, setToken } from './session'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

// A presigned URL the way R2 spells one — the strings the never-leaks
// assertions look for.
const GET_URL = (layer: string, n = 1) =>
  `https://r2.invalid/coveykeep-dev/covers/ci-${n}/${layer}?X-Amz-Credential=SERVEKEYID%2F20261101&X-Amz-Signature=coversig${n}`
const PUT_URL =
  'https://r2.invalid/coveykeep-dev-quarantine/covers/ci-new?X-Amz-Credential=UPLOADKEYID%2F20261101&X-Amz-Signature=putsig42'

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function stubFetch(handler: Handler) {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(String(url), init)))
  vi.stubGlobal('fetch', mock)
  return mock
}

function path(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '')
}

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
  clearCoverPictures()
  vi.unstubAllGlobals()
})

// A server whose cover URL route answers a fresh presigned URL per mint, and
// whose bucket answers bytes for it.
function coverServer(over: { mint?: (url: string) => Response } = {}) {
  let mints = 0
  return stubFetch((url) => {
    if (url.includes('/cover/url?layer=')) {
      if (over.mint) return over.mint(url)
      mints += 1
      const layer = url.endsWith('layer=web') ? 'web' : 'thumbnail'
      return json(200, {
        layer,
        content_type: 'image/webp',
        size_bytes: 1234,
        url: GET_URL(layer, mints),
        method: 'GET',
        expires_in: 300,
      })
    }
    if (url.startsWith('https://r2.invalid/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    throw new Error(`no stub for ${url}`)
  })
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

test('the read mints through the subject’s cover URL route and spends the presigned GET on ONE fetch with no credentials, answering a blob: URL and never the presigned one', async () => {
  const mock = coverServer()
  const gathering = await fetchCoverObjectUrl('gathering', 'g-1', 'web')
  const group = await fetchCoverObjectUrl('group', 'grp-1', 'thumbnail')
  expect(gathering).toEqual({ ok: true, objectUrl: 'blob:cover-1' })
  expect(group).toEqual({ ok: true, objectUrl: 'blob:cover-2' })
  const urls = mock.mock.calls.map(([url]) => String(url))
  expect(urls.map(path)).toEqual([
    '/gatherings/g-1/cover/url?layer=web',
    GET_URL('web', 1).replace('https://r2.invalid', ''),
    '/groups/grp-1/cover/url?layer=thumbnail',
    GET_URL('thumbnail', 2).replace('https://r2.invalid', ''),
  ])
  // The bucket fetch: no credentials, no Authorization header.
  for (const [url, init] of mock.mock.calls) {
    if (!String(url).startsWith('https://r2.invalid/')) continue
    expect((init as RequestInit).credentials).toBe('omit')
    expect(new Headers((init as RequestInit).headers).has('Authorization')).toBe(false)
  }
  // Each presigned URL was requested exactly once, and is in no answer.
  expect(urls.filter((url) => url === GET_URL('web', 1))).toHaveLength(1)
  expect(JSON.stringify([gathering, group])).not.toMatch(/X-Amz|r2\.invalid/)
})

test('a 409 is no_cover — the cover was cleared since the body was read — and any other refusal is unavailable, with nothing fetched from the bucket', async () => {
  coverServer({ mint: () => json(409, { detail: { code: 'no_cover', message: '' } }) })
  expect(await fetchCoverObjectUrl('group', 'grp-1', 'web')).toEqual({ ok: false, reason: 'no_cover' })
  const mock = coverServer({ mint: () => json(500, {}) })
  expect(await fetchCoverObjectUrl('group', 'grp-1', 'web')).toEqual({ ok: false, reason: 'unavailable' })
  expect(mock.mock.calls.some(([url]) => String(url).startsWith('https://r2.invalid/'))).toBe(false)
})

test('the module never names the archival layer', () => {
  const code = coversSource.replace(/\/\/.*$/gm, '')
  expect(code).not.toMatch(/archival/)
})

// ---------------------------------------------------------------------------
// The cache.
// ---------------------------------------------------------------------------

test('concurrent asks for one version share ONE fetch, and the same version asked again fetches nothing', async () => {
  const mock = coverServer()
  const asks = [1, 2, 3].map(() => loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00'))
  const outcomes = await Promise.all(asks)
  expect(outcomes.every((o) => o.ok && o.objectUrl === 'blob:cover-1')).toBe(true)
  expect(mock).toHaveBeenCalledTimes(2) // one mint, one bucket fetch
  const again = await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  expect(again).toEqual({ ok: true, objectUrl: 'blob:cover-1' })
  expect(mock).toHaveBeenCalledTimes(2)
  // The layers and the subjects are separate entries.
  await loadCoverPicture('group', 'grp-1', 'web', '2026-11-01T10:00:00+00:00')
  await loadCoverPicture('gathering', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  expect(mock).toHaveBeenCalledTimes(6)
  expect(revoked).toEqual([])
})

test('a NEWER version revokes the older object URL and drops its entry; an older version is answered from the newer entry, fetching nothing', async () => {
  const mock = coverServer()
  await loadCoverPicture('gathering', 'g-1', 'web', '2026-11-01T10:00:00+00:00')
  expect(revoked).toEqual([])
  const newer = await loadCoverPicture('gathering', 'g-1', 'web', '2026-11-01T11:00:00+00:00')
  expect(newer).toEqual({ ok: true, objectUrl: 'blob:cover-2' })
  expect(revoked).toEqual(['blob:cover-1'])
  expect(mock).toHaveBeenCalledTimes(4)
  // A stale body still on screen asks for the old version: the URL route
  // would serve the current cover anyway, so the newer entry answers it.
  const older = await loadCoverPicture('gathering', 'g-1', 'web', '2026-11-01T10:00:00+00:00')
  expect(older).toEqual({ ok: true, objectUrl: 'blob:cover-2' })
  expect(mock).toHaveBeenCalledTimes(4)
  expect(revoked).toEqual(['blob:cover-1'])
})

test('a version superseded while its fetch is in flight is revoked on arrival, and its askers get the newer picture', async () => {
  let releaseFirst: (() => void) | undefined
  let mints = 0
  stubFetch(async (url) => {
    if (url.includes('/cover/url')) {
      mints += 1
      const n = mints
      if (n === 1) await new Promise<void>((resolve) => (releaseFirst = resolve))
      return json(200, { url: GET_URL('web', n), method: 'GET' })
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  })
  const first = loadCoverPicture('group', 'grp-1', 'web', '2026-11-01T10:00:00+00:00')
  const second = await loadCoverPicture('group', 'grp-1', 'web', '2026-11-01T11:00:00+00:00')
  expect(second).toEqual({ ok: true, objectUrl: 'blob:cover-1' })
  releaseFirst?.()
  expect(await first).toEqual({ ok: true, objectUrl: 'blob:cover-1' })
  // The late bytes were made into an object URL and revoked at once.
  expect(created).toEqual(['blob:cover-1', 'blob:cover-2'])
  expect(revoked).toEqual(['blob:cover-2'])
})

test('a refusal is not kept: the next ask tries again', async () => {
  let fail = true
  const mock = coverServer({
    mint: () => (fail ? json(500, {}) : json(200, { url: GET_URL('thumbnail'), method: 'GET' })),
  })
  expect(await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')).toEqual({
    ok: false,
    reason: 'unavailable',
  })
  fail = false
  expect(await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')).toEqual({
    ok: true,
    objectUrl: 'blob:cover-1',
  })
  expect(mock).toHaveBeenCalledTimes(3)
})

test('THE SESSION ENDING revokes every object URL and empties the cache — and so does a session beginning', async () => {
  const mock = coverServer()
  await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  await loadCoverPicture('group', 'grp-1', 'web', '2026-11-01T10:00:00+00:00')
  await loadCoverPicture('gathering', 'g-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  clearToken()
  expect([...revoked].sort()).toEqual(['blob:cover-1', 'blob:cover-2', 'blob:cover-3'])
  // Emptied: the same version is fetched again.
  await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  expect(mock).toHaveBeenCalledTimes(8)
  setToken('next-person')
  expect(revoked).toContain('blob:cover-4')
  clearToken()
})

test('a cleared cover is forgotten: both layers revoked and dropped', async () => {
  coverServer()
  await loadCoverPicture('group', 'grp-1', 'thumbnail', '2026-11-01T10:00:00+00:00')
  await loadCoverPicture('group', 'grp-1', 'web', '2026-11-01T10:00:00+00:00')
  await loadCoverPicture('group', 'grp-2', 'web', '2026-11-01T10:00:00+00:00')
  forgetCoverPicture('group', 'grp-1')
  expect([...revoked].sort()).toEqual(['blob:cover-1', 'blob:cover-2'])
})

test('the change signal reaches every listener until it unsubscribes, and carries nothing', () => {
  const heard: unknown[][] = []
  const off = onCoverChange((...args: unknown[]) => heard.push(args))
  announceCoverChange()
  announceCoverChange()
  off()
  announceCoverChange()
  expect(heard).toEqual([[], []])
})

// ---------------------------------------------------------------------------
// Setting from a photograph, and clearing.
// ---------------------------------------------------------------------------

test('Use as cover sends exactly {"media_id"} to the subject’s cover and answers the cover the server returned; every refusal is one answer', async () => {
  const mock = stubFetch((url, init) => {
    if (init?.method === 'PUT' && url.endsWith('/gatherings/g-1/cover')) {
      return json(200, { cover: { source: 'photo', media_id: 'm-1', set_at: '2026-11-01T12:00:00+00:00' } })
    }
    if (init?.method === 'PUT' && url.endsWith('/groups/grp-1/cover')) {
      return json(409, { detail: { code: 'not_published', status: 'ready', publication_state: 'removed', message: 'x' } })
    }
    throw new Error('no stub')
  })
  expect(await setCoverFromPhoto('gathering', 'g-1', 'm-1')).toEqual({
    ok: true,
    cover: { source: 'photo', media_id: 'm-1', set_at: '2026-11-01T12:00:00+00:00' },
  })
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body))).toEqual({ media_id: 'm-1' })
  expect(await setCoverFromPhoto('group', 'grp-1', 'm-1')).toEqual({ ok: false })
  stubFetch(() => {
    throw new Error('offline')
  })
  expect(await setCoverFromPhoto('group', 'grp-1', 'm-1')).toEqual({ ok: false })
})

test('Remove cover is one DELETE: a 204 is done, anything else is not', async () => {
  const mock = stubFetch((_url, init) => (init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json(500, {})))
  expect(await clearCover('group', 'grp-1')).toEqual({ ok: true })
  expect(path(String(mock.mock.calls[0][0]))).toBe('/groups/grp-1/cover')
  stubFetch(() => json(404, { detail: 'Not found.' }))
  expect(await clearCover('gathering', 'g-1')).toEqual({ ok: false })
})

// ---------------------------------------------------------------------------
// Uploading.
// ---------------------------------------------------------------------------

function uploadServer(over: { intent?: () => Response; put?: () => Response; confirm?: () => Response } = {}) {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url.endsWith('/cover/upload')) {
      return (
        over.intent?.() ??
        json(201, {
          cover_image: { id: 'ci-new', status: 'pending_upload' },
          upload: {
            url: PUT_URL,
            method: 'PUT',
            headers: { 'Content-Length': '4', 'Content-Type': 'image/heic' },
            expires_in: 900,
          },
        })
      )
    }
    if (method === 'PUT' && url === PUT_URL) return over.put?.() ?? new Response(null, { status: 200 })
    if (method === 'POST' && url.endsWith('/cover-images/ci-new/confirm')) {
      return over.confirm?.() ?? json(200, { id: 'ci-new', status: 'uploaded', failure_reason: null })
    }
    throw new Error(`no stub for ${method} ${url}`)
  })
}

test('the upload: the intent body is EXACTLY {content_type, size_bytes} — a HEIC’s empty type from its extension, the size from the File — then the PUT with the signed type and no Authorization, then the confirm', async () => {
  setToken('session-jwt')
  const mock = uploadServer()
  const file = new File(['heic'], 'IMG_0001.HEIC', { type: '' })
  const outcome = await uploadCoverPicture('group', 'grp-1', file)
  expect(outcome).toEqual({ ok: true, coverImageId: 'ci-new' })
  const [intent, put, confirm] = mock.mock.calls
  expect(path(String(intent[0]))).toBe('/groups/grp-1/cover/upload')
  expect(JSON.parse(String(intent[1]?.body))).toEqual({ content_type: 'image/heic', size_bytes: 4 })
  expect(String(put[0])).toBe(PUT_URL)
  expect(put[1]?.method).toBe('PUT')
  expect(put[1]?.body).toBe(file)
  expect(put[1]?.credentials).toBe('omit')
  const putHeaders = new Headers(put[1]?.headers)
  expect(putHeaders.get('Content-Type')).toBe('image/heic')
  expect(putHeaders.has('Authorization')).toBe(false)
  expect(putHeaders.has('Content-Length')).toBe(false)
  expect(path(String(confirm[0]))).toBe('/cover-images/ci-new/confirm')
  expect(confirm[1]?.method).toBe('POST')
  expect(mock).toHaveBeenCalledTimes(3)
  // The PUT URL went to the one PUT and is in no answer.
  expect(JSON.stringify(outcome)).not.toMatch(/X-Amz|r2\.invalid/)
  expect(mock.mock.calls.filter(([url]) => String(url) === PUT_URL)).toHaveLength(1)
  clearToken()
})

test('the intent’s 422s map to their lines — content_type to unreadable, size_bytes to too large, the type winning beside an oversize — and nothing is PUT', async () => {
  const refuse = (...fields: string[]) => () =>
    json(422, { detail: fields.map((f) => ({ loc: ['body', f], msg: 'each photo is limited to 25 MB', type: 'value_error' })) })
  const file = new File(['x'], 'a.png', { type: 'image/png' })
  for (const [fields, code] of [
    [['size_bytes'], 'too_large'],
    [['content_type'], 'unreadable'],
    [['size_bytes', 'content_type'], 'unreadable'],
    [['other'], 'failed'],
  ] as const) {
    const mock = uploadServer({ intent: refuse(...fields) })
    expect(await uploadCoverPicture('gathering', 'g-1', file)).toEqual({ ok: false, code })
    expect(mock).toHaveBeenCalledTimes(1)
  }
  uploadServer({ intent: () => json(404, { detail: 'Not found.' }) })
  expect(await uploadCoverPicture('gathering', 'g-1', file)).toEqual({ ok: false, code: 'failed' })
})

test('a refused PUT never confirms; a confirm’s 409 superseded is superseded and every other confirm refusal is failed', async () => {
  const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
  const refusedPut = uploadServer({ put: () => new Response(null, { status: 403 }) })
  expect(await uploadCoverPicture('group', 'grp-1', file)).toEqual({ ok: false, code: 'failed' })
  expect(refusedPut).toHaveBeenCalledTimes(2)
  uploadServer({ confirm: () => json(409, { detail: { code: 'superseded', message: 'x' } }) })
  expect(await uploadCoverPicture('group', 'grp-1', file)).toEqual({ ok: false, code: 'superseded' })
  for (const confirm of [
    () => json(409, { detail: { code: 'not_uploaded', message: 'x' } }),
    () => json(409, { detail: { code: 'size_mismatch', message: 'x' } }),
    () => json(503, { detail: { code: 'storage_unavailable', message: 'x' } }),
    () => json(404, { detail: 'No such cover image.' }),
  ]) {
    uploadServer({ confirm })
    expect(await uploadCoverPicture('group', 'grp-1', file)).toEqual({ ok: false, code: 'failed' })
  }
})

test('following the cover image: uploaded and processing are being prepared, ready is ready, the reason decides a failure, destroying and destroyed are superseded, anything else did not finish', async () => {
  stubFetch(() => json(200, { id: 'ci-new', status: 'processing', failure_reason: null }))
  expect(await readCoverImage('ci-new')).toEqual({ ok: true, status: 'processing', failure_reason: null })
  stubFetch(() => json(404, { detail: 'No such cover image.' }))
  expect(await readCoverImage('ci-new')).toEqual({ ok: false })

  const read = (status: string, failure_reason: string | null = null) =>
    coverImageProgress({ ok: true, status, failure_reason })
  expect(read('uploaded')).toEqual({ state: 'preparing' })
  expect(read('processing')).toEqual({ state: 'preparing' })
  expect(read('ready')).toEqual({ state: 'ready' })
  expect(read('failed', 'unreadable')).toEqual({ state: 'failed', code: 'unreadable' })
  expect(read('failed', 'too_large')).toEqual({ state: 'failed', code: 'too_large' })
  expect(read('failed', 'interrupted')).toEqual({ state: 'failed', code: 'failed' })
  expect(read('failed', 'upload_incomplete')).toEqual({ state: 'failed', code: 'failed' })
  expect(read('destroying')).toEqual({ state: 'failed', code: 'superseded' })
  expect(read('destroyed')).toEqual({ state: 'failed', code: 'superseded' })
  expect(read('pending_upload')).toEqual({ state: 'failed', code: 'failed' })
  expect(read('something-new')).toEqual({ state: 'failed', code: 'failed' })
  expect(coverImageProgress({ ok: false })).toEqual({ state: 'failed', code: 'failed' })
})

// ---------------------------------------------------------------------------
// The words, as approved (Steven, 2026-11-01) — literals, so a reworded
// constant fails here.
// ---------------------------------------------------------------------------

test('every approved line, as a literal', () => {
  expect(EMPTY_COVER_LINE).toBe('No cover photo yet')
  expect(COVER_HINT_GATHERING).toBe('Or open one of the photos and choose Use as cover.')
  expect(COVER_HINT_GROUP).toBe(
    "Or open a photo in one of the group's gatherings and choose Use as the group's cover.",
  )
  expect(groupCoverConfirmSentence('The Lees', 'The Party')).toBe(
    "Everyone in The Lees will see this photo as the group's cover, including people who can't see The Party.",
  )
  expect(groupCoverSetLine('The Lees')).toBe("The Lees's cover is set.")
  expect(REMOVE_UPLOADED_SENTENCE).toBe(
    'The picture will be deleted. The empty cover shows until someone chooses another.',
  )
  expect(removePhotoSentence('The Party')).toBe("The photo stays in The Party. It just won't be the cover.")
  expect(REMOVE_PHOTO_SENTENCE_GROUP).toBe("The photo stays in its gathering. It just won't be the cover.")
  expect(COVER_UPLOADING).toBe('Uploading your picture…')
  expect(COVER_GETTING_READY).toBe('Getting it ready…')
  expect(coverFailureLine('superseded')).toBe(
    "A newer cover was chosen while this one was uploading, so it won't be used.",
  )
  expect(coverFailureLine('unreadable')).toBe("That picture couldn't be opened. Try a different one.")
  expect(coverFailureLine('too_large')).toBe('That picture is too large. Try a smaller one.')
  expect(coverFailureLine('failed')).toBe("The upload didn't finish. Try again.")
  expect(COVER_REFUSED).toBe('Something went wrong. Nothing changed — try again.')
})
