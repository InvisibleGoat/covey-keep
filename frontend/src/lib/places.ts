// Each member's place on a group's gathering (CK-80, Groups 3c — the surface
// for CK-77's backend; decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md
// §4, §9–§11). Shapes mirror backend/app/api/gatherings.py's places routes
// exactly — see reference/backend/api-reference.md, the Gatherings router's
// `GET`/`PUT /gatherings/{id}/places…` and `POST /gatherings`'s two lists.
// lib/groups.ts is the model: calls answering a STABLE CODE, and copy
// switched on that code — never on the server's wording, which is not
// carried.
//
// THE THREE WORDS (Steven, 2026-10-27): on screen a place reads *Invited*,
// *Sees the photos* or *Kept a surprise*. They are the screen's LABELS for
// the API's terms — `invited`, `shared_with`, `left_out` — which stay the
// terms in the records and the API; nothing here renames them. The labels
// live in PLACE_LABELS below and nowhere else in the code.
//
// THE MEMBERSHIP ID IS THE HANDLE IN CALLS AND NOWHERE ELSE (CK-75's rule):
// never rendered, never in an element id or a radio group's name, never
// stored or logged. A member is shown by display name and initials.
//
// NOBODY IS TOLD THEIR PLACE: no notification, email or message exists, and
// no copy here says or implies one is sent.
import { authFetch } from './api'
import { networkErrors } from './formErrors'

export type Place = 'invited' | 'shared_with' | 'left_out'

// The three choices, in the order a member's row offers them.
export const PLACES: readonly Place[] = ['invited', 'shared_with', 'left_out']

// THE ONE TABLE. *Sees the photos* stays true when posts arrive, where
// "Photos only" would not; *Kept a surprise* says the person won't know,
// without the harshness of "excluded" (record §11).
export const PLACE_LABELS: Record<Place, string> = {
  invited: 'Invited',
  shared_with: 'Sees the photos',
  left_out: 'Kept a surprise',
}

// One entry of `GET /gatherings/{id}/places`, exactly: the handle, the name,
// the place — null for a member with no row of either kind (the shape a
// member who joined after the dates passed holds) — and whether they
// co-host, which is why a move away from invited would be refused.
export interface PlaceEntry {
  membership_id: string
  display_name: string
  place: Place | null
  co_host: boolean
}

export interface PlaceList {
  // `invitees_chosen` — once chosen, chosen: false means a newcomer to the
  // group is invited to this gathering, true that they see its photos.
  inviteesChosen: boolean
  members: PlaceEntry[]
}

export type PlacesRead = { ok: true; value: PlaceList } | { ok: false; code: string }

export type PlaceOutcome =
  | { ok: true; entry: PlaceEntry }
  // 409 `is_co_host` | `has_answered` | `not_in_a_group`, the 422's
  // `is_host`, `not_found` for a 404 (the member's or the gathering's — one
  // meaning here: the caller can't make that change any more),
  // `unreachable` for a network failure, `failed` for anything else.
  | { ok: false; code: string }

