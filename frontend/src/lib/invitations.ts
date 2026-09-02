// Invitation API types and the pending-token handoff (CK-25). Shapes mirror
// backend/app/api/invitations.py's response bodies exactly — see
// reference/backend/api-reference.md, Invitations router.

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
  status: 'accepted' | 'already_accepted' | Exclude<InvitationStatus, 'valid'>
  gathering_id: string | null
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
