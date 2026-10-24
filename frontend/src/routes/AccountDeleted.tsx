import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { carriesAccountDeletedSignal } from '../lib/accountDeleted'
import { clearToken } from '../lib/session'

// Deliberately unguarded: the person landing here has no session any more.
// A plain confirmation, not the sign-in form with no explanation (CK-8).
//
// Since CK-76.1 the deletion's LAST step happens here, not in the Settings
// handler: the handler navigates to this route carrying a one-shot signal in
// the navigation's state, and this screen clears the session once it has
// rendered — so the person is never signed out while a guarded route is
// still on screen (React Router 7 runs a navigation as a transition; an
// urgent auth update made beside it renders first, and RequireAuth on the
// old route redirects before the navigation lands). The signal is then spent
// by replacing the entry's state, so a reload, Back or a later visit finds
// none. A direct visit — typed, bookmarked, signed in or out — carries no
// signal and signs nobody out.
export function AccountDeleted() {
  const location = useLocation()
  const navigate = useNavigate()
  const justDeleted = carriesAccountDeletedSignal(location.state)

  useEffect(() => {
    if (!justDeleted) return
    // This route has no guard, so the signed-out render that follows stays
    // right here. Clear first, then spend the signal: the replace is a
    // transition and lands after the clear has rendered.
    clearToken()
    navigate(location.pathname, { replace: true, state: null })
  }, [justDeleted, navigate, location.pathname])

  return (
    <main className="auth-screen">
      <h1>Your account is deleted</h1>
      <p>Your name and sign-in details are gone. What you contributed stays with the gatherings you gave it to.</p>
      <p>You're welcome back any time — signing up again starts a fresh account, not a way back into this one.</p>
      <Link to="/">Back to sign in</Link>
    </main>
  )
}
