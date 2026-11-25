// A chat, read and kept current (CK-103; THE DESIGN §4, §6, §7 and §9 of its
// kickoff): the first read by kind, the check's pace, what stops and starts
// it, `since` from the server's clock alone, the fresh first read, the four
// 404s, a late answer for another place, an id that left never back, the
// setting line's one re-read, the lost answer and what a screen reader is
// told. Fake timers, under StrictMode, every answer given by hand.
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatPlace } from '../lib/chat'
import { clearToken, setToken } from '../lib/session'
import { chatChanges, chatItem, chatPage, heldItem, pathOf } from '../test-support/chat'
import { useChat, type Chat, type RemoveResult, type SendResult } from './useChat'

const GROUP: ChatPlace = { kind: 'group', id: 'g-1' }
const OTHER: ChatPlace = { kind: 'group', id: 'g-2' }
const GATHERING: ChatPlace = { kind: 'gathering', id: 'x-1' }
const NOW = Date.parse('2026-11-24T15:00:00Z')

interface Asked {
  method: string
  path: string
  body: unknown
  at: number
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
      const call: Asked = {
        method: init.method ?? 'GET',
        path: pathOf(input),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        at: Date.now(),
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
const checks = () => asked.filter((call) => /chat\?since=/.test(call.path))
const CHECK = /\/chat\?since=/
const FRESH = /\/chat$/
const EARLIER = /\/chat\?before=/
const sinceOf = (call: Asked) => new URLSearchParams(call.path.split('?')[1]).get('since')

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
  await last(new RegExp(`^/groups/${id}/chat$`)).answer(200, page)
}

async function openGathering(page = chatPage([]), body = gathering()) {
  open(GATHERING)
  await last(/^\/gatherings\/x-1$/).answer(200, body)
  await last(/^\/gatherings\/x-1\/chat$/).answer(200, page)
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
    expect(waitingFor(/^\/groups\/g-1\/chat$/).length).toBeGreaterThan(0)
    await last(/^\/groups\/g-1$/).answer(200, group())
    expect(chat.status).toBe('loading')
    await last(/^\/groups\/g-1\/chat$/).answer(
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
    await last(/^\/gatherings\/x-1\/chat$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
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
    await last(/^\/groups\/g-1\/chat$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
    expect([chat.status, ids()]).toEqual(['notFound', []])
    view.unmount()

    open(GROUP)
    await last(/^\/groups\/g-1$/).answer(200, group())
    await last(/^\/groups\/g-1\/chat$/).answer(404, {})
    expect(chat.status).toBe('notFound')
    view.unmount()

    open(GROUP)
    await last(/^\/groups\/g-1$/).answer(500, {})
    await last(/^\/groups\/g-1\/chat$/).answer(200, chatPage([]))
    expect(chat.status).toBe('failed')
    await act(async () => chat.retry())
    expect(chat.status).toBe('loading')
    await last(/^\/groups\/g-1$/).answer(200, group())
    await last(/^\/groups\/g-1\/chat$/).answer(200, chatPage([at('a', '14:00:01.000000')]))
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
    await last(/^\/groups\/g-2\/chat$/).answer(200, chatPage([at('z', '14:00:09.000000')]))
    expect([chat.status, ids()]).toEqual(['loaded', ['z']])
  })

  it('ignores a first read that lands after the move', async () => {
    open(GROUP)
    const first = [last(/^\/groups\/g-1$/), last(/^\/groups\/g-1\/chat$/)]
    place = OTHER
    view.rerender(tree())
    await last(/^\/groups\/g-2$/).answer(200, group('g-2', 'Finch'))
    await last(/^\/groups\/g-2\/chat$/).answer(200, chatPage([at('z', '14:00:09.000000')]))
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
