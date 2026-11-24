// The fake server and the app around it, for the chat's route tests (CK-103):
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
}

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
  path: string
  body: unknown
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

function answer(method: string, path: string, body: unknown): Response {
  const [p, query = ''] = path.split('?')
  const params = new URLSearchParams(query)

  const chatPath = /^\/(groups|gatherings)\/([^/]+)\/chat$/.exec(p)
  if (chatPath) {
    const kind = chatPath[1] === 'groups' ? 'group' : 'gathering'
    const known = kind === 'group' ? world.groups[chatPath[2]] : world.gatherings[chatPath[2]]
    if (!known || (kind === 'gathering' && known.caller_view !== 'full')) return notFound()
    const chat = chatOf(`${kind}:${chatPath[2]}`)
    world.asOf += 1
    const as_of = `2026-11-24T15:00:00.${String(world.asOf).padStart(6, '0')}+00:00`
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
    if (params.has('since')) {
      return json(200, {
        items: chat.changes.filter((item) => chat.moderate || item.removed === null),
        removed: chat.removed,
        truncated: false,
        as_of,
        may_moderate: chat.moderate,
      })
    }
    const end = params.has('before') ? Number(params.get('before')) : shown.length
    const start = Math.max(0, end - Number(params.get('limit') ?? chat.page))
    return json(200, {
      items: shown.slice(start, end),
      older: start > 0 ? String(start) : null,
      as_of,
      may_moderate: chat.moderate,
    })
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
    const path = pathOf(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    world.log.push({ method, path, body })
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
      return answer(method, path, body)
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
export async function check() {
  const before = asked(/\/chat\?since=/).length
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => expect(asked(/\/chat\?since=/).length).toBeGreaterThan(before))
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

export function endWorld() {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearCoverPictures()
  clearToken()
  localStorage.clear()
  sessionStorage.clear()
}
