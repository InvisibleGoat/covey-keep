// /groups/join — the group link's landing (CK-79, Groups 3b;
// decisions/2026-10-23-joining-a-group-and-co-admins.md §2, §12). The link a
// member shares ends here with its token in the URL FRAGMENT. Deliberately
// NOT behind RequireAuth: a signed-out holder must see which group the link
// is for and how to ask to join.
//
// THE TOKEN: the fragment is consumed exactly once and stripped from the
// address bar and history (the AuthCallback discipline); a fresh token is
// parked across the sign-in round trip (lib/groupJoining.ts, CK-25's shape)
// and picked back up on the return leg, when there is no fragment. No token
// anywhere is the didn't-work screen, and no request is sent. The parked
// token is cleared at every terminal outcome — a request made or already
// waiting, already a member, a dead token, Not now.
//
// PREVIEW FIRST, SIGNED IN OR OUT (`POST /group-links/preview`, unauthenticated
// — CK-25's reason): every dead token gets its own screen before anyone is
// pushed through a sign-in. The preview runs once per token; which screen a
// valid preview shows is read from the auth state at render, so a session
// that settles after the preview still gets the right one.
//
// ASKING IS A PRESS, NEVER AN OPENING (Steven, 2026-10-27): a signed-in
// holder reads which group it is and that its admin and co-admins will see
// their name, and nothing is sent until they press Ask to join — a forwarded
// link may be for a group they do not want, and their name reaches its
// admins only when they choose. Signed out, Sign in to ask to join parks
// this address as the sign-in return (lib/returnPath.ts) and goes to `/`;
// the callback brings them back here.
//
// NOTHING HERE PROMISES A NOTICE: a declined requester is not told, for now
// (Steven, 2026-10-27; record §12), and the waiting screen says so plainly.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { networkErrors } from '../lib/formErrors'
import {
  clearGroupLinkToken,
  consumeFragmentToken,
  JOIN_RATE_LIMITED,
  JOIN_SIGNED_OUT_LINE,
  joinConsentLine,
  joinThroughLink,
  previewLink,
  readGroupLinkToken,
  requestInLine,
  storeGroupLinkToken,
  type LinkStatus,
} from '../lib/groupJoining'
import { parkReturnPath } from '../lib/returnPath'

type Preview =
  | { status: 'working' }
  | { status: 'missing' }
  | { status: 'failed' }
  | { status: LinkStatus; groupName: string | null }

// Where asking came to, once it is terminal on this screen.
type Asked = { status: 'requested' | 'pending' } | { status: 'expired' | 'revoked' | 'invalid' }

function groupLabel(groupName: string | null): string {
  return groupName ?? 'this group'
}

export function GroupJoin() {
  const { status: authStatus, person } = useAuth()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [fragmentConsumed, setFragmentConsumed] = useState(false)
  const [preview, setPreview] = useState<Preview>({ status: 'working' })
  const [previewKey, setPreviewKey] = useState(0)
  const [asked, setAsked] = useState<Asked | null>(null)
  const [asking, setAsking] = useState(false)
  const [askRefusal, setAskRefusal] = useState<string | null>(null)
  // The preview fires once per try (StrictMode re-runs effects).
  const previewedFor = useRef<number | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const fromFragment = consumeFragmentToken()
    if (fromFragment) storeGroupLinkToken(fromFragment)
    setToken(fromFragment ?? readGroupLinkToken())
    setFragmentConsumed(true)
  }, [])

  useEffect(() => {
    if (!fragmentConsumed || previewedFor.current === previewKey) return
    previewedFor.current = previewKey
    if (token === null) {
      setPreview({ status: 'missing' })
      return
    }
    async function check(resolved: string) {
      const outcome = await previewLink(resolved)
      if (!alive.current) return
      if (!outcome.ok) {
        setPreview({ status: 'failed' })
        return
      }
      // A dead token is spent for good: unpark it.
      if (outcome.status !== 'valid') clearGroupLinkToken()
      setPreview({ status: outcome.status, groupName: outcome.groupName })
    }
    void check(token)
  }, [fragmentConsumed, token, previewKey])

  async function ask() {
    if (token === null || asking) return
    setAsking(true)
    setAskRefusal(null)
    const outcome = await joinThroughLink(token)
    if (!alive.current) return
    setAsking(false)
    if (!outcome.ok) {
      // Not terminal: the token stays parked and the button is live again.
      if (outcome.code === 'rate_limited') setAskRefusal(JOIN_RATE_LIMITED)
      else if (outcome.code === 'unreachable') setAskRefusal(networkErrors().form[0])
      else setAskRefusal('Something went wrong. Nothing was sent — try again.')
      return
    }
    clearGroupLinkToken()
    if (outcome.status === 'already_member' && outcome.groupId) {
      navigate(`/groups/${outcome.groupId}`, { replace: true })
      return
    }
    if (outcome.status === 'already_member') {
      // A member's outcome always carries the id; without one, the dead
      // link's screen is the honest answer.
      setAsked({ status: 'invalid' })
      return
    }
    setAsked({ status: outcome.status })
  }

  function notNow() {
    clearGroupLinkToken()
    navigate('/home')
  }

  const groupName = 'groupName' in preview ? preview.groupName : null
  const shown = asked?.status ?? preview.status

  if (shown === 'working' || (preview.status === 'valid' && authStatus === 'loading')) {
    return (
      <main className="auth-screen">
        <p>Checking the link…</p>
      </main>
    )
  }

  if (shown === 'requested' || shown === 'pending') {
    return (
      <main className="auth-screen">
        <h1>{shown === 'requested' ? 'Your request is in' : "You've already asked to join"}</h1>
        <p>{requestInLine(groupName)}</p>
        <Link to="/groups">Your groups</Link>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  if (shown === 'valid' && authStatus === 'signedIn') {
    return (
      <main className="auth-screen">
        <h1>Join {groupLabel(groupName)}?</h1>
        <p>{joinConsentLine(person?.display_name ?? null)}</p>
        <button type="button" disabled={asking} onClick={() => void ask()}>
          {asking ? 'Asking…' : 'Ask to join'}
        </button>
        {askRefusal && (
          <p className="form-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {askRefusal}
          </p>
        )}
        <button type="button" className="link-button" disabled={asking} onClick={notNow}>
          Not now
        </button>
      </main>
    )
  }

  if (shown === 'valid') {
    return (
      <main className="auth-screen">
        <h1>Join {groupLabel(groupName)}</h1>
        <p>{JOIN_SIGNED_OUT_LINE}</p>
        <Link to="/" onClick={() => parkReturnPath('/groups/join')}>
          Sign in to ask to join
        </Link>
      </main>
    )
  }

  if (shown === 'expired') {
    return (
      <main className="auth-screen">
        <h1>This link has expired</h1>
        <p>Group links last 7 days. Ask someone in the group for the current one.</p>
      </main>
    )
  }

  if (shown === 'revoked') {
    return (
      <main className="auth-screen">
        <h1>This link has been turned off</h1>
        <p>Ask someone in the group for the current link.</p>
      </main>
    )
  }

  if (shown === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error" role="alert">
          The link couldn't be checked just now.
        </p>
        <button
          type="button"
          onClick={() => {
            setPreview({ status: 'working' })
            setPreviewKey((key) => key + 1)
          }}
        >
          Try again
        </button>
      </main>
    )
  }

  // missing and invalid: the link never resolved to a group at all.
  return (
    <main className="auth-screen">
      <h1>That link didn't work</h1>
      <p>The link looks incomplete or isn't valid. Ask someone in the group to send it again.</p>
    </main>
  )
}
