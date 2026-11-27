// A chat, read and kept current (CK-103; the chat record §2, §11). One hook,
// one session per place: `openChat` holds everything a chat needs while its
// page is open and publishes a snapshot of it, and the hook shows a snapshot
// only for the place on screen, so moving from one chat to another draws
// nothing of the last one and a late answer for it changes nothing.
//
// THE FIRST READ opens at the first message its person hasn't reached, with
// the line above it and up to twenty before it, or at the newest where there
// is none (CK-105, `?open=true`); what stands below a page that stops short of
// the newest is read on, one page at a time (`showLater`), and a check never
// fills that gap.
//
// THE CHECK. Two seconds after the last answer, five after one that failed,
// never two at once; `since` is the server's own instant, in X-Chat-Since
// (CK-105), with X-Chat-Typing while the box's words changed in the last four
// seconds. It stops with the page and while the tab is hidden, and runs at
// once on the tab's return. A check an act asks for (`checkNow`) runs at once,
// or straight after the one in flight.
//
// A FRESH FIRST READ takes a check's turn, at once, where a check was
// truncated or the caller came to run the chat or stopped running it; one
// that fails stays owed and is tried again at the retry's pace.
//
// AN EARLIER OR A LATER PAGE'S `as_of` never becomes the next check's
// `since`: a page carries none of what changed between.
//
// THE READING PLACE (CK-105): the newest entry its person has had in view,
// sent at most once a second and never two at once, never for what is in view
// while the tab is hidden, a failed one dropped, and one still owed sent with
// keepalive as the tab is hidden or the page goes. Nothing on opening: what
// stands above the line is reached already.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canDraw,
  CHAT_POLL_MS,
  CHAT_RETRY_MS,
  checkChat,
  compareEntries,
  EMPTY_CHAT,
  entriesOf,
  firstUnreadOf,
  isSettingLine,
  MARK_GAP_MS,
  markRead,
  mergeChat,
  newerOf,
  placeKey,
  readAfter,
  readChatGathering,
  readEarlier,
  readNewest,
  readOpen,
  removeMessage,
  sendMessage,
  setReaction,
  steadyTyping,
  TYPING_FRESH_MS,
  typingOf,
  type ChatChange,
  type ChatItem,
  type ChatList,
  type ChatPage,
  type ChatPlace,
  type ReactionKind,
  type SendRefusal,
} from '../lib/chat'
import { clearOpenChat } from '../lib/chatsNew'
import { viewOf, type GatheringWithOccurrences } from '../lib/gatherings'
import { readGroup, type Group } from '../lib/groups'

export type ChatSubject =
  | { kind: 'group'; group: Group }
  | { kind: 'gathering'; gathering: GatheringWithOccurrences }

export type Position = { created_at: string; id: string }

export interface ChatSnapshot {
  key: string
  status: 'loading' | 'loaded' | 'failed' | 'notFound'
  subject: ChatSubject | null
  entries: ChatItem[]
  // Whether there is a page before what is loaded, and how asking for it goes.
  older: boolean
  earlier: 'idle' | 'loading' | 'failed'
  // Whether what is loaded stops short of the newest, and how reading on goes.
  newer: boolean
  later: 'idle' | 'loading' | 'failed'
  // Where the New messages line stands: above this entry. It stays for the
  // page's life; a fresh first read draws it, or none, as it answers.
  line: Position | null
  // What the person had reached when the last first read landed: the entry
  // above the line, or with no line the newest it brought. Nothing at or
  // above it is new to them, so the button's dot never counts it.
  reached: Position | null
  // How many first reads have landed: the thread places itself on each.
  opened: number
  mayModerate: boolean
  checksFailing: boolean
  // Who else is typing, steadied, as the last check said.
  typing: string[]
  // What the last check that brought something from other people brought.
  arrived: { batch: number; items: ChatItem[] } | null
  // Moves when the thread must go to its newest: the caller's own send.
  newest: number
  // The caller's last message sent, so its top can be brought into view.
  sent: string | null
  // Moves when the button to the newest has done its part.
  toNewest: number
  // A send whose answer was lost, found written by a later check.
  settled: { words: string } | null
  // The device's clock at the last answer: what the day lines are read from.
  now: number
}

