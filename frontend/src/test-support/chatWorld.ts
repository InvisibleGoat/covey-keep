// The fake server and the app around it, for the chat's route tests (CK-103;
// the second pair since CK-105 — the page at the first unread, the pages on
// below it, a check by its header, typing, reactions and who left them, the
// reading place, and GET /chats/new):
// the real route table, the real AuthProvider over the real session store, and
// a chat per place that answers as backend/app/api/chat.py does — a page, a
// page back, a check, a send, a remove, and held messages for whoever runs it
// alone. A test stages what it wants otherwise: hold a request on a gate,
// refuse it, or lose it on the way (`stage`).
//
// The device's clock is stopped at NOW (Date alone; the timers run), and the
// profile's zone is forced to differ from the runner's.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { expect, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import type { ChatItem, HeldBody } from '../lib/chat'
import { clearCoverPictures } from '../lib/covers'
import { clearToken, setToken } from '../lib/session'
import { chatItem, pathOf } from './chat'
import type { Gate } from './focus'

// Tuesday, 24 November 2026, 3 in the afternoon in London's zone; 5 in the
// morning in Honolulu, and the 25th, 5 in the morning, in Kiritimati.
export const NOW = Date.parse('2026-11-24T15:00:00Z')
const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
export const ZONE = runnerZone === 'Pacific/Honolulu' ? 'Pacific/Kiritimati' : 'Pacific/Honolulu'

export const ME = 'Ann Mercer'
export const LEO = 'Leo Brandt'

export interface ChatState {
  items: ChatItem[]
  changes: ChatItem[]
  removed: string[]
  moderate: boolean
  page: number
  // The first message the caller hasn't read, as the server would find it from
  // their place; null or absent, nothing unread (the open page is the newest).
  firstUnread?: string | null
  // The other people typing, as every check answers them.
  typing?: string[]
  // The server's clock, where a test sets it; else a microsecond on each read.
  asOf?: string
}

type Kind = 'like' | 'heart' | 'laugh' | 'surprise' | 'sad' | 'thumbs_up' | 'celebrate'
const KINDS: Kind[] = ['like', 'heart', 'laugh', 'surprise', 'sad', 'thumbs_up', 'celebrate']
export interface Reaction {
  kind: Kind
  count: number | null
  mine: boolean
}
type WithReactions = ChatItem & { reactions?: Reaction[] | null }

interface Staged {
  method: string
  match: RegExp
  hold?: Gate
  status?: number
  body?: unknown
  network?: boolean
  always?: boolean
}

export interface Logged {
  method: string
  // The address as asked, then ` since=…` and ` typing=…` where a check sent
  // those headers (CK-105).
  path: string
  body: unknown
  keepalive: boolean
}

type Body = Record<string, unknown>

export interface World {
  groups: Record<string, Body>
  gatherings: Record<string, Body>
  chats: Record<string, ChatState>
  log: Logged[]
  inflight: number
  staged: Staged[]
  sent: number
  asOf: number
  // GET /chats/new's answer.
  chatsNew: { groups: string[]; gatherings: string[] }
  // GET /messages/{id}/reactions's answer, where a test sets one; the PUT
  // keeps it in step with the caller's own.
  who: Record<string, { kind: Kind; names: string[] }[]>
  // Each message's reactions as the server holds them: other people's count
  // and whether the caller's is there, kind by kind.
  tables: Record<string, Partial<Record<Kind, { others: number; mine: boolean }>>>
}

export let world: World

function groupBody(id: string, name: string, over: Body = {}): Body {
  return {
    id,
    name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ann',
    member_count: 3,
    caller_role: 'member',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
    ...over,
  }
}

function occurrence(gatheringId: string, startsAt: string) {
  return {
    id: `occ-${gatheringId}`,
    gathering_id: gatheringId,
    starts_at: startsAt,
    ends_at: null,
    location: null,
    map_url: null,
    caller_response: null,
  }
}

export const LEES = { id: 'g-1', name: 'The Lees' }

