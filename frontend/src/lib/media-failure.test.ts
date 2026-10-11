// CK-71 pins on the helpers a photograph that cannot be kept rests on
// (pipeline record §6.5 as amended). The value under test: each of the four
// failure reasons reads its own line — the first sentence for every reader,
// the second (what will work) for the uploader alone — and a row carrying no
// reason, or one this build does not know, reads CK-38's sentence as the
// fallback; the number in the too-large line comes from one constant beside
// the copy, never typed into it; the controls follow the reason and offer a
// retry only where a retry can succeed; mediaStateMessage routes a failed
// row through the same function; dismissMedia posts once to the row's own
// path with no body, reads a 204 as ok, and answers with the server's STABLE
// CODE and never its wording; the refusal lines switch on the code; and no
// line — the five failed lines from both seats, the refusals — names the
// file's contents: not "deleted", "corrupt", "damaged", "virus" or "error".
import { afterEach, expect, test, vi } from 'vitest'
import { networkErrors } from './formErrors'
import {
  dismissMedia,
  dismissRefusalMessage,
  failureMessage,
  failureRetry,
  MAX_PHOTO_MEGAPIXELS,
  mediaStateMessage,
  RETRY_LABEL,
} from './media'

afterEach(() => {
  vi.unstubAllGlobals()
})

// The record's rule, as the kickoff's ban list: the outcome, never the file's
// contents, and never a word that promises or threatens more than is true.
const FAILURE_BAN = /deleted|corrupt|damaged|virus|error/i

const REASONS = ['too_large', 'unreadable', 'upload_incomplete', 'interrupted'] as const

const SERVER_WORDING = 'SERVER WORDING XYZ — never rendered'

function answer(status: number, body?: unknown) {
  const mock = vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

test('each reason reads its own line — the first sentence for every reader, the second for the uploader alone — and the fallback is CK-38\'s sentence', () => {
  // The number is the constant's, and the constant mirrors the server's
  // pixel guard (processing.MAX_PIXELS, 50_000_000) — the two move together.
  expect(MAX_PHOTO_MEGAPIXELS).toBe(50)
  expect(failureMessage('too_large', true)).toBe(
    "This photo is too large to keep here — it's over 50 megapixels. A smaller copy will work.",
  )
  expect(failureMessage('too_large', false)).toBe(
    "This photo is too large to keep here — it's over 50 megapixels.",
  )
  for (const isOwn of [true, false]) {
    expect(failureMessage('unreadable', isOwn)).toBe("This file isn't a photo we can read.")
    // Exactly the device-side upload_failed line: one outcome, one sentence.
    expect(failureMessage('upload_incomplete', isOwn)).toBe("This upload didn't finish.")
    expect(failureMessage('interrupted', isOwn)).toBe("We couldn't finish preparing this photo.")
    // The defensive fallback — no reason, or one this build does not know.
    expect(failureMessage(null, isOwn)).toBe("We couldn't process this photo.")
    expect(failureMessage(undefined, isOwn)).toBe("We couldn't process this photo.")
    expect(failureMessage('someday_reason', isOwn)).toBe("We couldn't process this photo.")
  }
})

test('no failed line, from either seat, names the file\'s contents', () => {
  for (const reason of [...REASONS, null, 'someday_reason']) {
    for (const isOwn of [true, false]) {
      expect(failureMessage(reason, isOwn)).not.toMatch(FAILURE_BAN)
    }
  }
})

test('the controls follow the reason: a retry only where a retry can succeed, and its label says which kind', () => {
  // The same file over the pixel guard fails again — the control is for a
  // SMALLER copy; a file that is not a photo has no retry that could succeed.
  expect(failureRetry('too_large')).toBe('choose_smaller')
  expect(failureRetry('unreadable')).toBeNull()
  expect(failureRetry('upload_incomplete')).toBe('try_again')
  expect(failureRetry('interrupted')).toBe('try_again')
  // The fallback keeps CK-38's affordance.
  expect(failureRetry(null)).toBe('try_again')
  expect(failureRetry(undefined)).toBe('try_again')
  expect(failureRetry('someday_reason')).toBe('try_again')
  expect(RETRY_LABEL).toEqual({ try_again: 'Try again', choose_smaller: 'Choose a smaller copy' })
})

test('mediaStateMessage reads a failed row through its reason and the seat', () => {
  const row = {
    status: 'failed',
    publication_state: 'pending',
    uploader_display_name: 'Steven',
  }
  // The uploader reads what will work; everyone else the outcome alone.
  expect(mediaStateMessage({ ...row, is_own: true, failure_reason: 'too_large' }, { isHost: false })).toBe(
    "This photo is too large to keep here — it's over 50 megapixels. A smaller copy will work.",
  )
  expect(mediaStateMessage({ ...row, is_own: false, failure_reason: 'too_large' }, { isHost: true })).toBe(
    "This photo is too large to keep here — it's over 50 megapixels.",
  )
  expect(mediaStateMessage({ ...row, is_own: true, failure_reason: 'unreadable' }, { isHost: false })).toBe(
    "This file isn't a photo we can read.",
  )
  // A row that carries no reason at all reads the fallback.
  expect(mediaStateMessage({ ...row, is_own: true }, { isHost: false })).toBe(
    "We couldn't process this photo.",
  )
  expect(mediaStateMessage({ ...row, is_own: true, failure_reason: null }, { isHost: false })).toBe(
    "We couldn't process this photo.",
  )
})

test("dismissMedia posts once to the row's dismiss path with no body; a 204 is ok", async () => {
  const mock = answer(204)
  expect(await dismissMedia('m-1')).toEqual({ ok: true })
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(url).endsWith('/media/m-1/dismiss')).toBe(true)
  expect(init.method).toBe('POST')
  expect(init.body).toBeUndefined()
})

test('dismissMedia answers with the server\'s stable code and never its wording', async () => {
  answer(404, { detail: 'No such photograph.' })
  expect(await dismissMedia('m-1')).toEqual({ ok: false, code: 'not_found' })

  answer(409, {
    detail: { code: 'not_failed', publication_state: 'pending', status: 'ready', message: SERVER_WORDING },
  })
  const refused = await dismissMedia('m-1')
  expect(refused).toEqual({ ok: false, code: 'not_failed', status: 'ready' })
  expect(JSON.stringify(refused)).not.toContain(SERVER_WORDING)

  answer(500)
  expect(await dismissMedia('m-1')).toEqual({ ok: false, code: 'failed' })

  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network'))))
  expect(await dismissMedia('m-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('dismissRefusalMessage switches on the code, says nothing is gone when it is not, and keeps the ban', () => {
  expect(dismissRefusalMessage({ code: 'not_found' })).toBe(
    "This photo isn't here any more — refresh the list to see what is.",
  )
  expect(dismissRefusalMessage({ code: 'not_failed', status: 'ready' })).toBe(
    "This photo didn't fail, so there's nothing to dismiss — refresh the list to see where it is.",
  )
  expect(dismissRefusalMessage({ code: 'unreachable' })).toBe(networkErrors().form[0])
  expect(dismissRefusalMessage({ code: 'someday_code' })).toBe('Something went wrong. Nothing changed — try again.')
  for (const code of ['not_found', 'not_failed', 'unreachable', 'someday_code']) {
    expect(dismissRefusalMessage({ code })).not.toMatch(FAILURE_BAN)
  }
})
