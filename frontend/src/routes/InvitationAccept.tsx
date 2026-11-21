import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { BrandMark, Quail, SignInPrints } from '../components/AuthArt'
import { InvitationStep } from '../components/InvitationStep'
import { useFocusRequest } from '../components/useFocusRequest'
import { apiFetch } from '../lib/api'
import {
  acceptInvitation,
  clearInvitationToken,
  readInvitationToken,
  storeInvitationToken,
  type AcceptResult,
  type InvitationPreview,
} from '../lib/invitations'
import { parkReturnPath } from '../lib/returnPath'

// The acceptance landing screen (CK-25). The emailed invitation link ends
// here with the token in the URL FRAGMENT (never the query string — it must
// not reach server logs or Referer). Deliberately NOT behind RequireAuth: a
// signed-out invitee must see what they were invited to and where to sign in.
//
// Signed in: opening sends the acceptance (the CK-9 email-change
// precedent), the server accepts it when the invitation was sent to the
// signed-in account's own address, and success navigates straight to the
// gathering. Signed out: an unauthenticated preview renders the
// invitation's state — dead tokens get their DISTINGUISHED screens before
// anyone is pushed through a pointless sign-in — and a valid one parks the
// token (lib/invitations.ts) so it survives the magic-link round trip;
// /auth/callback routes back here when a parked token exists.
//
// Since CK-97 a failed check says one sentence, an alert, and offers Try
// again, which runs the same call once more on the token still held — the
// preview signed out, the acceptance signed in. Focus lands on the new
// screen's <h1>, or on the new Try again where it fails again; a landing
// that navigates needs nothing.
//
// Since CK-101, when the invitation was sent to another address the server
// writes nothing and answers `other_address`, and this draws THE STEP
// (components/InvitationStep.tsx), focus on its <h1>: Accept as {name} sends
// the acceptance again with `confirm_other_address`, and lands as above or,
// failing, keeps the step with the house line beneath it and focus back on
// the button; Sign out and use the invited address ends the session and
// leaves the parked token where it is. The call runs once per auth state, as
// the group landing's does, so the sign-out runs the landing again signed
// out — the preview — with focus on its screen's <h1>. An `other_address`
// with no title, like any answer this screen does not know, reads as
// `invalid`.

type ScreenState =
  | { status: 'working' }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'revoked' }
  | { status: 'signInNeeded'; title: string | null }
  | { status: 'otherAddress'; title: string }
  | { status: 'failed' }