export function gatheringBody(id: string, title: string, over: Body = {}): Body {
  return {
    id,
    gathering_type: 'potluck',
    title,
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-leo',
    host_account_id: 'acct-leo',
    caller_role: null,
    caller_view: 'full',
    group: LEES,
    cover: null,
    created_at: '2026-11-01T12:00:00+00:00',
    updated_at: null,
    occurrences: [occurrence(id, '2026-12-05T18:00:00+00:00')],
    outside_invitations: { on: false, since: null, by: null, may_change: false },
    caller_in_group: true,
    outside_alert: false,
    invited_count: 4,
    ...over,
  }
}

export function resetWorld() {
  world = {
    groups: {
      'g-1': groupBody('g-1', 'The Lees'),
      'g-2': groupBody('g-2', 'Finch', { member_count: 1 }),
    },
    gatherings: {
      // A group's gathering, its member's.
      'x-1': gatheringBody('x-1', 'Dinner'),
      // A standalone one.
      'x-2': gatheringBody('x-2', 'Book Club', {
        group: null,
        outside_invitations: null,
        caller_in_group: null,
        outside_alert: null,
      }),
      // Only shared with the caller: the photos-only view.
      'x-3': gatheringBody('x-3', 'Surprise', {
        caller_view: 'memory',
        occurrences: null,
        rsvp_list_visibility: null,
        invited_count: null,
      }),
      // The caller is from outside the group.
      'x-4': gatheringBody('x-4', 'Picnic', {
        outside_invitations: { on: true, since: '2026-11-20T12:00:00+00:00', by: LEO, may_change: false },
        caller_in_group: false,
      }),
    },
    chats: {},
    log: [],
    inflight: 0,
    staged: [],
    sent: 0,
    asOf: 0,
    chatsNew: { groups: [], gatherings: [] },
    who: {},
    tables: {},
  }
}

export function chatOf(key: string): ChatState {
  world.chats[key] ??= { items: [], changes: [], removed: [], moderate: false, page: 50 }
  return world.chats[key]
}

// Someone says something while the chat is open: the next check brings it.
export function say(key: string, item: ChatItem) {
  const chat = chatOf(key)
  chat.items.push(item)
  chat.changes.push(item)
}

// A message leaves, as the route has it: whoever runs the chat is sent it
// held, everyone else its id.
export function takeOut(key: string, id: string, held: Partial<HeldBody> = {}) {
  const chat = chatOf(key)
  const at = chat.items.findIndex((item) => item.id === id)
  if (at === -1) return
  const item = chat.items[at]
  if (!chat.moderate) {
    chat.items.splice(at, 1)
    chat.changes = chat.changes.filter((change) => change.id !== id)
    chat.removed.push(id)
    return
  }
  const removed: ChatItem = {
    ...item,
    removed: {
      at: new Date(NOW).toISOString(),
      by: ME,
      by_writer: item.author.is_self,
      by_self: true,
      ...held,
    },
  }
  chat.items[at] = removed
  chat.changes = [...chat.changes.filter((change) => change.id !== id), removed]
}

export function stage(method: string, match: RegExp, how: Omit<Staged, 'method' | 'match'>) {
  world.staged.push({ method, match, ...how })
}

