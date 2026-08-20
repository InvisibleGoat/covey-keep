import { createContext } from 'react'

export interface Person {
  id: string
  display_name: string
  email: string
}

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export interface AuthState {
  status: AuthStatus
  person: Person | null
  signIn: (token: string) => void
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
