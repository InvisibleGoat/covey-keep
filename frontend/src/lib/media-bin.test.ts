// CK-64 pins on the helpers the personal bin's surface rests on. The value
// under test: one function for the three acts on a row the caller uploaded
// — to the bin, back from it, gone for good — posting to the act's own path
// and answering with the server's STABLE CODE, never its wording; one
// refusal line per code, `not_pending` (the lost race on all three acts)
// among them, none claiming anything was deleted or put back when it was
// not; the days-left count rounded UP to whole days, "less than a day" in
// the last one, never negative, and never a countdown to deletion; the bin's
// line built from it and saying nothing about what happens at the window's
// end (the automatic clear ships switched off, so nothing is enforced
// there); and the permanent delete's confirmation, the bin record §7.1's
// sentence character for character, with "from CoveyKeep" kept because a
// printed book is out of reach.
import { afterEach, expect, test, vi } from 'vitest'
import { PRODUCT_NAME } from '../brand'
import { networkErrors } from './formErrors'
import {
  binDaysLeft,
  binMedia,
  binRefusalMessage,
  DELETE_PERMANENTLY_CONFIRMATION,
  mediaStateMessage,
  REMOVED_BIN_DAYS,
} from './media'

afterEach(() => {
  vi.unstubAllGlobals()
})

// The words the bin's surface may never use, on the rendered row and in
// both confirmations (the kickoff's ban list): every one of them promises
// something at the window's end, or a safety, that nothing enforces.
const BIN_BAN = /deleted after|emptied|cleared|forever|safe|backed up/i

const DAY = 86_400_000

function answer(status: number, body?: unknown) {
  const mock = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

test("binMedia posts once to the act's own path with no body, and a 200 is ok", async () => {
  for (const act of ['remove', 'restore', 'destroy'] as const) {
    const mock = answer(200, { id: 'm-1' })
    expect(await binMedia('m-1', act)).toEqual({ ok: true })
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith(`/media/m-1/${act}`)).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  }
})

test('each 409 comes back as its code with the state the server reports beside it, and never its wording', async () => {
  const cases: [string, Record<string, string>][] = [
    ['already_removed', { publication_state: 'removed', status: 'ready' }],
    ['not_removed', { publication_state: 'live', status: 'ready' }],
    ['not_ready', { publication_state: 'pending', status: 'failed' }],
    // The lost race on all three acts (api-reference): the row moved between
    // the read and the guarded write — the sweep marked it, or a second act
    // landed first — and nothing changed. It is `not_pending`, not a code of
    // the bin's own.
    ['not_pending', {}],
  ]
  for (const [code, state] of cases) {
    answer(409, { detail: { code, ...state, message: 'SERVER WORDING — never carried' } })
    const outcome = await binMedia('m-1', 'restore')
    expect(outcome).toEqual({
      ok: false,
      code,
      publication_state: state.publication_state,
      status: state.status,
    })
    expect(JSON.stringify(outcome)).not.toContain('SERVER WORDING')
  }
  // A 409 with no readable body still names a failure, never blank.
  answer(409)
  expect(await binMedia('m-1', 'remove')).toEqual({ ok: false, code: 'failed' })
})

