// The fake server behind CK-96's focus tests: the reads and acts of sign-in,
// Your plan, the group's link landing, the menu, the calendar, the two lists,
// a group's page and its People page, the group gathering form, a gathering's
// page and Settings' passkeys — each a named key a test can hold on a gate,
// fail, or answer, so every row of the kickoff's §4 can be staged with the
// request held and focus dropped to the body while it waits.
import { vi } from 'vitest'
import type { Gate } from './focus'

export type Key =
  | 'me'
  | 'groups'
  | 'gatherings'
  | 'group'
  | 'members'
  | 'strip'
  | 'groupMedia'
  | 'link'
  | 'requests'
  | 'groupInvitations'
  | 'groupRevoke'
  | 'groupCalendar'
  | 'calendar'
  | 'detail'
  | 'rsvps'
  | 'roster'
  | 'revoke'
  | 'coHosts'
  | 'places'
  | 'billing'
  | 'checkout'
  | 'portal'
  | 'passkeys'
  | 'requestLink'
  | 'passkeyBegin'
  | 'preview'
  | 'join'
  | 'media'

export interface Answer {
  status: number | 'network'
  body?: unknown
}

const DAY = 24 * 60 * 60 * 1000
export const GROUP = { id: 'grp-1', name: 'The Lees' }

function iso(offset: number) {
  return new Date(Date.now() + offset).toISOString()
}

function occurrence(id: string, gatheringId: string, startsAt: string) {
  return { id, gathering_id: gatheringId, starts_at: startsAt, ends_at: null, location: null, map_url: null, caller_response: null }
}

export const FREE_BILLING = {
  plan: null,
  status: null,
  current_period_end: null,
  ends_at: null,
  allowance: 10000,
  used: 1234,
  scheduled_change: null,
  plans: [
    { plan: null, allowance: 10000, monthly_price_cents: null },
    { plan: 'photos_100k', allowance: 100000, monthly_price_cents: 499 },
    { plan: 'photos_300k', allowance: 300000, monthly_price_cents: 999 },
  ],
  next: 'checkout',
}

export function paidBilling() {
  return { ...FREE_BILLING, plan: 'photos_100k', status: 'active', current_period_end: iso(20 * DAY), allowance: 100000, next: 'portal' }
}

export interface World96 {
  groups: Record<string, unknown>[]
  gatherings: Record<string, unknown>[]
  detail: Record<string, Record<string, unknown>>
  own: Record<string, unknown> | null
  pending: { id: string; channel: string; destination: string; created_at: string; expires_at: string }[]
  groupPending: { id: string; channel: string; destination: string; created_at: string; expires_at: string }[]
  billing: Record<string, unknown>
  passkeys: unknown[]
  preview: { status: string; group_name: string | null }
  joinAnswer: { status: string; group_id: string | null }
  hold: Partial<Record<Key, Gate>>
  // A persistent failure: every request on the key answers it until cleared.
  fail: Partial<Record<Key, Answer>>
  answer: Partial<Record<Key, Answer>>
  log: string[]
  // Requests not yet answered: a test waits for none before it presses, so
  // the app has settled (its first reads, the profile) and nothing from the
  // first render lands after the press.
  inflight: number
}

export let world96: World96

function groupBody() {
  return {
    id: GROUP.id,
    name: GROUP.name,
    group_type: 'HOUSEHOLD',
    admin_person_id: 'person-ada',
    member_count: 3,
    caller_role: 'admin',
    cover: null,
    created_at: '2026-10-27T12:00:00+00:00',
    updated_at: null,
  }
}

