import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { authFetch } from '../lib/api'
import { clearToken, getToken, setToken, subscribe } from '../lib/session'
import { AuthContext, type AuthStatus, type Person } from './context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'signedOut'))
  const [person, setPerson] = useState<Person | null>(null)

  const loadPerson = useCallback(async () => {
    try {
      const response = await authFetch('/auth/me')
      if (response.ok) {
        setPerson((await response.json()) as Person)
        setStatus('signedIn')
      } else if (response.status === 401) {
        // authFetch already cleared the token; state follows the server.
        setPerson(null)
        setStatus('signedOut')
      } else {
        // API trouble is not a revocation — stay signed in without a profile.
        setPerson(null)
        setStatus('signedIn')
      }
    } catch {
      setPerson(null)
      setStatus(getToken() ? 'signedIn' : 'signedOut')
    }
  }, [])

  useEffect(() => {
    if (getToken()) void loadPerson()
    // Only the server may end a session (401 → cleared token); mirror that here.
    return subscribe(() => {
      if (!getToken()) {
        setPerson(null)
        setStatus('signedOut')
      }
    })
  }, [loadPerson])

  const signIn = useCallback(
    (token: string) => {
      setToken(token)
      setStatus('loading')
      void loadPerson()
    },
    [loadPerson],
  )

  const signOut = useCallback(async () => {
    try {
      await authFetch('/auth/logout', { method: 'POST' })
    } catch {
      // Best effort — the local session ends regardless.
    }
    clearToken()
    setPerson(null)
    setStatus('signedOut')
  }, [])

  return (
    <AuthContext.Provider value={{ status, person, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}
