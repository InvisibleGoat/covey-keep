// The dot's store (CK-105 — the surface for CK-104's GET /chats/new;
// decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §5, §8).
// The last answer, in the page's memory alone: which of the caller's chats
// have something from someone else they haven't reached.
//
// THE PACE. It is read with the menu's reads (the menu asks on every page
// change), at once when the tab comes back, and every 60 seconds while the tab
// is visible, counted from the last answer — never while the tab is hidden and
// never two at once: an ask made while one is out is made once, after it.
//
// THE SESSION. A change of session empties it, and an answer asked for under
// the last one lands nowhere.
//
// THE OPEN CHAT. A chat whose newest message its person has reached is taken
// out at once (`clearOpenChat`), and a read that began before that cannot put
// it back; a read begun after it is the server's word again.
//
// NOTHING IS STORED ON THE DEVICE and nothing is logged.
import { useSyncExternalStore } from 'react'
import { authFetch } from './api'
import type { ChatPlace } from './chat'
import { subscribe as subscribeSession } from './session'

export const CHATS_NEW_MS = 60_000

export interface ChatsNew {
  groups: ReadonlySet<string>
  gatherings: ReadonlySet<string>
}

const NOTHING: ChatsNew = { groups: new Set(), gatherings: new Set() }

let now: ChatsNew = NOTHING
// Each session's reads are its own: an answer from an earlier one is ignored.
let session = 0
// Each read is numbered as it starts, and a cleared chat remembers the number
// of the last read begun before its clear.
let started = 0
const cleared = new Map<string, number>()
let out = false
let again = false
// The pace's timer and listener, while a frame runs it.
let running = false
let timer: ReturnType<typeof setTimeout> | null = null

const listeners = new Set<() => void>()

function publish(next: ChatsNew): void {
  now = next
  for (const listener of listeners) listener()
}

function keyOf(place: ChatPlace): string {
  return `${place.kind}:${place.id}`
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function startTimer(): void {
  stopTimer()
  if (running && !isHidden()) timer = setTimeout(askChatsNew, CHATS_NEW_MS)
}

// What the last answer said, as two sets.
export function chatsNewNow(): ChatsNew {
  return now
}

export function isNew(answer: ChatsNew, place: ChatPlace): boolean {
  return place.kind === 'group' ? answer.groups.has(place.id) : answer.gatherings.has(place.id)
}

// Ask the server again: at once where nothing is out, once after it where
// something is, and not at all while the tab is hidden.
export function askChatsNew(): void {
  if (isHidden()) return
  if (out) {
    again = true
    return
  }
  out = true
  again = false
  stopTimer()
  started += 1
  void read(session, started)
}

async function read(asked: number, number: number): Promise<void> {
  let answer: ChatsNew | null = null
  try {
    const response = await authFetch('/chats/new')
    if (response.ok) {
      const body = (await response.json()) as { groups?: unknown; gatherings?: unknown } | null
      answer = { groups: new Set(strings(body?.groups)), gatherings: new Set(strings(body?.gatherings)) }
    }
  } catch {
    // Kept as it was: a failed read says nothing.
  }
  if (asked !== session) return
  out = false
  if (answer !== null) {
    const groups = new Set([...answer.groups].filter((id) => !(number <= (cleared.get(`group:${id}`) ?? 0))))
    const gatherings = new Set(
      [...answer.gatherings].filter((id) => !(number <= (cleared.get(`gathering:${id}`) ?? 0))),
    )
    publish({ groups, gatherings })
  }
  if (again) askChatsNew()
  else startTimer()
}

// The open chat's person has reached its newest message: out at once, and no
// read begun before now brings it back.
export function clearOpenChat(place: ChatPlace): void {
  cleared.set(keyOf(place), started)
  if (!isNew(now, place)) return
  const groups = new Set(now.groups)
  const gatherings = new Set(now.gatherings)
  if (place.kind === 'group') groups.delete(place.id)
  else gatherings.delete(place.id)
  publish({ groups, gatherings })
}

function onVisibility(): void {
  if (isHidden()) stopTimer()
  else askChatsNew()
}

// The pace, for the frame's life: every minute from the last answer while the
// tab is visible, and at once on its return. The returned function stops it.
export function startChatsNew(): () => void {
  running = true
  startTimer()
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    running = false
    stopTimer()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

subscribeSession(() => {
  session += 1
  out = false
  again = false
  cleared.clear()
  publish(NOTHING)
})

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// The last answer, for a component: drawn again whenever it changes.
export function useChatsNew(): ChatsNew {
  return useSyncExternalStore(subscribeStore, chatsNewNow, chatsNewNow)
}
