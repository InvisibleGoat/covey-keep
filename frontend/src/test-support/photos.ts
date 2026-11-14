// CK-95 — the fake server behind the photos' focus tests (routes/focus-photos,
// focus-viewer and focus-covers): a gathering's Photos section, its acts, the
// viewer's layers, the uploads, the covers and a group's page, each answer
// mutating the world as the backend would. A test sets `photosWorld.answer[key]`
// to refuse an act and `photosWorld.hold[key]` to hold it on a released
// promise (test-support/focus.ts). Only test files import this.
import { vi } from 'vitest'
import type { Gate } from './focus'

export const DAY = 24 * 60 * 60 * 1000
const nextWeek = () => new Date(Date.now() + 7 * DAY).toISOString()
const ADDED_AT = '2026-11-01T13:00:00+00:00'

export const GROUP = { id: 'grp-95', name: 'The Lees' }

export type Row = Record<string, unknown> & { id: string; _bin?: boolean }

// A photograph: someone else's published one unless `over` says otherwise.
// Its filename is its name on screen (no caption).
export function photo(id: string, over: Record<string, unknown> = {}): Row {
  return {
    id,
    gathering_id: 'g-1',
    occurrence_id: null,
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: ADDED_AT,
    created_at: ADDED_AT,
    uploader_display_name: 'Nate Okafor',
    is_own: false,
    removed_at: null,
    filename: `IMG_${id}.jpg`,
    caption: null,
    tags: [],
    published_at: ADDED_AT,
    failure_reason: null,
    ...over,
  }
}

export const own = { is_own: true, uploader_display_name: 'Ada Test' }
export const waiting = { publication_state: 'pending', published_at: null }
export const inOwnBin = () => ({ ...own, publication_state: 'removed', removed_at: new Date(Date.now() - DAY).toISOString() })
export const inGatheringBin = () => ({
  publication_state: 'removed',
  removed_at: new Date(Date.now() - DAY).toISOString(),
  _bin: true,
})

export function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g-1',
    gathering_type: 'potluck',
    title: 'The Party',
    memorial_decedent_name: null,
    requires_approval: true,
    requires_approval_override: true,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-ada',
    host_account_id: 'acct-ada',
    caller_role: 'host',
    caller_view: 'full',
    group: null,
    cover: null,
    created_at: '2026-11-01T12:00:00+00:00',
    updated_at: null,
    occurrences: [
      { id: 'occ-1', gathering_id: 'g-1', starts_at: nextWeek(), ends_at: null, location: null, map_url: null, caller_response: null },
    ],
    outside_invitations: null,
    caller_in_group: null,
    outside_alert: null,
    ...over,
  }
}

export type Key =
  | 'publish'
  | 'decline'
  | 'remove'
  | 'restore'
  | 'destroy'
  | 'dismiss'
  | 'patch'
  | 'batch'
  | 'intents'
  | 'confirm'
  | 'list'
  | 'gatheringCover'
  | 'groupCover'
  | 'clearCover'
  | 'coverUpload'
  | 'coverConfirm'
  | 'coverImage'
  | 'layer'
  | 'groupMedia'

export interface Answer {
  status: number
  body?: unknown
}

interface World {
  detail: Record<string, unknown>
  rows: Row[]
  groupCover: Record<string, unknown> | null
  answer: Partial<Record<Key, Answer>>
  hold: Partial<Record<Key, Gate>>
  // The next N list reads (or group media reads) answer 500.
  failList: number
  failGroupMedia: number
  // Media ids whose web layer cannot be minted.
  failLayer: Set<string>
  // Every write the server received, `METHOD path`.
  writes: string[]
  coverImageStatus: string
  minted: number
}

export const photosWorld: World = {
  detail: detail(),
  rows: [],
  groupCover: null,
  answer: {},
  hold: {},
  failList: 0,
  failGroupMedia: 0,
  failLayer: new Set(),
  writes: [],
  coverImageStatus: 'ready',
  minted: 0,
}

