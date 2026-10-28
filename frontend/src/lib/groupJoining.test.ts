// CK-79 — lib/groupJoining.ts. The value under test: every call answers the
// server's stable code and never its wording; THE LINK NEVER LEAVES ITS CALL
// — `readLink` and `makeLink` hand back `{ expiresAt, share }` with no
// property holding the URL, and `share` hands the URL to the device and
// nowhere else, falling back from a refusing share sheet to the clipboard
// once, silent on a closed sheet; the two parked tokens keep CK-25's shape;
// and the copy, as literals.
import { afterEach, expect, test, vi } from 'vitest'
import { networkErrors } from './formErrors'
import {
  acceptGroupInvitation,
  approveRequest,
  approveSentence,
  askedLine,
  clearGroupInvitationToken,
  clearGroupLinkToken,
  consumeFragmentToken,
  declineRequest,
  decisionRefusalMessage,
  INVITE_HINT,
  INVITE_RATE_LIMITED,
  inviteByEmail,
  JOIN_RATE_LIMITED,
  JOIN_SIGNED_OUT_LINE,
  joinConsentLine,
  joinThroughLink,
  LINK_COPIED,
  LINK_HINT,
  linkExpiryLine,
  linkRefusalMessage,
  makeLink,
  NO_LINK_MEMBER,
  NO_REQUESTS,
  pendingExpiryLine,
  previewGroupInvitation,
  previewLink,
  readGroupInvitations,
  readGroupInvitationToken,
  readGroupLinkToken,
  readJoinRequests,
  readLink,
  REPLACE_LINK_SENTENCE,
  REQUESTS_HINT,
  requestInLine,
  revokeGroupInvitation,
  revokeLink,
  SHARE_FAILED,
  SHARE_UNAVAILABLE,
  shareOutcomeLine,
  shareText,
  storeGroupInvitationToken,
  storeGroupLinkToken,
  TURN_OFF_LINK_SENTENCE,
  type ShareableLink,
  type ShareDevice,
} from './groupJoining'
import source from './groupJoining.ts?raw'

const SERVER_WORDING = 'SERVER WORDING XYZ — never carried'
const URL_WITH_TOKEN = 'https://app.example/groups/join#token=tok-secret-1234'
const EXPIRES = '2026-11-03T18:00:00+00:00'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  window.location.hash = ''
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function stubFetch(respond: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(respond(String(url), init)))
  vi.stubGlobal('fetch', mock)
  return mock
}

function failFetch() {
  const mock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
  vi.stubGlobal('fetch', mock)
  return mock
}

function lastCall(mock: ReturnType<typeof vi.fn>) {
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit | undefined]
  return { path: String(url).replace(/^https?:\/\/[^/]+/, ''), method: init?.method ?? 'GET', init }
}

// No property of what is returned holds the URL — not a value, not a
// nested value, not the JSON a caller could log.
function expectNoUrl(value: unknown) {
  const seen: unknown[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') expect(v).not.toContain('#token=')
    if (v !== null && typeof v === 'object' && !seen.includes(v)) {
      seen.push(v)
      for (const inner of Object.values(v)) walk(inner)
    }
  }
  walk(value)
  expect(JSON.stringify(value)).not.toContain('#token=')
  expect(JSON.stringify(value)).not.toContain('tok-secret')
}

// ---------------------------------------------------------------------------
// The link: `{ expiresAt, share }`, never the URL.
// ---------------------------------------------------------------------------

test('readLink: a live link answers { expiresAt, share } with no property holding the URL; no link answers null', async () => {
  const mock = stubFetch(() => json(200, { url: URL_WITH_TOKEN, expires_at: EXPIRES }))
  const outcome = await readLink('g-1')
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/link', method: 'GET' })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok || outcome.link === null) throw new Error('expected a link')
  expect(Object.keys(outcome.link).sort()).toEqual(['expiresAt', 'share'])
  expect(outcome.link.expiresAt).toBe(EXPIRES)
  expectNoUrl(outcome)

  stubFetch(() => json(200, { url: null, expires_at: null }))
  expect(await readLink('g-1')).toEqual({ ok: true, link: null })
})

