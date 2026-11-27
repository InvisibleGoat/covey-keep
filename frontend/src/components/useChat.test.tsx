// A chat, read and kept current (CK-103; THE DESIGN §4, §6, §7 and §9 of its
// kickoff): the first read by kind, the check's pace, what stops and starts
// it, `since` from the server's clock alone, the fresh first read, the four
// 404s, a late answer for another place, an id that left never back, the
// setting line's one re-read, the lost answer and what a screen reader is
// told. Fake timers, under StrictMode, every answer given by hand.
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MARK_GAP_MS, TYPING_FRESH_MS, type ChatItem, type ChatPlace } from '../lib/chat'
import { askChatsNew, chatsNewNow, isNew } from '../lib/chatsNew'
import { clearToken, setToken } from '../lib/session'
import { AS_OF, chatChanges, chatItem, chatPage, heldItem, pathOf } from '../test-support/chat'
import { useChat, type Chat, type ReactResult, type RemoveResult, type SendResult } from './useChat'

const GROUP: ChatPlace = { kind: 'group', id: 'g-1' }
const OTHER: ChatPlace = { kind: 'group', id: 'g-2' }
const GATHERING: ChatPlace = { kind: 'gathering', id: 'x-1' }
const NOW = Date.parse('2026-11-24T15:00:00Z')

interface Asked {
  method: string
  path: string
  body: unknown
  at: number
  keepalive: boolean
  settled: boolean
  answer: (status: number, body?: unknown) => Promise<void>
  fail: () => Promise<void>
}

let asked: Asked[] = []
let chat: Chat
let place: ChatPlace
let view: ReturnType<typeof render>

function Probe() {
  chat = useChat(place)
  return null
}

const tree = () => (
  <StrictMode>
    <Probe />
  </StrictMode>
)

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

function stubFetch() {
  vi.stubGlobal('fetch', (input: unknown, init: RequestInit = {}) => {
    return new Promise<Response>((resolve, reject) => {
      // MOVED AT CK-105, with its reason: a check carries its instant and its
      // typing signal in headers (THE DESIGN §1, §9), so the path a test
      // matches is the address as asked and then those two headers, if sent.
      const headers = new Headers(init.headers)
      const since = headers.get('x-chat-since')
      const typing = headers.get('x-chat-typing')
      const call: Asked = {
        method: init.method ?? 'GET',
        path: `${pathOf(input)}${since === null ? '' : ` since=${since}`}${typing === null ? '' : ` typing=${typing}`}`,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        at: Date.now(),
        keepalive: init.keepalive === true,
        settled: false,
        answer: async (status, body) => {
          call.settled = true
          resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }))
          await flush()
        },
        fail: async () => {
          call.settled = true
          reject(new TypeError('Failed to fetch'))
          await flush()
        },
      }
      asked.push(call)
    })
  })
}

let hidden = false
async function setHidden(value: boolean) {
  hidden = value
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
  await flush()
}

const waitingFor = (match: RegExp, method = 'GET') =>
  asked.filter((call) => !call.settled && call.method === method && match.test(call.path))
const last = (match: RegExp, method = 'GET') => {
  const calls = waitingFor(match, method)
  expect(calls.length, `one ${method} ${match} waiting`).toBeGreaterThan(0)
  return calls[calls.length - 1]
}
// MOVED AT CK-105, with its reason: a check is the chat's own address with
// X-Chat-Since, and the first and fresh reads are `?open=true` (THE DESIGN §1).
const CHECK = / since=/
const checks = () => asked.filter((call) => CHECK.test(call.path))
const FRESH = /\/chat\?open=true$/
const EARLIER = /\/chat\?before=/
const sinceOf = (call: Asked) => / since=(\S+)/.exec(call.path)?.[1] ?? null

function open(at: ChatPlace) {
  place = at
  view = render(tree())
}

const group = (id = 'g-1', name = 'The Lees') => ({ id, name, member_count: 3, caller_role: 'member' })
const gathering = (over = {}) => ({
  id: 'x-1',
  title: 'Dinner',
  caller_view: 'full',
  caller_in_group: true,
  group: { id: 'g-1', name: 'The Lees' },
  outside_invitations: { on: false, since: null, by: null, may_change: false },
  invited_count: 4,
  ...over,
})

// StrictMode mounts, unmounts and mounts again: the first session's reads are
// answered by nothing and its page has gone.
async function openGroup(page = chatPage([]), id = 'g-1') {
  open({ kind: 'group', id })
  await last(new RegExp(`^/groups/${id}$`)).answer(200, group(id))
  await last(new RegExp(`^/groups/${id}/chat\\?open=true$`)).answer(200, page)
}

async function openGathering(page = chatPage([]), body = gathering()) {
  open(GATHERING)
  await last(/^\/gatherings\/x-1$/).answer(200, body)
  await last(/^\/gatherings\/x-1\/chat\?open=true$/).answer(200, page)
}

const ids = () => chat.entries.map((item) => item.id)
const at = (id: string, time: string, over: Partial<ChatItem> = {}) =>
  chatItem(id, { created_at: `2026-11-24T${time}+00:00`, ...over })
const mine = (id: string, time: string, body: string) =>
  at(id, time, { body, author: { display_name: 'Ann Mercer', is_self: true } })

async function start<T>(act_: () => Promise<T>): Promise<{ value: T | null }> {
  const landed: { value: T | null } = { value: null }
  await act(async () => {
    void act_().then((value) => (landed.value = value))
  })
  return landed
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  asked = []
  hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  setToken('session-test')
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearToken()
})