// What was asked, in order.
export function asked(match: RegExp, method = 'GET'): Logged[] {
  return world.log.filter((call) => call.method === method && match.test(call.path))
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

const notFound = () => json(404, { detail: 'Not Found' })

function isMemorial(key: string): boolean {
  const [kind, id] = key.split(':')
  return kind === 'gathering' && world.gatherings[id]?.gathering_type === 'memorial'
}

function findItem(id: string) {
  for (const [key, chat] of Object.entries(world.chats)) {
    const index = chat.items.findIndex((item) => item.id === id)
    if (index !== -1) return { key, chat, index, item: chat.items[index] as WithReactions }
  }
  return null
}

function tableOf(item: WithReactions) {
  world.tables[item.id] ??= Object.fromEntries(
    (item.reactions ?? []).map((one) => [
      one.kind,
      { others: one.count === null ? (one.mine ? 0 : 1) : one.count - (one.mine ? 1 : 0), mine: one.mine },
    ]),
  )
  return world.tables[item.id]
}

// A message's reactions from the server's table: the kinds in their own order,
// no count in a memorial's chat.
function reactionsFrom(key: string, id: string): Reaction[] {
  const table = world.tables[id] ?? {}
  return KINDS.flatMap((kind) => {
    const one = table[kind]
    if (one === undefined || one.others + (one.mine ? 1 : 0) === 0) return []
    return [{ kind, count: isMemorial(key) ? null : one.others + (one.mine ? 1 : 0), mine: one.mine }]
  })
}

function answer(
  method: string,
  path: string,
  body: unknown,
  headers: { since: string | null; typing: string | null } = { since: null, typing: null },
): Response {
  const [p, query = ''] = path.split('?')
  const params = new URLSearchParams(query)

  if (p === '/chats/new' && method === 'GET') return json(200, world.chatsNew)

  const reactionsPath = /^\/messages\/([^/]+)\/reactions$/.exec(p)
  if (reactionsPath) {
    const found = findItem(reactionsPath[1])
    if (found === null || found.item.removed !== null) return notFound()
    if (found.item.kind !== 'message') {
      return json(409, { detail: { code: 'not_a_message', message: 'A line the chat wrote itself takes no reactions.' } })
    }
    const { key, chat, index, item } = found
    if (method === 'GET') {
      return json(200, {
        reactions:
          world.who[item.id] ??
          (item.reactions ?? []).map((one) => ({ kind: one.kind, names: one.mine ? [ME] : [] })),
      })
    }
    if (method === 'PUT') {
      const { kind, on } = body as { kind: Kind; on: boolean }
      const table = tableOf(item)
      table[kind] = { others: table[kind]?.others ?? 0, mine: on }
      const reactions = reactionsFrom(key, item.id)
      const updated = { ...item, reactions } as ChatItem
      chat.items[index] = updated
      chat.changes = [...chat.changes.filter((change) => change.id !== item.id), updated]
      const who = world.who[item.id]
      if (who !== undefined) {
        const names = (who.find((one) => one.kind === kind)?.names ?? []).filter((name) => name !== ME)
        const next = on ? [...names, ME] : names
        world.who[item.id] = KINDS.flatMap((one) => {
          if (one === kind) return next.length > 0 ? [{ kind, names: next }] : []
          const other = who.find((each) => each.kind === one)
          return other === undefined ? [] : [other]
        })
      }
      return json(200, { reactions })
    }
    return notFound()
  }

  const chatPath = /^\/(groups|gatherings)\/([^/]+)\/chat(\/read)?$/.exec(p)
  if (chatPath) {
    const kind = chatPath[1] === 'groups' ? 'group' : 'gathering'
    const known = kind === 'group' ? world.groups[chatPath[2]] : world.gatherings[chatPath[2]]
    if (!known || (kind === 'gathering' && known.caller_view !== 'full')) return notFound()
    const chat = chatOf(`${kind}:${chatPath[2]}`)
    // The reading place: moved forward by the server, answered with nothing.
    if (chatPath[3] === '/read') return method === 'PUT' ? new Response(null, { status: 204 }) : notFound()
    world.asOf += 1
    const as_of = chat.asOf ?? `2026-11-24T15:00:00.${String(world.asOf).padStart(6, '0')}+00:00`
    if (method === 'POST') {
      world.sent += 1
      const item = chatItem(`sent-${world.sent}`, {
        created_at: new Date(NOW + world.sent).toISOString(),
        author: { display_name: ME, is_self: true },
        body: (body as { body: string }).body,
      })
      chat.items.push(item)
      chat.changes.push(item)
      return json(201, item)
    }
    const shown = chat.items.filter((item) => chat.moderate || item.removed === null)
    // A check: since CK-105 its instant in X-Chat-Since, as the route still
    // takes it in the query too.
    if (headers.since !== null || params.has('since')) {
      return json(200, {
        items: chat.changes.filter((item) => chat.moderate || item.removed === null),
        removed: chat.removed,
        truncated: false,
        as_of,
        may_moderate: chat.moderate,
        typing: chat.typing ?? [],
      })
    }
    const limit = Number(params.get('limit') ?? chat.page)
    // On below a cursor, oldest first (a cursor here is an index into what the
    // caller is shown).
    if (params.has('after')) {
      const start = Number(params.get('after'))
      const end = Math.min(shown.length, start + limit)
      return json(200, {
        items: shown.slice(start, end),
        newer: end < shown.length ? String(end) : null,
        as_of,
        may_moderate: chat.moderate,
      })
    }
    const opening = params.get('open') === 'true'
    if (opening && chat.firstUnread != null) {
      const at = shown.findIndex((item) => item.id === chat.firstUnread)
      if (at !== -1) {
        const start = Math.max(0, at - Math.min(20, limit - 1))
        const end = Math.min(shown.length, start + limit)
        const unread = shown
          .slice(at)
          .filter((item) => item.kind === 'message' && item.removed === null && !item.author.is_self).length
        return json(200, {
          items: shown.slice(start, end),
          older: start > 0 ? String(start) : null,
          newer: end < shown.length ? String(end) : null,
          first_unread: chat.firstUnread,
          unread: Math.min(100, unread),
          as_of,
          may_moderate: chat.moderate,
        })
      }
    }
    const end = params.has('before') ? Number(params.get('before')) : shown.length
    const start = Math.max(0, end - limit)
    const page = {
      items: shown.slice(start, end),
      older: start > 0 ? String(start) : null,
      as_of,
      may_moderate: chat.moderate,
    }
    return json(200, opening ? { ...page, first_unread: null, unread: 0, newer: null } : page)
  }

  const removePath = /^\/messages\/([^/]+)\/remove$/.exec(p)
  if (removePath && method === 'POST') {
    for (const key of Object.keys(world.chats)) takeOut(key, removePath[1])
    return new Response(null, { status: 204 })
  }

  if (p === '/auth/me') {
    return json(200, {
      id: 'person-ann',
      display_name: ME,
      email: 'ann@example.com',
      timezone: ZONE,
      account_id: 'acct-ann',
    })
  }
  if (p === '/groups') return json(200, { groups: Object.values(world.groups) })
  if (p === '/gatherings') return json(200, { gatherings: Object.values(world.gatherings).map(listItem) })
  const group = /^\/groups\/([^/]+)(\/[a-z]+)?$/.exec(p)
  if (group) {
    const known = world.groups[group[1]]
    if (!known) return notFound()
    if (group[2] === undefined) return json(200, known)
    if (group[2] === '/media') return json(200, { sections: [] })
    if (group[2] === '/gatherings') {
      return json(200, {
        gatherings: Object.values(world.gatherings)
          .filter((item) => (item.group as { id: string } | null)?.id === group[1])
          .map(listItem),
      })
    }
  }
  const gathering = /^\/gatherings\/([^/]+)(\/[a-z-]+)?$/.exec(p)
  if (gathering) {
    const known = world.gatherings[gathering[1]]
    if (!known) return notFound()
    if (gathering[2] === undefined) return json(200, known)
    if (gathering[2] === '/media') return json(200, { media: [] })
    if (gathering[2] === '/places') return json(200, { places: [] })
    if (gathering[2] === '/invitations') return json(200, { pending: [], accepted: [] })
    if (gathering[2] === '/co-hosts') return json(200, { co_hosts: [] })
  }
  return notFound()
}

function listItem(body: Body): Body {
  const { occurrences, ...rest } = body
  const dates = occurrences as { id: string; starts_at: string }[] | null
  return {
    ...rest,
    next_occurrence: dates ? { id: dates[0].id, starts_at: dates[0].starts_at } : null,
    occurrence_count: dates ? dates.length : null,
  }
}

export function stubServer() {
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const since = headers.get('x-chat-since')
    const typing = headers.get('x-chat-typing')
    const address = pathOf(input)
    const path = `${address}${since === null ? '' : ` since=${since}`}${typing === null ? '' : ` typing=${typing}`}`
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    world.log.push({ method, path, body, keepalive: init.keepalive === true })
    world.inflight += 1
    try {
      const at = world.staged.findIndex((one) => one.method === method && one.match.test(path))
      const one = at === -1 ? null : world.staged[at]
      if (one && !one.always) world.staged.splice(at, 1)
      if (one?.hold) await one.hold.promise
      if (one?.network) throw new TypeError('Failed to fetch')
      if (one?.status !== undefined) {
        return one.status === 204 ? new Response(null, { status: 204 }) : json(one.status, one.body ?? {})
      }
      return answer(method, address, body, { since, typing })
    } finally {
      world.inflight -= 1
    }
  })
}

