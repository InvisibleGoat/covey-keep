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
  stillToSend,
  type ChatItem,
  type ChatList,
} from './chat'
import {
  CHAT_HOLD_MS,
  chipLabel,
  CHOOSE_A_REACTION,
  firstUnreadOf,
  GO_TO_NEWEST,
  GO_TO_NEWEST_NEW,
  markRead,
  MARK_GAP_MS,
  NEW_MESSAGES,
  NEWER_FAILED,
  newerOf,
  REACTION_EMOJI,
  REACTION_KINDS,
  reactionLine,
  reactionName,
  reactionsOf,
  reactLabel,
  readAfter,
  readOpen,
  readWhoReacted,
  setReaction,
  steadyTyping,
  tileLabel,
  TYPING_FRESH_MS,
  typingLine,
  typingOf,
  WHO_FAILED,
  WHO_REACTED,
  whoNames,
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
    // MOVED AT CK-105, with its reason: a check carries its instant in
    // X-Chat-Since and never in the address (THE DESIGN §1), so its address is
    // the chat's own; the header is pinned in the second pair's calls below.
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/groups/group-1/chat'],
      ['GET', '/gatherings/gathering-1/chat?limit=20'],
      ['GET', '/groups/group-1/chat?before=a%2Bb%2Fc%3D'],
      ['GET', '/gatherings/gathering-1/chat'],
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

// What a send that landed leaves in the box (CK-103's fix-up): the box is open
// while a send waits, so the words that were sent come out of it and nothing
// else does.
describe('what is still to send', () => {
  it.each([
    // What was in the box when it was sent, unchanged.
    ['Hello', 'Hello', ''],
    ['  Hello \n', 'Hello', ''],
    ['\nHello', 'Hello', ''],
    // Typed after them.
    ['Hello and more', 'Hello', 'and more'],
    ['Hello, and more', 'Hello', ', and more'],
    ['Hello\nand more', 'Hello', 'and more'],
    ['  Hello\n\n  and more', 'Hello', 'and more'],
    ['Helloand more', 'Hello', 'and more'],
    // A space at the end is one the person has typed and is typing after.
    ['Hello and ', 'Hello', 'and '],
    // Only once.
    ['Hello Hello', 'Hello', 'Hello'],
    ['Two\nlines\nand a third', 'Two\nlines', 'and a third'],
    // Rewritten: as the person left it, its own leading space with it.
    ['Goodbye', 'Hello', 'Goodbye'],
    ['  Goodbye', 'Hello', '  Goodbye'],
    ['Oh, Hello', 'Hello', 'Oh, Hello'],
    ['hello', 'Hello', 'hello'],
    ['Hell', 'Hello', 'Hell'],
    ['', 'Hello', ''],
  ])('%j, with %j sent, leaves %j', (box, sent, left) => {
    expect(stillToSend(box, sent)).toBe(left)
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

  // Widened at CK-105: the dot's store is scanned too, and read by is banned.
  it('never says private, secure, safe, for everyone, or that a message was seen, read by or delivered', async () => {
    for (const source of [
      (await import('./chat?raw')).default as string,
      (await import('./chatsNew?raw')).default as string,
    ]) {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((text) => text.replace(/^\s*\/\/.*$/, ''))
        .join('\n')
      expect(code).not.toMatch(/\b(private|secure|safe|seen|delivered)\b/i)
      expect(code).not.toMatch(/for everyone|read by/i)
    }
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

// --- the second pair (CK-105; THE DESIGN §1, §3, §7, §9 to §11 and THE WORDS of
// its kickoff, approved by Steven on 2026-11-26) ----------------------------------

describe('the second pair: what is read', () => {
  type Call = { path: string; method: string; body: unknown; headers: Record<string, string>; keepalive: boolean }

  function stubAll(answers: (call: Call) => { status: number; body?: unknown } | Error) {
    setToken('session-test')
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, name) => {
        if (name !== 'authorization' && name !== 'content-type') headers[name] = value
      })
      const call = {
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers,
        keepalive: init.keepalive === true,
      }
      calls.push(call)
      const answer = answers(call)
      if (answer instanceof Error) throw answer
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
    })
    return calls
  }

  const SINCE = '2026-11-24T15:00:00.123456+00:00'
  const page = { items: [], older: null, newer: null, as_of: SINCE, may_moderate: false }

  it('opens at the first unread, goes on after a cursor, and checks with its instant in a header alone', async () => {
    const calls = stubAll(() => ({ status: 200, body: page }))
    await readOpen(GROUP)
    await readAfter(GATHERING, 'a+b/c=')
    await checkChat(GROUP, SINCE)
    await checkChat(GATHERING, SINCE, true)
    await checkChat(GATHERING, SINCE, false)
    expect(calls.map((call) => [call.method, call.path, call.headers])).toEqual([
      ['GET', '/groups/group-1/chat?open=true', {}],
      ['GET', '/gatherings/gathering-1/chat?after=a%2Bb%2Fc%3D', {}],
      ['GET', '/groups/group-1/chat', { 'x-chat-since': SINCE }],
      ['GET', '/gatherings/gathering-1/chat', { 'x-chat-since': SINCE, 'x-chat-typing': '1' }],
      ['GET', '/gatherings/gathering-1/chat', { 'x-chat-since': SINCE }],
    ])
  })

  it('sends neither header on a page read', async () => {
    const calls = stubAll(() => ({ status: 200, body: page }))
    await readOpen(GROUP)
    await readNewest(GROUP)
    await readEarlier(GROUP, 'c')
    await readAfter(GROUP, 'c')
    expect(calls.map((call) => call.headers)).toEqual([{}, {}, {}, {}])
  })

  it('answers not found for the open read on a 404 or a 422, and for after on a 404 alone', async () => {
    stubAll(() => ({ status: 404, body: { detail: 'Not found' } }))
    expect(await readOpen(GROUP)).toEqual({ status: 'notFound' })
    expect(await readAfter(GROUP, 'c')).toEqual({ status: 'notFound' })
    stubAll(() => ({ status: 422, body: { detail: [] } }))
    expect(await readOpen(GROUP)).toEqual({ status: 'notFound' })
    expect(await readAfter(GROUP, 'c')).toEqual({ status: 'failed' })
    stubAll(() => new TypeError('Failed to fetch'))
    expect(await readOpen(GROUP)).toEqual({ status: 'failed' })
  })

  it('marks a place with the one id, keepalive when asked, and says only whether it landed', async () => {
    const calls = stubAll(() => ({ status: 204 }))
    expect(await markRead(GROUP, 'm1')).toBe(true)
    expect(await markRead(GATHERING, 'm2', true)).toBe(true)
    expect(calls.map((call) => [call.method, call.path, call.body, call.keepalive])).toEqual([
      ['PUT', '/groups/group-1/chat/read', { through: 'm1' }, false],
      ['PUT', '/gatherings/gathering-1/chat/read', { through: 'm2' }, true],
    ])
    for (const status of [404, 422, 500]) {
      stubAll(() => ({ status, body: {} }))
      expect(await markRead(GROUP, 'm1')).toBe(false)
    }
    stubAll(() => new TypeError('Failed to fetch'))
    expect(await markRead(GROUP, 'm1')).toBe(false)
  })

  it('leaves or takes back a reaction with the kind in the body, and reads what came of it', async () => {
    const reactions = [{ kind: 'heart', count: 2, mine: true }]
    const calls = stubAll(() => ({ status: 200, body: { reactions } }))
    expect(await setReaction('m1', 'heart', true)).toEqual({ status: 'ok', reactions })
    expect(await setReaction('m1', 'like', false)).toEqual({ status: 'ok', reactions })
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['PUT', '/messages/m1/reactions', { kind: 'heart', on: true }],
      ['PUT', '/messages/m1/reactions', { kind: 'like', on: false }],
    ])
    stubAll(() => ({ status: 404, body: {} }))
    expect(await setReaction('m1', 'heart', true)).toEqual({ status: 'notFound' })
    for (const status of [409, 422, 500]) {
      stubAll(() => ({ status, body: { detail: { code: 'not_a_message' } } }))
      expect(await setReaction('m1', 'heart', true)).toEqual({ status: 'refused' })
    }
    stubAll(() => new TypeError('Failed to fetch'))
    expect(await setReaction('m1', 'heart', true)).toEqual({ status: 'unreachable' })
  })

  it('reads who reacted, by the message alone', async () => {
    const body = { reactions: [{ kind: 'like', names: ['Kelly Brandt'] }] }
    const calls = stubAll(() => ({ status: 200, body }))
    expect(await readWhoReacted('m1')).toEqual({ status: 'ok', value: body })
    expect(calls.map((call) => [call.method, call.path, call.headers])).toEqual([['GET', '/messages/m1/reactions', {}]])
    stubAll(() => ({ status: 404, body: {} }))
    expect(await readWhoReacted('m1')).toEqual({ status: 'notFound' })
  })
})

describe('the second pair: the quiet forms', () => {
  it('draws no chips and no React where the server sent no reactions', () => {
    expect(reactionsOf(message('a'))).toBeNull()
    expect(reactionsOf(message('a', { reactions: 'x' } as never))).toBeNull()
    expect(reactionsOf(message('a', { reactions: [] }))).toEqual([])
  })

  it('keeps the server’s order, and drops a kind it doesn’t know or a count it can’t draw', () => {
    const reactions = [
      { kind: 'sad', count: 1, mine: false },
      { kind: 'like', count: 3, mine: true },
      { kind: 'wink', count: 9, mine: false },
      { kind: 'heart', count: 0, mine: false },
      { kind: 'surprise', count: 2, mine: 'yes' },
      { kind: 'laugh', count: null, mine: true },
    ]
    expect(reactionsOf(message('a', { reactions } as never))).toEqual([
      { kind: 'sad', count: 1, mine: false },
      { kind: 'like', count: 3, mine: true },
      { kind: 'laugh', count: null, mine: true },
    ])
  })

  it('reads typing, newer and the first unread quietly when they are missing or wrong', () => {
    expect(typingOf({ typing: ['Kelly Brandt'] })).toEqual(['Kelly Brandt'])
    expect(typingOf({})).toEqual([])
    expect(typingOf({ typing: 'Kelly' })).toEqual([])
    expect(typingOf({ typing: ['Kelly', 3] })).toEqual(['Kelly'])
    const items = [message('a'), message('b')]
    expect(newerOf({ newer: 'n' })).toBe('n')
    expect(newerOf({})).toBeNull()
    expect(newerOf({ newer: 3 })).toBeNull()
    expect(firstUnreadOf({ items, first_unread: 'b' })).toBe('b')
    expect(firstUnreadOf({ items, first_unread: 'gone' })).toBeNull()
    expect(firstUnreadOf({ items, first_unread: null })).toBeNull()
    expect(firstUnreadOf({ items })).toBeNull()
  })

  it('counts typing for four seconds after a change, marks at most once a second, and holds for thirty days', () => {
    expect([TYPING_FRESH_MS, MARK_GAP_MS, CHAT_HOLD_MS]).toEqual([4000, 1000, 30 * 86_400_000])
  })
})

describe('the second pair: the merge', () => {
  const T = (second: number) => `2026-11-24T15:00:${String(second).padStart(2, '0')}.000000+00:00`

  it('reads newer from a first read and an after page, and goes on below', () => {
    const list = mergeChat(EMPTY_CHAT, { type: 'first', items: [at('a', T(1))], older: null, newer: 'n1' })
    expect(list.newer).toBe('n1')
    const on = mergeChat(list, { type: 'after', items: [at('b', T(2)), at('c', T(3))], newer: null })
    expect(ids(on)).toEqual(['a', 'b', 'c'])
    expect(on.newer).toBeNull()
    expect(mergeChat(EMPTY_CHAT, { type: 'first', items: [], older: null }).newer).toBeNull()
    expect(EMPTY_CHAT.newer).toBeNull()
  })

  it('adds nothing a check brings across a gap below, but updates what is loaded', () => {
    const list = mergeChat(EMPTY_CHAT, { type: 'first', items: [at('a', T(1)), at('b', T(2))], older: null, newer: 'n' })
    const changed = at('b', T(2), { body: 'Changed' })
    const next = mergeChat(list, { type: 'check', items: [at('z', T(9)), changed], removed: [] })
    expect(ids(next)).toEqual(['a', 'b'])
    expect(next.byId.get('b')?.body).toBe('Changed')
    expect(next.newer).toBe('n')
    // Once the newest is reached, a check adds as before.
    const reached = mergeChat(next, { type: 'after', items: [], newer: null })
    expect(ids(mergeChat(reached, { type: 'check', items: [at('z', T(9))], removed: [] }))).toEqual(['a', 'b', 'z'])
  })

  it('takes out a removed id across a gap, and never brings it back from below', () => {
    const list = mergeChat(EMPTY_CHAT, { type: 'first', items: [at('a', T(1)), at('b', T(2))], older: null, newer: 'n' })
    const next = mergeChat(list, { type: 'check', items: [], removed: ['b', 'far'] })
    expect(ids(next)).toEqual(['a'])
    expect(ids(mergeChat(next, { type: 'after', items: [at('far', T(8)), at('c', T(9))], newer: null }))).toEqual(['a', 'c'])
  })

  it('keeps a reaction’s answer over a check that began before it landed, and merges the rest', () => {
    const before = at('a', T(1), { reactions: [{ kind: 'heart', count: 1, mine: false }] })
    const answered = [{ kind: 'heart', count: 2, mine: true }] as const
    let list = mergeChat(first([before]), { type: 'reacted', id: 'a', reactions: [...answered] })
    expect(list.byId.get('a')?.reactions).toEqual(answered)
    const stale = at('a', T(1), { body: 'Merged', reactions: [{ kind: 'heart', count: 1, mine: false }] })
    list = mergeChat(list, { type: 'check', items: [stale], removed: [], keep: new Set(['a']) })
    expect(list.byId.get('a')?.reactions).toEqual(answered)
    expect(list.byId.get('a')?.body).toBe('Merged')
    // A check that began after the answer landed is the newer word.
    const later = [{ kind: 'heart', count: 3, mine: true }] as const
    list = mergeChat(list, { type: 'check', items: [at('a', T(1), { reactions: [...later] })], removed: [] })
    expect(list.byId.get('a')?.reactions).toEqual(later)
  })

  it('puts a reaction’s answer on a live message it holds, and on nothing else', () => {
    const list = first([held(at('h', T(1)), { at: T(2) })])
    expect(mergeChat(list, { type: 'reacted', id: 'h', reactions: [] }).byId.get('h')?.reactions).toBeUndefined()
    const after = mergeChat(list, { type: 'reacted', id: 'nobody', reactions: [] })
    expect(ids(after)).toEqual(['h'])
    expect(after.left.has('nobody')).toBe(false)
  })

  it('lets a held row go at the check whose instant is thirty days past its removal, by the server’s clock', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-12-25T15:00:00Z') })
    try {
      const removedAt = '2026-11-24T15:00:00.500000+00:00'
      const list = first([held(at('h', T(1)), { at: removedAt }), at('a', T(2))])
      const microBefore = mergeChat(list, { type: 'check', items: [], removed: [], asOf: '2026-12-24T15:00:00.499999+00:00' })
      expect(ids(microBefore)).toEqual(['h', 'a'])
      const secondBefore = mergeChat(list, { type: 'check', items: [], removed: [], asOf: '2026-12-24T14:59:59.500000+00:00' })
      expect(ids(secondBefore)).toEqual(['h', 'a'])
      const atThirty = mergeChat(list, { type: 'check', items: [], removed: [], asOf: '2026-12-24T10:00:00.500000-05:00' })
      expect(ids(atThirty)).toEqual(['a'])
      expect(atThirty.left.has('h')).toBe(true)
      // The device's clock, a day wrong either way, changes nothing: only the
      // server's instant on the check decides.
      vi.setSystemTime(Date.parse('2026-12-23T15:00:00Z'))
      expect(ids(mergeChat(list, { type: 'check', items: [], removed: [], asOf: '2026-12-24T15:00:00.500000Z' }))).toEqual(['a'])
      vi.setSystemTime(Date.parse('2026-12-25T15:00:01Z'))
      expect(ids(mergeChat(list, { type: 'check', items: [], removed: [], asOf: '2026-12-24T15:00:00.499999Z' }))).toEqual(['h', 'a'])
      // With no instant, nothing goes.
      expect(ids(mergeChat(list, { type: 'check', items: [], removed: [] }))).toEqual(['h', 'a'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the second pair: the words', () => {
  it('names the seven reactions as approved, Like first and then the kinds’ order', () => {
    expect(REACTION_KINDS).toEqual(['like', 'heart', 'laugh', 'surprise', 'sad', 'thumbs_up', 'celebrate'])
    expect(REACTION_KINDS.map(reactionName)).toEqual([
      'Like',
      'Heart',
      'Laughing',
      'Surprised',
      'Sad',
      'Thumbs up',
      'Celebrate',
    ])
    expect(REACTION_EMOJI).toEqual({
      heart: '❤️',
      laugh: '😂',
      surprise: '😮',
      sad: '😢',
      thumbs_up: '👍',
      celebrate: '🎉',
    })
  })

  it('names a chip with its count, and with none in a memorial’s chat', () => {
    expect(chipLabel('heart', 3)).toBe('Heart, 3')
    expect(chipLabel('heart', null)).toBe('Heart')
    expect(chipLabel('thumbs_up', 1)).toBe('Thumbs up, 1')
    expect(chipLabel('like', null)).toBe('Like')
  })

  it('names React by whose message it is', () => {
    expect(reactLabel({ display_name: 'Kelly Brandt', is_self: false })).toBe("React to Kelly Brandt's message")
    expect(reactLabel({ display_name: 'The Lees', is_self: false })).toBe("React to The Lees' message")
    expect(reactLabel({ display_name: 'Ann Mercer', is_self: true })).toBe('React to your message')
    expect(reactLabel({ display_name: 'a former member', is_self: false })).toBe("React to a former member's message")
  })

  it('names who reacted, You first, with one copy of the caller’s name taken out', () => {
    expect(whoNames(['Kelly Brandt'], false, 'Ann Mercer')).toBe('Kelly Brandt')
    expect(whoNames(['Kelly Brandt', 'Ann Mercer'], true, 'Ann Mercer')).toBe('You and Kelly Brandt')
    expect(whoNames(['Kelly Brandt', 'Ann Mercer', 'Leo Brandt'], true, 'Ann Mercer')).toBe(
      'You, Kelly Brandt and Leo Brandt',
    )
    expect(whoNames(['Kelly Brandt', 'Leo Brandt', 'Ray Brandt'], false, 'Ann Mercer')).toBe(
      'Kelly Brandt, Leo Brandt and Ray Brandt',
    )
    expect(whoNames(['Ann Mercer'], true, 'Ann Mercer')).toBe('You')
    // Two people of one name: one copy goes, the other stays.
    expect(whoNames(['Ann Mercer', 'Ann Mercer'], true, 'Ann Mercer')).toBe('You and Ann Mercer')
    // A namesake who reacted while the caller did not stays whole.
    expect(whoNames(['Ann Mercer', 'Kelly Brandt'], false, 'Ann Mercer')).toBe('Ann Mercer and Kelly Brandt')
    expect(whoNames(['a former member', 'Kelly Brandt'], false, 'Ann Mercer')).toBe('A former member and Kelly Brandt')
    expect(whoNames(['Kelly Brandt', 'a former member'], false, 'Ann Mercer')).toBe('Kelly Brandt and a former member')
    expect(whoNames([], true, 'Ann Mercer')).toBe('You')
    expect(whoNames(['Kelly Brandt'], true, null)).toBe('You and Kelly Brandt')
  })

  it('says the new lines as approved', () => {
    expect([CHOOSE_A_REACTION, WHO_REACTED, WHO_FAILED, NEW_MESSAGES, GO_TO_NEWEST, GO_TO_NEWEST_NEW, NEWER_FAILED]).toEqual([
      'Choose a reaction',
      'Who reacted',
      "Who reacted couldn't be loaded just now.",
      'New messages',
      'Go to the newest message',
      'Go to the newest message, new messages below',
      "Newer messages couldn't be loaded just now.",
    ])
    expect(tileLabel('The Brandts')).toBe('The Brandts, new messages')
    expect(reactionLine('refused')).toBe('Something went wrong. Nothing changed — try again.')
    expect(reactionLine('unreachable')).toBe("Couldn't reach the server. Check your connection and try again.")
  })

  it('says who is typing, three or more as several', () => {
    expect(typingLine([])).toBe('')
    expect(typingLine(['Kelly Brandt'])).toBe('Kelly Brandt is typing…')
    expect(typingLine(['Kelly Brandt', 'Leo Brandt'])).toBe('Kelly Brandt and Leo Brandt are typing…')
    expect(typingLine(['Kelly Brandt', 'Leo Brandt', 'Ray Brandt'])).toBe('Several people are typing…')
    expect(typingLine(['a former member'])).toBe('A former member is typing…')
  })

  it('keeps a typing name in its place while it stays, a new one joining at the end', () => {
    expect(steadyTyping([], ['Kelly', 'Leo'])).toEqual(['Kelly', 'Leo'])
    expect(steadyTyping(['Kelly', 'Leo'], ['Leo', 'Kelly'])).toEqual(['Kelly', 'Leo'])
    expect(steadyTyping(['Kelly', 'Leo'], ['Ray', 'Leo'])).toEqual(['Leo', 'Ray'])
    expect(steadyTyping(['Kelly', 'Kelly'], ['Kelly'])).toEqual(['Kelly'])
    expect(steadyTyping(['Kelly'], ['Kelly', 'Kelly'])).toEqual(['Kelly', 'Kelly'])
    expect(steadyTyping(['Kelly'], [])).toEqual([])
  })

  it('never says private, secure, safe, for everyone, seen, read by or delivered in a line it adds', () => {
    const lines = [
      CHOOSE_A_REACTION,
      WHO_REACTED,
      WHO_FAILED,
      NEW_MESSAGES,
      GO_TO_NEWEST,
      GO_TO_NEWEST_NEW,
      NEWER_FAILED,
      tileLabel('X'),
      typingLine(['A']),
      typingLine(['A', 'B']),
      typingLine(['A', 'B', 'C']),
      reactLabel({ display_name: 'A', is_self: false }),
      reactLabel({ display_name: 'A', is_self: true }),
      ...REACTION_KINDS.map((kind) => chipLabel(kind, 2)),
    ]
    for (const line of lines) {
      expect(line).not.toMatch(/\b(private|secure|safe|seen|delivered)\b/i)
      expect(line).not.toMatch(/for everyone|read by/i)
    }
  })
})