describe('the first read', () => {
  it('reads a group and its chat together', async () => {
    open(GROUP)
    expect(chat.status).toBe('loading')
    expect(waitingFor(/^\/groups\/g-1$/).length).toBeGreaterThan(0)
    expect(waitingFor(/^\/groups\/g-1\/chat\?open=true$/).length).toBeGreaterThan(0)
    await last(/^\/groups\/g-1$/).answer(200, group())
    expect(chat.status).toBe('loading')
    await last(/^\/groups\/g-1\/chat\?open=true$/).answer(
      200,
      chatPage([at('b', '14:00:02.000000'), at('a', '14:00:01.000000')], {
        may_moderate: true,
        older: 'c',
      }),
    )
    expect(chat.status).toBe('loaded')
    expect(chat.subject).toEqual({ kind: 'group', group: group() })
    expect(ids()).toEqual(['a', 'b'])
    expect([chat.mayModerate, chat.older, chat.checksFailing]).toEqual([true, true, false])
  })

  it('reads a gathering first, and its chat only in the full view', async () => {
    open(GATHERING)
    expect(waitingFor(/chat/)).toEqual([])
    await last(/^\/gatherings\/x-1$/).answer(200, gathering())
    await last(/^\/gatherings\/x-1\/chat\?open=true$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
    expect(chat.status).toBe('loaded')
    expect(chat.subject?.kind).toBe('gathering')
    expect(ids()).toEqual(['a'])
  })

  it('asks for nothing in the photos-only view, and there is no chat there', async () => {
    for (const caller_view of ['memory', undefined, 'something_new']) {
      asked = []
      open(GATHERING)
      await last(/^\/gatherings\/x-1$/).answer(200, gathering({ caller_view, invited_count: null }))
      expect(chat.status).toBe('notFound')
      await advance(60_000)
      expect(asked.filter((call) => call.path.includes('chat'))).toEqual([])
      view.unmount()
    }
  })

  it('is not there for a 404 on either read, and has failed for anything else', async () => {
    open(GROUP)
    await last(/^\/groups\/g-1$/).answer(404, {})
    await last(/^\/groups\/g-1\/chat\?open=true$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
    expect([chat.status, ids()]).toEqual(['notFound', []])
    view.unmount()

    open(GROUP)
    await last(/^\/groups\/g-1$/).answer(200, group())
    await last(/^\/groups\/g-1\/chat\?open=true$/).answer(404, {})
    expect(chat.status).toBe('notFound')
    view.unmount()

    open(GROUP)
    await last(/^\/groups\/g-1$/).answer(500, {})
    await last(/^\/groups\/g-1\/chat\?open=true$/).answer(200, chatPage([]))
    expect(chat.status).toBe('failed')
    await act(async () => chat.retry())
    expect(chat.status).toBe('loading')
    await last(/^\/groups\/g-1$/).answer(200, group())
    await last(/^\/groups\/g-1\/chat\?open=true$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
    expect([chat.status, ids()]).toEqual(['loaded', ['a']])
  })
})

describe('the check', () => {
  it('is two seconds after an answer, and never two at once', async () => {
    await openGroup()
    await advance(1999)
    expect(checks()).toEqual([])
    await advance(1)
    expect(checks()).toHaveLength(1)
    // Held: however long it takes, there is one.
    await advance(60_000)
    expect(checks()).toHaveLength(1)
    await last(CHECK).answer(200, chatChanges([at('a', '15:00:01.000000')]))
    expect(ids()).toEqual(['a'])
    await advance(1999)
    expect(checks()).toHaveLength(1)
    await advance(1)
    expect(checks()).toHaveLength(2)
  })

  it('is five seconds after one that failed, with the quiet line until one lands', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(500, {})
    expect([chat.checksFailing, ids()]).toEqual([true, ['a']])
    await advance(4999)
    expect(checks()).toHaveLength(1)
    await advance(1)
    expect(checks()).toHaveLength(2)
    await last(CHECK).fail()
    expect(chat.checksFailing).toBe(true)
    await advance(5000)
    await last(CHECK).answer(200, chatChanges())
    expect(chat.checksFailing).toBe(false)
    await advance(2000)
    expect(checks()).toHaveLength(4)
  })

  it('stops while the tab is hidden, and checks at once on its return', async () => {
    await openGroup()
    await setHidden(true)
    await advance(60_000)
    expect(checks()).toEqual([])
    await setHidden(false)
    expect(checks()).toHaveLength(1)
    await last(CHECK).answer(200, chatChanges())
    await advance(2000)
    expect(checks()).toHaveLength(2)
  })

  it('asks for no other while one lands behind a hidden tab, and one straight after on the return', async () => {
    await openGroup()
    await advance(2000)
    await setHidden(true)
    await last(CHECK).answer(200, chatChanges())
    await advance(60_000)
    expect(checks()).toHaveLength(1)
    await setHidden(false)
    expect(checks()).toHaveLength(2)
    // Hidden and back with one in flight: not two at once, and one after it.
    await setHidden(true)
    await setHidden(false)
    expect(checks()).toHaveLength(2)
    await last(CHECK).answer(200, chatChanges())
    expect(checks()).toHaveLength(3)
  })

  it('stops with the page', async () => {
    await openGroup()
    view.unmount()
    await advance(60_000)
    expect(checks()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('goes on from the server’s own instant, with the device’s clock an hour wrong', async () => {
    vi.setSystemTime(NOW - 3_600_000)
    await openGroup(chatPage([], { as_of: '2026-11-24T15:00:00.111111+00:00' }))
    await advance(2000)
    expect(sinceOf(checks()[0])).toBe('2026-11-24T15:00:00.111111+00:00')
    await last(CHECK).answer(200, chatChanges([], { as_of: '2026-11-24T15:00:02.222222+00:00' }))
    await advance(2000)
    expect(sinceOf(checks()[1])).toBe('2026-11-24T15:00:02.222222+00:00')
    // One that failed answered no instant, so the last one stands.
    await last(CHECK).answer(500, {})
    await advance(5000)
    expect(sinceOf(checks()[2])).toBe('2026-11-24T15:00:02.222222+00:00')
  })

  it('reads the chat afresh, at once, where a check could not hold everything', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(
      200,
      chatChanges([], { truncated: true, as_of: '2026-11-24T15:30:00.000000+00:00' }),
    )
    await last(FRESH).answer(
      200,
      chatPage([at('y', '15:00:01.000000'), at('z', '15:00:02.000000')], {
        older: 'c',
        as_of: '2026-11-24T15:30:01.000000+00:00',
      }),
    )
    expect([ids(), chat.older]).toEqual([['y', 'z'], true])
    expect(chat.arrived).toBeNull()
    await advance(2000)
    expect(sinceOf(checks()[1])).toBe('2026-11-24T15:30:01.000000+00:00')
  })

  it('still owes a fresh read that failed, at the retry’s pace', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    await last(FRESH).answer(500, {})
    expect([chat.checksFailing, ids()]).toEqual([true, ['a']])
    await advance(5000)
    expect(checks()).toHaveLength(1)
    await last(FRESH).answer(200, chatPage([at('z', '15:00:02.000000')]))
    expect([chat.checksFailing, ids()]).toEqual([false, ['z']])
  })

  it('reads the chat afresh where the caller has come to run it, and shows what left, held', async () => {
    const gone = at('gone', '14:00:01.000000')
    await openGroup(chatPage([gone, at('kept', '14:00:02.000000')]))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { removed: ['gone'] }))
    expect(ids()).toEqual(['kept'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { may_moderate: true }))
    expect(chat.mayModerate).toBe(true)
    await last(FRESH).answer(
      200,
      chatPage([heldItem(gone), at('kept', '14:00:02.000000')], { may_moderate: true }),
    )
    expect(ids()).toEqual(['gone', 'kept'])
  })

  it('drops every held message first where the caller has stopped running it, then reads afresh', async () => {
    const gone = heldItem(at('gone', '14:00:01.000000'))
    await openGroup(chatPage([gone, at('kept', '14:00:02.000000')], { may_moderate: true }))
    expect(ids()).toEqual(['gone', 'kept'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { may_moderate: false }))
    // Before the fresh read answers.
    expect([chat.mayModerate, ids()]).toEqual([false, ['kept']])
    await last(FRESH).answer(200, chatPage([at('kept', '14:00:02.000000')]))
    expect(ids()).toEqual(['kept'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([gone]))
    expect(ids()).toEqual(['kept'])
  })

  it('follows the device’s midnight, a day line’s, by the check', async () => {
    await openGroup()
    const opened = chat.now
    await advance(2000)
    await last(CHECK).answer(200, chatChanges())
    expect(chat.now).toBe(opened + 2000)
  })
})

describe('a 404', () => {
  const lost = () => expect([chat.status, ids(), chat.subject]).toEqual(['notFound', [], null])

  it('on a check lets go of everything, and checks no more', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(404, {})
    lost()
    await advance(60_000)
    expect(checks()).toHaveLength(1)
    await setHidden(true)
    await setHidden(false)
    expect(checks()).toHaveLength(1)
  })

  it('on a send lets go of everything, whatever a check then answers', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    const held = last(CHECK)
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').answer(404, {})
    lost()
    expect(sent.value).toEqual({ status: 'over' })
    await held.answer(200, chatChanges([at('b', '15:00:01.000000')]))
    lost()
    await advance(60_000)
    expect(checks()).toHaveLength(1)
  })

  it('on an earlier page lets go of everything', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { older: 'c' }))
    await act(async () => chat.showEarlier())
    await last(EARLIER).answer(404, {})
    lost()
    await advance(60_000)
    expect(checks()).toEqual([])
  })

  it('on the fresh read lets go of everything', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    await last(FRESH).answer(404, {})
    lost()
  })
})

