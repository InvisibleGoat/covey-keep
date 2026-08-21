import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { clearToken } from '../lib/session'
import { detectTimeZone, groupedTimeZones, timeZoneLabel } from '../lib/timezone'
import type { Person } from '../auth/context'

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

interface FieldErrors {
  display_name?: string
  timezone?: string
}

interface ValidationDetail {
  loc?: (string | number)[]
  msg?: string
}

// "Value error, display name cannot be empty" → "Display name cannot be empty"
function humanize(msg: string): string {
  const stripped = msg.replace(/^Value error,\s*/, '')
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

export function Settings() {
  const { person, updatePerson } = useAuth()
  const navigate = useNavigate()
  const [displayName, setDisplayName] = useState(person?.display_name ?? '')
  // Pre-select the stored zone; a never-captured profile falls back to the
  // browser-detected one so the select opens on something sensible.
  const [timeZone, setTimeZone] = useState(person?.timezone ?? detectTimeZone() ?? '')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [newEmail, setNewEmail] = useState('')
  // The address a confirmation link is out for. Component state only: on a
  // fresh visit the section simply shows the change form again, and any new
  // request supersedes the outstanding one server-side.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'cancelling'>('idle')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteState, setDeleteState] = useState<'idle' | 'deleting' | 'failed'>('idle')

  const groups = useMemo(() => groupedTimeZones(person?.timezone), [person?.timezone])

  function edited() {
    // Any edit invalidates a shown success/failure state.
    if (saveState === 'saved' || saveState === 'failed') setSaveState('idle')
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaveState('saving')
    setFieldErrors({})
    const body: Record<string, string> = { display_name: displayName }
    if (timeZone) body.timezone = timeZone
    try {
      const response = await authFetch('/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        // The auth context holds the person — updating it here is what makes
        // the new name show up in the signed-in shell without a reload.
        updatePerson((await response.json()) as Person)
        setSaveState('saved')
      } else if (response.status === 422) {
        const detail = (await response.json()).detail as ValidationDetail[] | string
        const errors: FieldErrors = {}
        if (Array.isArray(detail)) {
          for (const item of detail) {
            const field = item.loc?.at(-1)
            if ((field === 'display_name' || field === 'timezone') && item.msg) {
              errors[field] = humanize(item.msg)
            }
          }
        }
        setFieldErrors(errors)
        setSaveState('idle')
      } else {
        setSaveState('failed')
      }
    } catch {
      setSaveState('failed')
    }
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault()
    setEmailError(null)
    const target = newEmail.trim().toLowerCase()
    // A purely client-side courtesy — the person's own current address is no
    // secret to them, so this reveals nothing the server's byte-identical
    // response is protecting.
    if (person && target === person.email) {
      setEmailError("That's already your sign-in address.")
      return
    }
    setEmailState('sending')
    try {
      const response = await authFetch('/me/email-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_email: target }),
      })
      if (response.status === 202) {
        // The server says the same thing whether or not the address was
        // available — the pending copy mirrors that and promises nothing.
        setPendingEmail(target)
        setNewEmail('')
      } else if (response.status === 429) {
        setEmailError('Too many attempts. Wait a few minutes and try again.')
      } else if (response.status === 422) {
        setEmailError("That doesn't look like an email address.")
      } else {
        setEmailError('Something went wrong sending the link. Try again.')
      }
    } catch {
      setEmailError('Something went wrong sending the link. Try again.')
    }
    setEmailState('idle')
  }

  async function handleEmailCancel() {
    setEmailState('cancelling')
    setEmailError(null)
    try {
      const response = await authFetch('/me/email-change', { method: 'DELETE' })
      if (response.status === 204) {
        setPendingEmail(null)
      } else {
        setEmailError('Something went wrong cancelling. Try again.')
      }
    } catch {
      setEmailError('Something went wrong cancelling. Try again.')
    }
    setEmailState('idle')
  }

  async function handleDelete() {
    setDeleteState('deleting')
    try {
      // The typed value is sent as-is — the server independently verifies the
      // literal string, so the disabled-button check is UX, not the gate.
      const response = await authFetch('/me/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: deleteConfirm }),
      })
      if (response.status === 204) {
        // Batched with the navigation: the confirmation screen renders, not a
        // RequireAuth bounce to the sign-in form with no explanation.
        navigate('/account-deleted', { replace: true })
        clearToken()
      } else {
        setDeleteState('failed')
      }
    } catch {
      setDeleteState('failed')
    }
  }

  return (
    <main className="auth-screen">
      <h1>Settings</h1>

      <form className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value)
            edited()
          }}
        />
        <p className="field-hint">How your name appears on gatherings you join or host.</p>
        {fieldErrors.display_name && <p className="form-error">{fieldErrors.display_name}</p>}

        <label htmlFor="time-zone">Time zone</label>
        <select
          id="time-zone"
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value)
            edited()
          }}
        >
          {timeZone === '' && <option value="">Choose a time zone…</option>}
          {groups.map((group) => (
            <optgroup key={group.region} label={group.region}>
              {group.zones.map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="field-hint">Gathering times are shown to you in this time zone.</p>
        {fieldErrors.timezone && <p className="form-error">{fieldErrors.timezone}</p>}

        <button type="submit" disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {saveState === 'saved' && <p className="form-success">Saved.</p>}
        {saveState === 'failed' && (
          <p className="form-error">Something went wrong saving your settings. Try again.</p>
        )}
      </form>

      {/* Email is the credential, not a profile field (CK-9): it changes only
          by proof of control over the new inbox, so this is its own form —
          never a field on the profile PATCH above. */}
      {pendingEmail ? (
        <section className="auth-card" aria-labelledby="email-heading">
          <h2 id="email-heading">Sign-in email</h2>
          <p className="field-hint">
            We sent a confirmation link to <strong>{pendingEmail}</strong> — check that inbox.
            The link works for one hour. Until it's used, you still sign in as{' '}
            <strong>{person?.email}</strong>.
          </p>
          <button
            type="button"
            onClick={() => void handleEmailCancel()}
            disabled={emailState === 'cancelling'}
          >
            {emailState === 'cancelling' ? 'Cancelling…' : 'Cancel the change'}
          </button>
          {emailError && <p className="form-error">{emailError}</p>}
        </section>
      ) : (
        <form
          className="auth-card"
          onSubmit={(event) => void handleEmailSubmit(event)}
          aria-labelledby="email-heading"
        >
          <h2 id="email-heading">Sign-in email</h2>
          <p className="field-hint">
            You sign in as <strong>{person?.email}</strong>.
          </p>
          <label htmlFor="new-email">New email address</label>
          <input
            id="new-email"
            type="email"
            required
            autoComplete="email"
            value={newEmail}
            onChange={(event) => {
              setNewEmail(event.target.value)
              setEmailError(null)
            }}
          />
          <p className="field-hint">
            We'll send a confirmation link there — nothing changes until you open it.
          </p>
          <button type="submit" disabled={emailState === 'sending'}>
            {emailState === 'sending' ? 'Sending…' : 'Send confirmation link'}
          </button>
          {emailError && <p className="form-error">{emailError}</p>}
        </form>
      )}

      {/* Deliberately a section, not part of the form above: Enter in a
          profile field must never reach anything destructive. */}
      <section className="auth-card danger-zone" aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete your account</h2>
        <p className="danger-explainer">
          Your account and your name are removed; what you contributed stays with the
          gatherings you gave it to. This cannot be undone.
        </p>
        <label htmlFor="delete-confirm">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="delete-confirm"
          type="text"
          autoComplete="off"
          value={deleteConfirm}
          onChange={(event) => {
            setDeleteConfirm(event.target.value)
            if (deleteState === 'failed') setDeleteState('idle')
          }}
        />
        <button
          type="button"
          className="danger-button"
          disabled={deleteConfirm !== 'DELETE' || deleteState === 'deleting'}
          onClick={() => void handleDelete()}
        >
          {deleteState === 'deleting' ? 'Deleting…' : 'Delete my account'}
        </button>
        {deleteState === 'failed' && (
          <p className="form-error">Something went wrong deleting your account. Try again.</p>
        )}
      </section>

      <Link to="/home">Back to your gatherings</Link>
    </main>
  )
}
