// A chat, read and kept current (CK-103; the chat record §2, §11). One hook,
// one session per place: `openChat` holds everything a chat needs while its
// page is open and publishes a snapshot of it, and the hook shows a snapshot
// only for the place on screen, so moving from one chat to another draws
// nothing of the last one and a late answer for it changes nothing.
//
// THE CHECK. Two seconds after the last answer, five after one that failed,
// never two at once; `since` is the server's own instant. It stops with the
// page and while the tab is hidden, and runs at once on the tab's return. A
// check an act asks for (`checkNow`) runs at once, or straight after the one
// in flight.
//
// A FRESH FIRST READ takes a check's turn, at once, where a check was
// truncated or the caller came to run the chat or stopped running it; one
// that fails stays owed and is tried again at the retry's pace.
//
// AN EARLIER PAGE'S `as_of` never becomes the next check's `since`: a page
// back carries none of what changed between.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canDraw,
  CHAT_POLL_MS,
  CHAT_RETRY_MS,
  checkChat,
  EMPTY_CHAT,
  entriesOf,
  isSettingLine,
  mergeChat,
  placeKey,
  readChatGathering,
  readEarlier,
  readNewest,
  removeMessage,
  sendMessage,
  type ChatChange,
  type ChatItem,
  type ChatPage,
  type ChatPlace,
  type SendRefusal,
} from '../lib/chat'
import { viewOf, type GatheringWithOccurrences } from '../lib/gatherings'
import { readGroup, type Group } from '../lib/groups'

export type ChatSubject =
  | { kind: 'group'; group: Group }
  | { kind: 'gathering'; gathering: GatheringWithOccurrences }

export interface ChatSnapshot {
  key: string
  status: 'loading' | 'loaded' | 'failed' | 'notFound'
  subject: ChatSubject | null
  entries: ChatItem[]
  // Whether there is a page before what is loaded, and how asking for it goes.
  older: boolean
  earlier: 'idle' | 'loading' | 'failed'
  mayModerate: boolean
  checksFailing: boolean
  // What the last check that brought something from other people brought.
  arrived: { batch: number; items: ChatItem[] } | null
  // Moves when the thread must go to its newest: the caller's own send.
  newest: number
  // A send whose answer was lost, found written by a later check.
  settled: { words: string } | null
  // The device's clock at the last answer: what the day lines are read from.
  now: number
}

export type SendResult = { status: 'sent' } | { status: 'refused'; reason: SendRefusal } | { status: 'over' }
// `gone`: the message has left, or a check has been asked to bring its held
// row. `over`: the page moved on first.
export type RemoveResult = 'gone' | 'refused' | 'unreachable' | 'over'

export interface ChatSession {
  close: () => void
  retry: () => void
  showEarlier: () => void
  send: (words: string) => Promise<SendResult>
  forgetLost: () => void
  remove: (id: string) => Promise<RemoveResult>
}

function blank(place: ChatPlace): ChatSnapshot {
  return {
    key: placeKey(place),
    status: 'loading',
    subject: null,
    entries: [],
    older: false,
    earlier: 'idle',
    mayModerate: false,
    checksFailing: false,
    arrived: null,
    newest: 0,
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
    const [group, chat] = await Promise.all([readGroup(place.id), readNewest(place)])
    if (group.status === 'notFound' || chat.status === 'notFound') return { status: 'notFound' }
    if (group.status !== 'loaded' || chat.status !== 'ok') return { status: 'failed' }
    return { status: 'ok', subject: { kind: 'group', group: group.value }, page: chat.value }
  }
  const gathering = await readChatGathering(place.id)
  if (gathering.status !== 'ok') return gathering
  if (!viewOf(gathering.value.caller_view).full) return { status: 'notFound' }
  const chat = await readNewest(place)
  if (chat.status !== 'ok') return chat
  return { status: 'ok', subject: { kind: 'gathering', gathering: gathering.value }, page: chat.value }
}