// matchMedia as the app reads it: the frame's breakpoint, and whether the
// pointer is a fine one that hovers.
export function stubScreen({ wide = false, hover = false } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 900px') ? wide : query.includes('hover: hover') ? hover : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

export let navigate: NavigateFunction
export let address = ''

function Probe() {
  const location = useLocation()
  navigate = useNavigate()
  address = location.pathname + location.search + location.hash
  return null
}

export function renderApp(at: string, { strict = false } = {}) {
  const app = createElement(
    MemoryRouter,
    { initialEntries: [at] },
    createElement(AuthProvider, null, createElement(App)),
    createElement(Probe),
  )
  return render(strict ? createElement(StrictMode, null, app) : app)
}

export async function go(to: string | number) {
  await act(async () => {
    if (typeof to === 'number') await navigate(to)
    else await navigate(to)
  })
}

// Every request answered, and what the answers drew drawn.
export async function quiet() {
  await waitFor(() => expect(world.inflight).toBe(0))
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
}

// A check at once, as the tab's return asks for one, and its answer landed.
// MOVED AT CK-105, with its reason: a check is known by its X-Chat-Since header
// (THE DESIGN §1), which the log writes as ` since=`; the query's form is
// still read, so the unchanged code's checks count too.
export const CHECKED = /[? ]since=/
export async function check() {
  const before = asked(CHECKED).length
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => expect(asked(CHECKED).length).toBeGreaterThan(before))
  await quiet()
}

