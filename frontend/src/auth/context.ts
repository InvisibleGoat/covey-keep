import { createContext } from 'react'

export interface Person {
  id: string
  display_name: string
  email: string
  // IANA zone name (e.g. America/Chicago); null until captured on first
  // sign-in or set in /settings. Every gathering time renders through this.
  timezone: string | null
}

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export interface AuthState {
  status: AuthStatus
  person: Person | null
  signIn: (token: string) => void
  signOut: () => Promise<void>
  // Called with the server's response after a profile save so edits show up
  // everywhere immediately (no reload, no refetch).
  updatePerson: (person: Person) => void
}

export const AuthContext = createContext<AuthState | null>(null)