test('readLink and makeLink: their refusals carry the code — a 404 not_found, a 409 withdrawn_meanwhile, a network failure unreachable, a 500 failed', async () => {
  stubFetch(() => json(404, { detail: SERVER_WORDING }))
  expect(await readLink('g-1')).toEqual({ ok: false, code: 'not_found' })
  stubFetch(() => json(500, { detail: SERVER_WORDING }))
  expect(await readLink('g-1')).toEqual({ ok: false, code: 'failed' })
  failFetch()
  expect(await readLink('g-1')).toEqual({ ok: false, code: 'unreachable' })

  const mock = stubFetch(() =>
    json(409, { detail: { code: 'withdrawn_meanwhile', message: SERVER_WORDING } }),
  )
  const refused = await makeLink('g-1')
  expect(refused).toMatchObject({ ok: false, code: 'withdrawn_meanwhile' })
  expect(JSON.stringify(refused)).not.toContain(SERVER_WORDING)
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/link', method: 'POST' })
  expect(lastCall(mock).init?.body).toBeUndefined()
})

test('makeLink: a 201 answers the new link, with no property holding the URL', async () => {
  stubFetch(() => json(201, { url: URL_WITH_TOKEN, expires_at: EXPIRES }))
  const outcome = await makeLink('g-1')
  if (!outcome.ok || outcome.link === null) throw new Error('expected a link')
  expect(outcome.link.expiresAt).toBe(EXPIRES)
  expectNoUrl(outcome)
})

test('revokeLink: a DELETE answering 204', async () => {
  const mock = stubFetch(() => new Response(null, { status: 204 }))
  expect(await revokeLink('g-1')).toEqual({ ok: true })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/link', method: 'DELETE' })
})

// ---------------------------------------------------------------------------
// share: the device and nowhere else.
// ---------------------------------------------------------------------------

async function linkWith(device: ShareDevice | undefined): Promise<ShareableLink> {
  stubFetch(() => json(200, { url: URL_WITH_TOKEN, expires_at: EXPIRES }))
  const outcome = await readLink('g-1', device)
  if (!outcome.ok || outcome.link === null) throw new Error('expected a link')
  return outcome.link
}

function abortError(): Error {
  const error = new Error('Share canceled')
  error.name = 'AbortError'
  return error
}

test('share hands the URL to the share sheet with the group in the text, and answers shared', async () => {
  const device = { share: vi.fn(() => Promise.resolve()), writeText: vi.fn(() => Promise.resolve()) }
  const link = await linkWith(device)
  const fetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
  expect(await link.share('The Lees')).toBe('shared')
  expect(device.share).toHaveBeenCalledWith({
    title: 'Join The Lees on CoveyKeep',
    text: 'Join The Lees on CoveyKeep',
    url: URL_WITH_TOKEN,
  })
  expect(device.writeText).not.toHaveBeenCalled()
  // No request carries it anywhere.
  expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetches)
})

test('share: the person closing the share sheet (AbortError) answers cancelled, and the clipboard is never touched', async () => {
  const device = { share: vi.fn(() => Promise.reject(abortError())), writeText: vi.fn(() => Promise.resolve()) }
  const link = await linkWith(device)
  expect(await link.share('The Lees')).toBe('cancelled')
  expect(device.writeText).not.toHaveBeenCalled()
})

test('share: a share sheet that refuses falls back to the clipboard once — copied, or failed if the clipboard refuses too', async () => {
  const copying = {
    share: vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
    writeText: vi.fn(() => Promise.resolve()),
  }
  expect(await (await linkWith(copying)).share('The Lees')).toBe('copied')
  expect(copying.writeText).toHaveBeenCalledTimes(1)
  expect(copying.writeText).toHaveBeenCalledWith(URL_WITH_TOKEN)

  const refusing = {
    share: vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
    writeText: vi.fn(() => Promise.reject(new Error('denied'))),
  }
  expect(await (await linkWith(refusing)).share('The Lees')).toBe('failed')
  expect(refusing.writeText).toHaveBeenCalledTimes(1)

  const noClipboard = { share: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) }
  expect(await (await linkWith(noClipboard)).share('The Lees')).toBe('failed')
})