export type SendResult = { status: 'sent' } | { status: 'refused'; reason: SendRefusal } | { status: 'over' }
// `gone`: the message has left, or a check has been asked to bring its held
// row. `over`: the page moved on first.
export type RemoveResult = 'gone' | 'refused' | 'unreachable' | 'over'
// `notFound`: the message has gone, and a check has been asked for.
export type ReactResult = 'ok' | 'notFound' | 'refused' | 'unreachable' | 'over'
export type NewestResult = 'ok' | 'failed' | 'over'

export interface ChatSession {
  close: () => void
  retry: () => void
  showEarlier: () => void
  showLater: () => void
  send: (words: string) => Promise<SendResult>
  forgetLost: () => void
  remove: (id: string) => Promise<RemoveResult>
  react: (id: string, kind: ReactionKind, on: boolean) => Promise<ReactResult>
  goToNewest: () => Promise<NewestResult>
  typed: (words: string) => void
  markSeen: (id: string) => void
}

function blank(place: ChatPlace): ChatSnapshot {
  return {
    key: placeKey(place),
    status: 'loading',
    subject: null,
    entries: [],
    older: false,
    earlier: 'idle',
    newer: false,
    later: 'idle',
    line: null,
    reached: null,
    opened: 0,
    mayModerate: false,
    checksFailing: false,
    typing: [],
    arrived: null,
    newest: 0,
    sent: null,
    toNewest: 0,
    settled: null,
    now: Date.now(),
  }
}

type First =
  | { status: 'ok'; subject: ChatSubject; page: ChatPage }
  | { status: 'notFound' }
  | { status: 'failed' }

// The first read. A group's: the group and its chat, together. A gathering's:
// the gathering first, and the chat only where the view is the full one — in
// the photos-only view nothing is asked, and there is no chat at this address.
async function readFirst(place: ChatPlace): Promise<First> {
  if (place.kind === 'group') {
    const [group, chat] = await Promise.all([readGroup(place.id), readOpen(place)])
    if (group.status === 'notFound' || chat.status === 'notFound') return { status: 'notFound' }
    if (group.status !== 'loaded' || chat.status !== 'ok') return { status: 'failed' }
    return { status: 'ok', subject: { kind: 'group', group: group.value }, page: chat.value }
  }
  const gathering = await readChatGathering(place.id)
  if (gathering.status !== 'ok') return gathering
  if (!viewOf(gathering.value.caller_view).full) return { status: 'notFound' }
  const chat = await readOpen(place)
  if (chat.status !== 'ok') return chat
  return { status: 'ok', subject: { kind: 'gathering', gathering: gathering.value }, page: chat.value }
}

// Where the line stands on a first read, as the server answered.
function lineOf(page: ChatPage): Position | null {
  const id = firstUnreadOf(page)
  const item = id === null ? undefined : page.items.find((one) => one.id === id)
  return item === undefined ? null : { created_at: item.created_at, id: item.id }
}

// The entry before the line, which the person has reached already.
function beforeLine(list: ChatList, line: Position | null): Position | null {
  if (line === null) return null
  const above = entriesOf(list).filter((item) => compareEntries(item, line) < 0)
  const last = above[above.length - 1]
  return last === undefined ? null : { created_at: last.created_at, id: last.id }
}

// What a first read leaves reached: above its line, or all of it with none.
function reachedAt(list: ChatList, line: Position | null): Position | null {
  if (line !== null) return beforeLine(list, line)
  const entries = entriesOf(list)
  const last = entries[entries.length - 1]
  return last === undefined ? null : { created_at: last.created_at, id: last.id }
}

function later(a: Position | null, b: Position | null): Position | null {
  if (a === null) return b
  if (b === null) return a
  return compareEntries(a, b) >= 0 ? a : b
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, at) => name === b[at])
}