async function refusalCode(response: Response): Promise<string> {
  if (response.status === 404) return 'not_found'
  if (response.status !== 409 && response.status !== 422) return 'failed'
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null
  const detail = body?.detail
  if (response.status === 422 && Array.isArray(detail) && detail.length > 0) {
    const code = (detail[0] as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  if (response.status === 409 && detail !== null && typeof detail === 'object') {
    const code = (detail as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'failed'
}

// Who stands where — the organisers' list (the host's or a co-host's).
export async function readPlaces(gatheringId: string): Promise<PlacesRead> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/places`)
    if (!response.ok) return { ok: false, code: await refusalCode(response) }
    const body = (await response.json()) as {
      invitees_chosen?: boolean
      members?: PlaceEntry[]
    }
    return {
      ok: true,
      value: { inviteesChosen: body.invitees_chosen === true, members: body.members ?? [] },
    }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// Change one member's place — one PUT, the 200 the member's entry as the
// server now holds it. Nothing is sent to the member.
export async function setPlace(
  gatheringId: string,
  membershipId: string,
  place: Place,
): Promise<PlaceOutcome> {
  try {
    const response = await authFetch(`/gatherings/${gatheringId}/places/${membershipId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place }),
    })
    if (response.ok) return { ok: true, entry: (await response.json()) as PlaceEntry }
    return { ok: false, code: await refusalCode(response) }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// The create body's two lists (`POST /gatherings` with `group_id`), from the
// form's choices in joining order — membership id to place:
// - EVERY MEMBER INVITED → NEITHER LIST. That is the whole-group create,
//   CK-76's byte for byte: `invitees_chosen` stays false, so a member who
//   joins the group later is invited too. Sending `invited` with everyone in
//   it would mark the gathering chosen and make every later newcomer see the
//   photos only — a silent difference, which is why it is never sent.
// - OTHERWISE → `invited` (possibly `[]`), and `left_out` when anyone is kept
//   a surprise; the server shares the gathering with everyone else.
export interface PlacesBody {
  invited?: string[]
  left_out?: string[]
}

export function placesBody(choices: ReadonlyMap<string, Place>): PlacesBody {
  const invited: string[] = []
  const leftOut: string[] = []
  let everyoneInvited = true
  for (const [membershipId, place] of choices) {
    if (place === 'invited') invited.push(membershipId)
    else everyoneInvited = false
    if (place === 'left_out') leftOut.push(membershipId)
  }
  if (everyoneInvited) return {}
  return leftOut.length > 0 ? { invited, left_out: leftOut } : { invited }
}

// The item-level 422s a create's lists can draw — `["body", "invited" |
// "left_out", N]` carrying `code` (`not_a_member`, `is_host`, `duplicate`) —
// read from the 422's body, so the form can map each back through the list
// AS SENT to the member it names. Anything else in the body is the one
// mapper's (lib/formErrors.ts).
export interface ListRefusal {
  list: 'invited' | 'left_out'
  index: number
  code: string
}

export function listRefusals(body: unknown): ListRefusal[] {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!Array.isArray(detail)) return []
  const found: ListRefusal[] = []
  for (const item of detail as { loc?: unknown; code?: unknown }[]) {
    const loc = Array.isArray(item.loc) ? item.loc : []
    const list = loc[1]
    const index = loc[2]
    if ((list === 'invited' || list === 'left_out') && typeof index === 'number') {
      found.push({ list, index, code: typeof item.code === 'string' ? item.code : 'failed' })
    }
  }
  return found
}

// --- copy ----------------------------------------------------------------------

export const PLACES_HEADING = "Who it's for"

// What the three places mean, said once above the member list — on the
// form and on the gathering page. It names no notification: nobody is told.
export const PLACES_HINT =
  "Invited people get the dates and the plans, and can add photos. People who see the photos get the photos and nothing else. Someone kept a surprise won't know about this gathering until you let them see the photos."

// What happens to someone who joins the group while the gathering is still
// ahead (record §9) — read from `invitees_chosen` on the gathering page, and
// from the current choice on the form (everyone invited sends neither list).
export function newcomerLine(inviteesChosen: boolean, groupName: string): string {
  return inviteesChosen
    ? `Anyone who joins ${groupName} before it's over will see the photos.`
    : `Anyone who joins ${groupName} before it's over is invited too.`
}

// A co-host's row offers Invited alone: the server refuses the other two
// (`is_co_host`), and a control that cannot succeed is not offered.
export const CO_HOST_ALWAYS_INVITED = 'A co-host is always invited.'

// A member with no place yet (they joined after the dates passed).
export function noPlaceLine(name: string): string {
  return `${name} has no place on this gathering yet.`
}

export function noOtherMembersLine(groupName: string): string {
  return `No one else is in ${groupName} yet.`
}

// What a refused move tells the organiser — switched on the CODE and never
// the wording. Each line says what is true and the way on; none claims
// anything changed.
export function placeRefusalMessage(code: string, name: string, groupName: string): string {
  switch (code) {
    case 'has_answered':
      return `${name} has answered a date, so they stay invited.`
    case 'is_co_host':
      return `${name} is a co-host, so they stay invited. Remove them as a co-host first.`
    case 'not_found':
      return `${name} isn't in ${groupName} any more — refresh the list.`
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// A create refused on one member's row: `not_a_member` — they left the group,
// or deleted their account, while the form was open. The other two codes
// (`is_host`, `duplicate`) cannot come from this form — the caller has no
// row and each member one — so they read as the generic line.
export function createRefusalMessage(code: string, name: string): string {
  if (code === 'not_a_member') {
    return `${name} isn't in this group any more — go back to the group and start again.`
  }
  return 'Something went wrong. Nothing was created — try again.'
}

// The prompt to share (Steven, 2026-10-27; record §4): once any of the
// gathering's dates has started, its host and co-hosts read one line per
// member still kept a surprise, with the one tap beside it. Nothing is sent
// to anyone.
export function promptLine(name: string): string {
  return `${name} doesn't know about this gathering yet.`
}

export function promptAction(name: string): string {
  return `Let ${name} see the photos`
}
