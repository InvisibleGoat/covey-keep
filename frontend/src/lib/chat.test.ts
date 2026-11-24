// The chat's merge, words, days and links (CK-103; THE DESIGN §4 to §8 and THE
// WORDS of its kickoff, approved by Steven on 2026-11-24). Every line is a
// literal here, from every seat that reads it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearToken, setToken } from './session'
import {
  backTo,
  canDraw,
  CHAT_FAILED,
  CHAT_POLL_MS,
  CHAT_RETRY_MS,
  checkChat,
  CHECKS_FAILING,
  compareEntries,
  dayLine,
  daysLeftWords,
  DELETE,
  DELETE_SENTENCE,
  DELETE_YOUR_MESSAGE,
  EARLIER_FAILED,
  EMPTY_CHAT,
  entriesOf,
  GATHERING_NOTICE,
  gatheringChatLine,
  groupChatLine,
  groupNotice,
  heldWords,
  HIDE_IT,
  KEEP_IT,
  lineWords,
  linkPieces,
  mergeChat,
  messageLabel,
  MESSAGES,
  NO_CHAT_HERE,
  NO_MESSAGES,
  NOTHING_HERE,
  newMessages,
  ONLY_MEMBERS,
  OPEN_CHAT,
  PREVIEW_FAILED,
  previewTime,
  readEarlier,
  readNewest,
  REMOVE,
  removeLabel,
  removeLine,
  removeMessage,
  removeSentence,
  SEND,
  sendLine,
  sendMessage,
  SHOW_EARLIER,
  SHOW_IT,
  spoken,
  type ChatItem,
  type ChatList,
} from './chat'

const GROUP = { kind: 'group', id: 'group-1' } as const
const GATHERING = { kind: 'gathering', id: 'gathering-1' } as const

let made = 0
function message(id: string, overrides: Partial<ChatItem> = {}): ChatItem {
  made += 1
  return {
    id,
    kind: 'message',
    created_at: '2026-11-24T15:00:00.000000+00:00',
    author: { display_name: 'Leo Brandt', is_self: false },
    body: `Words ${made}`,
    removed: null,
    ...overrides,
  }
}

function held(item: ChatItem, removed: Partial<NonNullable<ChatItem['removed']>> = {}): ChatItem {
  return {
    ...item,
    removed: { at: '2026-11-24T16:00:00+00:00', by: 'Ann Mercer', by_writer: false, by_self: false, ...removed },
  }
}

function at(id: string, instant: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return message(id, { created_at: instant, ...overrides })
}

function first(items: ChatItem[], older: string | null = null): ChatList {
  return mergeChat(EMPTY_CHAT, { type: 'first', items, older })
}

const ids = (list: ChatList) => entriesOf(list).map((item) => item.id)

afterEach(() => {
  vi.unstubAllGlobals()
  clearToken()
})

describe('the order', () => {
  it('is by the microsecond, where the millisecond is the same', () => {
    const list = first([
      at('late', '2026-11-24T15:00:00.000900+00:00'),
      at('early', '2026-11-24T15:00:00.000100+00:00'),
      at('middle', '2026-11-24T15:00:00.000500+00:00'),
    ])
    expect(ids(list)).toEqual(['early', 'middle', 'late'])
  })

  it('puts a whole second, written with no fraction, before every fraction of it', () => {
    const list = first([
      at('half', '2026-11-24T15:00:00.500000Z'),
      at('whole', '2026-11-24T15:00:00Z'),
      at('next', '2026-11-24T15:00:01Z'),
      at('before', '2026-11-24T14:59:59.999999Z'),
    ])
    expect(ids(list)).toEqual(['before', 'whole', 'half', 'next'])
  })

  it('is the instant and not the text, whatever offset it is written with', () => {
    const list = first([
      at('second', '2026-11-24T10:00:01.000000-05:00'),
      at('first', '2026-11-24T15:00:00.000000+00:00'),
      at('third', '2026-11-24T15:00:02Z'),
    ])
    expect(ids(list)).toEqual(['first', 'second', 'third'])
  })

  it('is the id, at one instant', () => {
    const instant = '2026-11-24T15:00:00.123456Z'
    expect(ids(first([at('c', instant), at('a', instant), at('b', instant)]))).toEqual(['a', 'b', 'c'])
    expect(compareEntries(at('a', instant), at('a', instant))).toBe(0)
  })
})

