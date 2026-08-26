import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { effectiveZone, wallClockToInstant } from '../lib/datetime'
import { errorsFromResponse, networkErrors, noErrors, type FormErrors } from '../lib/formErrors'
import { GATHERING_TYPES, type Gathering } from '../lib/gatherings'

interface OccurrenceDraft {
  key: number
  startsAt: string
  endsAt: string
  location: string
  mapUrl: string
}

let nextKey = 0
function emptyOccurrence(): OccurrenceDraft {
  nextKey += 1
  return { key: nextKey, startsAt: '', endsAt: '', location: '', mapUrl: '' }
}

// Inline field error, targetable by the input's aria-describedby.
function FieldError({ errors, field }: { errors: FormErrors; field: string }) {
  const message = errors.fields[field]
  if (!message) return null
  return (
    <p className="form-error" id={`error-${field}`}>
      {message}
    </p>
  )
}

function describedBy(errors: FormErrors, field: string): string | undefined {
  return errors.fields[field] ? `error-${field}` : undefined
}

export function GatheringNew() {
  const { person } = useAuth()
  const navigate = useNavigate()
  const zone = effectiveZone(person?.timezone)
  const zoneFromProfile = person?.timezone != null

  const [gatheringType, setGatheringType] = useState('')
  const [title, setTitle] = useState('')
  // Kept across type flips so switching away and back doesn't lose the name;
  // it is only rendered and only SENT while the type is memorial.
  const [decedentName, setDecedentName] = useState('')
  const [occurrences, setOccurrences] = useState<OccurrenceDraft[]>([emptyOccurrence()])
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<FormErrors>(noErrors())

  const isMemorial = gatheringType === 'memorial'
  // "Can plausibly succeed" (the Settings idiom): presence only. The decedent
  // name deliberately does NOT gate submission — the backend's field-level
  // 422 is the authority on the memorial rule, and this form's job is to
  // render it, not pre-empt it.
  const plausible =
    gatheringType !== '' && title.trim() !== '' && occurrences.every((o) => o.startsAt !== '')

  function editOccurrence(key: number, patch: Partial<OccurrenceDraft>) {
    setOccurrences((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setErrors(noErrors())

    const body = {
      gathering_type: gatheringType,
      title,
      // null (not omitted) when blank so a memorial with no name draws the
      // backend's field-level 422 rather than a client-side block.
      ...(isMemorial ? { memorial_decedent_name: decedentName.trim() || null } : {}),
      occurrences: occurrences.map((o) => ({
        // The load-bearing conversion: the wall clock the person typed is a
        // time in THEIR zone, never the browser's.
        starts_at: wallClockToInstant(o.startsAt, zone),
        ...(o.endsAt ? { ends_at: wallClockToInstant(o.endsAt, zone) } : {}),
        ...(o.location.trim() ? { location: o.location.trim() } : {}),
        ...(o.mapUrl.trim() ? { map_url: o.mapUrl.trim() } : {}),
      })),
    }

    // Every key this form renders an inline error against; anything the
    // backend reports outside this list surfaces as a form-level message.
    const visibleFields = [
      'gathering_type',
      'title',
      'memorial_decedent_name',
      'occurrences',
      ...occurrences.flatMap((_, index) =>
        ['starts_at', 'ends_at', 'location', 'map_url'].map(
          (field) => `occurrences.${index}.${field}`,
        ),
      ),
    ]

    try {
      const response = await authFetch('/gatherings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.status === 201) {
        const created = (await response.json()) as Gathering
        navigate(`/gatherings/${created.id}`)
        return
      }
      setErrors(await errorsFromResponse(response, visibleFields))
    } catch {
      setErrors(networkErrors())
    }
    setSubmitting(false)
  }

  return (
    <main className="auth-screen">
      <h1>New gathering</h1>

      <form className="auth-card gathering-form" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="gathering-type">Type of gathering</label>
        <select
          id="gathering-type"
          value={gatheringType}
          aria-describedby={describedBy(errors, 'gathering_type')}
          onChange={(event) => setGatheringType(event.target.value)}
        >
          {gatheringType === '' && <option value="">Choose a type…</option>}
          {GATHERING_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
        <FieldError errors={errors} field="gathering_type" />

        <label htmlFor="gathering-title">Title</label>
        <input
          id="gathering-title"
          type="text"
          required
          maxLength={200}
          value={title}
          aria-describedby={describedBy(errors, 'title')}
          onChange={(event) => setTitle(event.target.value)}
        />
        <FieldError errors={errors} field="title" />

        {/* Rendered when and only when the type is memorial — a UX mirror of
            the backend's gate, never a replacement: nothing here blocks a
            blank submit, and the backend's 422 lands right below. */}
        {isMemorial && (
          <>
            <label htmlFor="decedent-name">Decedent's name</label>
            <input
              id="decedent-name"
              type="text"
              maxLength={200}
              value={decedentName}
              aria-describedby={describedBy(errors, 'memorial_decedent_name')}
              onChange={(event) => setDecedentName(event.target.value)}
            />
            <p className="field-hint">The person this memorial remembers.</p>
            <FieldError errors={errors} field="memorial_decedent_name" />
          </>
        )}

        <h2>When</h2>
        <p className="field-hint">
          {zoneFromProfile
            ? `Times in ${zone} — your profile time zone.`
            : `Times in ${zone} — your device's time zone.`}
        </p>

        {occurrences.map((row, index) => (
          <fieldset key={row.key} className="occurrence-fields">
            <legend>{occurrences.length > 1 ? `Date ${index + 1}` : 'Date'}</legend>

            <label htmlFor={`starts-at-${row.key}`}>Starts</label>
            <input
              id={`starts-at-${row.key}`}
              type="datetime-local"
              required
              value={row.startsAt}
              aria-describedby={describedBy(errors, `occurrences.${index}.starts_at`)}
              onChange={(event) => editOccurrence(row.key, { startsAt: event.target.value })}
            />
            <FieldError errors={errors} field={`occurrences.${index}.starts_at`} />

            <label htmlFor={`ends-at-${row.key}`}>Ends (optional)</label>
            <input
              id={`ends-at-${row.key}`}
              type="datetime-local"
              value={row.endsAt}
              aria-describedby={describedBy(errors, `occurrences.${index}.ends_at`)}
              onChange={(event) => editOccurrence(row.key, { endsAt: event.target.value })}
            />
            <FieldError errors={errors} field={`occurrences.${index}.ends_at`} />

            <label htmlFor={`location-${row.key}`}>Location (optional)</label>
            <input
              id={`location-${row.key}`}
              type="text"
              value={row.location}
              aria-describedby={describedBy(errors, `occurrences.${index}.location`)}
              onChange={(event) => editOccurrence(row.key, { location: event.target.value })}
            />
            <FieldError errors={errors} field={`occurrences.${index}.location`} />

            <label htmlFor={`map-url-${row.key}`}>Map link (optional)</label>
            <input
              id={`map-url-${row.key}`}
              type="text"
              inputMode="url"
              value={row.mapUrl}
              aria-describedby={describedBy(errors, `occurrences.${index}.map_url`)}
              onChange={(event) => editOccurrence(row.key, { mapUrl: event.target.value })}
            />
            <FieldError errors={errors} field={`occurrences.${index}.map_url`} />

            {occurrences.length > 1 && (
              <button
                type="button"
                className="link-button"
                onClick={() => setOccurrences((rows) => rows.filter((r) => r.key !== row.key))}
              >
                Remove this date
              </button>
            )}
          </fieldset>
        ))}

        {/* Season-cap and other occurrences-level messages land here — the
            backend's wording verbatim (it names the span; that arithmetic is
            the server's, never restated client-side). */}
        <FieldError errors={errors} field="occurrences" />

        <button
          type="button"
          className="link-button"
          onClick={() => setOccurrences((rows) => [...rows, emptyOccurrence()])}
        >
          Add another date
        </button>

        <button type="submit" disabled={!plausible || submitting}>
          {submitting ? 'Creating…' : 'Create gathering'}
        </button>
        {errors.form.map((message, index) => (
          <p key={index} className="form-error">
            {message}
          </p>
        ))}
      </form>

      <Link to="/gatherings">Back to your gatherings</Link>
    </main>
  )
}
