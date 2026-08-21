import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { getToken } from '../lib/session'
import type { Person } from '../auth/context'

type Status = 'success' | 'expired' | 'used' | 'taken' | 'invalid'

function readStatus(): Status {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const status = fragment.get('status')
  return status === 'success' || status === 'expired' || status === 'used' || status === 'taken'
    ? status
    : 'invalid'
}

const FAILURE_COPY: Record<Exclude<Status, 'success'>, { heading: string; body: string }> = {
  expired: {
    heading: 'That link has expired',
    body: 'Email-change links work for one hour. You can request a fresh one from Settings.',
  },
  used: {
    heading: 'That link was already used',
    body: "Confirmation links work once. If you made the change, you're all set — sign in with your new address.",
  },
  taken: {
    heading: "That address can't be used",
    body: "It now belongs to another account, so this change can't be completed. You can request a change to a different address from Settings.",
  },
  invalid: {
    heading: "That link didn't work",
    body: 'It may have been copied incompletely. Try the link from the email again, or request a fresh one from Settings.',
  },
}

// Deliberately unguarded: the confirmation link is often opened in a browser
// with no session — that is the whole point of the unauthenticated verify
// endpoint (the token is the authorization).
export function EmailChangeResult() {
  const { status: authStatus, updatePerson } = useAuth()
  const [status] = useState<Status>(readStatus)

  useEffect(() => {
    // When THIS browser holds the surviving session, refetch the profile so
    // the app shows the new address everywhere without a reload.
    if (status !== 'success' || !getToken()) return
    void (async () => {
      try {
        const response = await authFetch('/auth/me')
        if (response.ok) updatePerson((await response.json()) as Person)
      } catch {
        // Best effort — the next full load reflects the change regardless.
      }
    })()
  }, [status, updatePerson])

  if (status === 'success') {
    return (
      <main className="auth-screen">
        <h1>Your sign-in email is changed</h1>
        <p>Use the new address next time you sign in.</p>
        <p>
          For safety, every other device was signed out — only the device that asked for the
          change is still signed in.
        </p>
        {authStatus === 'signedIn' ? (
          <Link to="/home">Back to your gatherings</Link>
        ) : (
          <Link to="/">Go to sign in</Link>
        )}
      </main>
    )
  }

  const copy = FAILURE_COPY[status]
  return (
    <main className="auth-screen">
      <h1>{copy.heading}</h1>
      <p>{copy.body}</p>
      <Link to="/">Back to sign in</Link>
    </main>
  )
}
