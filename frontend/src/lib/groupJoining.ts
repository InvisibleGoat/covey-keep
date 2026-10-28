// Joining a group on the surface (CK-79, Groups 3b — the surface for CK-75's
// backend; decisions/2026-10-23-joining-a-group-and-co-admins.md §2, §3,
// §12). The joining calls, the two parked tokens and the copy, in
// lib/groups.ts's shape: shapes mirror backend/app/api/group_links.py's and
// group_invitations.py's bodies exactly, and every outcome carries the
// server's STABLE CODE, never its wording.
//
// THE GROUP'S LINK NEVER LEAVES ITS CALL — CK-74's rule for a Checkout URL,
// applied to a bearer credential (record §2: anyone holding it can ask to
// join). `readLink` and `makeLink` answer `{ expiresAt, share }` or no link;
// `share` is a function that closes over the URL and hands it to the
// DEVICE — the browser's share sheet (`navigator.share`) where there is one,
// else the clipboard. The URL is never a property of what is returned,
// never in component state, never in the DOM, never logged and never sent in
// another request; it lives in this closure until the person's own share
// sheet or clipboard takes it. The product sends nothing and stores no
// phone number (record §2).
//
// WHY A CLOSURE AND NOT A CALL ON CLICK: the share sheet and the clipboard
// both need the click's user activation, which a network round trip after
// the click can spend. So the URL is fetched when the section loads and when
// a link is made, and `share()` calls the device at once.
//
// THE PARKED TOKENS — CK-25's three-function shape, one key per landing:
// `covey-keep:group-link-token` and `covey-keep:group-invitation-token`. A
// token sits in localStorage across the sign-in round trip (a full
// navigation away through an inbox and back through /auth/callback) and is
// cleared the moment it is redeemed or found dead. Bearer credentials at
// rest for minutes, as CK-25's are.
//
// NOBODY IS TOLD ANYTHING: a declined requester is not told, for now
// (Steven, 2026-10-27; record §12), and no notification exists — no copy
// here promises one.
import { PRODUCT_NAME } from '../brand'
import { apiFetch, authFetch } from './api'
import { errorsFromResponse, networkErrors, type FormErrors } from './formErrors'

// --- the bodies ----------------------------------------------------------------

// `GET /groups/{id}/join-requests` — the requester's display name and nothing
// else about them.
export interface JoinRequest {
  id: string
  display_name: string
  created_at: string
}

// `GET /groups/{id}/invitations` — one pending row: the address an organiser
// typed, shown to organisers alone (record DATA-HANDLING; CK-25's precedent).
export interface PendingGroupInvitation {
  id: string
  channel: string
  destination: string
  created_at: string
  expires_at: string
}

export type LinkStatus = 'valid' | 'expired' | 'revoked' | 'invalid'
export type GroupInvitationStatus = 'valid' | 'expired' | 'used' | 'revoked' | 'invalid'

// --- the device -----------------------------------------------------------------

// What `share()` reaches for: the browser's share sheet and its clipboard.
// Injectable for tests (the `follow` idiom); the app passes nothing and gets
// the browser's own, read at the moment of the share.
export interface ShareDevice {
  share?: (data: ShareData) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

export function browserDevice(): ShareDevice {
  if (typeof navigator === 'undefined') return {}
  const nav: Navigator = navigator
  const device: ShareDevice = {}
  if (typeof nav.share === 'function') device.share = (data) => nav.share(data)
  const clipboard: Clipboard | undefined = nav.clipboard
  if (clipboard && typeof clipboard.writeText === 'function') {
    device.writeText = (text) => clipboard.writeText(text)
  }
  return device
}

// What a press of Share the link came to:
//   `shared` — the share sheet took it; `copied` — the clipboard did;
//   `cancelled` — the person closed the share sheet (AbortError), and
//     nothing is said;
//   `unavailable` — this browser has neither;
//   `failed` — otherwise. A share sheet that refuses falls back to the
//     clipboard once before answering `failed`.
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unavailable' | 'failed'

export interface ShareableLink {
  // The live link's expiry, an ISO instant; rendered as a day.
  expiresAt: string
  // Hands the link to the device. The URL is in this closure and nowhere
  // else; the group's name is passed at the press, so a rename since the
  // read is the name shared.
  share: (groupName: string) => Promise<ShareOutcome>
}

function isAbort(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
  )
}

function shareable(url: string, expiresAt: string, device: ShareDevice | undefined): ShareableLink {
  return {
    expiresAt,
    share: async (groupName: string) => {
      const using = device ?? browserDevice()
      if (using.share) {
        try {
          const text = shareText(groupName)
          await using.share({ title: text, text, url })
          return 'shared'
        } catch (error) {
          if (isAbort(error)) return 'cancelled'
          // The share sheet refused: the clipboard, once.
        }
      }
      if (using.writeText) {
        try {
          await using.writeText(url)
          return 'copied'
        } catch {
          return 'failed'
        }
      }
      return using.share ? 'failed' : 'unavailable'
    },
  }
}