describe('another place', () => {
  it('draws nothing of the last one, and ignores its late answers', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    const late = last(CHECK)
    place = OTHER
    view.rerender(tree())
    expect([chat.status, ids(), chat.subject]).toEqual(['loading', [], null])
    await late.answer(200, chatChanges([at('b', '15:00:01.000000')]))
    expect([chat.status, ids()]).toEqual(['loading', []])
    await last(/^\/groups\/g-2$/).answer(200, group('g-2', 'Finch'))
    await last(/^\/groups\/g-2\/chat\?open=true$/).answer(200, chatPage([at('z', '14:00:09.000000')]))
    expect([chat.status, ids()]).toEqual(['loaded', ['z']])
  })

  it('ignores a first read that lands after the move', async () => {
    open(GROUP)
    const first = [last(/^\/groups\/g-1$/), last(/^\/groups\/g-1\/chat\?open=true$/)]
    place = OTHER
    view.rerender(tree())
    await last(/^\/groups\/g-2$/).answer(200, group('g-2', 'Finch'))
    await last(/^\/groups\/g-2\/chat\?open=true$/).answer(200, chatPage([at('z', '14:00:09.000000')]))
    await first[0].answer(200, group())
    await first[1].answer(200, chatPage([at('a', '14:00:01.000000')]))
    expect(ids()).toEqual(['z'])
    expect(chat.subject).toEqual({ kind: 'group', group: group('g-2', 'Finch') })
  })
})

describe('an id that left', () => {
  it('is never back from a late check, an earlier page or a send’s answer', async () => {
    const gone = at('gone', '14:00:01.000000')
    await openGroup(chatPage([gone, at('kept', '14:00:02.000000')], { older: 'c' }))
    const sent = await start<SendResult>(() => chat.send('Words of gone'))
    const send = last(/chat$/, 'POST')
    await act(async () => chat.showEarlier())
    const earlier = last(EARLIER)
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { removed: ['gone', 'sent'] }))
    expect(ids()).toEqual(['kept'])
    await earlier.answer(200, chatPage([gone]))
    expect(ids()).toEqual(['kept'])
    await send.answer(201, mine('sent', '15:00:01.000000', 'Words of gone'))
    expect([ids(), sent.value]).toEqual([['kept'], { status: 'sent' }])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([gone]))
    expect(ids()).toEqual(['kept'])
  })
})

