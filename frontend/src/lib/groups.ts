// Group API types, calls and copy (CK-78, Groups 3a — the surface for
// CK-45's and CK-75's backend; decisions/2026-10-23-joining-a-group-and-co-admins.md
// §5–§7). Shapes mirror backend/app/api/groups.py's bodies exactly — see
// reference/backend/api-reference.md, Groups router. lib/coHosts.ts is the
// model: two flags from the body's role, calls answering a stable code, and
// copy switched on that code.
//
// WHO THE CALLER IS COMES FROM THE BODY: `caller_role` — `admin` |
// `co_admin` | `member` — read through `groupRoleFlags` into `isAdmin` (the
// RESERVED set: choosing co-admins, removing them, handing the admin role
// over) and `organises` (the admin OR a co-admin — the DELEGABLE set:
// renaming, removing an ordinary member). Nothing here compares person ids
// to decide a role; `admin_person_id` rides the type and gates nothing.
//
// THE MEMBERSHIP ID IS THE HANDLE IN CALLS AND NOWHERE ELSE: never rendered,
// never stored, never logged. A member is shown by display name and
// initials — never an email, a phone number, a person id or an account id
// (record §5).
//
// REFUSALS SWITCH ON THE STABLE CODE, NEVER THE WORDING (the CK-30 marker
// precedent): a 422 answers its `detail[0].code`, the leave's 409 its
// `detail.code`, a 404 — the group's or the member's, one meaning here:
// the caller may not make that change any more — `not_found`, a network
// failure `unreachable`. The server's `message` is not carried. Creating
// and renaming a group go through lib/formErrors.ts instead (field errors
// on `name`); there is no second mapper.
//
// NOBODY IS TOLD they were made a co-admin, removed, or handed the admin
// role: no notification exists (record §12).
import { authFetch } from './api'
import { errorsFromResponse, networkErrors, type FormErrors } from './formErrors'

export type GroupRole = 'admin' | 'co_admin' | 'member'

// Every group body (`POST /groups`, `GET /groups`, `GET`/`PATCH
// /groups/{id}`, the hand-over's 200), exactly.
export interface Group {
  id: string
  name: string
  group_type: string
  admin_person_id: string | null
  member_count: number
  caller_role: GroupRole
  created_at: string
  updated_at: string | null
}

// One row of `GET /groups/{id}/members`, in joining order: the handle, the
// name, the role, and the one caller-relative fact.
export interface GroupMember {
  membership_id: string
  display_name: string
  role: GroupRole
  is_self: boolean
}

// The two flags every gated control on the group page reads on purpose.
// Anything but the three known roles — null, a missing field, a value this
// build does not know — gates CLOSED (`roleFlags`' rule): a control that
// cannot succeed teaches a person the product does something it does not,
// and the server would refuse it. A `member` holds neither flag.
export interface GroupRoleFlags {
  isAdmin: boolean
  organises: boolean
}

export function groupRoleFlags(role: unknown): GroupRoleFlags {
  const isAdmin = role === 'admin'
  return { isAdmin, organises: isAdmin || role === 'co_admin' }
}

// The letters beside a member's name until profile pictures exist (record
// §5): the first letter of each of the first two words that carry one,
// uppercased; one word gives one letter; nothing usable gives "?". Words
// split on whitespace only, so a hyphenated name is one word. Rendered
// aria-hidden beside the name, never instead of it.
export function initials(displayName: string | null | undefined): string {
  const words = (displayName ?? '').trim().split(/\s+/)
  const letters: string[] = []
  for (const word of words) {
    const first = word.match(/[\p{L}\p{N}]/u)
    if (first) letters.push(first[0])
    if (letters.length === 2) break
  }
  return letters.length > 0 ? letters.join('').toUpperCase() : '?'
}

// "1 member", "3 members" — the count the server computes (store who,
// compute how many), counting the people the member list shows.
export function memberCountLabel(count: number): string {
  return count === 1 ? '1 member' : `${count} members`
}

// The word beside a name on the member list; nothing for an ordinary member.
export function roleLabel(role: unknown): string | null {
  if (role === 'admin') return 'Admin'
  if (role === 'co_admin') return 'Co-admin'
  return null
}

