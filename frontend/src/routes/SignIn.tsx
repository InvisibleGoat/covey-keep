import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { PRODUCT_NAME, TAGLINE } from '../brand'
import { apiFetch, TOS_VERSION } from '../lib/api'
import {
  browserSupportsWebAuthn,
  isCeremonyCancelled,
  signInWithPasskey,
} from '../lib/passkeys'

type SubmitState = 'idle' | 'submitting' | 'sent' | 'rateLimited' | 'failed'

export function SignIn() {
  const { status, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [tosAccepted, setTosAccepted] = useState(false)
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [apiStatus, setApiStatus] = useState('checking…')
  const [passkeySupported] = useState(() => browserSupportsWebAuthn())
  const [passkeyState, setPasskeyState] = useState<'idle' | 'working'>('idle')
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

  // The CK-4 deploy end-to-end check: frontend reaching the API it was built for.
  useEffect(() => {
    let cancelled = false
    apiFetch('/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { status?: string }) => {
        if (!cancelled) setApiStatus(body.status === 'ok' ? 'ok' : 'unexpected response')
      })
      .catch(() => {
        if (!cancelled) setApiStatus('unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (status === 'signedIn' || status === 'loading') return <Navigate to="/home" replace />

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!tosAccepted) return
    setSubmitState('submitting')
    try {
      const response = await apiFetch('/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, tos_accepted: tosAccepted, tos_version: TOS_VERSION }),
      })
      if (response.status === 202) setSubmitState('sent')
      else if (response.status === 429) setSubmitState('rateLimited')
      else setSubmitState('failed')
    } catch {
      setSubmitState('failed')
    }
  }

  async function handlePasskey() {
    setPasskeyError(null)
    setPasskeyState('working')
    try {
      // No ToS gate here, deliberately: a passkey can only sign in an account
      // that already exists, and consent was recorded when it was created.
      const token = await signInWithPasskey()
      signIn(token)
      // status flips to 'loading' → the redirect above navigates to /home.
    } catch (err) {
      if (!isCeremonyCancelled(err)) {
        setPasskeyError("Passkey sign-in didn't work. Emailing yourself a link still does.")
      }
    }
    setPasskeyState('idle')
  }

  return (
    <main className="auth-screen">
      <h1>{PRODUCT_NAME}</h1>
      <p className="tagline">{TAGLINE}</p>

      {submitState === 'sent' ? (
        <section className="auth-card">
          <h2>Check your email</h2>
          {/* Mirrors the API's non-enumerating wording — never reveal whether
              the address was known. */}
          <p>If that address can receive email, a sign-in link is on its way.</p>
          <p>The link works once and expires in 15 minutes.</p>
          <button type="button" className="link-button" onClick={() => setSubmitState('idle')}>
            Use a different address
          </button>
        </section>
      ) : (
        <form className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label className="tos-row">
            <input
              type="checkbox"
              checked={tosAccepted}
              onChange={(event) => setTosAccepted(event.target.checked)}
            />
            <span>
              I agree to the <Link to="/tos">Terms of Service</Link>
            </span>
          </label>
          <button type="submit" disabled={!tosAccepted || submitState === 'submitting'}>
            {submitState === 'submitting' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {submitState === 'rateLimited' && (
            <p className="form-error">Too many link requests just now — wait a few minutes and try again.</p>
          )}
          {submitState === 'failed' && (
            <p className="form-error">Something went wrong sending the link. Try again.</p>
          )}
          {/* Secondary, never primary or default (sign-in-ergonomics §4):
              passkeys are the security path for people who already know what
              they are — the emailed link stays the way in. Hidden entirely
              where WebAuthn is unavailable. No address is collected on this
              path, in any form. */}
          {passkeySupported && (
            <button
              type="button"
              className="link-button"
              disabled={passkeyState === 'working'}
              onClick={() => void handlePasskey()}
            >
              {passkeyState === 'working' ? 'Waiting for your passkey…' : 'Use a passkey'}
            </button>
          )}
          {passkeyError && <p className="form-error">{passkeyError}</p>}
        </form>
      )}

      <p className="api-status">API: {apiStatus}</p>
    </main>
  )
}