// --- outcomes --------------------------------------------------------------------

// Every failed call answers a code: the 409's `detail.code`
// (`already_decided`, `withdrawn_meanwhile`), `rate_limited` for a 429,
// `not_found` for a 404 (the caller may not do that here any more),
// `unreachable` for a network failure, `failed` for anything else.
export type Refusal = { ok: false; code: string }

async function refusal(response: Response): Promise<Refusal & { outcome?: string | null }> {
  if (response.status === 404) return { ok: false, code: 'not_found' }
  if (response.status === 429) return { ok: false, code: 'rate_limited' }
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null
    const detail = body?.detail
    if (detail !== null && typeof detail === 'object') {
      const { code, outcome } = detail as { code?: unknown; outcome?: unknown }
      if (typeof code === 'string') {
        return { ok: false, code, outcome: typeof outcome === 'string' ? outcome : null }
      }
    }
  }
  return { ok: false, code: 'failed' }
}

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await authFetch(path, init)
  } catch {
    return null
  }
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// --- the link (record §2, §3) -----------------------------------------------------

export type LinkOutcome = { ok: true; link: ShareableLink | null } | Refusal

function linkFrom(body: unknown, device: ShareDevice | undefined): ShareableLink | null {
  const { url, expires_at } = (body ?? {}) as { url?: unknown; expires_at?: unknown }
  if (typeof url !== 'string' || typeof expires_at !== 'string') return null
  return shareable(url, expires_at, device)
}

// Any member reads the live link: `{ expiresAt, share }`, or null when the
// group has none (`{"url": null, "expires_at": null}`).
export async function readLink(groupId: string, device?: ShareDevice): Promise<LinkOutcome> {
  const response = await call(`/groups/${groupId}/link`)
  if (response === null) return { ok: false, code: 'unreachable' }
  if (response.ok) return { ok: true, link: linkFrom(await response.json(), device) }
  return refusal(response)
}

// The admin or a co-admin makes the link, or replaces it: every older link
// stops working at once. The 201's body is the new link.
export async function makeLink(groupId: string, device?: ShareDevice): Promise<LinkOutcome> {
  const response = await call(`/groups/${groupId}/link`, { method: 'POST' })
  if (response === null) return { ok: false, code: 'unreachable' }
  if (response.status === 201) return { ok: true, link: linkFrom(await response.json(), device) }
  return refusal(response)
}

export type ActOutcome = { ok: true } | (Refusal & { outcome?: string | null })

async function act(path: string, init: RequestInit, okStatus: number): Promise<ActOutcome> {
  const response = await call(path, init)
  if (response === null) return { ok: false, code: 'unreachable' }
  if (response.status === okStatus) return { ok: true }
  return refusal(response)
}

// The admin or a co-admin turns the link off: a 204, idempotent.
export function revokeLink(groupId: string): Promise<ActOutcome> {
  return act(`/groups/${groupId}/link`, { method: 'DELETE' }, 204)
}

// --- requests to join -----------------------------------------------------------

export type ReadOutcome<T> = { ok: true; value: T } | Refusal

export async function readJoinRequests(groupId: string): Promise<ReadOutcome<JoinRequest[]>> {
  const response = await call(`/groups/${groupId}/join-requests`)
  if (response === null) return { ok: false, code: 'unreachable' }
  if (!response.ok) return refusal(response)
  const body = (await response.json()) as { join_requests?: JoinRequest[] }
  return { ok: true, value: body.join_requests ?? [] }
}

// Approving writes the membership; a decided request answers the 409
// `already_decided` with its `outcome` (`approved` | `declined`).
export function approveRequest(groupId: string, requestId: string): Promise<ActOutcome> {
  return act(`/groups/${groupId}/join-requests/${requestId}/approve`, { method: 'POST' }, 200)
}

export function declineRequest(groupId: string, requestId: string): Promise<ActOutcome> {
  return act(`/groups/${groupId}/join-requests/${requestId}/decline`, { method: 'POST' }, 200)
}

// --- emailed invitations ---------------------------------------------------------

export async function readGroupInvitations(
  groupId: string,
): Promise<ReadOutcome<PendingGroupInvitation[]>> {
  const response = await call(`/groups/${groupId}/invitations`)
  if (response === null) return { ok: false, code: 'unreachable' }
  if (!response.ok) return refusal(response)
  const body = (await response.json()) as { pending?: PendingGroupInvitation[] }
  return { ok: true, value: body.pending ?? [] }
}

