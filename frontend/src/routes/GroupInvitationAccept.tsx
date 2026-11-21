// /groups/invitations/accept — the emailed group invitation's landing (CK-79,
// Groups 3b; decisions/2026-10-23-joining-a-group-and-co-admins.md §2).
// CK-25's acceptance screen (`routes/InvitationAccept.tsx`) exactly, with
// the group as its target — kept a component of its own so the gathering's
// screen does not change. Deliberately NOT behind RequireAuth: a signed-out
// invitee must see what they were invited to and where to sign in.
//
// The token rides the URL FRAGMENT; it is consumed once and stripped (the
// AuthCallback discipline), parked across the sign-in round trip
// (lib/groupJoining.ts) and picked back up on the return leg. Signed out: an
// unauthenticated preview renders the invitation's state — every dead token
// gets its DISTINGUISHED screen before anyone is pushed through a pointless
// sign-in — and a valid one offers Sign in to accept, which parks this
// address as the sign-in return (lib/returnPath.ts). Signed in: opening
// sends the acceptance, and the server accepts it when the invitation was
// sent to the signed-in account's own address (unlike the group's link,
// where asking is a press); `accepted` or `already_accepted` lands on the
// group's page. Acceptance is idempotent server-side. The parked token is
// cleared on redemption and on any dead state.
//
// Since CK-101, when the invitation was sent to another address the server
// writes nothing and answers `other_address`, and this draws THE STEP
// (components/InvitationStep.tsx), focus on its <h1>: Accept as {name} sends
// the acceptance again with `confirm_other_address`, and lands as above or,
// failing, keeps the step with the house line beneath it and focus back on
// the button; Sign out and use the invited address ends the session and
// leaves the parked token where it is, so the landing runs again signed out
// and shows the preview's screen with focus on its <h1>. An `other_address`
// with no group name is an answer this screen cannot draw, and reads as
// `invalid`.
//
// Since CK-97 a failed check says one sentence, an alert, and offers Try
// again, which runs the same call once more on the token still held — the
// preview signed out, the acceptance signed in. Focus lands on the new
// screen's <h1>, or on the new Try again where it fails again; a landing
// that navigates needs nothing.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { InvitationStep } from '../components/InvitationStep'
import { useFocusRequest } from '../components/useFocusRequest'
import {
  acceptGroupInvitation,
  clearGroupInvitationToken,
  consumeFragmentToken,
  previewGroupInvitation,
  readGroupInvitationToken,
  storeGroupInvitationToken,
} from '../lib/groupJoining'
import { parkReturnPath } from '../lib/returnPath'

type ScreenState =
  | { status: 'working' }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'revoked' }
  | { status: 'signInNeeded'; groupName: string | null }
  | { status: 'otherAddress'; groupName: string }
  | { status: 'failed' }

export function GroupInvitationAccept() {
  const { status: authStatus, person, signOut } = useAuth()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [fragmentConsumed, setFragmentConsumed] = useState(false)
  const [screen, setScreen] = useState<ScreenState>({ status: 'working' })
  // One call per auth state (StrictMode re-runs effects): the preview while
  // signed out, the acceptance once signed in — so a session that settles
  // after the preview still accepts.
  // A Try again is a new attempt under the same auth state (CK-97).
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

  useEffect(() => {
    const fromFragment = consumeFragmentToken()
    if (fromFragment) storeGroupInvitationToken(fromFragment)
    setToken(fromFragment ?? readGroupInvitationToken())
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
      if (authStatus === 'signedIn') {
        const outcome = await acceptGroupInvitation(resolved)
        if (!alive.current) return
        if (!outcome.ok) {
          show({ status: 'failed' })
          return
        }
        if (
          (outcome.status === 'accepted' || outcome.status === 'already_accepted') &&
          outcome.groupId
        ) {
          clearGroupInvitationToken()
          navigate(`/groups/${outcome.groupId}`, { replace: true })
          return
        }
        if (outcome.status === 'other_address' && outcome.groupName) {
          // Nothing was written or spent: the token stays parked for either
          // answer, and focus goes to the step's heading, never a button.
          setStepFailed(false)
          setScreen({ status: 'otherAddress', groupName: outcome.groupName })
          requestFocus(headingRef)
          return
        }
        // A dead token is spent for good — unpark it so the callback stops
        // routing back here.
        clearGroupInvitationToken()
        const dead = outcome.status
        show({
          status:
            dead === 'expired' || dead === 'used' || dead === 'revoked' ? dead : 'invalid',
        })
        return
      }
      const preview = await previewGroupInvitation(resolved)
      if (!alive.current) return
      if (!preview.ok) {
        show({ status: 'failed' })
        return
      }
      if (preview.status === 'valid') {
        show({ status: 'signInNeeded', groupName: preview.groupName })
        return
      }
      clearGroupInvitationToken()
      show({ status: preview.status })
    }
    void act(token)
  }, [fragmentConsumed, token, authStatus, attempt, navigate, requestFocus])

  // Accept as {name}: the acceptance again, confirmed. A landing navigates;
  // a dead token is spent and draws its screen; a failure keeps the step.
  async function acceptAnyway() {
    if (token === null) return
    setStepFailed(false)
    setStepBusy(true)
    const outcome = await acceptGroupInvitation(token, true)
    if (!alive.current) return
    setStepBusy(false)
    if (!outcome.ok) {
      setStepFailed(true)
      requestFocus(acceptRef)
      return
    }
    if ((outcome.status === 'accepted' || outcome.status === 'already_accepted') && outcome.groupId) {
      clearGroupInvitationToken()
      navigate(`/groups/${outcome.groupId}`, { replace: true })
      return
    }
    clearGroupInvitationToken()
    const dead = outcome.status
    setScreen({ status: dead === 'expired' || dead === 'used' || dead === 'revoked' ? dead : 'invalid' })
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

  if (screen.status === 'working') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <p>Checking your invitation…</p>
      </main>
    )
  }

  if (screen.status === 'otherAddress') {
    return (
      <main className="auth-screen" ref={mainRef}>
        <InvitationStep
          invitationTo={`join ${screen.groupName}`}
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
      <main className="auth-screen" ref={mainRef}>
        <h1 ref={headingRef} tabIndex={-1}>You're invited to join {screen.groupName ?? 'a group'}</h1>
        <p>Sign in, or create your account, to accept — you'll come right back here.</p>
        <Link to="/" onClick={() => parkReturnPath('/groups/invitations/accept')}>
          Sign in to accept
        </Link>
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
          If that was you, sign in with the same account and the group will be in Your groups.
          Otherwise, ask the person who invited you to send a fresh one.
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