export function InvitationAccept() {
  const { status: authStatus, person, signOut } = useAuth()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [fragmentConsumed, setFragmentConsumed] = useState(false)
  const [screen, setScreen] = useState<ScreenState>({ status: 'working' })
  // The accept/preview call fires exactly once per auth state (StrictMode
  // re-runs effects); accepting is idempotent server-side, but one call is
  // still the contract. A Try again is a new attempt, the call made once
  // more (CK-97); a sign-out from THE STEP is a new auth state, so the
  // preview follows it (CK-101 — until then the call ran once per attempt,
  // whatever the auth state).
  const startedFor = useRef<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retryOwed = useRef(false)
  const alive = useRef(true)
  const mainRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const tryAgainRef = useRef<HTMLButtonElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusRequest(mainRef)
  // THE STEP's press (CK-101): busy while Accept as is out, and whether the
  // last one failed — the house line beneath the buttons.
  const [stepBusy, setStepBusy] = useState(false)
  const [stepFailed, setStepFailed] = useState(false)

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
    const key = `${authStatus}:${attempt}`
    if (!fragmentConsumed || authStatus === 'loading' || startedFor.current === key) return
    if (token === null) {
      setScreen({ status: 'missing' })
      return
    }
    startedFor.current = key
    const owed = retryOwed.current
    retryOwed.current = false
    // Where a retry's answer lands: the new screen's heading, or the new
    // Try again (the hook spends it after the render that draws it).
    const show = (next: ScreenState) => {
      setScreen(next)
      if (owed) requestFocus(next.status === 'failed' ? tryAgainRef : headingRef)
    }

    async function act(resolved: string) {
      try {
        if (authStatus === 'signedIn') {
          const outcome = await acceptInvitation(resolved)
          if (!alive.current) return
          if (!outcome.ok) {
            show({ status: 'failed' })
            return
          }
          const result = outcome.result
          if (
            (result.status === 'accepted' || result.status === 'already_accepted') &&
            result.gathering_id
          ) {
            clearInvitationToken()
            // The invitee ends up signed in and looking at the gathering.
            navigate(`/gatherings/${result.gathering_id}`, { replace: true })
            return
          }
          if (result.status === 'other_address' && result.gathering_title) {
            // Nothing was written or spent: the token stays parked for either
            // answer, and focus goes to the step's heading, never a button.
            setStepFailed(false)
            setScreen({ status: 'otherAddress', title: result.gathering_title })
            requestFocus(headingRef)
            return
          }
          // A dead token is spent for good — unpark it so the callback stops
          // routing back here.
          clearInvitationToken()
          show({ status: deadScreen(result.status) })
        } else {
          const response = await apiFetch('/invitations/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resolved }),
          })
          if (!alive.current) return
          if (!response.ok) {
            show({ status: 'failed' })
            return
          }
          const preview = (await response.json()) as InvitationPreview
          if (preview.status === 'valid') {
            // The sign-in return (CK-79): this screen's own address, so the
            // callback brings the invitee back here. The callback's
            // invitation-token branch, which did this alone before CK-79,
            // stays as its fallback.
            parkReturnPath('/invitations/accept')
            show({ status: 'signInNeeded', title: preview.gathering_title })
          } else {
            clearInvitationToken()
            show({ status: preview.status })
          }
        }
      } catch {
        if (alive.current) show({ status: 'failed' })
      }
    }
    void act(token)
  }, [fragmentConsumed, token, authStatus, attempt, navigate, requestFocus])

  // Accept as {name}: the acceptance again, confirmed. A landing navigates;
  // a dead token is spent and draws its screen; a failure keeps the step.
  async function acceptAnyway() {
    if (token === null) return
    setStepFailed(false)
    setStepBusy(true)
    const outcome = await acceptInvitation(token, true)
    if (!alive.current) return
    setStepBusy(false)
    if (!outcome.ok) {
      setStepFailed(true)
      requestFocus(acceptRef)
      return
    }
    const result = outcome.result
    if ((result.status === 'accepted' || result.status === 'already_accepted') && result.gathering_id) {
      clearInvitationToken()
      navigate(`/gatherings/${result.gathering_id}`, { replace: true })
      return
    }
    clearInvitationToken()
    setScreen({ status: deadScreen(result.status) })
    requestFocus(headingRef)
  }

  // Sign out and use the invited address: the session ends and the parked
  // token stays, so the landing runs again signed out — the preview — and
  // its screen's heading takes focus.
  async function signOutForInvited() {
    retryOwed.current = true
    setScreen({ status: 'working' })
    await signOut()
  }

  function tryAgain() {
    retryOwed.current = true
    setScreen({ status: 'working' })
    setAttempt((n) => n + 1)
  }

  // The two states the mockup draws (CK-81; screens 20 and 21): the waiting
  // quail while the invitation is checked, and the signed-out landing beside
  // the prints, with the small mark and the screen's own words. The dead
  // tokens' screens below keep their markup and take the look.
  if (screen.status === 'working') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <div className="auth-wait">
          <Quail />
          <p>Checking your invitation…</p>
        </div>
      </main>
    )
  }

  if (screen.status === 'otherAddress') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <InvitationStep
          invitationTo={`"${screen.title}"`}
          person={person}
          busy={stepBusy}
          failed={stepFailed}
          headingRef={headingRef}
          acceptRef={acceptRef}
          onAccept={() => void acceptAnyway()}
          onSignOut={() => void signOutForInvited()}
        />
      </main>
    )
  }

  if (screen.status === 'signInNeeded') {
    return (
      <main className="auth-screen auth-split" ref={mainRef}>
        <SignInPrints />
        <div className="auth-side">
          <BrandMark />
          <div className="auth-head">
            <h1 ref={headingRef} tabIndex={-1}>You're invited</h1>
            {screen.title !== null && <p>You've been invited to "{screen.title}".</p>}
            <p>Sign in (or create your account) to accept — you'll come right back here.</p>
          </div>
          <Link to="/" className="btn btn-primary">
            Sign in to accept
          </Link>
        </div>
      </main>
    )
  }

  if (screen.status === 'expired') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <h1 ref={headingRef} tabIndex={-1}>This invitation has expired</h1>
        <p>Invitations last 7 days. Ask the person who invited you to send a fresh one.</p>
      </main>
    )
  }

  if (screen.status === 'revoked') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <h1 ref={headingRef} tabIndex={-1}>This invitation is no longer active</h1>
        <p>It was withdrawn or replaced. Ask the person who invited you to send a fresh one.</p>
      </main>
    )
  }

  if (screen.status === 'used') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <h1 ref={headingRef} tabIndex={-1}>This invitation has already been used</h1>
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
      <main className="auth-screen" ref={mainRef}>
        <h1 ref={headingRef} tabIndex={-1}>Something went wrong</h1>
        <p className="form-error" role="alert">
          The invitation couldn't be checked just now.
        </p>
        <button ref={tryAgainRef} type="button" onClick={tryAgain}>
          Try again
        </button>
      </main>
    )
  }

  // missing and invalid: the link never resolved to an invitation at all.
  return (
    <main className="auth-screen" ref={mainRef}>
      <h1 ref={headingRef} tabIndex={-1}>That invitation link didn't work</h1>
      <p>
        The link looks incomplete or isn't valid. Try opening it again from your
        invitation, or ask for a new one.
      </p>
    </main>
  )
}

// A dead or unknown answer's screen: the three dead tokens by name, anything
// else — an answer this screen does not know included — `invalid`.
function deadScreen(status: AcceptResult['status']): 'expired' | 'used' | 'revoked' | 'invalid' {
  return status === 'expired' || status === 'used' || status === 'revoked' ? status : 'invalid'
}