export type InviteOutcome =
  | { ok: true; invitation: PendingGroupInvitation }
  // `code` is `rate_limited` for a 429, the 409's code, or null for what the
  // one mapper maps (a 422 on `destination` or `channel`, a network failure,
  // a server error); `errors` is always what the form renders.
  | { ok: false; code: string | null; errors: FormErrors }

const INVITE_FIELDS = ['destination', 'channel']

// Invite by email: the channel pinned to EMAIL — the API accepts SMS in its
// schema and refuses it as not yet available, and a control it refuses is
// worse than none (the CK-18 lesson). The body is exactly `{"channel":
// "EMAIL", "destination"}`; a 422 lands on its field through the one mapper.
export async function inviteByEmail(groupId: string, destination: string): Promise<InviteOutcome> {
  const response = await call(`/groups/${groupId}/invitations`, postJson({ channel: 'EMAIL', destination }))
  if (response === null) return { ok: false, code: null, errors: networkErrors() }
  if (response.status === 201) {
    return { ok: true, invitation: (await response.json()) as PendingGroupInvitation }
  }
  if (response.status === 429) {
    return { ok: false, code: 'rate_limited', errors: { fields: {}, form: [INVITE_RATE_LIMITED], types: {} } }
  }
  if (response.status === 409 || response.status === 404) {
    const { code } = await refusal(response)
    return { ok: false, code, errors: { fields: {}, form: [inviteRefusalMessage(code)], types: {} } }
  }
  return { ok: false, code: null, errors: await errorsFromResponse(response, INVITE_FIELDS) }
}

// Revoking: a 204, idempotent; a 404 means it stopped being pending (accepted
// meanwhile, or revoked elsewhere) — the list is stale either way.
export function revokeGroupInvitation(groupId: string, invitationId: string): Promise<ActOutcome> {
  return act(`/groups/${groupId}/invitations/${invitationId}`, { method: 'DELETE' }, 204)
}

// --- the two landings -------------------------------------------------------------

export type PreviewOutcome<S> = { ok: true; status: S; groupName: string | null } | Refusal

