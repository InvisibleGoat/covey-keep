// Invitation API types and the pending-token handoff (CK-25). Shapes mirror
// backend/app/api/invitations.py's response bodies exactly — see
// reference/backend/api-reference.md, Invitations router.
import { authFetch } from './api'

export interface PendingInvitation {
  id: string
  channel: string
  destination: string
  created_at: string
  expires_at: string
}

export interface AcceptedInvitation {
  id: string
  display_name: string
  accepted_at: string
  // On a group's gathering (CK-92): true for a person invited from outside
  // the group. Optional — absent reads as a member's row (CK-93).
  from_outside?: boolean
}

export interface InvitationLists {
  pending: PendingInvitation[]
  accepted: AcceptedInvitation[]
}

// The token-resolution states the backend distinguishes (the CK-9
// /email-change precedent: a dead link gets a distinguished screen, never a
// blank page).
export type InvitationStatus = 'valid' | 'expired' | 'used' | 'revoked' | 'invalid'

export interface InvitationPreview {
  status: InvitationStatus
  gathering_title: string | null
}

export interface AcceptResult {
  // `other_address` since CK-101: the invitation was sent to another address
  // than the signed-in account's, nothing was written, and the landing asks
  // (THE STEP). It carries the gathering's title, never the destination.
  status: 'accepted' | 'already_accepted' | 'other_address' | Exclude<InvitationStatus, 'valid'>
  gathering_id: string | null
  gathering_title?: string | null
}

// The acceptance (CK-25), and since CK-101 its second asking: opening sends
// exactly `{"token"}`, as before, so a deploy window's old API answers as it
// always has; only Accept as {name} on the step sends the confirmation,
// `{"token", "confirm_other_address": true}`. A thrown fetch or a non-2xx is
// `{ ok: false }` — the landing decides what that draws.
export async function acceptInvitation(
  token: string,
  confirmOtherAddress = false,
): Promise<{ ok: true; result: AcceptResult } | { ok: false }> {
  try {
    const response = await authFetch('/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmOtherAddress ? { token, confirm_other_address: true } : { token }),
    })
    if (!response.ok) return { ok: false }
    return { ok: true, result: (await response.json()) as AcceptResult }
  } catch {
    return { ok: false }
  }
}

// The invitation token must survive the sign-in round trip: an invitee with
// no session leaves for their inbox and comes back through /auth/callback,
// which is a full navigation — so the acceptance screen parks the token here
// and the callback routes back to the acceptance screen when one is parked.
// Cleared the moment the token is redeemed or found dead.
const TOKEN_KEY = 'covey-keep:invitation-token'

export function storeInvitationToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Storage unavailable (private mode): acceptance still works while the
    // tab lives; a sign-in round trip loses the token, and re-clicking the
    // emailed link recovers — acceptance is idempotent.
  }
}

export function readInvitationToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function clearInvitationToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing stored to clear.
  }
}

// A refused Revoke's line beneath its row (CK-96, approved 2026-11-14): one
// copy, read by a gathering's Invitations and a group's People page.
export const REVOKE_REFUSED = 'Something went wrong. Nothing changed — try again.'