describe('earlier messages', () => {
  it('are added above, and the page’s own instant is never what the next check goes on from', async () => {
    await openGroup(
      chatPage([at('c', '14:00:03.000000')], {
        older: 'cur',
        as_of: '2026-11-24T15:00:00.111111+00:00',
      }),
    )
    await act(async () => chat.showEarlier())
    expect(chat.earlier).toBe('loading')
    // One press, one request.
    await act(async () => chat.showEarlier())
    expect(waitingFor(EARLIER)).toHaveLength(1)
    await last(EARLIER).answer(
      200,
      chatPage([at('a', '14:00:01.000000'), at('b', '14:00:02.000000')], {
        as_of: '2026-11-24T15:59:59.000000+00:00',
      }),
    )
    expect([ids(), chat.older, chat.earlier]).toEqual([['a', 'b', 'c'], false, 'idle'])
    await advance(2000)
    expect(sinceOf(checks()[0])).toBe('2026-11-24T15:00:00.111111+00:00')
    expect(chat.arrived).toBeNull()
  })

  it('say when they could not be read, and are asked for again', async () => {
    await openGroup(chatPage([at('c', '14:00:03.000000')], { older: 'cur' }))
    await act(async () => chat.showEarlier())
    await last(EARLIER).answer(500, {})
    expect([chat.earlier, chat.older, ids()]).toEqual(['failed', true, ['c']])
    await act(async () => chat.showEarlier())
    await last(EARLIER).answer(200, chatPage([at('b', '14:00:02.000000')]))
    expect([chat.earlier, ids()]).toEqual(['idle', ['b', 'c']])
  })

  it('asked for before the list was replaced are never joined to it', async () => {
    await openGroup(chatPage([at('c', '14:00:03.000000')], { older: 'cur' }))
    await act(async () => chat.showEarlier())
    const late = last(EARLIER)
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    await last(FRESH).answer(200, chatPage([at('z', '15:00:02.000000')], { older: 'new' }))
    await late.answer(200, chatPage([at('b', '14:00:02.000000')]))
    expect([ids(), chat.older, chat.earlier]).toEqual([['z'], true, 'idle'])
  })
})

describe('a setting line', () => {
  it('that arrives reads the gathering again once, though the checks repeat it', async () => {
    const on = chatItem('s', {
      kind: 'outside_invitations_on',
      body: null,
      created_at: '2026-11-24T15:00:01.000000+00:00',
    })
    await openGathering()
    const reads = () => asked.filter((call) => call.path === '/gatherings/x-1').length
    const opened = reads()
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([on]))
    expect(reads()).toBe(opened + 1)
    await last(/^\/gatherings\/x-1$/).answer(
      200,
      gathering({ outside_invitations: { on: true, since: null, by: null, may_change: false } }),
    )
    expect(
      chat.subject?.kind === 'gathering' && chat.subject.gathering.outside_invitations?.on,
    ).toBe(true)
    for (let n = 0; n < 3; n += 1) {
      await advance(2000)
      await last(CHECK).answer(200, chatChanges([on]))
    }
    expect(reads()).toBe(opened + 1)
    expect(ids()).toEqual(['s'])
  })

  it('that was there at the first read reads nothing again', async () => {
    const on = chatItem('s', { kind: 'outside_invitations_on', body: null })
    await openGathering(chatPage([on]))
    const before = asked.length
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([on]))
    expect(asked.length).toBe(before + 1)
  })
})

describe('sending', () => {
  it('adds the message and takes the thread to its newest', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    const newest = chat.newest
    const sent = await start<SendResult>(() => chat.send('Hello'))
    expect(sent.value).toBeNull()
    const post = last(/^\/groups\/g-1\/chat$/, 'POST')
    expect(post.body).toEqual({ body: 'Hello' })
    await post.answer(201, mine('m', '15:00:01.000000', 'Hello'))
    expect([ids(), sent.value]).toEqual([['a', 'm'], { status: 'sent' }])
    expect(chat.newest).toBe(newest + 1)
    // The check that repeats it adds nothing and says nothing.
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:01.000000', 'Hello')]))
    expect([ids(), chat.arrived]).toEqual([['a', 'm'], null])
  })

  it('answers a refusal by its code, and keeps the list', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    for (const [status, detail, reason] of [
      [422, [{ type: 'string_too_long' }], 'too_long'],
      [429, { code: 'too_many_messages' }, 'too_many'],
      [500, 'x', 'other'],
    ] as const) {
      const sent = await start<SendResult>(() => chat.send('Hello'))
      await last(/chat$/, 'POST').answer(status, { detail })
      expect(sent.value).toEqual({ status: 'refused', reason })
    }
    expect(ids()).toEqual(['a'])
  })

  it('whose answer was lost checks at once, and was sent where that brings its words', async () => {
    const old = mine('old', '14:00:01.000000', 'Hello')
    await openGroup(chatPage([old]))
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    expect(checks()).toHaveLength(1)
    expect(sent.value).toBeNull()
    const newest = chat.newest
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:01.000000', 'Hello'), old]))
    expect([sent.value, ids()]).toEqual([{ status: 'sent' }, ['old', 'm']])
    expect([chat.newest, chat.settled]).toEqual([newest + 1, null])
  })

  it('whose answer was lost was not sent where no message of the caller’s has those words', async () => {
    const old = mine('old', '14:00:01.000000', 'Hello')
    await openGroup(chatPage([old]))
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    await last(CHECK).answer(
      200,
      chatChanges([
        old,
        at('theirs', '15:00:01.000000', { body: 'Hello' }),
        mine('other', '15:00:02.000000', 'Hello there'),
      ]),
    )
    expect(sent.value).toEqual({ status: 'refused', reason: 'unreachable' })
    expect(chat.settled).toBeNull()
    // And a later check that brings it says so, leaving the thread where it is.
    const newest = chat.newest
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:03.000000', 'Hello')]))
    expect([chat.settled, chat.newest]).toEqual([{ words: 'Hello' }, newest])
  })

  it('whose answer was lost, and whose words have changed since, is let go', async () => {
    await openGroup()
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    await last(CHECK).fail()
    expect(sent.value).toEqual({ status: 'refused', reason: 'unreachable' })
    await act(async () => chat.forgetLost())
    await advance(5000)
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:03.000000', 'Hello')]))
    expect([ids(), chat.settled]).toEqual([['m'], null])
  })

  it('whose answer was lost is not let go while its own check is out', async () => {
    await openGroup()
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    await act(async () => chat.forgetLost())
    const newest = chat.newest
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:03.000000', 'Hello')]))
    expect([sent.value, ids(), chat.newest]).toEqual([{ status: 'sent' }, ['m'], newest + 1])
  })

  it('and is still looked for after a check of its own that did not bring it', async () => {
    await openGroup()
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    await act(async () => chat.forgetLost())
    await last(CHECK).answer(200, chatChanges())
    expect([sent.value, chat.settled]).toEqual([{ status: 'refused', reason: 'unreachable' }, null])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:03.000000', 'Hello')]))
    expect([ids(), chat.settled]).toEqual([['m'], { words: 'Hello' }])
  })

  it('whose answer was lost waits for a check that started after it', async () => {
    await openGroup()
    await advance(2000)
    const before = last(CHECK)
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').fail()
    expect(checks()).toHaveLength(1)
    await before.answer(200, chatChanges())
    expect([checks().length, sent.value]).toEqual([2, null])
    await last(CHECK).answer(200, chatChanges([mine('m', '15:00:03.000000', 'Hello')]))
    expect(sent.value).toEqual({ status: 'sent' })
  })

  it('while the chat is read afresh stays in the list', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').answer(201, mine('m', '15:00:01.000000', 'Hello'))
    expect(sent.value).toEqual({ status: 'sent' })
    await last(FRESH).answer(200, chatPage([at('z', '15:00:00.000000')]))
    expect(ids()).toEqual(['z', 'm'])
  })
})

