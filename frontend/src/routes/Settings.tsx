import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
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
  const [displayName, setDisplayName] = useState(person?.display_name ?? '')
  // Pre-select the stored zone; a never-captured profile falls back to the
  // browser-detected one so the select opens on something sensible.
  const [timeZone, setTimeZone] = useState(person?.timezone ?? detectTimeZone() ?? '')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

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

      <Link to="/home">Back to your gatherings</Link>
    </main>
  )
}