// The chat open at an address, its first read landed.
export async function openChatAt(at: string, options: { strict?: boolean } = {}) {
  const view = renderApp(at, options)
  await screen.findByRole('region', { name: 'Messages' })
  await quiet()
  return view
}

export const thread = () => screen.getByRole('region', { name: 'Messages' })
export const box = () => screen.getByRole<HTMLTextAreaElement>('textbox')
export const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' })
export const live = () => document.querySelector<HTMLElement>('[aria-live="polite"]')

export function type(words: string) {
  fireEvent.change(box(), { target: { value: words } })
}

// A message of someone's, some minutes before NOW.
export function said(id: string, minutes: number, over: Partial<ChatItem> = {}): ChatItem {
  return chatItem(id, { created_at: new Date(NOW - minutes * 60_000).toISOString(), ...over })
}

export function mine(id: string, minutes: number, over: Partial<ChatItem> = {}): ChatItem {
  return said(id, minutes, { author: { display_name: ME, is_self: true }, ...over })
}

export function startWorld(screenSize: { wide?: boolean; hover?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  resetWorld()
  stubServer()
  stubScreen(screenSize)
  setToken('session-test')
}

// --- the thread's geometry, as the browser would measure it (CK-105) ----------------
//
// A thread 400 tall whose list starts 100 down, each entry `tall(li)` tall (100
// unless a test says otherwise), the place of each arithmetic; the sentinel
// sits at the list's end. jsdom has no layout, so this is all a test can see.
// `resize` changes the thread's own height, as a phone's keyboard does, and
// fires the scroll event the browser fires with it.

export interface Geometry {
  readonly top: number
  at: (value: number) => Promise<void>
  bottom: () => number
  place: (element: Element) => { top: number; bottom: number }
  resize: (height: number) => Promise<void>
}

export function stubGeometry(tall: (li: HTMLLIElement) => number = () => 100): Geometry {
  const isThread = (element: Element) => element.classList.contains('thread')
  const rows = (threadElement: Element) => [...threadElement.querySelectorAll('li')]
  const height = (threadElement: Element) => 100 + rows(threadElement).reduce((sum, li) => sum + tall(li), 0)
  let top = 0
  let view = 400
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return isThread(this) ? height(this) : 0
  })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return isThread(this) ? view : 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return isThread(this) ? top : 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (isThread(this)) top = Math.max(0, Math.min(value, height(this) - view))
  })
  const place = (element: Element) => {
    const threadElement = element.closest('.thread')
    if (threadElement === null) return { top: 0, bottom: 0 }
    if (element === threadElement) return { top: 0, bottom: view }
    if (element.classList.contains('sentinel')) {
      const end = height(threadElement) - top
      return { top: end, bottom: end + 1 }
    }
    if (element.tagName !== 'LI') return { top: 0, bottom: 0 }
    let at = 100 - top
    for (const li of rows(threadElement)) {
      if (li === element) return { top: at, bottom: at + tall(li) }
      at += tall(li)
    }
    return { top: 0, bottom: 0 }
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { top: y, bottom } = place(this)
    return { top: y, bottom, height: bottom - y, left: 0, right: 0, width: 0, x: 0, y } as DOMRect
  })
  return {
    get top() {
      return top
    },
    at: async (value: number) => {
      top = value
      await act(async () => void fireEvent.scroll(thread()))
      await observers.look()
    },
    bottom: () => height(thread()) - view,
    place,
    resize: async (value: number) => {
      view = value
      top = Math.max(0, Math.min(top, height(thread()) - view))
      await act(async () => void fireEvent.scroll(thread()))
      await observers.look()
    },
  }
}

