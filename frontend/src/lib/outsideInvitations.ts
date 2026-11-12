// Inviting people outside the group (CK-93 — the surface for CK-92's
// backend; decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §5,
// §6, §7, §11 items 5–11). Shapes mirror backend/app/api/gatherings.py's
// outside-invitation routes and body fields exactly — see
// reference/backend/api-reference.md, the Gatherings router. lib/places.ts
// is the model: calls answering a STABLE CODE, never the server's wording,
// and every line of copy here, with the approved words (Steven, 2026-11-10;
// the record §11 item 8) as written.
//
// THE BODY DECIDES. Who may change the setting (`may_change`), who is in the
// group (`caller_in_group`) and who is shown the alert (`outside_alert`) are
// the server's answers on the detail body, read through `outsideFlags` and
// nowhere by hand — `roleFlags`' and `viewOf`'s rule: each flag is true only
// for exactly `true` (or, for `outsider`, exactly `false`), so an absent
// field, a null or a value this build does not know renders nothing new.
//
// NOTHING IS STORED ON THE DEVICE: the setting and the alert's dismissal are
// the server's, so they follow the person to every device.
import { authFetch } from './api'
import type { GatheringWithOccurrences } from './gatherings'

// `outside_invitations` on a group's gathering's body (CK-92): set exactly
// while on, with the opener's display name — null while off, and once their
// account is deleted — and whether THE CALLER may change it.
export interface OutsideInvitationsBody {
  on: boolean
  since: string | null
  by: string | null
  may_change: boolean
}

// The preview `GET /gatherings/{id}/outside-invitations` answers: what
// turning it off would do — the outsiders by display name (null for a
// deleted account) in the order they accepted, and the count of invitations
// that still work. No address, no person id.
export interface OutsidePreview {
  on: boolean
  outsiders: { display_name: string | null }[]
  pending: number
}

export interface OutsideFlags {
  // The card: the gathering's host or a co-host, or the group's admin or a
  // co-admin who can read the gathering — the server's `may_change`.
  mayChange: boolean
  on: boolean
  // The line: the caller holds a membership of the group.
  inGroup: boolean
  // The outsider's page: the caller does NOT hold a membership — exactly
  // `caller_in_group === false`, never an absent field.
  outsider: boolean
  // The alert.
  alert: boolean
}

interface OutsideFields {
  outside_invitations?: unknown
  caller_in_group?: unknown
  outside_alert?: unknown
}

export function outsideFlags(gathering: OutsideFields): OutsideFlags {
  const setting = gathering.outside_invitations
  const body = setting !== null && typeof setting === 'object' ? (setting as Record<string, unknown>) : null
  return {
    mayChange: body?.may_change === true,
    on: body?.on === true,
    inGroup: gathering.caller_in_group === true,
    outsider: gathering.caller_in_group === false,
    alert: gathering.outside_alert === true,
  }
}

// The opener's name the alert carries — the body's `by`, a string or null.
export function openerOf(gathering: OutsideFields): string | null {
  const setting = gathering.outside_invitations
  if (setting === null || typeof setting !== 'object') return null
  const by = (setting as Record<string, unknown>).by
  return typeof by === 'string' && by !== '' ? by : null
}

function codeOf(response: Response): string {
  return response.status === 404 ? 'not_found' : 'failed'
}

export type SetOutcome =
  | { ok: true; gathering: GatheringWithOccurrences }
  // `not_found` for the 404 (the caller can't change this setting any more),
  // `unreachable` for a network failure, `failed` for anything else.
  | { ok: false; code: string }

// Turn it on or off: one PUT with exactly `{"on": true|false}`, the 200 the
// caller's detail body, which replaces the gathering the page holds.
export async function setOutsideInvitations(gatheringId: string, on: boolean): Promise<SetOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/outside-invitations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    })
    if (!response.ok) return { ok: false, code: codeOf(response) }
    return { ok: true, gathering: (await response.json()) as GatheringWithOccurrences }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

export type PreviewOutcome = { ok: true; preview: OutsidePreview } | { ok: false; code: string }

