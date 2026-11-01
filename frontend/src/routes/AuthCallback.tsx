import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { BrandMark, Quail, SignInPrints } from '../components/AuthArt'
import { readInvitationToken } from '../lib/invitations'
import { takeReturnPath } from '../lib/returnPath'

export function AuthCallback() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  // The fragment is consumed exactly once — StrictMode re-runs the effect with
  // the hash already stripped, which must not flip a good sign-in to an error.
  const handled = useRef(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const token = fragment.get('token')
    // Strip the fragment immediately: the token must not sit in the address
    // bar, browser history, or a copy-pasted bug report.
    history.replaceState(null, '', window.location.pathname)
    if (token) {
      signIn(token)
      // Where the person was going, in this order (CK-79):
      //   1. the sign-in return — a page `RequireAuth` turned them away from,
      //      or a landing screen that sent them to sign in — when one is
      //      parked, valid and fresh (lib/returnPath.ts; taking it clears it);
      //   2. else the CK-25 acceptance screen when an invitation token is
      //      parked — the branch from before CK-79, kept as the fallback;
      //   3. else Groups — Home is retired (CK-82), and sign-in lands on
      //      Groups.
      const back = takeReturnPath()
      navigate(back ?? (readInvitationToken() ? '/invitations/accept' : '/groups'), { replace: true })
    } else {
      setFailed(true)
    }
  }, [signIn, navigate])

  // The mockup's waiting style (CK-81): the quail breathing above the line
  // (stilled under reduced motion), and the failure in its expired-link
  // design — the prints, the small mark, the screen's own words, and the
  // way back as the primary button.
  if (!failed) {
    return (
      <main className="auth-screen">
        <div className="auth-wait">
          <Quail />
          <p>Signing you in…</p>
        </div>
      </main>
    )
  }

  return (
    <main className="auth-screen auth-split">
      <SignInPrints />
      <div className="auth-side">
        <BrandMark />
        <div className="auth-head">
          <h1>That link didn't work</h1>
          <p>Sign-in links work once and expire after 15 minutes. This one has expired or was already used.</p>
        </div>
        <Link to="/" className="btn btn-primary">
          Request a new sign-in link
        </Link>
      </div>
    </main>
  )
}
