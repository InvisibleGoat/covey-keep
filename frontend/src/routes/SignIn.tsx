import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { apiFetch, TOS_VERSION } from '../lib/api'

type SubmitState = 'idle' | 'submitting' | 'sent' | 'rateLimited' | 'failed'

export function SignIn() {
  const { status } = useAuth()
  const [email, setEmail] = useState('')
  const [tosAccepted, setTosAccepted] = useState(false)
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [apiStatus, setApiStatus] = useState('checking…')

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

  return (
    <main className="auth-screen">
      <h1>Covey Keep</h1>
      <p className="tagline">Plan the gathering. Keep the day.</p>

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
        </form>
      )}

      <p className="api-status">API: {apiStatus}</p>
    </main>
  )
}