// The page header's line about the caller, for the two roles that run the
// group; nothing for a member.
export function callerRoleLine(role: unknown): string | null {
  if (role === 'admin') return "You're the admin."
  if (role === 'co_admin') return "You're a co-admin."
  return null
}

// --- reads ------------------------------------------------------------------

export type GroupRead<T> =
  | { status: 'loaded'; value: T }
  // A 404 — a missing id and a group the caller is not in, byte-identical
  // on the server and one screen here — or a path 422 (an id that cannot
  // name anything), which is the same screen from the reader's side.
  | { status: 'notFound' }
  | { status: 'failed' }

export async function listGroups(): Promise<{ ok: true; groups: Group[] } | { ok: false }> {
  try {
    const response = await authFetch('/groups')
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { groups?: Group[] }
    return { ok: true, groups: body.groups ?? [] }
  } catch {
    return { ok: false }
  }
}

async function read<T>(path: string, pick: (body: unknown) => T): Promise<GroupRead<T>> {
  try {
    const response = await authFetch(path)
    if (response.ok) return { status: 'loaded', value: pick(await response.json()) }
    if (response.status === 404 || response.status === 422) return { status: 'notFound' }
    return { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

export function readGroup(groupId: string): Promise<GroupRead<Group>> {
  return read(`/groups/${groupId}`, (body) => body as Group)
}

export function readMembers(groupId: string): Promise<GroupRead<GroupMember[]>> {
  return read(
    `/groups/${groupId}/members`,
    (body) => (body as { members?: GroupMember[] }).members ?? [],
  )
}

// --- create and rename: through the one mapper -------------------------------

export type GroupFormOutcome = { ok: true; group: Group } | { ok: false; errors: FormErrors }

const NAME_FIELDS = ['name']

// Starting a group: the body is exactly `{"name"}` — never `group_type`,
// which the API accepts for one value (HOUSEHOLD, its default) and refuses
// for every other, so offering or sending it would be a control the API
// rejects (the CK-18 lesson). A 201 is the new group; a blank or over-long
// name the server refuses lands on `name` through the mapper.
export async function createGroup(name: string): Promise<GroupFormOutcome> {
  try {
    const response = await authFetch('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (response.status === 201) return { ok: true, group: (await response.json()) as Group }
    return { ok: false, errors: await errorsFromResponse(response, NAME_FIELDS) }
  } catch {
    return { ok: false, errors: networkErrors() }
  }
}

// Renaming: `{"name"}` as typed — a blanked field goes out as "" so the
// server's own refusal renders (never null: `name` is not clearable). A 404
// means the caller no longer organises the group; it is not a validation
// outcome, so it carries the refusal line rather than the mapper's generic
// one.
export async function renameGroup(groupId: string, name: string): Promise<GroupFormOutcome> {
  try {
    const response = await authFetch(`/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (response.ok) return { ok: true, group: (await response.json()) as Group }
    if (response.status === 404) {
      return { ok: false, errors: { fields: {}, form: [groupRefusalMessage('not_found', '')] } }
    }
    return { ok: false, errors: await errorsFromResponse(response, NAME_FIELDS) }
  } catch {
    return { ok: false, errors: networkErrors() }
  }
}

// --- the acts on members, and leaving -----------------------------------------

export type GroupOutcome =
  | { ok: true }
  // The 422's stable code (`not_a_member` | `is_admin` | `already_co_admin`
  // | `account_deleted`), the leave's 409 code (`hand_over_first`),
  // `not_found` for a 404, `unreachable` for a network failure, or `failed`
  // for anything else. The server's `message` is NOT carried.
  | { ok: false; code: string }

async function refusalCode(response: Response): Promise<string> {
  if (response.status === 404) return 'not_found'
  if (response.status !== 422 && response.status !== 409) return 'failed'
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

async function act(path: string, method: string, okStatus: number, body?: unknown): Promise<GroupOutcome> {
  try {
    const response = await authFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (response.status === okStatus) return { ok: true }
    return { ok: false, code: await refusalCode(response) }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// The admin makes a co-admin (reserved): one POST naming the membership.
export function addCoAdmin(groupId: string, membershipId: string): Promise<GroupOutcome> {
  return act(`/groups/${groupId}/co-admins`, 'POST', 201, { membership_id: membershipId })
}

// The admin removes a co-admin, or a co-admin steps down — one route, one
// DELETE. The membership itself is untouched: an ex-co-admin is a member.
export function removeCoAdmin(groupId: string, membershipId: string): Promise<GroupOutcome> {
  return act(`/groups/${groupId}/co-admins/${membershipId}`, 'DELETE', 204)
}

// The admin removes anyone but themselves; a co-admin an ordinary member.
// Removing someone never touches their gatherings (record §7).
export function removeMember(groupId: string, membershipId: string): Promise<GroupOutcome> {
  return act(`/groups/${groupId}/members/${membershipId}`, 'DELETE', 204)
}

// The admin hands the role over (reserved): the named member is the admin
// at once, and the caller a member. The 200 carries the group body; the
// page re-reads rather than trusting a merge (optimistic-free).
export function handOver(groupId: string, membershipId: string): Promise<GroupOutcome> {
  return act(`/groups/${groupId}/hand-over`, 'POST', 200, { membership_id: membershipId })
}

// Any member leaves; the admin with another member draws the 409
// `hand_over_first`, and nothing changes.
export function leaveGroup(groupId: string): Promise<GroupOutcome> {
  return act(`/groups/${groupId}/leave`, 'POST', 204)
}

// --- copy ----------------------------------------------------------------------

// Which act a refusal answers: one code (`is_admin`) means two things.
export type GroupAct =
  | 'make_co_admin'
  | 'remove_co_admin'
  | 'step_down'
  | 'make_admin'
  | 'remove_member'
  | 'leave'

// What a refused act tells the person — switched on the CODE and never the
// wording. Each line says what is true and the way on; none claims anything
// changed.
export function groupRefusalMessage(code: string, name: string, act?: GroupAct): string {
  switch (code) {
    case 'not_a_member':
      return `${name} isn't in this group any more — refresh the list.`
    case 'is_admin':
      return act === 'make_admin' ? "That's you — you're already the admin." : `${name} is the admin.`
    case 'already_co_admin':
      return `${name} is already a co-admin — refresh the list.`
    case 'account_deleted':
      return `${name} has deleted their account — refresh the list.`
    case 'hand_over_first':
      return "You're the admin, so someone else needs the role before you leave. Choose Make admin beside a member's name."
    case 'not_found':
      return "You can't make that change any more — refresh the page."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// What the admin hands a co-admin, above the member list — the delegable
// set in plain words, each clause a power the server grants a co-admin
// today (inviting and approving have their screens since Groups 3b,
// CK-79), and the reserved set as what stays with "you" (the admin is the
// reader).
export const CO_ADMIN_HINT =
  'A co-admin can rename the group, invite people, approve requests to join, and remove members. Only you choose co-admins, remove them, and make someone else the admin.'

// The second steps — each act but Make co-admin is deliberate, because the
// person loses their controls (or their place) the moment it lands.
export function removeCoAdminSentence(name: string): string {
  return `${name} will no longer be able to rename the group, invite people, approve requests to join or remove members.`
}

export const STEP_DOWN_SENTENCE =
  "You'll no longer be able to rename the group, invite people, approve requests to join or remove members. Only the admin can make you a co-admin again."

export function makeAdminSentence(name: string): string {
  return `${name} will be the admin at once, and you'll be a member. Only ${name} can make you the admin again.`
}

export function removeMemberSentence(name: string): string {
  return `${name} will no longer be a member of this group. Gatherings they're already part of don't change.`
}

// The leave card's explainer — removal and leaving touch no gathering row
// (record §7, the archive record §6), and coming back is a new invitation
// or an approved request. The way back is left out for the only member:
// nobody would be left in the group to invite them or approve a request.
export const LEAVE_EXPLAINER = "You'll stop seeing this group and its members. Gatherings you're already part of don't change."
export const LEAVE_COME_BACK =
  'To come back, someone in the group will need to invite you or approve your request.'
export const LEAVE_ONLY_MEMBER = "You're the only member, so the group will be left with nobody in it."

export function leaveSentence(groupName: string): string {
  return `Leave ${groupName}?`
}
