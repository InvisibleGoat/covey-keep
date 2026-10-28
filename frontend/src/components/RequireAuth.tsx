import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { parkReturnPath } from '../lib/returnPath'

// The route guard. A signed-out visitor is sent to the sign-in screen at `/`
// — that redirect is unchanged since CK-6 — and, since CK-79, the page they
// were turned away from is PARKED first (lib/returnPath.ts), so the sign-in
// round trip brings them back to it instead of to Home.
//
// It parks only when this page load has been signed out since its auth
// state first settled (`signedOutSinceLoad`): a visitor with no session, or
// whose stored session failed its first check. A sign-out, or a 401 that
// ends a session this page load held, parks nothing — the next person to
// sign in on a shared device must not land on the last one's page. What
// parks is `pathname + search` and never `hash`: a fragment is where this
// app carries tokens.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, signedOutSinceLoad } = useAuth()
  const location = useLocation()
  const turnedAway = location.pathname + location.search
  const parks = status === 'signedOut' && signedOutSinceLoad === true

  // Parked in an effect, not during render: a render can be discarded, an
  // effect runs only for what was committed. `<Navigate>`'s own effect runs
  // first (a child's effects precede its parent's), but a router navigation
  // is a transition that renders later, so the path parked here is still
  // the one this render turned away.
  useEffect(() => {
    if (parks) parkReturnPath(turnedAway)
  }, [parks, turnedAway])

  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Signing you in…</p>
      </main>
    )
  }
  if (status === 'signedOut') return <Navigate to="/" replace />
  return <>{children}</>
}