describe('the merge', () => {
  it('adds what a check brings, in its place, and changes nothing it is given', () => {
    const list = first([at('b', '2026-11-24T15:00:02Z')])
    const before = ids(list)
    const next = mergeChat(list, {
      type: 'check',
      items: [at('c', '2026-11-24T15:00:03Z'), at('a', '2026-11-24T15:00:01Z')],
      removed: [],
    })
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(ids(list)).toEqual(before)
  })

  it('takes out an id the check says has left, and no later check brings it back', () => {
    const gone = at('gone', '2026-11-24T15:00:01Z')
    const list = mergeChat(first([gone, at('kept', '2026-11-24T15:00:02Z')]), {
      type: 'check',
      items: [],
      removed: ['gone'],
    })
    expect(ids(list)).toEqual(['kept'])
    expect(ids(mergeChat(list, { type: 'check', items: [gone], removed: [] }))).toEqual(['kept'])
  })

  it('never brings a left id back from an earlier page, a send or a first read', () => {
    const gone = at('gone', '2026-11-24T15:00:01Z')
    const kept = at('kept', '2026-11-24T15:00:02Z')
    const list = mergeChat(first([gone, kept], 'cursor'), { type: 'left', id: 'gone' })
    expect(ids(mergeChat(list, { type: 'earlier', items: [gone], older: null }))).toEqual(['kept'])
    expect(ids(mergeChat(list, { type: 'sent', item: gone }))).toEqual(['kept'])
    expect(ids(mergeChat(list, { type: 'first', items: [gone, kept], older: null }))).toEqual(['kept'])
  })

  it('remembers an id that left before it was ever here', () => {
    const list = mergeChat(first([]), { type: 'check', items: [], removed: ['late'] })
    expect(ids(mergeChat(list, { type: 'sent', item: at('late', '2026-11-24T15:00:01Z') }))).toEqual([])
  })

  it('takes a held message in place of its live copy, and never the live copy back', () => {
    const live = at('a', '2026-11-24T15:00:01Z')
    const list = mergeChat(first([live], 'cursor'), { type: 'check', items: [held(live)], removed: [] })
    expect(entriesOf(list)[0].removed).not.toBeNull()
    for (const change of [
      { type: 'check', items: [live], removed: [] },
      { type: 'earlier', items: [live], older: null },
      { type: 'sent', item: live },
      { type: 'first', items: [live], older: null },
    ] as const) {
      expect(entriesOf(mergeChat(list, { ...change } as never))[0].removed).not.toBeNull()
    }
  })

  it('adds nothing older than the oldest loaded while there are earlier messages', () => {
    const list = first([at('b', '2026-11-24T15:00:02Z'), at('c', '2026-11-24T15:00:03Z')], 'cursor')
    const old = held(at('a', '2026-11-24T15:00:01Z'))
    expect(ids(mergeChat(list, { type: 'check', items: [old], removed: [] }))).toEqual(['b', 'c'])
    // It still updates one that is loaded, the oldest included.
    const oldest = held(entriesOf(list)[0])
    const updated = mergeChat(list, { type: 'check', items: [oldest], removed: [] })
    expect(entriesOf(updated)[0].removed).not.toBeNull()
  })

  it('adds one older than the oldest loaded where there is nothing earlier', () => {
    const list = first([at('b', '2026-11-24T15:00:02Z')], null)
    const late = at('a', '2026-11-24T15:00:01Z')
    expect(ids(mergeChat(list, { type: 'check', items: [late], removed: [] }))).toEqual(['a', 'b'])
  })

  it('keeps to the oldest page loaded after the oldest message in it has left', () => {
    const list = mergeChat(
      first([at('b', '2026-11-24T15:00:02Z'), at('d', '2026-11-24T15:00:04Z')], 'cursor'),
      { type: 'left', id: 'b' },
    )
    // Between the two: inside what was loaded, so it is added.
    expect(ids(mergeChat(list, { type: 'check', items: [at('c', '2026-11-24T15:00:03Z')], removed: [] }))).toEqual([
      'c',
      'd',
    ])
    expect(ids(mergeChat(list, { type: 'check', items: [at('a', '2026-11-24T15:00:01Z')], removed: [] }))).toEqual(['d'])
  })

  it('takes an earlier page above, and its cursor', () => {
    const list = first([at('c', '2026-11-24T15:00:03Z')], 'cursor-1')
    const next = mergeChat(list, {
      type: 'earlier',
      items: [at('a', '2026-11-24T15:00:01Z'), at('b', '2026-11-24T15:00:02Z')],
      older: 'cursor-2',
    })
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(next.older).toBe('cursor-2')
    // Something between a and c is inside what is loaded now.
    expect(ids(mergeChat(next, { type: 'check', items: [at('bb', '2026-11-24T15:00:02.5Z')], removed: [] }))).toEqual([
      'a',
      'b',
      'bb',
      'c',
    ])
    const last = mergeChat(next, { type: 'earlier', items: [], older: null })
    expect(last.older).toBeNull()
    expect(last.from).toBeNull()
  })

  it('puts a first read in place of the list', () => {
    const list = mergeChat(first([at('a', '2026-11-24T15:00:01Z'), at('b', '2026-11-24T15:00:02Z')]), {
      type: 'first',
      items: [at('y', '2026-11-24T16:00:01Z'), at('z', '2026-11-24T16:00:02Z')],
      older: 'cursor',
    })
    expect(ids(list)).toEqual(['y', 'z'])
    expect(list.older).toBe('cursor')
  })

  it('drops every held message when the caller stops running the chat, and lets none back', () => {
    const kept = at('kept', '2026-11-24T15:00:02Z')
    const gone = held(at('gone', '2026-11-24T15:00:01Z'))
    const list = mergeChat(first([gone, kept]), { type: 'heldGone' })
    expect(ids(list)).toEqual(['kept'])
    expect(ids(mergeChat(list, { type: 'check', items: [gone], removed: [] }))).toEqual(['kept'])
  })

  it('shows a message that left again, held, where the caller has come to run the chat', () => {
    const item = at('a', '2026-11-24T15:00:01Z')
    const list = mergeChat(first([item]), { type: 'check', items: [], removed: ['a'] })
    const asMember = mergeChat(list, { type: 'first', items: [held(item)], older: null })
    expect(ids(asMember)).toEqual([])
    const asOrganiser = mergeChat(list, { type: 'first', items: [held(item)], older: null, forgetLeft: true })
    expect(ids(asOrganiser)).toEqual(['a'])
  })
})

