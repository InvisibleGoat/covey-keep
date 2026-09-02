import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { apiFetch, authFetch } from '../lib/api'
import {
  clearInvitationToken,
  readInvitationToken,
  storeInvitationToken,
  type AcceptResult,
  type InvitationPreview,
} from '../lib/invitations'

// The acceptance landing screen (CK-25). The emailed invitation link ends
// here with the token in the URL FRAGMENT (never the query string — it must
// not reach server logs or Referer). Deliberately NOT behind RequireAuth: a
// signed-out invitee must see what they were invited to and where to sign in.
//
// Signed in: the token is redeemed immediately (opening the link IS the
// intent — the CK-9 email-change precedent) and success navigates straight
// to the gathering. Signed out: an unauthenticated preview renders the
// invitation's state — dead tokens get their DISTINGUISHED screens before
// anyone is pushed through a pointless sign-in — and a valid one parks the
// token (lib/invitations.ts) so it survives the magic-link round trip;
// /auth/callback routes back here when a parked token exists.

type ScreenState =
  | { status: 'working' }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'revoked' }
  | { status: 'signInNeeded'; title: string | null }
  | { status: 'failed' }

export function InvitationAccept() {
  const { status: authStatus } = useAuth()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [fragmentConsumed, setFragmentConsumed] = useState(false)
  const [screen, setScreen] = useState<ScreenState>({ status: 'working' })
  // The accept/preview call fires exactly once (StrictMode re-runs effects);
  // accepting is idempotent server-side, but one call is still the contract.
  const started = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Consume the fragment exactly once (the AuthCallback discipline): the raw
  // token must not sit in the address bar, history, or a pasted bug report.
  // A fresh token is parked immediately — the sign-in round trip is a full
  // navigation away and back. With no fragment (the return leg), the parked
  // token is picked back up.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const fromFragment = fragment.get('token')
    history.replaceState(null, '', window.location.pathname)
    if (fromFragment) storeInvitationToken(fromFragment)
    setToken(fromFragment ?? readInvitationToken())
    setFragmentConsumed(true)
  }, [])

  useEffect(() => {
    if (!fragmentConsumed || authStatus === 'loading' || started.current) return
    if (token === null) {
      setScreen({ status: 'missing' })
      return
    }
    started.current = true

    async function act(resolved: string) {
      try {
        if (authStatus === 'signedIn') {
          const response = await authFetch('/invitations/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resolved }),
          })
          if (!alive.current) return
          if (!response.ok) {
            setScreen({ status: 'failed' })
            return
          }
          const result = (await response.json()) as AcceptResult
          if (
            (result.status === 'accepted' || result.status === 'already_accepted') &&
            result.gathering_id
          ) {
            clearInvitationToken()
            // The invitee ends up signed in and looking at the gathering.
            navigate(`/gatherings/${result.gathering_id}`, { replace: true })
            return
          }
          // A dead token is spent for good — unpark it so the callback stops
          // routing back here.
          clearInvitationToken()
          setScreen({ status: result.status as Exclude<AcceptResult['status'], 'accepted' | 'already_accepted'> })
        } else {
          const response = await apiFetch('/invitations/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resolved }),
          })
          if (!alive.current) return
          if (!response.ok) {
            setScreen({ status: 'failed' })
            return
          }
          const preview = (await response.json()) as InvitationPreview
          if (preview.status === 'valid') {
            setScreen({ status: 'signInNeeded', title: preview.gathering_title })
          } else {
            clearInvitationToken()
            setScreen({ status: preview.status })
          }
        }
      } catch {
        if (alive.current) setScreen({ status: 'failed' })
      }
    }
    void act(token)
  }, [fragmentConsumed, token, authStatus, navigate])

  if (screen.status === 'working') {
    return (
      <main className="auth-screen">
        <p>Checking your invitation…</p>
      </main>
    )
  }

  if (screen.status === 'signInNeeded') {
    return (
      <main className="auth-screen">
        <h1>You're invited</h1>
        {screen.title !== null && <p>You've been invited to "{screen.title}".</p>}
        <p>Sign in (or create your account) to accept — you'll come right back here.</p>
        <Link to="/">Sign in to accept</Link>
      </main>
    )
  }

  if (screen.status === 'expired') {
    return (
      <main className="auth-screen">
        <h1>This invitation has expired</h1>
        <p>Invitations last 7 days. Ask the person who invited you to send a fresh one.</p>
      </main>
    )
  }

  if (screen.status === 'revoked') {
    return (
      <main className="auth-screen">
        <h1>This invitation is no longer active</h1>
        <p>It was withdrawn or replaced. Ask the person who invited you to send a fresh one.</p>
      </main>
    )
  }

  if (screen.status === 'used') {
    return (
      <main className="auth-screen">
        <h1>This invitation has already been used</h1>
        <p>
          If that was you, sign in with the same account and the gathering will be on your
          list. Otherwise, ask the person who invited you to send a fresh one.
        </p>
        <Link to="/">Go to sign in</Link>
      </main>
    )
  }

  if (screen.status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error">
          The invitation couldn't be checked just now. Try the link from your invitation
          again.
        </p>
      </main>
    )
  }

  // missing and invalid: the link never resolved to an invitation at all.
  return (
    <main className="auth-screen">
      <h1>That invitation link didn't work</h1>
      <p>
        The link looks incomplete or isn't valid. Try opening it again from your
        invitation, or ask for a new one.
      </p>
    </main>
  )
}
