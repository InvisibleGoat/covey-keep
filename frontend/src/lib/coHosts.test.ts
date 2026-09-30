// CK-69 pins on the co-host helpers (the surface for CK-68's backend;
// co-hosts §4, §7). The value under test: one POST naming the accepted
// invitation and one DELETE to the row's own path, each answering with the
// server's STABLE CODE and never its wording; one refusal line per code
// (the four 422 codes, the 404 as "no longer allowed"), none claiming
// anything changed; the host's hint and the two second-step sentences as
// literals — the host addressed as "you", the reserved acts named as what
// stays with the host, and nothing about a notification, because none
// exists.
import { afterEach, expect, test, vi } from 'vitest'
import {
  addCoHost,
  CO_HOST_HINT,
  coHostRefusalMessage,
  removeCoHost,
  removeCoHostSentence,
  STEP_DOWN_SENTENCE,
} from './coHosts'
import { networkErrors } from './formErrors'

afterEach(() => {
  vi.unstubAllGlobals()
})

// The words no co-host copy may use (the bin ban list, for the same reason:
// each promises something nothing enforces) — and nothing about a notice.
const BAN = /deleted after|emptied|cleared|forever|safe|backed up|notif|email/i

const SERVER_WORDING = 'SERVER WORDING — never carried'

function answer(status: number, body?: unknown) {
  const mock = vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

test('addCoHost posts the accepted invitation id once; a 201 is ok, a 404 is not_found, a 422 is its code and never its wording, anything else fails, and a network failure is unreachable', async () => {
  const mock = answer(201, {
    invitation_id: 'i-1',
    display_name: 'peter',
    added_at: '2026-09-30T12:00:00+00:00',
    is_self: false,
  })
  expect(await addCoHost('g-1', 'i-1')).toEqual({ ok: true })
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url.endsWith('/gatherings/g-1/co-hosts')).toBe(true)
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual({ invitation_id: 'i-1' })

  // The gathering's 404: the caller is not the host (or no longer an
  // organiser at all) — byte-identical to a missing gathering.
  answer(404, { detail: 'No such gathering.' })
  expect(await addCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'not_found' })

  // The four refusals, each as its code, the server's message left behind.
  for (const code of ['not_invited', 'is_host', 'already_co_host', 'account_deleted']) {
    answer(422, {
      detail: [{ loc: ['body', 'invitation_id'], msg: SERVER_WORDING, type: 'value_error', code }],
    })
    const outcome = await addCoHost('g-1', 'i-1')
    expect(outcome).toEqual({ ok: false, code })
    expect(JSON.stringify(outcome)).not.toContain('SERVER WORDING')
  }
  // A 422 with no usable code still names a failure, never blank.
  answer(422, { detail: 'malformed' })
  expect(await addCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'failed' })
  answer(500, { detail: 'boom' })
  expect(await addCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'failed' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
  expect(await addCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'unreachable' })
})

test("removeCoHost sends one DELETE to the row's own path with no body; 204 is ok, 404 is not_found, anything else fails, a network failure is unreachable", async () => {
  const mock = answer(204)
  expect(await removeCoHost('g-1', 'i-1')).toEqual({ ok: true })
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url.endsWith('/gatherings/g-1/co-hosts/i-1')).toBe(true)
  expect(init.method).toBe('DELETE')
  expect(init.body).toBeUndefined()

  // The co-host 404 (a co-host naming another, or a handle naming nobody)
  // and the gathering's 404 (no longer an organiser) both read the same.
  answer(404, { detail: 'No such co-host.' })
  expect(await removeCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'not_found' })
  answer(500, { detail: 'boom' })
  expect(await removeCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'failed' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
  expect(await removeCoHost('g-1', 'i-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('a refusal reads from its code — one line per code, the name in the already_co_host line — and none claims anything changed', () => {
  expect(coHostRefusalMessage('not_invited', 'Aunt May')).toBe(
    "That invitation can't be found any more — refresh the list.",
  )
  expect(coHostRefusalMessage('is_host', 'Steven')).toBe("That's you — you're already the host.")
  expect(coHostRefusalMessage('already_co_host', 'Aunt May')).toBe(
    'Aunt May is already a co-host — refresh the list.',
  )
  expect(coHostRefusalMessage('account_deleted', 'Aunt May')).toBe(
    "This person has deleted their account, so they can't be a co-host.",
  )
  expect(coHostRefusalMessage('not_found', 'Aunt May')).toBe(
    "You can't change co-hosts for this gathering any more — refresh the page.",
  )
  expect(coHostRefusalMessage('unreachable', 'Aunt May')).toBe(networkErrors().form[0])
  expect(coHostRefusalMessage('someday_code', 'Aunt May')).toBe(
    'Something went wrong. Nothing changed — try again.',
  )
  for (const code of ['not_invited', 'is_host', 'already_co_host', 'account_deleted', 'not_found', 'other']) {
    const line = coHostRefusalMessage(code, 'Aunt May')
    expect(line).not.toMatch(/\b(is now|was made|has been made|was removed|has been removed)\b/i)
    expect(line).not.toMatch(BAN)
    expect(line).not.toContain('SERVER WORDING')
  }
})

test('the hint and the two second-step sentences, as literals: the host addressed as "you", the reserved acts named as what stays with the host, and nothing about a notice', () => {
  expect(CO_HOST_HINT).toBe(
    'A co-host can edit this gathering and its dates, invite people, see every answer, and take photos off the gathering. Only you review photos, delete them permanently, and choose co-hosts.',
  )
  expect(removeCoHostSentence('peter')).toBe(
    'peter will no longer be able to edit this gathering, invite people, or take photos off it.',
  )
  expect(STEP_DOWN_SENTENCE).toBe(
    "You'll no longer be able to edit this gathering, invite people, or take photos off it. Only the host can make you a co-host again.",
  )
  // The seat rule: the host reads the hint and the remove step, and is
  // never addressed as "the host" there; a co-host reads the step-down
  // sentence, where "the host" is someone else.
  expect(CO_HOST_HINT).not.toMatch(/the host/i)
  expect(removeCoHostSentence('peter')).not.toMatch(/the host/i)
  for (const copy of [CO_HOST_HINT, removeCoHostSentence('peter'), STEP_DOWN_SENTENCE]) {
    expect(copy).not.toMatch(BAN)
    expect(copy).not.toMatch(/approv|shared|screen|permission|setting|toggle/i)
  }
})
