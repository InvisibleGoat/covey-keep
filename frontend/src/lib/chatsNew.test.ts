// The dot's store (CK-105; THE DESIGN §6 and §8 of its kickoff, approved by
// Steven on 2026-11-26): the last answer of GET /chats/new, read with the
// menu's reads, at once on the tab's return and every 60 s while the tab is
// visible, never while it is hidden and never twice at once; emptied when the
// session changes; and an open chat's own clear that a stale read can't undo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToken, setToken } from './session'
import { askChatsNew, CHATS_NEW_MS, chatsNewNow, clearOpenChat, isNew, startChatsNew } from './chatsNew'

type Pending = { path: string; resolve: (answer: { status: number; body?: unknown } | Error) => void }

let pending: Pending[] = []
let hidden = false

function stubFetch() {
  pending = []
  vi.stubGlobal('fetch', (input: string) => {
    const url = new URL(input)
    return new Promise<Response>((resolve, reject) => {
      pending.push({
        path: `${url.pathname}${url.search}`,
        resolve: (answer) => {
          if (answer instanceof Error) reject(answer)
          else resolve(new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }))
        },
      })
    })
  })
}

async function answer(body: unknown, status = 200) {
  const next = pending.shift()
  if (next === undefined) throw new Error('nothing was asked')
  next.resolve({ status, body })
  await vi.advanceTimersByTimeAsync(0)
}

function setHidden(value: boolean) {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}

const G1 = { kind: 'group', id: 'g-1' } as const
const G2 = { kind: 'group', id: 'g-2' } as const
const X1 = { kind: 'gathering', id: 'x-1' } as const

let stop: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  stubFetch()
  setToken('session-a')
})

afterEach(() => {
  stop?.()
  stop = null
  clearToken()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the read', () => {
  it('asks GET /chats/new and holds each kind of chat by its id', async () => {
    askChatsNew()
    expect(pending.map((call) => call.path)).toEqual(['/chats/new'])
    await answer({ groups: ['g-1'], gatherings: ['x-1'] })
    const now = chatsNewNow()
    expect([isNew(now, G1), isNew(now, G2), isNew(now, X1)]).toEqual([true, false, true])
    expect(isNew(now, { kind: 'gathering', id: 'g-1' })).toBe(false)
  })

  it('never asks twice at once: a second ask waits for the first and is made once after it', async () => {
    askChatsNew()
    askChatsNew()
    askChatsNew()
    expect(pending).toHaveLength(1)
    await answer({ groups: [], gatherings: [] })
    expect(pending).toHaveLength(1)
    await answer({ groups: ['g-1'], gatherings: [] })
    expect(pending).toHaveLength(0)
    expect(isNew(chatsNewNow(), G1)).toBe(true)
  })

  it('keeps what it had when a read fails, and reads a wrong shape as nothing new', async () => {
    askChatsNew()
    await answer({ groups: ['g-1'], gatherings: [] })
    askChatsNew()
    await answer({ detail: 'x' }, 500)
    expect(isNew(chatsNewNow(), G1)).toBe(true)
    askChatsNew()
    pending.shift()?.resolve(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(0)
    expect(isNew(chatsNewNow(), G1)).toBe(true)
    askChatsNew()
    await answer({ groups: 'g-1', gatherings: [3, 'x-1'] })
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), X1)]).toEqual([false, true])
  })
})

describe('the pace', () => {
  it('reads every 60 seconds while the tab is visible, counted from the last answer', async () => {
    expect(CHATS_NEW_MS).toBe(60_000)
    stop = startChatsNew()
    expect(pending).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(CHATS_NEW_MS - 1)
    expect(pending).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await answer({ groups: [], gatherings: [] })
    await vi.advanceTimersByTimeAsync(CHATS_NEW_MS - 1)
    expect(pending).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveLength(1)
  })

  it('a read the menu asks for starts the minute again', async () => {
    stop = startChatsNew()
    await vi.advanceTimersByTimeAsync(50_000)
    askChatsNew()
    await answer({ groups: [], gatherings: [] })
    await vi.advanceTimersByTimeAsync(CHATS_NEW_MS - 1)
    expect(pending).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveLength(1)
  })

  it('reads nothing while the tab is hidden, and at once on its return', async () => {
    stop = startChatsNew()
    setHidden(true)
    await vi.advanceTimersByTimeAsync(CHATS_NEW_MS * 3)
    askChatsNew()
    expect(pending).toHaveLength(0)
    setHidden(false)
    expect(pending.map((call) => call.path)).toEqual(['/chats/new'])
  })

  it('a return while a read is out asks once more after it, never two at once', async () => {
    stop = startChatsNew()
    askChatsNew()
    setHidden(true)
    setHidden(false)
    expect(pending).toHaveLength(1)
    await answer({ groups: [], gatherings: [] })
    expect(pending).toHaveLength(1)
  })

  it('stops with its frame: no timer and no listener left', async () => {
    stop = startChatsNew()
    stop()
    stop = null
    await vi.advanceTimersByTimeAsync(CHATS_NEW_MS * 3)
    setHidden(true)
    setHidden(false)
    expect(pending).toHaveLength(0)
  })
})

describe('the session and the open chat', () => {
  it('is emptied when the session changes, and an answer begun before it is ignored', async () => {
    askChatsNew()
    await answer({ groups: ['g-1'], gatherings: ['x-1'] })
    askChatsNew()
    clearToken()
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), X1)]).toEqual([false, false])
    setToken('session-b')
    askChatsNew()
    expect(pending).toHaveLength(2)
    // The newer session's answer lands first; the older one's, late, is ignored.
    pending[1].resolve({ status: 200, body: { groups: ['g-2'], gatherings: [] } })
    await vi.advanceTimersByTimeAsync(0)
    pending[0].resolve({ status: 200, body: { groups: ['g-1'], gatherings: ['x-1'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), G2), isNew(chatsNewNow(), X1)]).toEqual([false, true, false])
  })

  it('takes the open chat out at once, and a read begun before that never puts it back', async () => {
    askChatsNew()
    await answer({ groups: ['g-1', 'g-2'], gatherings: [] })
    askChatsNew()
    clearOpenChat(G1)
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), G2)]).toEqual([false, true])
    await answer({ groups: ['g-1', 'g-2'], gatherings: [] })
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), G2)]).toEqual([false, true])
    // A read begun after it is the server's word again.
    askChatsNew()
    await answer({ groups: ['g-1'], gatherings: [] })
    expect([isNew(chatsNewNow(), G1), isNew(chatsNewNow(), G2)]).toEqual([true, false])
  })

  it('holds nothing on the device', async () => {
    const before = { ...localStorage }
    const session = { ...sessionStorage }
    askChatsNew()
    await answer({ groups: ['g-1'], gatherings: ['x-1'] })
    clearOpenChat(G1)
    expect({ ...localStorage }).toEqual(before)
    expect({ ...sessionStorage }).toEqual(session)
  })
})