describe('the calls', () => {
  type Call = { path: string; method: string; body: unknown }

  function stub(answers: (call: Call) => { status: number; body?: unknown } | Error) {
    setToken('session-test')
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      const call = {
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      }
      calls.push(call)
      const answer = answers(call)
      if (answer instanceof Error) throw answer
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
    })
    return calls
  }

  const page = { items: [], older: null, as_of: '2026-11-24T15:00:00.123456+00:00', may_moderate: false }

  it('reads the newest, an earlier page and what changed, by kind, each value encoded', async () => {
    const calls = stub(() => ({ status: 200, body: page }))
    await readNewest(GROUP)
    await readNewest(GATHERING, 20)
    await readEarlier(GROUP, 'a+b/c=')
    await checkChat(GATHERING, '2026-11-24T15:00:00.123456+00:00')
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/groups/group-1/chat'],
      ['GET', '/gatherings/gathering-1/chat?limit=20'],
      ['GET', '/groups/group-1/chat?before=a%2Bb%2Fc%3D'],
      ['GET', '/gatherings/gathering-1/chat?since=2026-11-24T15%3A00%3A00.123456%2B00%3A00'],
    ])
  })

  it('answers not found for a 404, and for an id that names nothing on the first read alone', async () => {
    stub(() => ({ status: 404, body: { detail: 'Not found' } }))
    expect(await readNewest(GROUP)).toEqual({ status: 'notFound' })
    expect(await readEarlier(GROUP, 'c')).toEqual({ status: 'notFound' })
    expect(await checkChat(GROUP, 'c')).toEqual({ status: 'notFound' })
    stub(() => ({ status: 422, body: { detail: [] } }))
    expect(await readNewest(GROUP)).toEqual({ status: 'notFound' })
    expect(await readEarlier(GROUP, 'c')).toEqual({ status: 'failed' })
    expect(await checkChat(GROUP, 'c')).toEqual({ status: 'failed' })
    stub(() => new TypeError('Failed to fetch'))
    expect(await readNewest(GROUP)).toEqual({ status: 'failed' })
  })

  it('sends exactly the words in a body of one field', async () => {
    const item = message('m1')
    const calls = stub(() => ({ status: 201, body: item }))
    expect(await sendMessage(GROUP, 'Hello there')).toEqual({ status: 'sent', item })
    expect(calls).toEqual([{ path: '/groups/group-1/chat', method: 'POST', body: { body: 'Hello there' } }])
  })

  it('reads a refused send by its type or its code and never by its words', async () => {
    const answers: [number, unknown, string][] = [
      [422, [{ type: 'string_too_long', loc: ['body', 'body'], msg: 'x', ctx: { max_length: 4000 } }], 'too_long'],
      [422, [{ type: 'string_too_short', loc: ['body', 'body'], msg: 'string_too_long' }], 'other'],
      [422, 'string_too_long', 'other'],
      [429, { code: 'too_many_messages', message: 'x' }, 'too_many'],
      [429, { code: 'something_else', message: 'x' }, 'other'],
      [429, 'too_many_messages', 'other'],
      [400, 'x', 'other'],
      [500, 'x', 'other'],
    ]
    for (const [status, detail, reason] of answers) {
      stub(() => ({ status, body: { detail } }))
      expect(await sendMessage(GROUP, 'x')).toEqual({ status: 'refused', reason })
    }
    stub(() => ({ status: 500 }))
    expect(await sendMessage(GROUP, 'x')).toEqual({ status: 'refused', reason: 'other' })
    stub(() => ({ status: 404, body: {} }))
    expect(await sendMessage(GROUP, 'x')).toEqual({ status: 'notFound' })
    stub(() => new TypeError('Failed to fetch'))
    expect(await sendMessage(GROUP, 'x')).toEqual({ status: 'unreachable' })
  })

  it('removes by the message alone, and reads what came of it', async () => {
    const calls = stub(() => ({ status: 204 }))
    expect(await removeMessage('m1')).toBe('removed')
    expect(calls).toEqual([{ path: '/messages/m1/remove', method: 'POST', body: undefined }])
    const answers: [number, unknown, string][] = [
      [409, { code: 'already_removed', message: 'x' }, 'removed'],
      [409, { code: 'not_a_message', message: 'x' }, 'refused'],
      [409, 'already_removed', 'refused'],
      [404, 'x', 'notFound'],
      [500, 'x', 'refused'],
    ]
    for (const [status, detail, outcome] of answers) {
      stub(() => ({ status, body: { detail } }))
      expect(await removeMessage('m1')).toBe(outcome)
    }
    stub(() => new TypeError('Failed to fetch'))
    expect(await removeMessage('m1')).toBe('unreachable')
  })

  it('checks two seconds after an answer and five after a failure', () => {
    expect([CHAT_POLL_MS, CHAT_RETRY_MS]).toEqual([2000, 5000])
  })
})

