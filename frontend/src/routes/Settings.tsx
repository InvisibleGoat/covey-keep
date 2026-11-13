import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { PasskeySection } from '../components/PasskeySection'
import { firstFieldWithError, useFocusRequest } from '../components/useFocusRequest'
import { ACCOUNT_DELETED_SIGNAL } from '../lib/accountDeleted'
import { authFetch } from '../lib/api'
import { planLine, readBilling, type Billing } from '../lib/billing'
import { describedBy, errorsFromResponse, noErrors, type FormErrors } from '../lib/formErrors'
import { detectTimeZone, groupedTimeZones, timeZoneLabel } from '../lib/timezone'
import type { Person } from '../auth/context'

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

// Both forms' refusals go through the one mapper (lib/formErrors.ts) and
// render through components/FieldError.tsx — the error-<field> /
// aria-describedby contract every form has used since CK-17. Until CK-82
// this screen kept its own pre-CK-17 mapper, keyed on the last `loc`
// segment and hardcoded to two fields (a standing exception in
// components.md, recorded and not blessed). The words a person reads for
// any refusal the server sends today are unchanged.
const PROFILE_FIELDS = ['display_name', 'timezone']
const EMAIL_FIELDS = ['new_email']

// Kept deliberately over the server's own message on `new_email`, which
// reads "not an email address" (deps.py::normalize_email): this line says
// it better.
const NOT_AN_EMAIL = "That doesn't look like an email address."
const SEND_FAILED = 'Something went wrong sending the link. Try again.'

function formLine(message: string): FormErrors {
  return { ...noErrors(), form: [message] }
}

