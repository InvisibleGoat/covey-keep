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
// address as the sign-in return (lib/returnPath.ts). Signed in: OPENING
// ACCEPTS (CK-25's rule — the invitation was addressed to them, unlike the
// group's link, where asking is a press), and `accepted` or
// `already_accepted` lands on the group's page. Acceptance is idempotent
// server-side. The parked token is cleared on redemption and on any dead
// state.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
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
  | { status: 'failed' }

export function GroupInvitationAccept() {
  const { status: authStatus } = useAuth()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [fragmentConsumed, setFragmentConsumed] = useState(false)
  const [screen, setScreen] = useState<ScreenState>({ status: 'working' })
  // One call per auth state (StrictMode re-runs effects): the preview while
  // signed out, the acceptance once signed in — so a session that settles
  // after the preview still accepts.
  const startedFor = useRef<string | null>(null)
  const alive = useRef(true)

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
    if (!fragmentConsumed || authStatus === 'loading' || startedFor.current === authStatus) return
    if (token === null) {
      setScreen({ status: 'missing' })
      return
    }
    startedFor.current = authStatus

    async function act(resolved: string) {
      if (authStatus === 'signedIn') {
        const outcome = await acceptGroupInvitation(resolved)
        if (!alive.current) return
        if (!outcome.ok) {
          setScreen({ status: 'failed' })
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
        // A dead token is spent for good — unpark it so the callback stops
        // routing back here.
        clearGroupInvitationToken()
        const dead = outcome.status
        setScreen({
          status:
            dead === 'expired' || dead === 'used' || dead === 'revoked' ? dead : 'invalid',
        })
        return
      }
      const preview = await previewGroupInvitation(resolved)
      if (!alive.current) return
      if (!preview.ok) {
        setScreen({ status: 'failed' })
        return
      }
      if (preview.status === 'valid') {
        setScreen({ status: 'signInNeeded', groupName: preview.groupName })
        return
      }
      clearGroupInvitationToken()
      setScreen({ status: preview.status })
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
        <h1>You're invited to join {screen.groupName ?? 'a group'}</h1>
        <p>Sign in, or create your account, to accept — you'll come right back here.</p>
        <Link to="/" onClick={() => parkReturnPath('/groups/invitations/accept')}>
          Sign in to accept
        </Link>
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
          If that was you, sign in with the same account and the group will be in Your groups.
          Otherwise, ask the person who invited you to send a fresh one.
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