describe('the words', () => {
  const line = (kind: string, name: string, self = false): ChatItem => ({
    id: 'l',
    kind,
    created_at: '2026-11-24T15:00:00Z',
    author: { display_name: name, is_self: self },
    body: null,
    removed: null,
  })

  it('says the approved words as they are', () => {
    expect([OPEN_CHAT, SEND, NO_MESSAGES, ONLY_MEMBERS, GATHERING_NOTICE]).toEqual([
      'Open chat',
      'Send',
      'No messages yet.',
      "Only the group's members",
      'Everyone invited to this gathering can read this chat.',
    ])
    expect(messageLabel('The Lees')).toBe('Message The Lees')
    expect(groupNotice('Mercer family')).toBe(
      "Only Mercer family's members can read this chat. People who join later see it from the day they join.",
    )
    expect(groupNotice('The Lees')).toBe(
      "Only The Lees' members can read this chat. People who join later see it from the day they join.",
    )
  })

  it('counts the people of a group and the invited of a gathering, and says Chat alone with no number', () => {
    expect([groupChatLine(9), groupChatLine(1), groupChatLine(0), groupChatLine(null), groupChatLine(undefined)]).toEqual([
      '9 people · Chat',
      '1 person · Chat',
      'Chat',
      'Chat',
      'Chat',
    ])
    expect([gatheringChatLine(7), gatheringChatLine(1), gatheringChatLine(0), gatheringChatLine(null), gatheringChatLine(undefined)]).toEqual([
      '7 invited · Chat',
      '1 invited · Chat',
      'Chat',
      'Chat',
      'Chat',
    ])
  })

  it('says the join line in full, yours, and a former member’s', () => {
    expect(lineWords(line('joined', 'Leo Brandt'), null)).toBe(
      'Leo Brandt joined the group. Leo Brandt sees the chat from today on.',
    )
    expect(lineWords(line('joined', 'Leo Brandt', true), null)).toBe(
      'You joined the group. You see the chat from today on.',
    )
    expect(lineWords(line('joined', 'a former member'), null)).toBe('A former member joined the group.')
  })

  it('says the two setting lines, yours, and a former member’s', () => {
    const on = 'outside_invitations_on'
    const off = 'outside_invitations_off'
    expect(lineWords(line(on, 'Leo Brandt'), 'The Lees')).toBe('Leo Brandt opened this gathering to people outside The Lees.')
    expect(lineWords(line(off, 'Leo Brandt'), 'The Lees')).toBe('Leo Brandt closed this gathering to people outside The Lees.')
    expect(lineWords(line(on, 'Leo Brandt', true), 'The Lees')).toBe('You opened this gathering to people outside The Lees.')
    expect(lineWords(line(off, 'Leo Brandt', true), 'The Lees')).toBe('You closed this gathering to people outside The Lees.')
    expect(lineWords(line(on, 'a former member'), 'The Lees')).toBe(
      'A former member opened this gathering to people outside The Lees.',
    )
    expect(lineWords(line(off, 'a former member'), 'The Lees')).toBe(
      'A former member closed this gathering to people outside The Lees.',
    )
    expect(lineWords(line(on, 'Leo Brandt'), null)).toBeNull()
  })

  it('draws the four kinds it knows and no other', () => {
    for (const kind of ['message', 'joined', 'outside_invitations_on', 'outside_invitations_off']) {
      expect(canDraw(line(kind, 'Leo'))).toBe(true)
    }
    expect(canDraw(line('photos_added', 'Leo'))).toBe(false)
    expect(lineWords(line('photos_added', 'Leo'), 'The Lees')).toBeNull()
  })

  it('says the two steps, the same in a group’s chat and a gathering’s', () => {
    expect([DELETE_SENTENCE, DELETE, REMOVE, KEEP_IT]).toEqual([
      'Delete this message? It will leave the chat at once.',
      'Delete',
      'Remove',
      'Keep it',
    ])
    expect(removeSentence('Leo Brandt')).toBe("Remove Leo Brandt's message? It will leave the chat at once.")
    expect(removeSentence('Chris')).toBe("Remove Chris' message? It will leave the chat at once.")
    expect(removeSentence('a former member')).toBe("Remove a former member's message? It will leave the chat at once.")
  })

  it('says a held message’s row in each of its forms', () => {
    const theirs = message('m', { author: { display_name: 'Leo Brandt', is_self: false } })
    const mine = message('m', { author: { display_name: 'Ann Mercer', is_self: true } })
    const formers = message('m', { author: { display_name: 'a former member', is_self: false } })
    expect(heldWords(held(theirs, { by: 'Leo Brandt', by_writer: true }))).toBe('Leo Brandt deleted a message')
    expect(heldWords(held(mine, { by: 'Ann Mercer', by_writer: true, by_self: true }))).toBe('You deleted a message')
    expect(heldWords(held(theirs, { by: 'Ann Mercer', by_self: true }))).toBe("You removed Leo Brandt's message")
    expect(heldWords(held(theirs, { by: 'Maya Lee' }))).toBe("Maya Lee removed Leo Brandt's message")
    expect(heldWords(held(mine, { by: 'Maya Lee' }))).toBe('Maya Lee removed your message')
    expect(heldWords(held(formers, { by: 'a former member', by_writer: true }))).toBe('A former member deleted a message')
    expect(heldWords(held(formers, { by: 'Ann Mercer', by_self: true }))).toBe("You removed a former member's message")
    expect(heldWords(held(theirs, { by: 'a former member' }))).toBe("A former member removed Leo Brandt's message")
    expect(heldWords(held(message('m', { author: { display_name: 'The Lees', is_self: false } }), { by: 'Maya' }))).toBe(
      "Maya removed The Lees' message",
    )
  })

  it('gives a remover’s own name where the API does not say who the caller is', () => {
    const theirs = held(message('m'), { by: 'Ann Mercer' })
    const { by_self: _, ...rest } = theirs.removed!
    expect(heldWords({ ...theirs, removed: rest })).toBe("Ann Mercer removed Leo Brandt's message")
  })

  it('says the days a held message has left', () => {
    const DAY = 86_400_000
    const now = Date.parse('2026-11-24T16:00:00Z')
    const removed = (ms: number) => new Date(now - ms).toISOString()
    expect(daysLeftWords(removed(0), now)).toBe('30 days left')
    expect(daysLeftWords(removed(1.5 * DAY), now)).toBe('29 days left')
    expect(daysLeftWords(removed(28.5 * DAY), now)).toBe('2 days left')
    expect(daysLeftWords(removed(29 * DAY), now)).toBe('1 day left')
    expect(daysLeftWords(removed(30 * DAY + 60_000), now)).toBe('Less than a day left')
  })

  it('says every state and every label', () => {
    expect([
      NOTHING_HERE,
      NO_CHAT_HERE,
      CHAT_FAILED,
      PREVIEW_FAILED,
      CHECKS_FAILING,
      SHOW_EARLIER,
      EARLIER_FAILED,
      SHOW_IT,
      HIDE_IT,
      MESSAGES,
      DELETE_YOUR_MESSAGE,
    ]).toEqual([
      'Nothing here',
      "There's no chat to show at this address.",
      "This chat couldn't be loaded just now.",
      "The chat couldn't be loaded just now.",
      "New messages couldn't be loaded just now. Still trying.",
      'Show earlier messages',
      "Earlier messages couldn't be loaded just now.",
      'Show it',
      'Hide it',
      'Messages',
      'Delete your message',
    ])
    expect(backTo('The Lees')).toBe('Back to The Lees')
    expect(removeLabel('Leo Brandt')).toBe("Remove Leo Brandt's message")
    expect(removeLabel('The Lees')).toBe("Remove The Lees' message")
    expect(newMessages(4)).toBe('4 new messages')
  })

  it('says each refusal', () => {
    expect(sendLine('too_long')).toBe('That message is too long. Shorten it and send again.')
    expect(sendLine('too_many')).toBe("That's a lot of messages in a minute. Wait a moment, then send it again.")
    expect(sendLine('other')).toBe('Something went wrong. Nothing was sent — try again.')
    expect(sendLine('unreachable')).toBe("Couldn't reach the server. Check your connection and try again.")
    expect(removeLine('refused')).toBe('Something went wrong. Nothing changed — try again.')
    expect(removeLine('unreachable')).toBe("Couldn't reach the server. Check your connection and try again.")
  })

  it('says to a screen reader whose message it is, or the line’s own words, and nothing of a held one', () => {
    expect(spoken(message('m', { body: 'Bring the big pot' }), null)).toBe('Leo Brandt: Bring the big pot')
    expect(spoken(message('m', { body: 'Hi', author: { display_name: 'a former member', is_self: false } }), null)).toBe(
      'A former member: Hi',
    )
    expect(spoken(line('joined', 'Leo Brandt'), null)).toBe(
      'Leo Brandt joined the group. Leo Brandt sees the chat from today on.',
    )
    expect(spoken(held(message('m')), null)).toBeNull()
  })

  it('never says private, secure, safe, for everyone, or that a message was seen or delivered', async () => {
    const source = (await import('./chat?raw')).default as string
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((text) => text.replace(/^\s*\/\/.*$/, ''))
      .join('\n')
    expect(code).not.toMatch(/\b(private|secure|safe|seen|delivered)\b/i)
    expect(code).not.toMatch(/for everyone/i)
  })
})