export function openChat(place: ChatPlace, publish: (snapshot: ChatSnapshot) => void): ChatSession {
  let closed = false
  let snapshot = blank(place)
  let list = EMPTY_CHAT
  let asOf = ''
  // Moves when the list is replaced, so a page asked for before is never
  // joined to it.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let owed = false
  let waiting: (() => void)[] = []
  let freshOwed = false
  let forgetLeft = false
  // What the caller sent while a fresh first read was on its way.
  let sentSince: ChatItem[] | null = null
  let lost: { words: string; before: ReadonlySet<string>; found: boolean; settling: boolean } | null = null
  // Each check is numbered as it starts; a reaction's answer remembers the
  // number of the last check begun before it landed.
  let checksBegun = 0
  const reactedAt = new Map<string, number>()
  // When the box's words last changed, while it holds any.
  let typingAt: number | null = null
  // The reading place: the newest entry in view, the newest sent, whether one
  // is out, and whether a second has passed since the last went.
  let inView: Position | null = null
  let marked: Position | null = null
  let markOut = false
  let gapOpen = true
  let gapTimer: ReturnType<typeof setTimeout> | null = null

  function emit(patch: Partial<ChatSnapshot>) {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    publish(snapshot)
  }

  // The page has gone, or there is no chat here any more: a late answer
  // changes nothing.
  function moved(): boolean {
    return closed || snapshot.status !== 'loaded'
  }

  function change(next: ChatChange, patch: Partial<ChatSnapshot> = {}) {
    list = mergeChat(list, next)
    show(patch)
  }

  // What is loaded, drawn.
  function show(patch: Partial<ChatSnapshot> = {}) {
    emit({
      entries: entriesOf(list).filter(canDraw),
      older: list.older !== null,
      newer: list.newer !== null,
      ...patch,
    })
    settleLost()
  }

  function setTyping(names: string[]) {
    const next = steadyTyping(snapshot.typing, names)
    if (!sameNames(next, snapshot.typing)) emit({ typing: next })
  }

  // A lost send is found where a message of the caller's, with its words, is
  // here that wasn't when it began.
  function settleLost() {
    if (lost === null) return
    const { words, before, settling } = lost
    for (const item of list.byId.values()) {
      if (!item.author.is_self || item.body !== words || item.removed !== null || before.has(item.id)) continue
      lost.found = true
      lost = null
      // While the send itself waits, it ends as any send does; after, the box
      // is told, and the thread stays where it is.
      emit(settling ? { newest: snapshot.newest + 1, sent: item.id } : { settled: { words } })
      return
    }
  }

  // There is no chat here for this person any more: everything read is let go.
  function over() {
    clearTimer()
    list = EMPTY_CHAT
    lost = null
    inView = null
    emit({ ...blank(place), status: 'notFound' })
  }

  async function first() {
    const answer = await readFirst(place)
    if (closed) return
    if (answer.status === 'notFound') return over()
    if (answer.status === 'failed') return emit({ status: 'failed' })
    const { page } = answer
    asOf = page.as_of
    generation += 1
    const line = lineOf(page)
    list = mergeChat(EMPTY_CHAT, { type: 'first', items: page.items, older: page.older, newer: newerOf(page) })
    marked = later(marked, beforeLine(list, line))
    show({
      status: 'loaded',
      subject: answer.subject,
      mayModerate: page.may_moderate,
      line,
      reached: reachedAt(list, line),
      opened: snapshot.opened + 1,
      typing: steadyTyping([], typingOf(page)),
      now: Date.now(),
    })
    schedule(CHAT_POLL_MS)
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function schedule(wait: number) {
    clearTimer()
    if (moved() || document.hidden) return
    timer = setTimeout(() => void run(), wait)
  }

  // One turn: a check, or the fresh first read owed, then the one it owes.
  async function run() {
    if (moved() || inFlight) return
    clearTimer()
    inFlight = true
    owed = false
    const served = waiting
    waiting = []
    let outcome = freshOwed ? await fresh() : await check()
    while (outcome === 'ok' && freshOwed && !moved()) outcome = await fresh()
    inFlight = false
    for (const serve of served) serve()
    if (moved()) return
    if (outcome === 'notFound') return over()
    if (snapshot.checksFailing !== (outcome === 'failed')) emit({ checksFailing: outcome === 'failed' })
    if (owed) void run()
    else schedule(outcome === 'failed' ? CHAT_RETRY_MS : CHAT_POLL_MS)
  }

  // Resolves once a check that STARTED after this call has landed.
  function checkNow(): Promise<void> {
    return new Promise((resolve) => {
      if (moved()) return resolve()
      waiting.push(resolve)
      if (inFlight) owed = true
      else void run()
    })
  }

  type Landed = 'ok' | 'failed' | 'notFound'

  function isTyping(): boolean {
    return typingAt !== null && Date.now() - typingAt < TYPING_FRESH_MS
  }

  async function check(): Promise<Landed> {
    checksBegun += 1
    const begun = checksBegun
    const answer = await checkChat(place, asOf, isTyping())
    if (moved()) return 'ok'
    if (answer.status !== 'ok') {
      setTyping([])
      return answer.status
    }
    const { value } = answer
    setTyping(typingOf(value))
    if (value.may_moderate !== snapshot.mayModerate) {
      runsChanged(value.may_moderate)
      return 'ok'
    }
    if (value.truncated) {
      freshOwed = true
      return 'ok'
    }
    const known = list.byId
    asOf = value.as_of
    const keep = new Set([...reactedAt].filter(([, at]) => at >= begun).map(([id]) => id))
    const next = mergeChat(list, {
      type: 'check',
      items: value.items,
      removed: value.removed,
      keep,
      asOf: value.as_of,
    })
    if (value.items.length === 0 && value.removed.length === 0 && next.byId.size === list.byId.size) {
      emit({ now: Date.now() })
      return 'ok'
    }
    list = next
    show({ now: Date.now() })
    const brought = value.items.filter((item) => !known.has(item.id) && list.byId.get(item.id) === item)
    announce(brought)
    followSetting(brought)
    return 'ok'
  }

  async function fresh(): Promise<Landed> {
    sentSince = []
    const answer = await readOpen(place)
    const meanwhile = sentSince
    sentSince = null
    if (moved()) return 'ok'
    if (answer.status !== 'ok') return answer.status
    const { value } = answer
    if (value.may_moderate !== snapshot.mayModerate) runsChanged(value.may_moderate)
    freshOwed = false
    generation += 1
    asOf = value.as_of
    const known = list.byId
    const line = lineOf(value)
    list = mergeChat(list, { type: 'first', items: value.items, older: value.older, newer: newerOf(value), forgetLeft })
    show({ earlier: 'idle', later: 'idle', line, reached: reachedAt(list, line), opened: snapshot.opened + 1, now: Date.now() })
    marked = later(marked, beforeLine(list, line))
    forgetLeft = false
    for (const item of meanwhile) {
      if (list.newer === null) change({ type: 'sent', item })
    }
    followSetting(value.items.filter((item) => !known.has(item.id)))
    return 'ok'
  }

  // The caller came to run the chat, or stopped: what they may see of it has
  // changed, so what they may no longer see goes now and the rest is read
  // again.
  function runsChanged(runs: boolean) {
    generation += 1
    freshOwed = true
    forgetLeft = runs
    if (runs) emit({ mayModerate: true, earlier: 'idle', later: 'idle' })
    else change({ type: 'heldGone' }, { mayModerate: false, earlier: 'idle', later: 'idle' })
  }

  function announce(brought: ChatItem[]) {
    const items = brought.filter((item) => !item.author.is_self && item.removed === null && canDraw(item))
    if (items.length === 0) return
    emit({ arrived: { batch: (snapshot.arrived?.batch ?? 0) + 1, items: [...items] } })
  }

  // A setting line that arrived while the chat is open: the gathering is read
  // again once, so the notice at the top follows the setting.
  function followSetting(brought: ChatItem[]) {
    if (place.kind !== 'gathering' || !brought.some(isSettingLine)) return
    void readChatGathering(place.id).then((answer) => {
      if (moved() || answer.status !== 'ok') return
      if (!viewOf(answer.value.caller_view).full) return
      emit({ subject: { kind: 'gathering', gathering: answer.value } })
    })
  }

  async function showEarlier() {
    const { older } = list
    if (older === null || snapshot.status !== 'loaded' || snapshot.earlier === 'loading') return
    const asked = generation
    emit({ earlier: 'loading' })
    const answer = await readEarlier(place, older)
    if (moved() || asked !== generation) return
    if (answer.status === 'notFound') return over()
    if (answer.status === 'failed') return emit({ earlier: 'failed' })
    if (answer.value.may_moderate !== snapshot.mayModerate) {
      runsChanged(answer.value.may_moderate)
      void checkNow()
      return
    }
    change(
      { type: 'earlier', items: answer.value.items, older: answer.value.older },
      { earlier: 'idle', now: Date.now() },
    )
  }

  // The page below what is loaded, toward the newest: one at a time.
  async function showLater() {
    const { newer } = list
    if (newer === null || snapshot.status !== 'loaded' || snapshot.later === 'loading') return
    const asked = generation
    emit({ later: 'loading' })
    const answer = await readAfter(place, newer)
    if (moved() || asked !== generation) return
    if (answer.status === 'notFound') return over()
    if (answer.status === 'failed') return emit({ later: 'failed' })
    if (answer.value.may_moderate !== snapshot.mayModerate) {
      runsChanged(answer.value.may_moderate)
      void checkNow()
      return
    }
    change(
      { type: 'after', items: answer.value.items, newer: newerOf(answer.value) },
      { later: 'idle', now: Date.now() },
    )
  }

  // The newest page, in place of what is loaded and with no line: the button
  // to the newest across a gap, and a send across one.
  async function readToNewest(): Promise<NewestResult> {
    const answer = await readNewest(place)
    if (moved()) return 'over'
    if (answer.status === 'notFound') {
      over()
      return 'over'
    }
    if (answer.status === 'failed') return 'failed'
    const { value } = answer
    if (value.may_moderate !== snapshot.mayModerate) runsChanged(value.may_moderate)
    generation += 1
    change(
      { type: 'first', items: value.items, older: value.older, newer: null },
      { earlier: 'idle', later: 'idle', line: null, now: Date.now() },
    )
    return 'ok'
  }

  async function goToNewest(): Promise<NewestResult> {
    if (moved()) return 'over'
    if (list.newer !== null) {
      const outcome = await readToNewest()
      if (outcome !== 'ok') return outcome
    }
    emit({ toNewest: snapshot.toNewest + 1 })
    return 'ok'
  }

  async function send(words: string): Promise<SendResult> {
    lost = null
    const before = new Set(list.byId.keys())
    const outcome = await sendMessage(place, words)
    if (moved()) return { status: 'over' }
    if (outcome.status === 'sent') {
      typingAt = null
      sentSince?.push(outcome.item)
      if (list.newer === null) {
        change({ type: 'sent', item: outcome.item }, { newest: snapshot.newest + 1, sent: outcome.item.id })
      } else {
        // A gap stands below: the newest page first, then the message in it.
        const { item } = outcome
        void readToNewest().then((read) => {
          if (read !== 'ok' || moved()) return
          change({ type: 'sent', item }, { newest: snapshot.newest + 1, sent: item.id })
        })
      }
      return { status: 'sent' }
    }
    if (outcome.status === 'notFound') {
      over()
      return { status: 'over' }
    }
    if (outcome.status === 'refused') return { status: 'refused', reason: outcome.reason }
    const mine = { words, before, found: false, settling: true }
    lost = mine
    settleLost()
    if (!mine.found) await checkNow()
    mine.settling = false
    if (moved()) return { status: 'over' }
    return mine.found ? { status: 'sent' } : { status: 'refused', reason: 'unreachable' }
  }

  async function remove(id: string): Promise<RemoveResult> {
    const outcome = await removeMessage(id)
    if (moved()) return 'over'
    if (outcome === 'refused' || outcome === 'unreachable') return outcome
    if (outcome === 'removed' && snapshot.mayModerate) void checkNow()
    else change({ type: 'left', id })
    return 'gone'
  }

  async function react(id: string, kind: ReactionKind, on: boolean): Promise<ReactResult> {
    const outcome = await setReaction(id, kind, on)
    if (moved()) return 'over'
    if (outcome.status === 'ok') {
      reactedAt.set(id, checksBegun)
      change({ type: 'reacted', id, reactions: outcome.reactions })
      return 'ok'
    }
    if (outcome.status === 'notFound') {
      void checkNow()
      return 'notFound'
    }
    return outcome.status
  }

  // The box's words: whether the caller is typing, for the next check.
  function typed(words: string) {
    typingAt = words.trim() === '' ? null : Date.now()
  }

  // The newest entry the person has had in view. A second's gap is kept by a
  // timer, so nothing but time opens it.
  function markSeen(id: string) {
    if (moved() || document.hidden) return
    const item = list.byId.get(id)
    if (item === undefined) return
    inView = later(inView, { created_at: item.created_at, id: item.id })
    sendMark()
  }

  function markOwed(): Position | null {
    if (inView === null) return null
    return marked === null || compareEntries(inView, marked) > 0 ? inView : null
  }

  // While the tab is hidden the page may be frozen or gone before the second
  // has passed — a phone's app closed from the switcher never unmounts — so
  // one still owed goes at once, with keepalive, as soon as none is out.
  function sendMark() {
    const hiding = document.hidden
    if (closed || markOut || (!gapOpen && !hiding)) return
    const through = markOwed()
    if (through === null) return
    marked = through
    markOut = true
    gapOpen = false
    if (gapTimer !== null) clearTimeout(gapTimer)
    gapTimer = setTimeout(() => {
      gapTimer = null
      gapOpen = true
      sendMark()
    }, MARK_GAP_MS)
    void markRead(place, through.id, hiding).then((landed) => {
      markOut = false
      if (closed) return
      if (landed) clearIfNewest(through)
      sendMark()
    })
  }

  // The newest entry loaded is reached and nothing newer is left: the dot for
  // this chat goes now.
  function clearIfNewest(through: Position) {
    if (list.newer !== null) return
    const entries = entriesOf(list)
    const newest = entries[entries.length - 1]
    if (newest === undefined || compareEntries(through, newest) >= 0) clearOpenChat(place)
  }

  // On the tab's return, at once; straight after one left in flight. As it is
  // hidden, a mark still owed.
  function onVisibility() {
    if (document.hidden) {
      clearTimer()
      setTyping([])
      if (!moved()) sendMark()
      return
    }
    void checkNow()
  }

  document.addEventListener('visibilitychange', onVisibility)
  void first()

  return {
    close() {
      if (closed) return
      const stillOwed = snapshot.status === 'loaded' ? markOwed() : null
      closed = true
      clearTimer()
      if (gapTimer !== null) clearTimeout(gapTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const serve of waiting) serve()
      waiting = []
      if (stillOwed !== null) void markRead(place, stillOwed.id, true)
    },
    retry() {
      if (closed || snapshot.status !== 'failed') return
      emit({ status: 'loading' })
      void first()
    },
    showEarlier: () => void showEarlier(),
    showLater: () => void showLater(),
    send,
    // Not while the send is still being asked after: it would end as one that
    // never arrived though it was written, and be sent twice.
    forgetLost() {
      if (lost !== null && !lost.settling) lost = null
    },
    remove,
    react,
    goToNewest,
    typed,
    markSeen,
  }
}

export interface Chat extends ChatSnapshot {
  retry: () => void
  showEarlier: () => void
  showLater: () => void
  send: (words: string) => Promise<SendResult>
  forgetLost: () => void
  remove: (id: string) => Promise<RemoveResult>
  react: (id: string, kind: ReactionKind, on: boolean) => Promise<ReactResult>
  goToNewest: () => Promise<NewestResult>
  typed: (words: string) => void
  markSeen: (id: string) => void
}

const OVER: SendResult = { status: 'over' }

export function useChat(place: ChatPlace): Chat {
  const { kind, id } = place
  const key = placeKey(place)
  const [held, setHeld] = useState<ChatSnapshot | null>(null)
  const session = useRef<ChatSession | null>(null)

  useEffect(() => {
    const opened = openChat({ kind, id }, setHeld)
    session.current = opened
    return () => {
      opened.close()
      if (session.current === opened) session.current = null
    }
  }, [kind, id])

  const retry = useCallback(() => session.current?.retry(), [])
  const showEarlier = useCallback(() => session.current?.showEarlier(), [])
  const showLater = useCallback(() => session.current?.showLater(), [])
  const send = useCallback(async (words: string) => session.current?.send(words) ?? OVER, [])
  const forgetLost = useCallback(() => session.current?.forgetLost(), [])
  const remove = useCallback(async (item: string): Promise<RemoveResult> => session.current?.remove(item) ?? 'over', [])
  const react = useCallback(
    async (item: string, reaction: ReactionKind, on: boolean): Promise<ReactResult> =>
      session.current?.react(item, reaction, on) ?? 'over',
    [],
  )
  const goToNewest = useCallback(async (): Promise<NewestResult> => session.current?.goToNewest() ?? 'over', [])
  const typed = useCallback((words: string) => session.current?.typed(words), [])
  const markSeen = useCallback((item: string) => session.current?.markSeen(item), [])

  // A snapshot for another place counts as loading.
  const shown = held !== null && held.key === key ? held : blank(place)
  return { ...shown, retry, showEarlier, showLater, send, forgetLost, remove, react, goToNewest, typed, markSeen }
}