// What turning it off would do — read on a turn-off press and never before.
export async function readOutsideInvitations(gatheringId: string): Promise<PreviewOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/outside-invitations`)
    if (!response.ok) return { ok: false, code: codeOf(response) }
    const body = (await response.json()) as {
      on?: unknown
      outsiders?: unknown
      pending?: unknown
    }
    const outsiders = Array.isArray(body.outsiders)
      ? (body.outsiders as { display_name?: unknown }[]).map((entry) => ({
          display_name: typeof entry?.display_name === 'string' ? entry.display_name : null,
        }))
      : []
    const pending = typeof body.pending === 'number' && body.pending > 0 ? body.pending : 0
    return { ok: true, preview: { on: body.on === true, outsiders, pending } }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

export type DismissOutcome = { ok: true } | { ok: false; code: string }

// Got it: the server keeps the dismissal (204, always, on the memory tier).
export async function dismissOutsideAlert(gatheringId: string): Promise<DismissOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/outside-alert/dismiss`, {
      method: 'POST',
    })
    if (!response.ok) return { ok: false, code: codeOf(response) }
    return { ok: true }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// Whether a turn-off needs its step: only when it would name someone or stop
// an invitation (Steven's answer 3, 2026-11-12). Otherwise one press.
export function turnOffNeedsStep(preview: OutsidePreview): boolean {
  return preview.outsiders.length > 0 || preview.pending > 0
}

// --- copy: the approved words (Steven, 2026-11-10), as written ------------------

// The setting, a switch.
export function switchLabel(group: string): string {
  return `Invite people outside ${group}`
}

// Turning it on, a second step.
export function turnOnSentence(group: string): string {
  return `People you invite from outside ${group} will see everything in this gathering, including what's already there. Everyone in it will be told.`
}
export const TURN_IT_ON = 'Turn it on'
export const NOT_NOW = 'Not now'

// The line at the top of Photos, for the group's members (the record §6).
export function groupLine(group: string, on: boolean): string {
  return on
    ? `People outside ${group} can see this gathering and everything in it.`
    : `Only people in ${group} can see this gathering for now. If people outside ${group} are invited, they'll see everything in it, including what's already there.`
}

// The alert (the record §5), naming the opener — or, with the opener's
// account deleted (`by` null), the passive form (CK-93's kickoff).
export function alertSentence(by: string | null, gathering: string, group: string): string {
  const rest = `They can see everything in it, including what's already there. If you added something that should stay with ${group}, you can remove it.`
  return by !== null
    ? `${by} opened ${gathering} to people outside ${group}. ${rest}`
    : `${gathering} was opened to people outside ${group}. ${rest}`
}
export const GOT_IT = 'Got it'

// Turning it off, a second step: the first outsider in the preview's order,
// then how many more; then the pending clause. Never called for a preview
// that names nobody and stops nothing (`turnOffNeedsStep`).
export function turnOffSentence(preview: OutsidePreview): string {
  const sentences: string[] = []
  const count = preview.outsiders.length
  if (count > 0) {
    const first = preview.outsiders[0].display_name ?? 'Someone'
    const others = count - 1
    if (others === 0) sentences.push(`${first} will no longer see this gathering.`)
    else if (others === 1) sentences.push(`${first} and 1 other will no longer see this gathering.`)
    else sentences.push(`${first} and ${others} others will no longer see this gathering.`)
  }
  if (preview.pending > 0) sentences.push('Invitations not yet accepted will stop working.')
  return sentences.join(' ')
}
export const TURN_IT_OFF = 'Turn it off'
export const KEEP_IT_ON = 'Keep it on'

// An outsider's row in the Co-hosts section's Invited list (Steven's answer
// 4, 2026-11-12).
export function fromOutsideLabel(name: string, group: string): string {
  return `${name} · From outside ${group}`
}

// --- copy: CK-93's kickoff, for Steven to approve or change --------------------

export const TURNING_IT_ON = 'Turning it on…'
export const TURNING_IT_OFF = 'Turning it off…'
export const PREVIEW_FAILED = "Who would lose access couldn't be checked just now."
export const TRY_AGAIN = 'Try again'
export const NOT_ALLOWED = "You can't change this setting any more."
export const REFRESH = 'Refresh'
export const CHANGE_FAILED = 'Something went wrong. Nothing was changed — try again.'
export const ALERT_FAILED = 'Something went wrong. Try again.'

// A send the server refused with `members_only`: someone turned it off
// meanwhile.
export function turnedOffMeanwhile(group: string): string {
  return `Inviting people outside ${group} was turned off. Nothing was sent.`
}