test('share: no share sheet — the clipboard, copied or failed; neither — unavailable', async () => {
  const clipboard = { writeText: vi.fn(() => Promise.resolve()) }
  expect(await (await linkWith(clipboard)).share('The Lees')).toBe('copied')
  expect(clipboard.writeText).toHaveBeenCalledWith(URL_WITH_TOKEN)

  const broken = { writeText: vi.fn(() => Promise.reject(new Error('denied'))) }
  expect(await (await linkWith(broken)).share('The Lees')).toBe('failed')

  expect(await (await linkWith({})).share('The Lees')).toBe('unavailable')
})

test('share with no device injected reads the browser’s own — jsdom has neither, so unavailable', async () => {
  const link = await linkWith(undefined)
  expect(await link.share('The Lees')).toBe('unavailable')
})

test('share calls the device before anything is awaited — the click’s user activation is not spent first', async () => {
  const device = { share: vi.fn(() => Promise.resolve()) }
  const link = await linkWith(device)
  const pending = link.share('The Lees')
  // Synchronously, before the promise is awaited.
  expect(device.share).toHaveBeenCalledTimes(1)
  await pending
})

// ---------------------------------------------------------------------------
// Requests to join.
// ---------------------------------------------------------------------------

test('readJoinRequests: the rows on 200; a 404 not_found; a network failure unreachable', async () => {
  const rows = [{ id: 'r-1', display_name: 'Zoe', created_at: '2026-10-26T15:00:00+00:00' }]
  const mock = stubFetch(() => json(200, { join_requests: rows }))
  expect(await readJoinRequests('g-1')).toEqual({ ok: true, value: rows })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/join-requests', method: 'GET' })
  stubFetch(() => json(404, { detail: SERVER_WORDING }))
  expect(await readJoinRequests('g-1')).toEqual({ ok: false, code: 'not_found' })
  failFetch()
  expect(await readJoinRequests('g-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('approveRequest and declineRequest: one POST each with no body; a 409 answers already_decided with its outcome, never the wording', async () => {
  const decided = {
    id: 'r-1',
    display_name: 'Zoe',
    created_at: '2026-10-26T15:00:00+00:00',
    outcome: 'approved',
    decided_at: '2026-10-27T16:00:00+00:00',
  }
  let mock = stubFetch(() => json(200, decided))
  expect(await approveRequest('g-1', 'r-1')).toEqual({ ok: true })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/join-requests/r-1/approve', method: 'POST' })
  expect(lastCall(mock).init?.body).toBeUndefined()

  mock = stubFetch(() => json(200, { ...decided, outcome: 'declined' }))
  expect(await declineRequest('g-1', 'r-1')).toEqual({ ok: true })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/join-requests/r-1/decline', method: 'POST' })

  for (const outcome of ['approved', 'declined', null]) {
    stubFetch(() => json(409, { detail: { code: 'already_decided', outcome, message: SERVER_WORDING } }))
    const refused = await approveRequest('g-1', 'r-1')
    expect(refused).toEqual({ ok: false, code: 'already_decided', outcome })
  }
  stubFetch(() => json(404, { detail: SERVER_WORDING }))
  expect(await declineRequest('g-1', 'r-1')).toEqual({ ok: false, code: 'not_found' })
  stubFetch(() => json(500, {}))
  expect(await declineRequest('g-1', 'r-1')).toEqual({ ok: false, code: 'failed' })
  failFetch()
  expect(await approveRequest('g-1', 'r-1')).toEqual({ ok: false, code: 'unreachable' })
})

// ---------------------------------------------------------------------------
// Emailed invitations.
// ---------------------------------------------------------------------------

const PENDING = {
  id: 'inv-1',
  channel: 'EMAIL',
  destination: 'dora@example.com',
  created_at: '2026-10-27T15:00:00+00:00',
  expires_at: '2026-11-03T15:00:00+00:00',
}

test('readGroupInvitations: the pending rows on 200; refusals by code', async () => {
  const mock = stubFetch(() => json(200, { pending: [PENDING] }))
  expect(await readGroupInvitations('g-1')).toEqual({ ok: true, value: [PENDING] })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/invitations', method: 'GET' })
  stubFetch(() => json(404, {}))
  expect(await readGroupInvitations('g-1')).toEqual({ ok: false, code: 'not_found' })
})

test('inviteByEmail: the body is exactly {"channel":"EMAIL","destination"}; a 201 is the pending row', async () => {
  const mock = stubFetch(() => json(201, PENDING))
  expect(await inviteByEmail('g-1', 'dora@example.com')).toEqual({ ok: true, invitation: PENDING })
  const { path, method, init } = lastCall(mock)
  expect({ path, method }).toEqual({ path: '/groups/g-1/invitations', method: 'POST' })
  expect(JSON.parse(String(init?.body))).toEqual({ channel: 'EMAIL', destination: 'dora@example.com' })
})

test('inviteByEmail: a 422 lands on destination or channel through the one mapper; a 429 is rate_limited with its line; a 409 its code; a network failure the app’s line', async () => {
  stubFetch(() =>
    json(422, { detail: [{ loc: ['body', 'destination'], msg: 'Value error, not an address', type: 'value_error' }] }),
  )
  let outcome = await inviteByEmail('g-1', 'x')
  expect(outcome).toMatchObject({ ok: false, code: null })
  if (outcome.ok) throw new Error('expected a refusal')
  expect(outcome.errors.fields.destination).toBe('Not an address')

  stubFetch(() =>
    json(422, { detail: [{ loc: ['body', 'channel'], msg: "text-message invitations aren't available yet", type: 'value_error' }] }),
  )
  outcome = await inviteByEmail('g-1', 'x')
  if (outcome.ok) throw new Error('expected a refusal')
  expect(outcome.errors.fields.channel).toBe("Text-message invitations aren't available yet")

  stubFetch(() => json(429, { detail: SERVER_WORDING }))
  outcome = await inviteByEmail('g-1', 'x')
  expect(outcome).toEqual({
    ok: false,
    code: 'rate_limited',
    errors: { fields: {}, form: [INVITE_RATE_LIMITED], types: {} },
  })

  stubFetch(() => json(409, { detail: { code: 'withdrawn_meanwhile', message: SERVER_WORDING } }))
  outcome = await inviteByEmail('g-1', 'x')
  expect(outcome).toMatchObject({ ok: false, code: 'withdrawn_meanwhile' })
  expect(JSON.stringify(outcome)).not.toContain(SERVER_WORDING)

  failFetch()
  outcome = await inviteByEmail('g-1', 'x')
  expect(outcome).toEqual({ ok: false, code: null, errors: networkErrors() })
})

test('revokeGroupInvitation: a DELETE answering 204; a 404 not_found', async () => {
  const mock = stubFetch(() => new Response(null, { status: 204 }))
  expect(await revokeGroupInvitation('g-1', 'inv-1')).toEqual({ ok: true })
  expect(lastCall(mock)).toMatchObject({ path: '/groups/g-1/invitations/inv-1', method: 'DELETE' })
  stubFetch(() => json(404, {}))
  expect(await revokeGroupInvitation('g-1', 'inv-1')).toEqual({ ok: false, code: 'not_found' })
})

// ---------------------------------------------------------------------------
// The two landings' calls.
// ---------------------------------------------------------------------------

test('previewLink: unauthenticated, the token in a POST body; each status to its outcome; a failure by code', async () => {
  localStorage.setItem('covey-keep:session-token', 'session-abc')
  for (const status of ['valid', 'expired', 'revoked', 'invalid'] as const) {
    const mock = stubFetch(() => json(200, { status, group_name: status === 'valid' ? 'The Lees' : null }))
    expect(await previewLink('tok-1')).toEqual({
      ok: true,
      status,
      groupName: status === 'valid' ? 'The Lees' : null,
    })
    const { path, method, init } = lastCall(mock)
    expect({ path, method }).toEqual({ path: '/group-links/preview', method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'tok-1' })
    // Unauthenticated: no bearer rides the preview.
    expect(new Headers(init?.headers).get('Authorization')).toBeNull()
  }
  stubFetch(() => json(500, {}))
  expect(await previewLink('tok-1')).toEqual({ ok: false, code: 'failed' })
  failFetch()
  expect(await previewLink('tok-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('joinThroughLink: authenticated, the token in a POST body; each status to its outcome, the group id only where the server gives one; a 429 rate_limited', async () => {
  localStorage.setItem('covey-keep:session-token', 'session-abc')
  for (const [status, groupId] of [
    ['requested', null],
    ['pending', null],
    ['already_member', 'g-1'],
    ['expired', null],
    ['revoked', null],
    ['invalid', null],
  ] as const) {
    const mock = stubFetch(() => json(200, { status, group_id: groupId }))
    expect(await joinThroughLink('tok-1')).toEqual({ ok: true, status, groupId })
    const { path, method, init } = lastCall(mock)
    expect({ path, method }).toEqual({ path: '/group-links/join', method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'tok-1' })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-abc')
  }
  stubFetch(() => json(429, { detail: SERVER_WORDING }))
  expect(await joinThroughLink('tok-1')).toEqual({ ok: false, code: 'rate_limited' })
  failFetch()
  expect(await joinThroughLink('tok-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('previewGroupInvitation and acceptGroupInvitation: CK-25’s statuses, on the group', async () => {
  for (const status of ['valid', 'expired', 'used', 'revoked', 'invalid'] as const) {
    const mock = stubFetch(() => json(200, { status, group_name: status === 'valid' ? 'The Lees' : null }))
    expect(await previewGroupInvitation('tok-2')).toMatchObject({ ok: true, status })
    expect(lastCall(mock).path).toBe('/group-invitations/preview')
  }
  for (const [status, groupId] of [
    ['accepted', 'g-1'],
    ['already_accepted', 'g-1'],
    ['expired', null],
    ['used', null],
    ['revoked', null],
    ['invalid', null],
  ] as const) {
    const mock = stubFetch(() => json(200, { status, group_id: groupId }))
    expect(await acceptGroupInvitation('tok-2')).toEqual({ ok: true, status, groupId })
    expect(lastCall(mock)).toMatchObject({ path: '/group-invitations/accept', method: 'POST' })
  }
})

// ---------------------------------------------------------------------------
// The parked tokens and the fragment.
// ---------------------------------------------------------------------------

test('the two parked tokens: CK-25’s three functions each, on their own keys, independent of each other and of CK-25’s', () => {
  storeGroupLinkToken('link-tok')
  storeGroupInvitationToken('inv-tok')
  expect(localStorage.getItem('covey-keep:group-link-token')).toBe('link-tok')
  expect(localStorage.getItem('covey-keep:group-invitation-token')).toBe('inv-tok')
  expect(localStorage.getItem('covey-keep:invitation-token')).toBeNull()
  expect(readGroupLinkToken()).toBe('link-tok')
  expect(readGroupInvitationToken()).toBe('inv-tok')
  clearGroupLinkToken()
  expect(readGroupLinkToken()).toBeNull()
  expect(readGroupInvitationToken()).toBe('inv-tok')
  clearGroupInvitationToken()
  expect(readGroupInvitationToken()).toBeNull()
})

test('the parked tokens survive storage that throws: nothing stored, nothing read, nothing thrown', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('QuotaExceededError')
  })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('SecurityError')
  })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('SecurityError')
  })
  expect(() => storeGroupLinkToken('t')).not.toThrow()
  expect(readGroupLinkToken()).toBeNull()
  expect(() => clearGroupInvitationToken()).not.toThrow()
})