export function openChat(place: ChatPlace, publish: (snapshot: ChatSnapshot) => void): ChatSession {
  let closed = false
  let snapshot = blank(place)
  let list = EMPTY_CHAT
  let asOf = ''
  // Moves when the list is replaced, so an earlier page asked for before is
  // never joined to it.
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
    emit({ entries: entriesOf(list).filter(canDraw), older: list.older !== null, ...patch })
    settleLost()
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
      emit(settling ? { newest: snapshot.newest + 1 } : { settled: { words } })
      return
    }
  }

  // There is no chat here for this person any more: everything read is let go.
  function over() {
    clearTimer()
    list = EMPTY_CHAT
    lost = null
    emit({ ...blank(place), status: 'notFound' })
  }

  async function first() {
    const answer = await readFirst(place)
    if (closed) return
    if (answer.status === 'notFound') return over()
    if (answer.status === 'failed') return emit({ status: 'failed' })
    asOf = answer.page.as_of
    change(
      { type: 'first', items: answer.page.items, older: answer.page.older },
      {
        status: 'loaded',
        subject: answer.subject,
        mayModerate: answer.page.may_moderate,
        now: Date.now(),
      },
    )
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

  async function check(): Promise<Landed> {
    const answer = await checkChat(place, asOf)
    if (moved()) return 'ok'
    if (answer.status !== 'ok') return answer.status
    const { value } = answer
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
    if (value.items.length === 0 && value.removed.length === 0) {
      emit({ now: Date.now() })
      return 'ok'
    }
    change({ type: 'check', items: value.items, removed: value.removed }, { now: Date.now() })
    const brought = value.items.filter((item) => !known.has(item.id) && list.byId.get(item.id) === item)
    announce(brought)
    followSetting(brought)
    return 'ok'
  }

  async function fresh(): Promise<Landed> {
    sentSince = []
    const answer = await readNewest(place)
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
    change(
      { type: 'first', items: value.items, older: value.older, forgetLeft },
      { earlier: 'idle', now: Date.now() },
    )
    forgetLeft = false
    for (const item of meanwhile) change({ type: 'sent', item })
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
    if (runs) emit({ mayModerate: true, earlier: 'idle' })
    else change({ type: 'heldGone' }, { mayModerate: false, earlier: 'idle' })
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

  async function send(words: string): Promise<SendResult> {
    lost = null
    const before = new Set(list.byId.keys())
    const outcome = await sendMessage(place, words)
    if (moved()) return { status: 'over' }
    if (outcome.status === 'sent') {
      sentSince?.push(outcome.item)
      change({ type: 'sent', item: outcome.item }, { newest: snapshot.newest + 1 })
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

  // On the tab's return, at once; straight after one left in flight.
  function onVisibility() {
    if (document.hidden) return clearTimer()
    void checkNow()
  }

  document.addEventListener('visibilitychange', onVisibility)
  void first()

  return {
    close() {
      closed = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      for (const serve of waiting) serve()
      waiting = []
    },
    retry() {
      if (closed || snapshot.status !== 'failed') return
      emit({ status: 'loading' })
      void first()
    },
    showEarlier: () => void showEarlier(),
    send,
    // Not while the send is still being asked after: it would end as one that
    // never arrived though it was written, and be sent twice.
    forgetLost() {
      if (lost !== null && !lost.settling) lost = null
    },
    remove,
  }
}

export interface Chat extends ChatSnapshot {
  retry: () => void
  showEarlier: () => void
  send: (words: string) => Promise<SendResult>
  forgetLost: () => void
  remove: (id: string) => Promise<RemoveResult>
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
  const send = useCallback(async (words: string) => session.current?.send(words) ?? OVER, [])
  const forgetLost = useCallback(() => session.current?.forgetLost(), [])
  const remove = useCallback(async (item: string): Promise<RemoveResult> => session.current?.remove(item) ?? 'over', [])

  // A snapshot for another place counts as loading.
  const shown = held !== null && held.key === key ? held : blank(place)
  return { ...shown, retry, showEarlier, send, forgetLost, remove }
}