describe('deleting and removing', () => {
  const REMOVE = /^\/messages\/a\/remove$/

  it('takes the message out at once for someone who does not run the chat', async () => {
    await openGroup(chatPage([mine('a', '14:00:01.000000', 'x'), at('b', '14:00:02.000000')]))
    const result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(204)
    expect([result.value, ids(), checks().length]).toEqual(['gone', ['b'], 0])
  })

  it('checks at once for someone who runs it, and the message stays until that lands', async () => {
    const item = at('a', '14:00:01.000000')
    await openGroup(chatPage([item], { may_moderate: true }))
    const result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(204)
    expect([result.value, checks().length]).toEqual(['gone', 1])
    expect(chat.entries[0].removed).toBeNull()
    await last(CHECK).answer(
      200,
      chatChanges([heldItem(item, { by_self: true })], { may_moderate: true }),
    )
    expect(chat.entries[0].removed).not.toBeNull()
  })

  it('checks straight after the one in flight', async () => {
    const item = at('a', '14:00:01.000000')
    await openGroup(chatPage([item], { may_moderate: true }))
    await advance(2000)
    const flying = last(CHECK)
    await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(204)
    expect(checks()).toHaveLength(1)
    await flying.answer(200, chatChanges([], { may_moderate: true }))
    expect(checks()).toHaveLength(2)
  })

  it('lands a message someone had already removed the same way, and a 404 takes it out', async () => {
    const item = at('a', '14:00:01.000000')
    await openGroup(chatPage([item], { may_moderate: true }))
    let result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(409, { detail: { code: 'already_removed' } })
    expect([result.value, checks().length]).toEqual(['gone', 1])
    await last(CHECK).answer(200, chatChanges([], { may_moderate: true }))
    result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(404, {})
    expect([result.value, ids(), checks().length]).toEqual(['gone', [], 1])
  })

  it('says what failed and changes nothing', async () => {
    await openGroup(chatPage([mine('a', '14:00:01.000000', 'x')]))
    let result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').answer(500, {})
    expect([result.value, ids()]).toEqual(['refused', ['a']])
    result = await start<RemoveResult>(() => chat.remove('a'))
    await last(REMOVE, 'POST').fail()
    expect([result.value, ids()]).toEqual(['unreachable', ['a']])
  })
})

describe('what arrived', () => {
  it('is what a check brought from other people, and each once', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    expect(chat.arrived).toBeNull()
    await advance(2000)
    const joined = chatItem('j', {
      kind: 'joined',
      body: null,
      created_at: '2026-11-24T15:00:02.000000+00:00',
    })
    const brought = [at('b', '15:00:01.000000'), joined, mine('m', '15:00:03.000000', 'Mine')]
    await last(CHECK).answer(
      200,
      chatChanges([...brought, heldItem(at('h', '15:00:04.000000'))]),
    )
    expect(chat.arrived).toEqual({ batch: 1, items: [brought[0], joined] })
    await advance(2000)
    await last(CHECK).answer(200, chatChanges(brought))
    expect(chat.arrived?.batch).toBe(1)
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([...brought, at('c', '15:00:05.000000')]))
    expect(chat.arrived).toEqual({ batch: 2, items: [at('c', '15:00:05.000000')] })
  })

  it('is never an entry this build cannot draw', async () => {
    await openGroup()
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([chatItem('n', { kind: 'photos_added', body: null })]))
    expect(chat.arrived).toBeNull()
  })
})

// --- the second pair (CK-105; THE DESIGN §1 to §3, §5, §6, §7, §9 to §11 of its
// kickoff, approved by Steven on 2026-11-26) -----------------------------------

const AFTER = /\/chat\?after=/
const NEWEST = /^\/groups\/g-1\/chat$/
const MARK = /\/chat\/read$/
const marks = () => asked.filter((call) => call.method === 'PUT' && MARK.test(call.path))
const T = (time: string) => `2026-11-24T${time}+00:00`