export function gatheringDetail(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const inGroup = id === 'g-2'
  return {
    id,
    gathering_type: 'potluck',
    title: inGroup ? 'The Group Party' : 'The Party',
    memorial_decedent_name: null,
    requires_approval: false,
    requires_approval_override: null,
    rsvp_list_visibility: 'INVITEES',
    publication_state: 'live',
    created_by_account_id: 'acct-ada',
    host_account_id: 'acct-ada',
    caller_role: 'host',
    caller_view: 'full',
    group: inGroup ? GROUP : null,
    cover: null,
    created_at: '2026-11-01T12:00:00+00:00',
    updated_at: null,
    occurrences: [occurrence(`occ-${id}`, id, iso(7 * DAY)), occurrence(`occ-${id}-b`, id, iso(14 * DAY))],
    outside_invitations: inGroup ? { on: false, since: null, by: null, may_change: false } : null,
    caller_in_group: inGroup ? true : null,
    outside_alert: inGroup ? false : null,
    ...over,
  }
}

function listItem(id: string, title: string, group: typeof GROUP | null) {
  return {
    id,
    gathering_type: 'potluck',
    title,
    caller_view: 'full',
    group,
    cover: null,
    next_occurrence: occurrence(`occ-${id}`, id, iso(7 * DAY)),
    occurrence_count: 1,
    caller_role: 'host',
  }
}

export function resetWorld96() {
  world96 = {
    groups: [groupBody()],
    gatherings: [listItem('g-2', 'The Group Party', GROUP), listItem('g-1', 'The Party', null)],
    detail: { 'g-1': gatheringDetail('g-1'), 'g-2': gatheringDetail('g-2') },
    own: null,
    pending: [{ id: 'inv-dora', channel: 'EMAIL', destination: 'dora@example.com', created_at: iso(-DAY), expires_at: iso(6 * DAY) }],
    groupPending: [{ id: 'ginv-dora', channel: 'EMAIL', destination: 'dora@example.com', created_at: iso(-DAY), expires_at: iso(6 * DAY) }],
    billing: FREE_BILLING,
    passkeys: [],
    preview: { status: 'valid', group_name: GROUP.name },
    joinAnswer: { status: 'requested', group_id: null },
    hold: {},
    fail: {},
    answer: {},
    log: [],
    inflight: 0,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status })
}

// Hold the request while the test asks, then answer a failure or an answer
// the test set, else the success `ok` gives.
async function reply(key: Key, ok: () => Response): Promise<Response> {
  world96.log.push(key)
  const w = world96
  w.inflight += 1
  try {
    await w.hold[key]?.promise
    const given = w.fail[key] ?? w.answer[key]
    if (given !== undefined) {
      if (given.status === 'network') throw new TypeError('Failed to fetch')
      return json(given.status, given.body ?? { detail: 'refused' })
    }
    return ok()
  } finally {
    w.inflight -= 1
  }
}

