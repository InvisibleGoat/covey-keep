import { createContext } from 'react'

export interface Person {
  id: string
  display_name: string
  email: string
  // IANA zone name (e.g. America/Chicago); null until captured on first
  // sign-in or set in /settings. Every gathering time renders through this.
  timezone: string | null
  // The caller's own account id, from /auth/me (CK-20). No gate reads it
  // since CK-69: a role comes from the body's `caller_role` (roleFlags,
  // groupRoleFlags), and no surface compares account ids.
  account_id: string
}

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export interface AuthState {
  status: AuthStatus
  person: Person | null
  // The sign-in return's one fact (CK-79): true while THIS PAGE LOAD has
  // been signed out since its auth state first settled and has never been
  // signed in — the only time `RequireAuth` parks the page it turns away. A
  // visitor who arrives without a session, or whose stored session fails
  // its first check, is a signed-out visit; a sign-out, or a 401 that ends a
  // session this page load held, is not, so the next person to sign in on a
  // shared device never lands on the last one's page. Optional so a
  // hand-built context (a test's) parks nothing; `AuthProvider` always sets
  // it.
  signedOutSinceLoad?: boolean
  signIn: (token: string) => void
  signOut: () => Promise<void>
  // Called with the server's response after a profile save so edits show up
  // everywhere immediately (no reload, no refetch).
  updatePerson: (person: Person) => void
}

export const AuthContext = createContext<AuthState | null>(null)