describe('the second pair: opening', () => {
  it('opens at the first unread, with the line and the page below it', async () => {
    await openGroup(
      chatPage([at('a', '14:00:01.000000'), at('b', '14:00:02.000000'), at('c', '14:00:03.000000')], {
        first_unread: 'b',
        unread: 2,
        newer: 'n1',
      }),
    )
    expect(chat.line).toEqual({ created_at: T('14:00:02.000000'), id: 'b' })
    expect([chat.newer, chat.opened]).toEqual([true, 1])
  })

  it('opens at the newest with no line where nothing is unread, a count beside it or not', async () => {
    for (const over of [{ first_unread: null, unread: 3 }, { first_unread: null, unread: 0 }, {}]) {
      asked = []
      await openGroup(chatPage([at('a', '14:00:01.000000')], over))
      expect([chat.line, chat.newer]).toEqual([null, false])
      view.unmount()
    }
  })

  it('reads on below one page at a time, from each page’s own cursor', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { first_unread: 'a', unread: 1, newer: 'n1' }))
    await act(async () => chat.showLater())
    await act(async () => chat.showLater())
    expect(chat.later).toBe('loading')
    expect(waitingFor(AFTER).map((call) => call.path)).toEqual(['/groups/g-1/chat?after=n1'])
    await last(AFTER).answer(200, { items: [at('b', '14:00:02.000000')], newer: 'n2', as_of: T('15:59:59.000000'), may_moderate: false })
    expect([ids(), chat.newer, chat.later]).toEqual([['a', 'b'], true, 'idle'])
    await act(async () => chat.showLater())
    expect(last(AFTER).path).toBe('/groups/g-1/chat?after=n2')
    await last(AFTER).answer(200, { items: [at('c', '14:00:03.000000')], newer: null, as_of: T('15:59:59.000000'), may_moderate: false })
    expect([ids(), chat.newer]).toEqual([['a', 'b', 'c'], false])
    await act(async () => chat.showLater())
    expect(waitingFor(AFTER)).toEqual([])
    // An after page's instant is never what the next check goes on from.
    await advance(2000)
    expect(sinceOf(checks()[0])).toBe(AS_OF)
  })

  it('says a later page failed, and asks for it again', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    await act(async () => chat.showLater())
    await last(AFTER).answer(500, {})
    expect([chat.later, chat.newer, ids()]).toEqual(['failed', true, ['a']])
    await act(async () => chat.showLater())
    await last(AFTER).answer(200, { items: [at('b', '14:00:02.000000')], newer: null, as_of: AS_OF, may_moderate: false })
    expect([chat.later, ids()]).toEqual(['idle', ['a', 'b']])
  })

  it('is not there for a 404 on a later page', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    await act(async () => chat.showLater())
    await last(AFTER).answer(404, {})
    expect([chat.status, ids()]).toEqual(['notFound', []])
  })

  it('never joins a later page asked for before the list was read afresh', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    await act(async () => chat.showLater())
    const late = last(AFTER)
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    await last(FRESH).answer(200, chatPage([at('z', '15:00:02.000000')]))
    await late.answer(200, { items: [at('b', '14:00:02.000000')], newer: null, as_of: AS_OF, may_moderate: false })
    expect([ids(), chat.later, chat.opened]).toEqual([['z'], 'idle', 2])
  })
})

describe('the second pair: the check', () => {
  it('carries its instant in X-Chat-Since and nothing in the address', async () => {
    await openGroup(chatPage([], { as_of: '2026-11-24T15:00:00.111111+00:00' }))
    await advance(2000)
    expect(checks().map((call) => call.path)).toEqual(['/groups/g-1/chat since=2026-11-24T15:00:00.111111+00:00'])
  })

  it('adds nothing across a gap below, and still updates what is loaded', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([at('z', '15:00:09.000000'), at('a', '14:00:01.000000', { body: 'New words' })]))
    expect(ids()).toEqual(['a'])
    expect(chat.entries[0].body).toBe('New words')
    expect(chat.arrived).toBeNull()
  })

  it('lets a held row go at the check whose instant is thirty days past its removal', async () => {
    const gone = heldItem(at('h', '14:00:01.000000'), { at: '2026-11-24T14:30:00.000000+00:00' })
    await openGroup(chatPage([gone, at('a', '14:00:02.000000')], { may_moderate: true }))
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { may_moderate: true, as_of: '2026-12-24T14:29:59.999999+00:00' }))
    expect(ids()).toEqual(['h', 'a'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { may_moderate: true, as_of: '2026-12-24T14:30:00.000000+00:00' }))
    expect(ids()).toEqual(['a'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([gone], { may_moderate: true, as_of: '2026-12-24T14:30:02.000000+00:00' }))
    expect(ids()).toEqual(['a'])
  })
})

describe('the second pair: typing, sent', () => {
  it('is on a check while the box holds words changed in the last four seconds', async () => {
    expect(TYPING_FRESH_MS).toBe(4000)
    await openGroup()
    await act(async () => chat.typed('Hel'))
    await advance(2000)
    expect(last(CHECK).path).toMatch(/ typing=1$/)
    await last(CHECK).answer(200, chatChanges())
    await advance(2000)
    expect(last(CHECK).path).not.toMatch(/typing/)
    await last(CHECK).answer(200, chatChanges())
    await act(async () => chat.typed('Hello'))
    await advance(2000)
    expect(last(CHECK).path).toMatch(/ typing=1$/)
    await last(CHECK).answer(200, chatChanges())
    await act(async () => chat.typed('   '))
    await advance(2000)
    expect(last(CHECK).path).not.toMatch(/typing/)
  })

  it('stops with a send that landed, until the next change', async () => {
    await openGroup()
    await act(async () => chat.typed('Hi'))
    const sent = await start<SendResult>(() => chat.send('Hi'))
    await last(/chat$/, 'POST').answer(201, mine('m', '15:00:01.000000', 'Hi'))
    expect(sent.value).toEqual({ status: 'sent' })
    await advance(2000)
    expect(last(CHECK).path).not.toMatch(/typing/)
    await last(CHECK).answer(200, chatChanges())
    await act(async () => chat.typed('Next'))
    await advance(2000)
    expect(last(CHECK).path).toMatch(/ typing=1$/)
  })

  it('is never on another read', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { older: 'c', newer: 'n1' }))
    await act(async () => chat.typed('Words'))
    await act(async () => chat.showEarlier())
    await act(async () => chat.showLater())
    expect(last(EARLIER).path).toBe('/groups/g-1/chat?before=c')
    expect(last(AFTER).path).toBe('/groups/g-1/chat?after=n1')
    await act(async () => void chat.goToNewest())
    expect(waitingFor(NEWEST)).toHaveLength(1)
    // From here: StrictMode's first mount left its own open read unanswered.
    const from = asked.length
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { truncated: true }))
    expect(asked.slice(from).filter((call) => !call.settled && FRESH.test(call.path))).toHaveLength(1)
  })
})