describe('the days, in the profile’s zone', () => {
  // Two zones, so that whichever the runner is in, one is another.
  const TOKYO = 'Asia/Tokyo'
  const LA = 'America/Los_Angeles'
  const now = (instant: string) => Date.parse(instant)

  it('reads the zone’s own day and not the runner’s or UTC’s', () => {
    // 01:00 on the 24th in Tokyo; still the 23rd in Los Angeles and in UTC.
    const instant = '2026-11-23T16:00:00Z'
    const at = now('2026-11-23T18:00:00Z')
    expect(dayLine(instant, TOKYO, at)).toBe('Today')
    expect(dayLine('2026-11-23T14:30:00Z', TOKYO, at)).toBe('Yesterday')
    expect(dayLine('2026-11-23T14:30:00Z', LA, at)).toBe('Today')
  })

  it('follows midnight in the zone', () => {
    const instant = '2026-11-24T07:30:00Z' // 23:30 on the 23rd in Los Angeles
    expect(dayLine(instant, LA, now('2026-11-24T07:59:59Z'))).toBe('Today')
    expect(dayLine(instant, LA, now('2026-11-24T08:00:00Z'))).toBe('Yesterday')
    expect(dayLine(instant, LA, now('2026-11-25T08:00:00Z'))).toBe('Monday')
  })

  it('is right across a daylight-saving change', () => {
    // Los Angeles leaves daylight time on 2026-11-01, a day of 25 hours, and
    // returns on 2027-03-14, a day of 23.
    const at = now('2026-11-02T08:30:00Z') // 00:30 on the 2nd
    expect(dayLine('2026-11-01T07:30:00Z', LA, at)).toBe('Yesterday') // 00:30 on the 1st, 25 hours before
    expect(dayLine('2026-11-01T06:30:00Z', LA, at)).toBe('Saturday') // 23:30 on Oct 31
    const spring = now('2027-03-15T07:10:00Z') // 00:10 on the 15th
    expect(dayLine('2027-03-14T08:05:00Z', LA, spring)).toBe('Yesterday') // 00:05 on the 14th
    expect(dayLine('2027-03-14T07:55:00Z', LA, spring)).toBe('Saturday') // 23:55 on the 13th
  })

  it('says the weekday for the last six days, then the date, then its year', () => {
    const at = now('2026-11-24T20:00:00Z') // a Tuesday
    expect(dayLine('2026-11-22T20:00:00Z', LA, at)).toBe('Sunday')
    expect(dayLine('2026-11-18T20:00:00Z', LA, at)).toBe('Wednesday')
    expect(dayLine('2026-11-17T20:00:00Z', LA, at)).toBe('Nov 17')
    expect(dayLine('2026-10-04T20:00:00Z', LA, at)).toBe('Oct 4')
    expect(dayLine('2025-10-04T20:00:00Z', LA, at)).toBe('Oct 4, 2025')
    // 23:30 on Dec 31 in Los Angeles, read on the New Year’s Day after a week.
    expect(dayLine('2027-01-01T07:30:00Z', LA, now('2027-01-10T20:00:00Z'))).toBe('Dec 31, 2026')
  })

  it('gives a preview the time alone today, and the day and the time otherwise', () => {
    const at = now('2026-11-24T20:00:00Z')
    expect(previewTime('2026-11-24T17:05:00Z', LA, at)).toBe('9:05 AM')
    expect(previewTime('2026-11-23T17:05:00Z', LA, at)).toBe('Yesterday, 9:05 AM')
    expect(previewTime('2026-10-04T17:05:00Z', LA, at)).toBe('Oct 4, 10:05 AM')
  })
})