test('the 404 is not_found, a request that never reached the server is unreachable, and anything else is a failure', async () => {
  answer(404, { detail: 'No such photograph.' })
  expect(await binMedia('m-1', 'destroy')).toEqual({ ok: false, code: 'not_found' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
  expect(await binMedia('m-1', 'remove')).toEqual({ ok: false, code: 'unreachable' })
  answer(500, { detail: 'boom' })
  expect(await binMedia('m-1', 'restore')).toEqual({ ok: false, code: 'failed' })
})

test('a refusal reads from its code — one line per code, not_pending among them — and none claims anything was deleted or put back', () => {
  expect(binRefusalMessage({ code: 'not_found' })).toBe(
    "This photo isn't here any more — refresh the list to see what is.",
  )
  expect(binRefusalMessage({ code: 'not_ready', status: 'failed' })).toBe(
    "This photo couldn't be processed, so there's nothing stored to act on.",
  )
  expect(binRefusalMessage({ code: 'not_ready', status: 'processing' })).toBe(
    "This photo isn't ready yet — it can't be sent to the bin, put back or deleted until it is.",
  )
  expect(binRefusalMessage({ code: 'already_removed' })).toBe('This photo is already in your bin.')
  expect(binRefusalMessage({ code: 'not_removed' })).toBe(
    "This photo isn't in your bin any more — refresh the list to see where it is.",
  )
  expect(binRefusalMessage({ code: 'not_pending' })).toBe(
    'This photo changed while you were looking at it — refresh the list and try again.',
  )
  expect(binRefusalMessage({ code: 'unreachable' })).toBe(networkErrors().form[0])
  expect(binRefusalMessage({ code: 'someday_code' })).toBe(
    'Something went wrong. Nothing changed — try again.',
  )
  // A refusal changed nothing, and no line says otherwise: nothing "was
  // deleted", nothing "is back", and none of the banned words.
  for (const code of ['not_found', 'not_ready', 'already_removed', 'not_removed', 'not_pending', 'other']) {
    for (const status of ['failed', 'processing', undefined]) {
      const line = binRefusalMessage({ code, status })
      expect(line).not.toMatch(/\b(was|has been|is now|got) (deleted|destroyed|removed|put back|restored|recovered)/i)
      expect(line).not.toMatch(BIN_BAN)
    }
  }
})

test('the days left: 30 at removal, rounded up mid-day, less than a day in the last day, never negative, null for a stamp that cannot be read', () => {
  const removed = new Date('2026-09-10T12:00:00+00:00')
  const at = (msLater: number) => new Date(removed.getTime() + msLater)
  const stamp = '2026-09-10T12:00:00+00:00'
  // The moment of removal: the whole window.
  expect(binDaysLeft(stamp, at(0))).toBe(REMOVED_BIN_DAYS)
  expect(REMOVED_BIN_DAYS).toBe(30)
  // Mid-day, rounded UP: two and a half days in is 27.5 left, told as 28 —
  // never a smaller number than the truth while a day is partly theirs.
  expect(binDaysLeft(stamp, at(2.5 * DAY))).toBe(28)
  expect(binDaysLeft(stamp, at(2 * DAY))).toBe(28)
  expect(binDaysLeft(stamp, at(2 * DAY + 1))).toBe(28)
  // Exactly a day left is one day, and a millisecond less is the last day.
  expect(binDaysLeft(stamp, at(29 * DAY))).toBe(1)
  expect(binDaysLeft(stamp, at(29 * DAY + 1))).toBe(0)
  expect(binDaysLeft(stamp, at(29.5 * DAY))).toBe(0)
  // At the window's own instant and past it: never negative. (The server
  // stops listing the row there — this is the floor, not a claim.)
  expect(binDaysLeft(stamp, at(30 * DAY))).toBe(0)
  expect(binDaysLeft(stamp, at(45 * DAY))).toBe(0)
  // A stamp that cannot be read counts nothing rather than "less than a day".
  expect(binDaysLeft('not a date', at(0))).toBeNull()
})

test("the bin's line: whose it is, and how long the way back stays open — and nothing about the window's end", () => {
  const own = { status: 'ready', publication_state: 'removed', is_own: true, uploader_display_name: 'Steven' }
  const stamp = '2026-09-10T12:00:00+00:00'
  const at = (days: number) => new Date(Date.parse(stamp) + days * DAY)
  // Every form, as a literal, with `now` injected so nothing here reads the
  // clock. (Until CK-64 the line read "Removed. Only you can still see it,
  // for 30 days after removal." — lib/media.test.ts's pin changed with it.)
  expect(mediaStateMessage({ ...own, removed_at: stamp }, { isHost: false, now: at(0) })).toBe(
    'In your bin. Only you can see it, and you can put it back for 30 more days.',
  )
  expect(mediaStateMessage({ ...own, removed_at: stamp }, { isHost: true, now: at(2) })).toBe(
    'In your bin. Only you can see it, and you can put it back for 28 more days.',
  )
  expect(mediaStateMessage({ ...own, removed_at: stamp }, { isHost: false, now: at(29) })).toBe(
    'In your bin. Only you can see it, and you can put it back for 1 more day.',
  )
  expect(mediaStateMessage({ ...own, removed_at: stamp }, { isHost: false, now: at(29.5) })).toBe(
    'In your bin. Only you can see it, and you can put it back for less than a day.',
  )
  // A row that carries no stamp (a caller that did not load it) still gets
  // an honest line, with no count invented.
  expect(mediaStateMessage({ ...own, removed_at: null }, { isHost: false, now: at(0) })).toBe(
    'In your bin. Only you can see it, and you can put it back.',
  )
  expect(mediaStateMessage(own, { isHost: false })).toBe(
    'In your bin. Only you can see it, and you can put it back.',
  )
  // The branch the audience rule makes unreachable, kept defensive.
  expect(mediaStateMessage({ ...own, is_own: false, removed_at: stamp }, { isHost: true, now: at(0) })).toBe(
    'Removed.',
  )
  // Nothing promises deletion on a date, an emptying, or a safety: the
  // automatic clear ships switched off, and until it is on nothing clears a
  // bin — the copy may claim only that the way back closes.
  for (const days of [0, 2, 29, 29.5, 31]) {
    for (const isHost of [true, false]) {
      const line = mediaStateMessage({ ...own, removed_at: stamp }, { isHost, now: at(days) })
      expect(line).not.toMatch(BIN_BAN)
      expect(line).not.toMatch(/delet|destroy|remov|30 days/i)
    }
  }
})

test("the permanent delete's confirmation is the record's sentence, character for character, and names the product from brand.ts", () => {
  expect(DELETE_PERMANENTLY_CONFIRMATION).toBe(
    'Are you sure? This will permanently remove the photo from CoveyKeep and cannot be recovered.',
  )
  expect(DELETE_PERMANENTLY_CONFIRMATION).toContain(`from ${PRODUCT_NAME} and`)
  expect(DELETE_PERMANENTLY_CONFIRMATION).not.toMatch(BIN_BAN)
})