// IntersectionObserver as the browser has it: an observer calls back only
// after `observe()` (the Gotcha's rule 2), with what is in its root's box
// widened by its margin, and again on `look()`, as after a scroll.
interface Watch {
  callback: IntersectionObserverCallback
  observer: IntersectionObserver
  root: Element | null
  margin: number
  targets: Set<Element>
}

let watches: Watch[] = []

export const observers = {
  // How many watch something now.
  count: () => watches.filter((watch) => watch.targets.size > 0).length,
  async look() {
    await act(async () => {
      for (const watch of [...watches]) call(watch, [...watch.targets])
    })
  },
}

function call(watch: Watch, targets: Element[]) {
  if (targets.length === 0 || !watches.includes(watch)) return
  const view = watch.root?.getBoundingClientRect() ?? ({ top: 0, bottom: 400 } as DOMRect)
  const entries = targets.map((target) => {
    const box = target.getBoundingClientRect()
    const isIntersecting = box.bottom > view.top - watch.margin && box.top < view.bottom + watch.margin
    return {
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: box,
      rootBounds: view,
      intersectionRect: box,
      time: 0,
    } as IntersectionObserverEntry
  })
  watch.callback(entries, watch.observer)
}

export function stubObservers() {
  watches = []
  class FakeObserver {
    readonly root: Element | null
    readonly rootMargin: string
    readonly thresholds: number[] = [0]
    private readonly watch: Watch
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.root = (options.root as Element | null | undefined) ?? null
      this.rootMargin = options.rootMargin ?? '0px'
      this.watch = {
        callback,
        observer: this as unknown as IntersectionObserver,
        root: this.root,
        margin: Number.parseFloat(this.rootMargin) || 0,
        targets: new Set(),
      }
      watches.push(this.watch)
    }
    observe(target: Element) {
      this.watch.targets.add(target)
      setTimeout(() => call(this.watch, [target]), 0)
    }
    unobserve(target: Element) {
      this.watch.targets.delete(target)
    }
    disconnect() {
      this.watch.targets.clear()
      watches = watches.filter((watch) => watch !== this.watch)
    }
    takeRecords() {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
}

// The tab hidden or shown, as the browser says it and tells the page.
export async function setHidden(value: boolean) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(value)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value ? 'hidden' : 'visible')
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
}

// The marks of the reading place asked, in order.
export const marksAsked = () => world.log.filter((call) => call.method === 'PUT' && /\/chat\/read$/.test(call.path))

export function endWorld() {
  watches = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearCoverPictures()
  clearToken()
  localStorage.clear()
  sessionStorage.clear()
}