describe('the links', () => {
  it('makes an explicit http or https address a link and leaves everything else as text', () => {
    expect(linkPieces('See https://example.com/a?b=1#c now')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/a?b=1#c', href: 'https://example.com/a?b=1#c' },
      { text: ' now' },
    ])
    expect(linkPieces('http://example.com/a')).toEqual([{ text: 'http://example.com/a', href: 'http://example.com/a' }])
    expect(linkPieces('Two https://a.example/x and https://b.example/y')).toHaveLength(4)
  })

  it('leaves the punctuation after an address outside it', () => {
    const linked = (words: string) => linkPieces(words).find((piece) => piece.href)?.text
    expect(linked('Look at https://example.com/a.')).toBe('https://example.com/a')
    expect(linked('(https://example.com/a)')).toBe('https://example.com/a')
    expect(linked('(see https://example.com/a).')).toBe('https://example.com/a')
    expect(linked('https://example.com/a, https')).toBe('https://example.com/a')
    expect(linked('is it https://example.com/a?!')).toBe('https://example.com/a')
    expect(linked('“https://example.com/a”')).toBe('https://example.com/a')
    expect(linked('[https://example.com/a]')).toBe('https://example.com/a')
    // A bracket the address opened is its own.
    expect(linked('https://example.com/Thing_(one)')).toBe('https://example.com/Thing_(one)')
    expect(linked('(https://example.com/Thing_(one))')).toBe('https://example.com/Thing_(one)')
  })

  it('never links a script, a bare domain, a mail address or another scheme', () => {
    for (const words of [
      'javascript:alert(1)',
      'example.com/a',
      'www.example.com',
      'leo@example.com',
      'ftp://example.com/a',
      'data:text/html,x',
      'https://',
    ]) {
      expect(linkPieces(words)).toEqual([{ text: words }])
    }
  })

  it('keeps every character of the words, in order', () => {
    for (const words of ['', 'a\nb  c', 'x https://example.com/a) y', '<b>https://example.com/a</b>', 'https://a.example https://b.example']) {
      expect(linkPieces(words).map((piece) => piece.text).join('')).toBe(words)
    }
  })
})