export function Settings() {
  const { person, updatePerson } = useAuth()
  const navigate = useNavigate()
  const [displayName, setDisplayName] = useState(person?.display_name ?? '')
  // Pre-select the stored zone; a never-captured profile falls back to the
  // browser-detected one so the select opens on something sensible.
  const [timeZone, setTimeZone] = useState(person?.timezone ?? detectTimeZone() ?? '')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [profileErrors, setProfileErrors] = useState<FormErrors>(noErrors)
  const [newEmail, setNewEmail] = useState('')
  // The address a confirmation link is out for. Component state only: on a
  // fresh visit the section simply shows the change form again, and any new
  // request supersedes the outstanding one server-side.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'cancelling'>('idle')
  const [emailErrors, setEmailErrors] = useState<FormErrors>(noErrors)
  // Cancelling an outstanding change is not a form: its one failure line.
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteState, setDeleteState] = useState<'idle' | 'deleting' | 'failed'>('idle')
  // Your plan (CK-74): the current allowance and price, read from
  // GET /billing — the screen keeps no numbers of its own. A failed read
  // leaves the link alone; the plan screen says the rest.
  const [billing, setBilling] = useState<Billing | null>(null)

  const groups = useMemo(() => groupedTimeZones(person?.timezone), [person?.timezone])

  // Focus after an answer (CK-94; reference/frontend/components.md). Each
  // section is its own container, so a person who moved elsewhere while a
  // request waited keeps their place.
  const profileForm = useRef<HTMLFormElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const emailSection = useRef<HTMLElement | null>(null)
  const emailField = useRef<HTMLInputElement>(null)
  const sendButton = useRef<HTMLButtonElement>(null)
  const pendingSentence = useRef<HTMLParagraphElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const deleteSection = useRef<HTMLElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const focusInProfile = useFocusRequest(profileForm)
  const focusInEmail = useFocusRequest(emailSection)
  const focusInDelete = useFocusRequest(deleteSection)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await readBilling()
      if (!cancelled && result.ok) setBilling(result.billing)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function edited() {
    // Any edit invalidates a shown success/failure state.
    if (saveState === 'saved' || saveState === 'failed') setSaveState('idle')
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaveState('saving')
    setProfileErrors(noErrors())
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
        focusInProfile(saveButton)
      } else if (response.status === 422) {
        // A field the form shows lands on it; anything else — another field,
        // a string `detail` — lands form-level instead of vanishing.
        setProfileErrors(await errorsFromResponse(response, PROFILE_FIELDS))
        setSaveState('idle')
        focusInProfile(() => firstFieldWithError(profileForm.current) ?? saveButton.current)
      } else {
        setSaveState('failed')
        focusInProfile(saveButton)
      }
    } catch {
      setSaveState('failed')
      focusInProfile(saveButton)
    }
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault()
    setEmailErrors(noErrors())
    const target = newEmail.trim().toLowerCase()
    // A purely client-side courtesy — the person's own current address is no
    // secret to them, so this reveals nothing the server's byte-identical
    // response is protecting. It is about the field, so it lands on it.
    if (person && target === person.email) {
      setEmailErrors({ ...noErrors(), fields: { new_email: "That's already your sign-in address." } })
      focusInEmail(emailField)
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
        focusInEmail(pendingSentence)
      } else if (response.status === 429) {
        setEmailErrors(formLine('Too many attempts. Wait a few minutes and try again.'))
        focusInEmail(sendButton)
      } else if (response.status === 422) {
        // A refusal on `new_email` keeps this screen's own line; any other
        // 422 — another field, a string `detail` — shows the mapper's
        // form-level line rather than being swallowed.
        const errors = await errorsFromResponse(response, EMAIL_FIELDS)
        if (errors.fields.new_email) errors.fields.new_email = NOT_AN_EMAIL
        setEmailErrors(errors)
        focusInEmail(() => firstFieldWithError(emailSection.current) ?? sendButton.current)
      } else {
        setEmailErrors(formLine(SEND_FAILED))
        focusInEmail(sendButton)
      }
    } catch {
      setEmailErrors(formLine(SEND_FAILED))
      focusInEmail(sendButton)
    }
    setEmailState('idle')
  }

  async function handleEmailCancel() {
    setEmailState('cancelling')
    setCancelError(null)
    try {
      const response = await authFetch('/me/email-change', { method: 'DELETE' })
      if (response.status === 204) {
        setPendingEmail(null)
        focusInEmail(emailField)
      } else {
        setCancelError('Something went wrong cancelling. Try again.')
        focusInEmail(cancelButton)
      }
    } catch {
      setCancelError('Something went wrong cancelling. Try again.')
      focusInEmail(cancelButton)
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
        // Navigate, and ONLY navigate. The session is cleared by the
        // confirmation screen once it has rendered, on the one-shot signal
        // this state carries (lib/accountDeleted.ts; CK-76.1). Until CK-76.1
        // `clearToken()` followed this line, counting on one batched render —
        // but React Router 7 runs a navigation as a transition, so an urgent
        // auth update made in the same tick renders FIRST, while the route is
        // still /settings, and RequireAuth redirects to `/` before the
        // navigation lands: the person saw the sign-in form with no
        // explanation. Nothing here may end the session while this guarded
        // route is still the one on screen.
        navigate('/account-deleted', { replace: true, state: ACCOUNT_DELETED_SIGNAL })
      } else {
        setDeleteState('failed')
        focusInDelete(deleteButton)
      }
    } catch {
      setDeleteState('failed')
      focusInDelete(deleteButton)
    }
  }

  return (
    <main className="auth-screen">
      <h1>Settings</h1>

      <form ref={profileForm} className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          value={displayName}
          aria-describedby={describedBy(profileErrors, 'display_name')}
          onChange={(event) => {
            setDisplayName(event.target.value)
            edited()
          }}
        />
        <p className="field-hint">How your name appears on gatherings you join or host.</p>
        <FieldError errors={profileErrors} field="display_name" />

        <label htmlFor="time-zone">Time zone</label>
        <select
          id="time-zone"
          value={timeZone}
          aria-describedby={describedBy(profileErrors, 'timezone')}
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
        <FieldError errors={profileErrors} field="timezone" />

        <button ref={saveButton} type="submit" disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <FormLevelErrors errors={profileErrors} />
        {saveState === 'saved' && (
          <p className="form-success" role="status">
            Saved.
          </p>
        )}
        {saveState === 'failed' && (
          <p className="form-error" role="alert">
            Something went wrong saving your settings. Try again.
          </p>
        )}
      </form>

      {/* Your plan (CK-74): one line and a link. The usage, the other plans
          and the acts live on the plan screen; this section only says
          which plan, and never a usage figure (keeping-explained §3
          principle 5 — a person's usage is shown on the one screen that is
          theirs). Above the email section because it is the thing a person
          is most likely to come here for. */}
      <section className="auth-card" aria-labelledby="plan-heading">
        <h2 id="plan-heading">Your plan</h2>
        {billing && <p className="field-hint">{planLine(billing)}</p>}
        <Link to="/plan">See your plan</Link>
      </section>

      {/* Email is the credential, not a profile field (CK-9): it changes only
          by proof of control over the new inbox, so this is its own form —
          never a field on the profile PATCH above. */}
      {pendingEmail ? (
        <section ref={emailSection} className="auth-card" aria-labelledby="email-heading">
          <h2 id="email-heading">Sign-in email</h2>
          {/* Focusable by script alone (tabIndex -1): where focus lands once
              the link is out, so the person hears what happened (CK-94). */}
          <p ref={pendingSentence} className="field-hint" tabIndex={-1}>
            We sent a confirmation link to <strong>{pendingEmail}</strong> — check that inbox.
            The link works for one hour. Until it's used, you still sign in as{' '}
            <strong>{person?.email}</strong>.
          </p>
          <button
            ref={cancelButton}
            type="button"
            onClick={() => void handleEmailCancel()}
            disabled={emailState === 'cancelling'}
          >
            {emailState === 'cancelling' ? 'Cancelling…' : 'Cancel the change'}
          </button>
          {cancelError && (
            <p className="form-error" role="alert">
              {cancelError}
            </p>
          )}
        </section>
      ) : (
        <form
          ref={(element) => {
            emailSection.current = element
          }}
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
            ref={emailField}
            id="new-email"
            type="email"
            required
            autoComplete="email"
            value={newEmail}
            aria-describedby={describedBy(emailErrors, 'new_email')}
            onChange={(event) => {
              setNewEmail(event.target.value)
              setEmailErrors(noErrors())
            }}
          />
          <FieldError errors={emailErrors} field="new_email" />
          <p className="field-hint">
            We'll send a confirmation link there — nothing changes until you open it.
          </p>
          <button ref={sendButton} type="submit" disabled={emailState === 'sending'}>
            {emailState === 'sending' ? 'Sending…' : 'Send confirmation link'}
          </button>
          <FormLevelErrors errors={emailErrors} />
        </form>
      )}

      <PasskeySection />

      {/* Deliberately a section, not part of the form above: Enter in a
          profile field must never reach anything destructive. */}
      <section ref={deleteSection} className="auth-card danger-zone" aria-labelledby="delete-heading">
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
          ref={deleteButton}
          type="button"
          className="danger-button"
          disabled={deleteConfirm !== 'DELETE' || deleteState === 'deleting'}
          onClick={() => void handleDelete()}
        >
          {deleteState === 'deleting' ? 'Deleting…' : 'Delete my account'}
        </button>
        {deleteState === 'failed' && (
          <p className="form-error" role="alert">
            Something went wrong deleting your account. Try again.
          </p>
        )}
      </section>

      <Link to="/gatherings">Back to your gatherings</Link>
    </main>
  )
}