export function resetPhotosWorld(rows: Row[], over: Record<string, unknown> = {}) {
  photosWorld.detail = detail(over)
  photosWorld.rows = rows
  photosWorld.groupCover = null
  photosWorld.answer = {}
  photosWorld.hold = {}
  photosWorld.failList = 0
  photosWorld.failGroupMedia = 0
  photosWorld.failLayer = new Set()
  photosWorld.writes = []
  photosWorld.coverImageStatus = 'ready'
  photosWorld.minted = 0
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

export function invalid(...loc: (string | number)[]): Answer {
  return { status: 422, body: { detail: [{ loc: ['body', ...loc], msg: 'Value error, refused', type: 'value_error' }] } }
}

export function conflict(code: string, extra: Record<string, unknown> = {}): Answer {
  return { status: 409, body: { detail: { code, message: 'refused', ...extra } } }
}

async function reply(key: Key, ok: () => Response): Promise<Response> {
  await photosWorld.hold[key]?.promise
  const given = photosWorld.answer[key]
  if (given !== undefined) return json(given.status, given.body ?? { detail: 'refused' })
  return ok()
}

function bare(row: Row): Record<string, unknown> {
  const { _bin, ...rest } = row
  return rest
}

function groupBody() {
  return {
    id: GROUP.id,
    name: GROUP.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: 4,
    caller_role: 'admin',
    cover: photosWorld.groupCover,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

function listItem() {
  const d = photosWorld.detail
  return {
    id: d.id,
    gathering_type: d.gathering_type,
    title: d.title,
    memorial_decedent_name: null,
    caller_role: d.caller_role,
    caller_view: 'full',
    group: d.group,
    cover: d.cover,
    created_at: d.created_at,
    next_occurrence: (d.occurrences as { starts_at: string }[])[0],
    occurrence_count: 1,
  }
}

export function stubPhotosServer() {
  let uploads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const raw = String(url)
      if (raw.startsWith('https://r2.invalid/')) {
        if (method === 'PUT') return new Response(null, { status: 200 })
        return new Response(new Uint8Array(raw.includes('/web?') ? 100 : 3), { status: 200 })
      }
      const p = raw.replace(/^https?:\/\/[^/]+/, '')
      const path = p.split('?')[0]
      const body = () => JSON.parse(String(init?.body)) as Record<string, unknown>
      if (method !== 'GET') photosWorld.writes.push(`${method} ${path}`)
      const rows = photosWorld.rows
      const find = (id: string) => rows.find((r) => r.id === id)

      if (p === '/auth/me') {
        return json(200, {
          id: 'person-ada',
          display_name: 'Ada Test',
          email: 'ada@example.com',
          timezone: 'America/Chicago',
          account_id: 'acct-ada',
        })
      }
      if (p === '/groups') return json(200, { groups: photosWorld.detail.group === null ? [] : [groupBody()] })
      if (p === '/gatherings' && method === 'GET') return json(200, { gatherings: [listItem()] })
      if (p === '/billing') return json(404, {})
      if (p === '/gatherings/g-1' && method === 'GET') return json(200, photosWorld.detail)

      if (method === 'GET' && path === '/gatherings/g-1/media') {
        return reply('list', () => {
          if (photosWorld.failList > 0) {
            photosWorld.failList -= 1
            return json(500, { detail: 'down' })
          }
          const params = new URLSearchParams(p.split('?')[1] ?? '')
          let listed: Row[]
          if (params.get('awaiting_review') === 'true') listed = rows.filter((r) => r.status === 'ready' && r.publication_state === 'pending')
          else if (params.get('removed') === 'true') listed = rows.filter((r) => r._bin === true)
          else listed = rows.filter((r) => r._bin !== true)
          const q = (params.get('q') ?? '').toLowerCase()
          if (q) listed = listed.filter((r) => [r.caption, r.filename, ...(r.tags as string[])].some((s) => typeof s === 'string' && s.toLowerCase().includes(q)))
          return json(200, { media: listed.map(bare) })
        })
      }

      const layer = p.match(/^\/media\/([\w-]+)\/url\?layer=(\w+)$/)
      if (method === 'GET' && layer) {
        return reply('layer', () => {
          if (layer[2] === 'web' && photosWorld.failLayer.has(layer[1])) return json(500, { detail: 'down' })
          return json(200, {
            url: `https://r2.invalid/media/${layer[1]}/${layer[2]}?X-Amz-Signature=sig-${(photosWorld.minted += 1)}`,
            method: 'GET',
          })
        })
      }

      const actOn = path.match(/^\/media\/([\w-]+)\/(publish|decline|remove|restore|destroy|dismiss|confirm)$/)
      if (method === 'POST' && actOn) {
        const [, id, which] = actOn
        return reply(which as Key, () => {
          const row = find(id)
          if (row === undefined) return json(404, { detail: 'Not Found' })
          if (which === 'publish') Object.assign(row, { publication_state: 'live', published_at: ADDED_AT })
          else if (which === 'decline' || which === 'remove') {
            Object.assign(row, { publication_state: 'removed', removed_at: new Date().toISOString(), _bin: !row.is_own })
          } else if (which === 'restore') {
            const toLive = row._bin === true || photosWorld.detail.requires_approval !== true
            Object.assign(row, { publication_state: toLive ? 'live' : 'pending', removed_at: null, _bin: false })
          } else if (which === 'destroy' || which === 'dismiss') rows.splice(rows.indexOf(row), 1)
          else if (which === 'confirm') Object.assign(row, { status: 'ready', publication_state: 'live' })
          return which === 'confirm' ? json(200, bare(row)) : new Response(null, { status: 204 })
        })
      }

      const patch = path.match(/^\/media\/([\w-]+)$/)
      if (method === 'PATCH' && patch) {
        return reply('patch', () => {
          const row = find(patch[1]) as Row
          Object.assign(row, body())
          return json(200, bare(row))
        })
      }

      if (method === 'POST' && path === '/gatherings/g-1/media/publish') {
        return reply('batch', () => {
          for (const id of body().media_ids as string[]) Object.assign(find(id) as Row, { publication_state: 'live' })
          return json(200, {})
        })
      }

      if (method === 'POST' && path === '/gatherings/g-1/media/intents') {
        return reply('intents', () => {
          const items = body().items as { filename: string; content_type: string; size_bytes: number }[]
          const intents = items.map((item) => {
            uploads += 1
            const id = `up-${uploads}`
            rows.unshift(photo(id, { ...own, status: 'pending_upload', publication_state: 'pending', published_at: null, filename: item.filename }))
            return {
              media: { id, status: 'pending_upload', filename: item.filename },
              upload: { url: `https://r2.invalid/upload/${id}?X-Amz-Signature=put`, method: 'PUT', headers: { 'Content-Type': item.content_type }, expires_in: 900 },
            }
          })
          return json(201, { intents })
        })
      }

      // Covers.
      if (method === 'PUT' && path === '/gatherings/g-1/cover') {
        return reply('gatheringCover', () => {
          const cover = { source: 'photo', media_id: String(body().media_id), set_at: new Date().toISOString() }
          photosWorld.detail = { ...photosWorld.detail, cover }
          return json(200, { cover })
        })
      }
      if (method === 'PUT' && path === `/groups/${GROUP.id}/cover`) {
        return reply('groupCover', () => {
          photosWorld.groupCover = { source: 'photo', set_at: new Date().toISOString() }
          return json(200, { cover: photosWorld.groupCover })
        })
      }
      if (method === 'DELETE' && (path === '/gatherings/g-1/cover' || path === `/groups/${GROUP.id}/cover`)) {
        return reply('clearCover', () => {
          if (path.startsWith('/gatherings')) photosWorld.detail = { ...photosWorld.detail, cover: null }
          else photosWorld.groupCover = null
          return new Response(null, { status: 204 })
        })
      }
      if (method === 'POST' && (path === '/gatherings/g-1/cover/upload' || path === `/groups/${GROUP.id}/cover/upload`)) {
        return reply('coverUpload', () =>
          json(201, {
            cover_image: { id: 'ci-1', status: 'pending_upload' },
            upload: { url: 'https://r2.invalid/covers/ci-1?X-Amz-Signature=put', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, expires_in: 900 },
          }),
        )
      }
      if (method === 'POST' && path === '/cover-images/ci-1/confirm') return reply('coverConfirm', () => json(200, {}))
      if (method === 'GET' && path === '/cover-images/ci-1') {
        return reply('coverImage', () => {
          const status = photosWorld.coverImageStatus
          if (status === 'ready') {
            const cover = { source: 'upload', set_at: new Date().toISOString() }
            photosWorld.detail = { ...photosWorld.detail, cover }
            photosWorld.groupCover = cover
          }
          return json(200, { id: 'ci-1', status, failure_reason: status === 'failed' ? 'unreadable' : null })
        })
      }
      const coverUrl = path.match(/^\/(gatherings|groups)\/([\w-]+)\/cover\/url$/)
      if (method === 'GET' && coverUrl) {
        return json(200, { url: `https://r2.invalid/covers/${coverUrl[2]}/web?X-Amz-Signature=sig`, method: 'GET' })
      }

      // A group's page.
      if (p === `/groups/${GROUP.id}`) return json(200, groupBody())
      if (p === `/groups/${GROUP.id}/gatherings`) return json(200, { gatherings: [{ ...listItem(), group: GROUP }] })
      if (p === `/groups/${GROUP.id}/media`) {
        return reply('groupMedia', () => {
          if (photosWorld.failGroupMedia > 0) {
            photosWorld.failGroupMedia -= 1
            return json(500, { detail: 'down' })
          }
          const live = rows.filter((r) => r.status === 'ready' && r.publication_state === 'live')
          return json(200, {
            sections: live.length === 0 ? [] : [{ gathering_id: 'g-1', published_count: live.length, media: live.slice(0, 8).map(bare) }],
          })
        })
      }
      if (p === '/gatherings/g-1/places') return json(200, { invitees_chosen: true, members: [] })
      return json(404, { detail: 'Not Found' })
    }),
  )
}

// The accessible name a group takes from the sentence it points at.
export function labelledName(element: Element | null): string | null {
  const by = element?.getAttribute('aria-labelledby')
  if (!by) return element?.getAttribute('aria-label') ?? null
  return by
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
}

// The row on screen whose words include `name`.
export function rowOf(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li.media-item')].find((li) => li.textContent?.includes(name))
  if (!found) throw new Error(`no row for ${name}`)
  return found
}

export function rowGone(name: string): boolean {
  return ![...document.querySelectorAll<HTMLElement>('li.media-item')].some((li) => li.textContent?.includes(name))
}
