import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { authFetch } from '../lib/api'
import { clearToken, getToken, setToken, subscribe } from '../lib/session'
import { detectTimeZone } from '../lib/timezone'
import { AuthContext, type AuthStatus, type Person } from './context'

// Dedupes the first-sign-in timezone capture when React runs effects twice in
// development (StrictMode). Not a "once ever" latch: a failed attempt may
// retry on a later sign-in, and a different account signing in still gets one.
let timezoneCaptureInFlight = false

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'signedOut'))
  const [person, setPerson] = useState<Person | null>(null)

  const captureTimeZone = useCallback(async (loaded: Person) => {
    // Silent first-sign-in capture (CK-7). Browsers know the person's own
    // zone and every calendar product records it — but it is still a write
    // the user didn't ask for, so: only when nothing is set (a chosen value
    // is NEVER overwritten — the null check is the whole rule), and the
    // settings screen shows the result plainly so it stays correctable.
    if (loaded.timezone !== null || timezoneCaptureInFlight) return
    const detected = detectTimeZone()
    if (!detected) return
    timezoneCaptureInFlight = true
    try {
      const response = await authFetch('/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: detected }),
      })
      if (response.ok) setPerson((await response.json()) as Person)
      // Failure (including a zone the server doesn't recognize) is silent:
      // capture is best-effort and /settings remains the explicit path.
    } catch {
      // API unreachable — same story.
    } finally {
      timezoneCaptureInFlight = false
    }
  }, [])

  const loadPerson = useCallback(async () => {
    try {
      const response = await authFetch('/auth/me')
      if (response.ok) {
        const loaded = (await response.json()) as Person
        setPerson(loaded)
        setStatus('signedIn')
        void captureTimeZone(loaded)
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
  }, [captureTimeZone])

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

  const updatePerson = useCallback((next: Person) => setPerson(next), [])

  return (
    <AuthContext.Provider value={{ status, person, signIn, signOut, updatePerson }}>
      {children}
    </AuthContext.Provider>
  )
}
