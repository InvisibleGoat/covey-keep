// CK-38 media helper pins: a HEIC with an empty file.type still declares a
// type (the declared type is signed into the presigned PUT — a wrong one
// reads as a permissions failure at R2); an unknown type goes to the server
// for ITS refusal, never a client guess; the state message is a function of
// publication_state, so the `live` branch exists before anything reaches it;
// and the copy never implies a reviewer.
import { expect, test } from 'vitest'
import {
  anyInFlight,
  declaredContentType,
  intentErrorFields,
  isTerminal,
  mediaStateMessage,
  PICKER_ACCEPT,
} from './media'

test('a HEIC whose file.type is empty still declares image/heic', () => {
  expect(declaredContentType({ name: 'IMG_0569.HEIC', type: '' })).toBe('image/heic')
  expect(declaredContentType({ name: 'IMG_0570.heif', type: '' })).toBe('image/heif')
})

test('a browser-known type wins over the extension, and an unknown one is left for the server to refuse', () => {
  expect(declaredContentType({ name: 'photo.jpg', type: 'image/jpeg' })).toBe('image/jpeg')
  // The Live Photo's MOV half: the browser names it, and the server's 422 is
  // what refuses it — this function does not pre-empt the allowlist.
  expect(declaredContentType({ name: 'IMG_0569.MOV', type: 'video/quicktime' })).toBe(
    'video/quicktime',
  )
  // No type, no extension anyone knows: the generic binary type, so the
  // refusal that renders is the server's, in the server's words.
  expect(declaredContentType({ name: 'mystery', type: '' })).toBe('application/octet-stream')
  expect(declaredContentType({ name: 'clip.mov', type: '' })).toBe('application/octet-stream')
})

test('the picker accept mirrors the allowlist with the extensions a typeless HEIC needs', () => {
  expect(PICKER_ACCEPT.split(',')).toEqual(
    expect.arrayContaining(['image/jpeg', 'image/heic', 'image/heif', '.heic', '.heif']),
  )
  expect(PICKER_ACCEPT).not.toContain('video')
})

test('intent error fields cover every sent index and the batch key', () => {
  expect(intentErrorFields(2)).toEqual([
    'items',
    'items.0.content_type',
    'items.0.size_bytes',
    'items.0.occurrence_id',
    'items.0.filename',
    'items.1.content_type',
    'items.1.size_bytes',
    'items.1.occurrence_id',
    'items.1.filename',
  ])
})

test('ready and failed are terminal; everything else keeps the list polling', () => {
  expect(isTerminal({ status: 'ready' })).toBe(true)
  expect(isTerminal({ status: 'failed' })).toBe(true)
  for (const status of ['pending_upload', 'uploaded', 'processing']) {
    expect(isTerminal({ status })).toBe(false)
  }
  expect(anyInFlight([{ status: 'ready' }, { status: 'failed' }])).toBe(false)
  expect(anyInFlight([{ status: 'ready' }, { status: 'processing' }])).toBe(true)
  expect(anyInFlight([])).toBe(false)
})

const own = { is_own: true, uploader_display_name: 'Steven' }

test('the message is read from publication_state: the same ready row says two different things', () => {
  // The branch nothing reaches yet, written now so the publication phase
  // (consent-gate-defaults §1 — ready → live for a private gathering) changes
  // this component's behaviour without changing a line of it.
  expect(mediaStateMessage({ status: 'ready', publication_state: 'live', ...own }, { isHost: false })).toBe(
    'Everyone in this gathering can see it.',
  )
  expect(
    mediaStateMessage({ status: 'ready', publication_state: 'pending', ...own }, { isHost: false }),
  ).toBe('Only you and the host can see this.')
  // The uploader IS the host: the two admitted people are one.
  expect(
    mediaStateMessage({ status: 'ready', publication_state: 'pending', ...own }, { isHost: true }),
  ).toBe('Only you can see this.')
  // The host looking at someone else's pending photograph.
  expect(
    mediaStateMessage(
      { status: 'ready', publication_state: 'pending', is_own: false, uploader_display_name: 'grandma' },
      { isHost: true },
    ),
  ).toBe('Only grandma and you can see this.')
  // The bin (nothing removes yet; the branch is derived, like CK-37's).
  expect(
    mediaStateMessage({ status: 'ready', publication_state: 'removed', ...own }, { isHost: false }),
  ).toBe('Removed. Only you can still see it, for 30 days after removal.')
})

test('every in-flight rung has its own honest line, and failure names the outcome, never the file', () => {
  const at = (status: string) =>
    mediaStateMessage({ status, publication_state: 'pending', ...own }, { isHost: false })
  expect(at('pending_upload')).toBe('On its way — still being uploaded.')
  expect(at('uploaded')).toBe('Uploaded — waiting to be prepared.')
  expect(at('processing')).toBe('Being prepared — usually within a minute, longer for a big batch.')
  expect(at('failed')).toBe("We couldn't process this photo.")
  expect(at('failed')).not.toMatch(/corrupt/i)
  // An unknown rung is named, never blank.
  expect(at('someday_rung')).toBe('Status: someday_rung.')
})

test('no state message implies a reviewer, an approval, or that a pending photograph is shared', () => {
  const rows = [
    { status: 'pending_upload', publication_state: 'pending' },
    { status: 'uploaded', publication_state: 'pending' },
    { status: 'processing', publication_state: 'pending' },
    { status: 'ready', publication_state: 'pending' },
    { status: 'ready', publication_state: 'removed' },
    { status: 'failed', publication_state: 'pending' },
  ]
  for (const row of rows) {
    for (const isHost of [true, false]) {
      for (const is_own of [true, false]) {
        const message = mediaStateMessage(
          { ...row, is_own, uploader_display_name: 'grandma' },
          { isHost },
        )
        expect(message).not.toMatch(/approv|review|shared|posted|publish/i)
      }
    }
  }
})