async function preview<S>(path: string, token: string): Promise<PreviewOutcome<S>> {
  try {
    // Unauthenticated, deliberately (CK-25's reason): the landing renders
    // its distinguished states before anyone goes through a sign-in. A POST,
    // so the token stays out of every access log.
    const response = await apiFetch(path, postJson({ token }))
    if (!response.ok) return { ok: false, code: 'failed' }
    const body = (await response.json()) as { status: S; group_name: string | null }
    return { ok: true, status: body.status, groupName: body.group_name ?? null }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

export type FlowOutcome<S> = { ok: true; status: S; groupId: string | null } | Refusal

async function flow<S>(path: string, token: string): Promise<FlowOutcome<S>> {
  const response = await call(path, postJson({ token }))
  if (response === null) return { ok: false, code: 'unreachable' }
  if (response.ok) {
    const body = (await response.json()) as { status: S; group_id: string | null }
    return { ok: true, status: body.status, groupId: body.group_id ?? null }
  }
  return refusal(response)
}

export function previewLink(token: string): Promise<PreviewOutcome<LinkStatus>> {
  return preview('/group-links/preview', token)
}

// Asking to join: `requested` | `pending` | `already_member` (the only
// outcome that carries the group id) | a dead token's status; a 429 answers
// `rate_limited`.
export function joinThroughLink(
  token: string,
): Promise<FlowOutcome<'requested' | 'pending' | 'already_member' | Exclude<LinkStatus, 'valid'>>> {
  return flow('/group-links/join', token)
}

export function previewGroupInvitation(token: string): Promise<PreviewOutcome<GroupInvitationStatus>> {
  return preview('/group-invitations/preview', token)
}

// Accepting: `accepted` | `already_accepted` (both with the group id) | a
// dead token's status (`expired`, `used`, `revoked`, `invalid`).
export function acceptGroupInvitation(
  token: string,
): Promise<FlowOutcome<'accepted' | 'already_accepted' | Exclude<GroupInvitationStatus, 'valid'>>> {
  return flow('/group-invitations/accept', token)
}

// --- the parked tokens (CK-25's shape) -----------------------------------------------

const LINK_TOKEN_KEY = 'covey-keep:group-link-token'
const INVITATION_TOKEN_KEY = 'covey-keep:group-invitation-token'

function store(key: string, token: string): void {
  try {
    localStorage.setItem(key, token)
  } catch {
    // Storage unavailable (private mode): the landing still works while the
    // tab lives; a sign-in round trip loses the token, and opening the link
    // again recovers.
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function clear(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing stored to clear.
  }
}

export const storeGroupLinkToken = (token: string) => store(LINK_TOKEN_KEY, token)
export const readGroupLinkToken = () => read(LINK_TOKEN_KEY)
export const clearGroupLinkToken = () => clear(LINK_TOKEN_KEY)

export const storeGroupInvitationToken = (token: string) => store(INVITATION_TOKEN_KEY, token)
export const readGroupInvitationToken = () => read(INVITATION_TOKEN_KEY)
export const clearGroupInvitationToken = () => clear(INVITATION_TOKEN_KEY)

// The fragment's token, consumed once (the AuthCallback discipline): read
// `#token=`, strip the fragment from the address bar and history at once,
// and answer the token or null.
export function consumeFragmentToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const token = fragment.get('token')
  history.replaceState(null, '', window.location.pathname)
  return token
}

// --- copy ----------------------------------------------------------------------------

// The link's hint — for every member, beside Share the link, and for an
// organiser beside Make a link.
export const LINK_HINT = 'Anyone you send it to can ask to join. An admin or co-admin approves each request.'

export function linkExpiryLine(day: string): string {
  return `Works until ${day}`
}

// What the share sheet carries beside the link; the name from brand.ts.
export function shareText(groupName: string): string {
  return `Join ${groupName} on ${PRODUCT_NAME}`
}

export const LINK_COPIED = 'Link copied. Paste it into a message to the people you want to invite.'
export const SHARE_FAILED = "This browser couldn't share or copy the link — try again."
export const SHARE_UNAVAILABLE = "This browser can't share or copy the link. Open this page on your phone to share it."

// The line a share outcome leaves in the status region: nothing for a share
// sheet that took it (the person watched it happen) or one they closed.
export function shareOutcomeLine(outcome: ShareOutcome | null): string {
  switch (outcome) {
    case 'copied':
      return LINK_COPIED
    case 'failed':
      return SHARE_FAILED
    case 'unavailable':
      return SHARE_UNAVAILABLE
    default:
      return ''
  }
}

export const NO_LINK_MEMBER = "There's no link to share right now. An admin or co-admin can make one."

export const REPLACE_LINK_SENTENCE =
  "The current link will stop working, and anyone who hasn't used it yet will need the new one."
export const TURN_OFF_LINK_SENTENCE = 'The link will stop working. Requests already made stay in Requests to join.'

export function linkRefusalMessage(code: string): string {
  switch (code) {
    case 'withdrawn_meanwhile':
      return 'The link changed just now — try again.'
    case 'not_found':
      return "You can't change this group's link any more — refresh the page."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

export const REQUESTS_HINT =
  "People who ask with the group's link wait here. They aren't told if you decline, and they can ask again with the link."
export const NO_REQUESTS = 'No one is waiting to join.'

export function askedLine(day: string): string {
  return `asked ${day}`
}

// Approving's second step (Steven, 2026-10-27): approving shows the group's
// members, and brings its upcoming gatherings, to someone the approver may
// know only by name.
export function approveSentence(name: string, groupName: string): string {
  return `${name} will join ${groupName} and see its members. The group's upcoming gatherings will include them.`
}

// A refused decision, from its code — the outcome says which way it went.
export function decisionRefusalMessage(code: string, outcome?: string | null): string {
  switch (code) {
    case 'already_decided':
      if (outcome === 'approved') return 'Someone already approved this request — refresh the list.'
      if (outcome === 'declined') return 'Someone already declined this request — refresh the list.'
      return 'Someone already decided this request — refresh the list.'
    case 'not_found':
      return "This request isn't here any more — refresh the list."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

export const INVITE_HINT = "They'll get an email with a link to join this group. Invitations expire after 7 days."
export const INVITE_RATE_LIMITED = 'Too many invitations just now — try again in a few minutes.'

function inviteRefusalMessage(code: string): string {
  if (code === 'withdrawn_meanwhile') return 'That invitation changed just now — try again.'
  if (code === 'not_found') return "You can't invite people to this group any more — refresh the page."
  return 'Something went wrong. Nothing was sent — try again.'
}

export function pendingExpiryLine(expired: boolean, day: string): string {
  return expired ? 'expired' : `expires ${day}`
}

// --- the link's landing (/groups/join) --------------------------------------------

export const JOIN_SIGNED_OUT_LINE =
  'Sign in, or create your account, to ask to join. An admin or co-admin approves each request.'

export function joinConsentLine(displayName: string | null): string {
  return displayName
    ? `When you ask, the group's admin and co-admins will see your name, ${displayName}.`
    : "When you ask, the group's admin and co-admins will see your name."
}

export function requestInLine(groupName: string | null): string {
  const who = groupName ? `An admin or co-admin of ${groupName}` : 'An admin or co-admin of the group'
  return `${who} will see it. You won't get a message when they decide — if they approve it, the group will be in Your groups.`
}

export const JOIN_RATE_LIMITED = 'Many people are asking to join this group just now — try again in a few minutes.'