export function stubWorld96() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      const w = world96
      if (p === '/health') return json(200, { status: 'ok' })
      if (p === '/auth/me') {
        return reply('me', () =>
          json(200, { id: 'person-ada', display_name: 'Ada Test', email: 'ada@example.com', timezone: 'America/Chicago', account_id: 'acct-ada' }),
        )
      }
      if (p === '/auth/request-link' && method === 'POST') return reply('requestLink', () => json(202, {}))
      if (p === '/auth/passkey/begin' && method === 'POST') return reply('passkeyBegin', () => json(500, {}))
      if (p === '/group-links/preview' && method === 'POST') return reply('preview', () => json(200, w.preview))
      if (p === '/group-links/join' && method === 'POST') return reply('join', () => json(200, w.joinAnswer))
      if (p === '/groups' && method === 'GET') return reply('groups', () => json(200, { groups: w.groups }))
      if (p === '/gatherings' && method === 'GET') return reply('gatherings', () => json(200, { gatherings: w.gatherings }))
      if (p === '/billing') return reply('billing', () => json(200, w.billing))
      if (p === '/billing/checkout' && method === 'POST') return reply('checkout', () => json(200, { url: 'https://stripe.invalid/c' }))
      if (p === '/billing/portal' && method === 'POST') return reply('portal', () => json(200, { url: 'https://stripe.invalid/p' }))
      if (p === '/me/passkeys') return reply('passkeys', () => json(200, w.passkeys))
      if (p === '/calendar') return reply('calendar', () => json(200, { dates: [], gatherings: [] }))
      if (p === `/groups/${GROUP.id}`) return reply('group', () => json(200, groupBody()))
      if (p === `/groups/${GROUP.id}/members`) {
        return reply('members', () =>
          json(200, {
            members: [
              { membership_id: 'mem-ada', person_id: 'person-ada', display_name: 'Ada Test', role: 'admin', joined_at: '2026-10-27T12:00:00+00:00', is_self: true },
              { membership_id: 'mem-bea', person_id: 'person-bea', display_name: 'Bea Test', role: 'member', joined_at: '2026-10-28T12:00:00+00:00', is_self: false },
            ],
          }),
        )
      }
      if (p === `/groups/${GROUP.id}/gatherings`) return reply('strip', () => json(200, { gatherings: [w.gatherings[0]] }))
      if (p === `/groups/${GROUP.id}/media`) return reply('groupMedia', () => json(200, { sections: [] }))
      if (p === `/groups/${GROUP.id}/calendar`) return reply('groupCalendar', () => json(200, { dates: [], gatherings: [] }))
      if (p === `/groups/${GROUP.id}/link` && method === 'GET') {
        return reply('link', () => json(200, { url: 'https://app.invalid/groups/join#token=t', expires_at: iso(14 * DAY) }))
      }
      if (p === `/groups/${GROUP.id}/join-requests`) {
        return reply('requests', () => json(200, { join_requests: [{ id: 'jr-zoe', display_name: 'Zoe Park', created_at: iso(-DAY) }] }))
      }
      if (p === `/groups/${GROUP.id}/invitations` && method === 'GET') return reply('groupInvitations', () => json(200, { pending: w.groupPending }))
      if (p.startsWith(`/groups/${GROUP.id}/invitations/`) && method === 'DELETE') {
        return reply('groupRevoke', () => {
          const id = p.split('/').pop()
          w.groupPending = w.groupPending.filter((entry) => entry.id !== id)
          return json(204, null)
        })
      }
      const g = /^\/gatherings\/(g-\d)(\/.*)?$/.exec(p)
      if (g) {
        const id = g[1]
        const rest = g[2] ?? ''
        if (rest === '' && method === 'GET') return reply('detail', () => json(200, w.detail[id]))
        if (rest === '/invitations' && method === 'GET') {
          return reply('roster', () =>
            json(200, {
              pending: id === 'g-1' ? w.pending : [],
              accepted: [{ id: 'inv-bea', display_name: 'Bea Test', accepted_at: '2026-11-02T12:00:00+00:00', from_outside: false }],
            }),
          )
        }
        if (rest === '/co-hosts' && method === 'GET') return reply('coHosts', () => json(200, { co_hosts: [] }))
        if (rest === '/places' && method === 'GET') {
          return reply('places', () =>
            json(200, { invitees_chosen: false, members: [{ membership_id: 'mem-bea', display_name: 'Bea Test', place: 'invited', co_host: false }] }),
          )
        }
        if (rest.startsWith('/media')) return reply('media', () => json(200, { media: [] }))
      }
      if (/^\/occurrences\/[\w-]+\/rsvps$/.test(p)) return reply('rsvps', () => json(200, { visibility: 'INVITEES', own: w.own, rsvps: [] }))
      if (p.startsWith('/invitations/pending/') && method === 'DELETE') {
        return reply('revoke', () => {
          const id = p.split('/').pop()
          w.pending = w.pending.filter((entry) => entry.id !== id)
          return json(204, null)
        })
      }
      if (/\/cover\/url$/.test(p)) return json(409, { detail: { code: 'no_cover' } })
      return json(404, { detail: 'Not Found' })
    }),
  )
}

// matchMedia as the frame reads it: a phone (drawer) or from 900px (column).
export function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: wide, media: '', addEventListener: () => {}, removeEventListener: () => {} })),
  )
}
