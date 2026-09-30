// Co-host API types, calls and copy (CK-69, the surface for CK-68's
// backend; decisions/2026-09-03-co-hosts.md §1, §4, §7). Shapes mirror
// backend/app/api/co_hosts.py's bodies exactly — see
// reference/backend/api-reference.md, Co-hosts router.
//
// THE HOST STAYS SINGULAR AND CHOOSES THE CO-HOSTS (co-hosts §4: adding and
// removing co-hosts is reserved). A co-host is named by THE ACCEPTED
// INVITATION'S ID — the one handle for a person in this gathering the host
// already reads in the Invitations section's Accepted list — never an email,
// a person id or an account id; the list below carries the same handle
// beside a display name and nothing else. A co-host may step down (their
// own row, `is_self`) and may not remove another (§7's second item: the
// answer built is no — the server hides it with the co-host 404, and this
// surface offers no control for it).
//
// REFUSALS SWITCH ON THE 422's STABLE CODE, NEVER ITS WORDING (the CK-30
// marker precedent; the review's contract): the server's `message` is not
// carried, the codes are the contract and the strings are ours. The one
// mapper in lib/formErrors.ts is for field errors that render inline against
// an input; a co-host refusal lands on the ROW it names and carries a code
// the copy switches on, so it is read the way `reviewMedia` reads a 409.
//
// NOBODY IS TOLD they were made or unmade a co-host: no notification exists
// (co-hosts, open — recorded, not built).
import { authFetch } from './api'
import { networkErrors } from './formErrors'

// One row of `GET /gatherings/{id}/co-hosts`: the handle, the name, when,
// and the one caller-relative fact — whether this row is the caller's own,
// so a co-host can find the row to step down from without holding any id
// of their own.
export interface CoHost {
  invitation_id: string
  display_name: string | null
  added_at: string
  is_self: boolean
}

export interface CoHostList {
  co_hosts: CoHost[]
}

export type CoHostOutcome =
  | { ok: true }
  // The 422's stable code on the add (`not_invited` | `is_host` |
  // `already_co_host` | `account_deleted`), `not_found` for the 404 on
  // either act (the caller is no longer allowed — the gathering's 404 for a
  // non-organiser, the co-host 404 for a handle this caller may not
  // remove), `unreachable` for a network failure, or this module's own word
  // for the rest. The server's `message` is NOT carried.
  | { ok: false; code: string }

async function refusalCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { code?: string }[] | unknown
  } | null
  const detail = body?.detail
  if (Array.isArray(detail) && detail.length > 0) {
    const code = (detail[0] as { code?: string }).code
    if (typeof code === 'string') return code
  }
  return 'failed'
}

// The host makes a co-host: one POST naming the accepted invitation. A 201
// is ok; the four refusals come back as their code; everyone who is not the
// host draws the gathering 404, which is `not_found` here.
export async function addCoHost(gatheringId: string, invitationId: string): Promise<CoHostOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/co-hosts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitation_id: invitationId }),
    })
    if (response.status === 201) return { ok: true }
    if (response.status === 404) return { ok: false, code: 'not_found' }
    if (response.status === 422) return { ok: false, code: await refusalCode(response) }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// The host removes a co-host, or a co-host steps down — one route, one
// DELETE, idempotent for the host. A 204 is ok; a 404 means the caller may
// not (not the host naming another, or no longer an organiser at all).
export async function removeCoHost(gatheringId: string, invitationId: string): Promise<CoHostOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/co-hosts/${invitationId}`, {
      method: 'DELETE',
    })
    if (response.status === 204) return { ok: true }
    if (response.status === 404) return { ok: false, code: 'not_found' }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// What a refused act tells the organiser — switched on the CODE and never
// the wording. Each line says what is true and offers the way on (a
// refresh); none claims anything changed.
export function coHostRefusalMessage(code: string, name: string): string {
  switch (code) {
    case 'not_invited':
      return "That invitation can't be found any more — refresh the list."
    case 'is_host':
      return "That's you — you're already the host."
    case 'already_co_host':
      return `${name} is already a co-host — refresh the list.`
    case 'account_deleted':
      return "This person has deleted their account, so they can't be a co-host."
    case 'not_found':
      return "You can't change co-hosts for this gathering any more — refresh the page."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// What the host is handing over, beside the list — the delegable set in
// plain words, and the reserved set as what stays with "you" (the host is
// the reader; the seat rule). Names no permission the server does not grant
// and no reserved act it would let a co-host take.
export const CO_HOST_HINT =
  'A co-host can edit this gathering and its dates, invite people, see every answer, and take photos off the gathering. Only you review photos, delete them permanently, and choose co-hosts.'

// The host's second step before removing a co-host: the person loses their
// controls at once, so the act is deliberate (the decline's shape).
export function removeCoHostSentence(name: string): string {
  return `${name} will no longer be able to edit this gathering, invite people, or take photos off it.`
}

// A co-host's second step before stepping down — and the one fact that
// makes it deliberate: only the host can make them a co-host again.
export const STEP_DOWN_SENTENCE =
  "You'll no longer be able to edit this gathering, invite people, or take photos off it. Only the host can make you a co-host again."