test('consumeFragmentToken: reads #token= once and strips the fragment from the address bar', () => {
  window.location.hash = '#token=frag-tok'
  expect(consumeFragmentToken()).toBe('frag-tok')
  expect(window.location.hash).toBe('')
  expect(consumeFragmentToken()).toBeNull()
})

// ---------------------------------------------------------------------------
// The copy, as literals.
// ---------------------------------------------------------------------------

test('the copy, as rendered literals', () => {
  expect(LINK_HINT).toBe('Anyone you send it to can ask to join. An admin or co-admin approves each request.')
  expect(linkExpiryLine('Nov 3')).toBe('Works until Nov 3')
  expect(shareText('The Lees')).toBe('Join The Lees on CoveyKeep')
  expect(LINK_COPIED).toBe('Link copied. Paste it into a message to the people you want to invite.')
  expect(SHARE_FAILED).toBe("This browser couldn't share or copy the link — try again.")
  expect(SHARE_UNAVAILABLE).toBe(
    "This browser can't share or copy the link. Open this page on your phone to share it.",
  )
  expect(shareOutcomeLine('copied')).toBe(LINK_COPIED)
  expect(shareOutcomeLine('failed')).toBe(SHARE_FAILED)
  expect(shareOutcomeLine('unavailable')).toBe(SHARE_UNAVAILABLE)
  expect(shareOutcomeLine('shared')).toBe('')
  expect(shareOutcomeLine('cancelled')).toBe('')
  expect(shareOutcomeLine(null)).toBe('')
  expect(NO_LINK_MEMBER).toBe("There's no link to share right now. An admin or co-admin can make one.")
  expect(REPLACE_LINK_SENTENCE).toBe(
    "The current link will stop working, and anyone who hasn't used it yet will need the new one.",
  )
  expect(TURN_OFF_LINK_SENTENCE).toBe(
    'The link will stop working. Requests already made stay in Requests to join.',
  )
  expect(linkRefusalMessage('withdrawn_meanwhile')).toBe('The link changed just now — try again.')
  expect(linkRefusalMessage('not_found')).toBe("You can't change this group's link any more — refresh the page.")
  expect(linkRefusalMessage('unreachable')).toBe(networkErrors().form[0])
  expect(linkRefusalMessage('failed')).toBe('Something went wrong. Nothing changed — try again.')
  expect(REQUESTS_HINT).toBe(
    "People who ask with the group's link wait here. They aren't told if you decline, and they can ask again with the link.",
  )
  expect(NO_REQUESTS).toBe('No one is waiting to join.')
  expect(askedLine('Oct 26')).toBe('asked Oct 26')
  expect(approveSentence('Zoe', 'The Lees')).toBe(
    "Zoe will join The Lees and see its members. The group's upcoming gatherings will include them.",
  )
  expect(decisionRefusalMessage('already_decided', 'approved')).toBe(
    'Someone already approved this request — refresh the list.',
  )
  expect(decisionRefusalMessage('already_decided', 'declined')).toBe(
    'Someone already declined this request — refresh the list.',
  )
  expect(decisionRefusalMessage('already_decided', null)).toBe(
    'Someone already decided this request — refresh the list.',
  )
  expect(decisionRefusalMessage('not_found')).toBe("This request isn't here any more — refresh the list.")
  expect(INVITE_HINT).toBe("They'll get an email with a link to join this group. Invitations expire after 7 days.")
  expect(INVITE_RATE_LIMITED).toBe('Too many invitations just now — try again in a few minutes.')
  expect(pendingExpiryLine(false, 'Nov 3')).toBe('expires Nov 3')
  expect(pendingExpiryLine(true, 'Nov 3')).toBe('expired')
  expect(JOIN_SIGNED_OUT_LINE).toBe(
    'Sign in, or create your account, to ask to join. An admin or co-admin approves each request.',
  )
  expect(joinConsentLine('Bea')).toBe("When you ask, the group's admin and co-admins will see your name, Bea.")
  expect(joinConsentLine(null)).toBe("When you ask, the group's admin and co-admins will see your name.")
  expect(requestInLine('The Lees')).toBe(
    "An admin or co-admin of The Lees will see it. You won't get a message when they decide — if they approve it, the group will be in Your groups.",
  )
  expect(JOIN_RATE_LIMITED).toBe('Many people are asking to join this group just now — try again in a few minutes.')
})

test('the module spells no product name — it flows from brand.ts — and promises no notice anywhere in its copy', () => {
  expect(source).not.toMatch(/covey ?keep/i)
  for (const line of [
    LINK_HINT,
    REQUESTS_HINT,
    JOIN_SIGNED_OUT_LINE,
    requestInLine('The Lees'),
    joinConsentLine('Bea'),
    approveSentence('Zoe', 'The Lees'),
  ]) {
    expect(line).not.toMatch(/\bsafe|secure|private|forever|backed up|\bevents?\b|notif|we'll let you know|you'll hear/i)
  }
})