describe('the second pair: typing, shown', () => {
  it('is the check’s names, each kept in its place while it stays', async () => {
    await openGroup()
    expect(chat.typing).toEqual([])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { typing: ['Kelly Brandt', 'Leo Brandt'] }))
    expect(chat.typing).toEqual(['Kelly Brandt', 'Leo Brandt'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { typing: ['Leo Brandt', 'Kelly Brandt'] }))
    expect(chat.typing).toEqual(['Kelly Brandt', 'Leo Brandt'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([at('b', '15:00:01.000000')], { typing: ['Ray Brandt', 'Leo Brandt'] }))
    expect(chat.typing).toEqual(['Leo Brandt', 'Ray Brandt'])
    await advance(2000)
    await last(CHECK).answer(200, chatChanges())
    expect(chat.typing).toEqual([])
  })

  it('goes with a failed check and a hidden tab', async () => {
    await openGroup()
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([], { typing: ['Kelly Brandt'] }))
    await advance(2000)
    await last(CHECK).answer(500, {})
    expect(chat.typing).toEqual([])
    await advance(5000)
    await last(CHECK).answer(200, chatChanges([], { typing: ['Kelly Brandt'] }))
    expect(chat.typing).toEqual(['Kelly Brandt'])
    await setHidden(true)
    expect(chat.typing).toEqual([])
  })
})

describe('the second pair: the mark', () => {
  const three = () => chatPage([at('a', '14:00:01.000000'), at('b', '14:00:02.000000'), at('c', '14:00:03.000000')])

  it('sends the newest entry seen, only when it is later than the last one sent, and nothing on opening', async () => {
    expect(MARK_GAP_MS).toBe(1000)
    await openGroup(three())
    await advance(5000)
    expect(marks()).toEqual([])
    await act(async () => chat.markSeen('b'))
    expect(marks().map((call) => [call.path, call.body])).toEqual([['/groups/g-1/chat/read', { through: 'b' }]])
    await marks()[0].answer(204)
    await advance(1000)
    await act(async () => chat.markSeen('a'))
    await act(async () => chat.markSeen('b'))
    expect(marks()).toHaveLength(1)
    await act(async () => chat.markSeen('c'))
    expect(marks().map((call) => call.body)).toEqual([{ through: 'b' }, { through: 'c' }])
  })

  it('is sent at most once a second, and never two at once', async () => {
    await openGroup(three())
    await act(async () => chat.markSeen('a'))
    await act(async () => chat.markSeen('b'))
    expect(marks()).toHaveLength(1)
    await advance(3000)
    expect(marks()).toHaveLength(1)
    await marks()[0].answer(204)
    // More than a second since the last went: the one owed goes at once.
    expect(marks().map((call) => call.body)).toEqual([{ through: 'a' }, { through: 'b' }])
    await marks()[1].answer(204)
    await act(async () => chat.markSeen('c'))
    expect(marks()).toHaveLength(2)
    await advance(999)
    expect(marks()).toHaveLength(2)
    await advance(1)
    expect(marks().map((call) => call.body)).toEqual([{ through: 'a' }, { through: 'b' }, { through: 'c' }])
  })

  it('drops a failed mark, and sends again for the next entry seen', async () => {
    await openGroup(three())
    await act(async () => chat.markSeen('a'))
    await marks()[0].fail()
    await advance(5000)
    await act(async () => chat.markSeen('a'))
    expect(marks()).toHaveLength(1)
    await act(async () => chat.markSeen('b'))
    expect(marks().map((call) => call.body)).toEqual([{ through: 'a' }, { through: 'b' }])
  })

  it('sends nothing for what is seen while the tab is hidden', async () => {
    await openGroup(three())
    await setHidden(true)
    await act(async () => chat.markSeen('c'))
    await advance(5000)
    await setHidden(false)
    await advance(5000)
    expect(marks()).toEqual([])
  })

  it('sends one still owed with keepalive as the page goes, and nothing where none is owed', async () => {
    await openGroup(three())
    await act(async () => chat.markSeen('a'))
    await marks()[0].answer(204)
    await act(async () => chat.markSeen('b'))
    expect(marks()).toHaveLength(1)
    view.unmount()
    expect(marks().map((call) => [call.body, call.keepalive])).toEqual([
      [{ through: 'a' }, false],
      [{ through: 'b' }, true],
    ])
    asked = []
    await openGroup(three())
    await act(async () => chat.markSeen('a'))
    await marks()[0].answer(204)
    view.unmount()
    expect(marks()).toHaveLength(1)
  })

  it('counts what stands above the line as read already', async () => {
    await openGroup(chatPage(three().items, { first_unread: 'c', unread: 1 }))
    await act(async () => chat.markSeen('b'))
    expect(marks()).toEqual([])
    await act(async () => chat.markSeen('c'))
    expect(marks().map((call) => call.body)).toEqual([{ through: 'c' }])
  })

  it('takes the open chat out of the dot once its newest is marked and nothing newer is left', async () => {
    askChatsNew()
    await last(/^\/chats\/new$/).answer(200, { groups: ['g-1'], gatherings: [] })
    await openGroup(chatPage([at('a', '14:00:01.000000')], { first_unread: 'a', unread: 2, newer: 'n1' }))
    await act(async () => chat.markSeen('a'))
    await marks()[0].answer(204)
    expect(isNew(chatsNewNow(), GROUP)).toBe(true)
    await act(async () => chat.showLater())
    await last(AFTER).answer(200, { items: [at('b', '14:00:02.000000')], newer: null, as_of: AS_OF, may_moderate: false })
    await advance(1000)
    await act(async () => chat.markSeen('b'))
    expect(isNew(chatsNewNow(), GROUP)).toBe(true)
    await marks()[1].answer(204)
    expect(isNew(chatsNewNow(), GROUP)).toBe(false)
  })
})

describe('the second pair: reactions', () => {
  const REACT = /^\/messages\/a\/reactions$/
  const heart = (count: number, mine_: boolean) => [{ kind: 'heart' as const, count, mine: mine_ }]

  it('leaves one, and the answer’s reactions replace the message’s', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000', { reactions: [] })]))
    const result = await start<ReactResult>(() => chat.react('a', 'heart', true))
    const put = last(REACT, 'PUT')
    expect(put.body).toEqual({ kind: 'heart', on: true })
    await put.answer(200, { reactions: heart(1, true) })
    expect(result.value).toBe('ok')
    expect(chat.entries[0].reactions).toEqual(heart(1, true))
  })

  it('is not undone by a check that began before its answer landed', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000', { reactions: heart(1, false) })]))
    await advance(2000)
    const before = last(CHECK)
    await start<ReactResult>(() => chat.react('a', 'heart', true))
    await last(REACT, 'PUT').answer(200, { reactions: heart(2, true) })
    await before.answer(200, chatChanges([at('a', '14:00:01.000000', { body: 'Merged', reactions: heart(1, false) })]))
    expect(chat.entries[0].reactions).toEqual(heart(2, true))
    expect(chat.entries[0].body).toBe('Merged')
    await advance(2000)
    await last(CHECK).answer(200, chatChanges([at('a', '14:00:01.000000', { reactions: heart(3, true) })]))
    expect(chat.entries[0].reactions).toEqual(heart(3, true))
  })

  it('checks at once where the message has gone', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000', { reactions: [] })]))
    const result = await start<ReactResult>(() => chat.react('a', 'like', true))
    await last(REACT, 'PUT').answer(404, {})
    expect([result.value, checks().length]).toEqual(['notFound', 1])
  })

  it('says what failed and changes nothing', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000', { reactions: heart(1, true) })]))
    let result = await start<ReactResult>(() => chat.react('a', 'heart', false))
    await last(REACT, 'PUT').answer(409, { detail: { code: 'not_a_message' } })
    expect([result.value, chat.entries[0].reactions]).toEqual(['refused', heart(1, true)])
    result = await start<ReactResult>(() => chat.react('a', 'heart', false))
    await last(REACT, 'PUT').fail()
    expect([result.value, chat.entries[0].reactions]).toEqual(['unreachable', heart(1, true)])
  })
})

describe('the second pair: the button to the newest', () => {
  it('goes to the foot of what is loaded where nothing is newer, asking nothing', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    const before = [chat.toNewest, asked.length]
    let result: string | null = null
    await act(async () => void chat.goToNewest().then((value) => (result = value)))
    expect([result, chat.toNewest, asked.length]).toEqual(['ok', before[0] + 1, before[1]])
  })

  it('reads the newest page first across a gap, in place of the list and with no line', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000'), at('b', '14:00:02.000000')], { first_unread: 'b', unread: 9, newer: 'n1' }))
    const before = chat.toNewest
    let result: string | null = null
    await act(async () => void chat.goToNewest().then((value) => (result = value)))
    expect(chat.toNewest).toBe(before)
    await last(NEWEST).answer(200, chatPage([at('y', '15:00:01.000000'), at('z', '15:00:02.000000')], { older: 'c' }))
    expect([result, ids(), chat.newer, chat.line, chat.toNewest, chat.older]).toEqual(['ok', ['y', 'z'], false, null, before + 1, true])
  })

  it('stays where it is when the newest page could not be read, and is not there for a 404', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    let result: string | null = null
    await act(async () => void chat.goToNewest().then((value) => (result = value)))
    await last(NEWEST).answer(500, {})
    expect([result, ids(), chat.newer]).toEqual(['failed', ['a'], true])
    await act(async () => void chat.goToNewest().then((value) => (result = value)))
    await last(NEWEST).answer(404, {})
    expect([result, chat.status]).toEqual(['over', 'notFound'])
  })
})

describe('the second pair: sending', () => {
  it('names the message it sent, so its top can be brought into view', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')]))
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').answer(201, mine('m', '15:00:01.000000', 'Hello'))
    expect([sent.value, chat.sent]).toEqual([{ status: 'sent' }, 'm'])
  })

  it('reads the newest page before its message is shown, where a gap is below', async () => {
    await openGroup(chatPage([at('a', '14:00:01.000000')], { newer: 'n1' }))
    const newest = chat.newest
    const sent = await start<SendResult>(() => chat.send('Hello'))
    await last(/chat$/, 'POST').answer(201, mine('m', '15:00:01.000000', 'Hello'))
    expect(sent.value).toEqual({ status: 'sent' })
    expect([ids(), chat.newest]).toEqual([['a'], newest])
    await last(NEWEST).answer(200, chatPage([at('x', '15:00:00.000000'), mine('m', '15:00:01.000000', 'Hello')]))
    expect([ids(), chat.newer, chat.sent, chat.newest]).toEqual([['x', 'm'], false, 'm', newest + 1])
  })
})
