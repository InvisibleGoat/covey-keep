import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { authFetch } from '../lib/api'
import {
  effectiveZone,
  formatInstantRange,
  instantToWallClock,
  wallClockToInstant,
} from '../lib/datetime'
import {
  describedBy,
  errorsFromResponse,
  networkErrors,
  noErrors,
  type FormErrors,
} from '../lib/formErrors'
import {
  gatheringTypeLabel,
  type GatheringWithOccurrences,
  type Occurrence,
} from '../lib/gatherings'

type DetailState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'failed' }
  | { status: 'loaded'; gathering: GatheringWithOccurrences }

interface GatheringForm {
  title: string
  decedentName: string
}

interface OccurrenceForm {
  startsAt: string
  endsAt: string
  location: string
  mapUrl: string
}

const EMPTY_OCCURRENCE_FORM: OccurrenceForm = {
  startsAt: '',
  endsAt: '',
  location: '',
  mapUrl: '',
}

// The stored occurrence rendered back into form values — instants become the
// wall clock of the person's zone through the ONE conversion home
// (lib/datetime.ts), so a save without edits converts back to the same
// instant rather than drifting by the zone offset.
function occurrenceToForm(occurrence: Occurrence, zone: string): OccurrenceForm {
  return {
    startsAt: instantToWallClock(occurrence.starts_at, zone),
    endsAt: occurrence.ends_at ? instantToWallClock(occurrence.ends_at, zone) : '',
    location: occurrence.location ?? '',
    mapUrl: occurrence.map_url ?? '',
  }
}

// PATCH bodies carry only what changed. `null` means "not provided" on every
// PATCH (nothing is clearable — the /me/profile convention), so a field
// blanked in the form cannot be expressed as a change: it is left out of the
// patch and out of the dirty check, and the hint beside the form says so
// plainly rather than letting a blank appear to clear. Text the backend
// validates non-blank (title, the decedent name) is the exception: a blanked
// one goes out as "" so the server's own refusal renders inline.
function gatheringPatch(
  form: GatheringForm,
  gathering: GatheringWithOccurrences,
): Record<string, string> {
  const patch: Record<string, string> = {}
  const title = form.title.trim()
  if (title !== gathering.title) patch.title = title
  if (gathering.gathering_type === 'memorial') {
    const name = form.decedentName.trim()
    if (name !== (gathering.memorial_decedent_name ?? '')) {
      patch.memorial_decedent_name = name
    }
  }
  return patch
}

function occurrencePatch(
  form: OccurrenceForm,
  server: OccurrenceForm,
  zone: string,
): Record<string, string> {
  const patch: Record<string, string> = {}
  if (form.startsAt !== '' && form.startsAt !== server.startsAt) {
    patch.starts_at = wallClockToInstant(form.startsAt, zone)
  }
  if (form.endsAt !== '' && form.endsAt !== server.endsAt) {
    patch.ends_at = wallClockToInstant(form.endsAt, zone)
  }
  const location = form.location.trim()
  if (location !== '' && location !== (server.location || '')) patch.location = location
  const mapUrl = form.mapUrl.trim()
  if (mapUrl !== '' && mapUrl !== (server.mapUrl || '')) patch.map_url = mapUrl
  return patch
}

const GATHERING_FIELDS = ['title', 'memorial_decedent_name']
const OCCURRENCE_FIELDS = ['starts_at', 'ends_at', 'location', 'map_url']

// The view-and-edit detail (CK-17 read-only; editing CK-18). Nothing here
// surfaces requires_approval, keeper counts, or gathering removal: those are
// later phases' surfaces. The gathering type is not editable — the backend's
// patchable surface is title + decedent name only.
export function GatheringDetail() {
  const { id } = useParams()
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  // Bumped after every successful mutation: the server re-sorts occurrences
  // by starts_at and stamps updated_at, so the page re-renders from a fresh
  // GET rather than from a locally-guessed merge (optimistic-free).
  const [reloadKey, setReloadKey] = useState(0)

  const [editingGathering, setEditingGathering] = useState(false)
  const [gatheringForm, setGatheringForm] = useState<GatheringForm>({
    title: '',
    decedentName: '',
  })
  const [gatheringErrors, setGatheringErrors] = useState<FormErrors>(noErrors())
  const [gatheringSubmitting, setGatheringSubmitting] = useState(false)

  const [editingOccurrenceId, setEditingOccurrenceId] = useState<string | null>(null)
  const [occurrenceForm, setOccurrenceForm] = useState<OccurrenceForm>(EMPTY_OCCURRENCE_FORM)
  const [occurrenceErrors, setOccurrenceErrors] = useState<FormErrors>(noErrors())
  const [occurrenceSubmitting, setOccurrenceSubmitting] = useState(false)

  const [addingOccurrence, setAddingOccurrence] = useState(false)
  const [addForm, setAddForm] = useState<OccurrenceForm>(EMPTY_OCCURRENCE_FORM)
  const [addErrors, setAddErrors] = useState<FormErrors>(noErrors())
  const [addSubmitting, setAddSubmitting] = useState(false)

  // Which occurrence's remove control last drew a refusal, and what it said —
  // the last-occurrence 422 renders beside the control that provoked it.
  const [removeErrors, setRemoveErrors] = useState<{
    occurrenceId: string
    errors: FormErrors
  } | null>(null)

  // Cancel-on-unmount for mutation handlers (the CK-19 convention covers
  // every in-flight request, not just the load effect below).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(`/gatherings/${id}`)
        if (cancelled) return
        if (response.ok) {
          setState({ status: 'loaded', gathering: (await response.json()) as GatheringWithOccurrences })
        } else if (response.status === 404 || response.status === 422) {
          // 404 covers both "does not exist" and "not yours to read" — the
          // backend deliberately does not distinguish them and neither does
          // this screen. A 422 here is an id that cannot name anything (not a
          // UUID), which is the same screen from the reader's side.
          setState({ status: 'notFound' })
        } else {
          setState({ status: 'failed' })
        }
      } catch {
        if (!cancelled) setState({ status: 'failed' })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, reloadKey])

  if (state.status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading…</p>
      </main>
    )
  }

  if (state.status === 'notFound') {
    // One screen, no speculation: it must not hint whether a gathering exists
    // behind this address.
    return (
      <main className="auth-screen">
        <h1>Nothing here</h1>
        <p>There's no gathering to show at this address.</p>
        <Link to="/gatherings">Back to your gatherings</Link>
      </main>
    )
  }

  if (state.status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error">This gathering couldn't be loaded just now. Try again.</p>
        <Link to="/gatherings">Back to your gatherings</Link>
      </main>
    )
  }

  const { gathering } = state
  const isMemorial = gathering.gathering_type === 'memorial'

  // Edit affordances render only for the admin — a non-admin sees the
  // read-only page with no edit controls at all, so no one can probe an edit
  // control to distinguish "not yours" from "does not exist" (the 404-not-403
  // posture). The real comparison since CK-20: /auth/me carries the caller's
  // account_id, so the gate is the admin fact itself — it holds however wide
  // later phases (invitations, keep/unkeep, claim) open the read audience,
  // where CK-18's interim `admin_account_id !== null` would have shown a
  // keeper-non-admin edit controls that 404. A profile that failed to load
  // (person null) gates closed, not open.
  const canEdit = person !== null && gathering.admin_account_id === person.account_id

  const gatheringDirty = Object.keys(gatheringPatch(gatheringForm, gathering)).length > 0
  const editedOccurrence =
    editingOccurrenceId === null
      ? null
      : gathering.occurrences.find((o) => o.id === editingOccurrenceId) ?? null
  const occurrenceDirty =
    editedOccurrence !== null &&
    Object.keys(occurrencePatch(occurrenceForm, occurrenceToForm(editedOccurrence, zone), zone))
      .length > 0

  function openGatheringEdit() {
    setGatheringForm({
      title: gathering.title,
      decedentName: gathering.memorial_decedent_name ?? '',
    })
    setGatheringErrors(noErrors())
    setEditingGathering(true)
  }

  function openOccurrenceEdit(occurrence: Occurrence) {
    setOccurrenceForm(occurrenceToForm(occurrence, zone))
    setOccurrenceErrors(noErrors())
    setEditingOccurrenceId(occurrence.id)
  }

  async function saveGathering(event: FormEvent) {
    event.preventDefault()
    const patch = gatheringPatch(gatheringForm, gathering)
    setGatheringSubmitting(true)
    setGatheringErrors(noErrors())
    try {
      const response = await authFetch(`/gatherings/${gathering.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!alive.current) return
      if (response.ok) {
        setEditingGathering(false)
        setReloadKey((key) => key + 1)
      } else {
        setGatheringErrors(await errorsFromResponse(response, GATHERING_FIELDS))
      }
    } catch {
      if (alive.current) setGatheringErrors(networkErrors())
    }
    if (alive.current) setGatheringSubmitting(false)
  }

  async function saveOccurrence(event: FormEvent, occurrence: Occurrence) {
    event.preventDefault()
    const patch = occurrencePatch(occurrenceForm, occurrenceToForm(occurrence, zone), zone)
    setOccurrenceSubmitting(true)
    setOccurrenceErrors(noErrors())
    try {
      const response = await authFetch(`/occurrences/${occurrence.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!alive.current) return
      if (response.ok) {
        setEditingOccurrenceId(null)
        setReloadKey((key) => key + 1)
      } else {
        setOccurrenceErrors(await errorsFromResponse(response, OCCURRENCE_FIELDS))
      }
    } catch {
      if (alive.current) setOccurrenceErrors(networkErrors())
    }
    if (alive.current) setOccurrenceSubmitting(false)
  }

  async function addOccurrence(event: FormEvent) {
    event.preventDefault()
    const body = {
      starts_at: wallClockToInstant(addForm.startsAt, zone),
      ...(addForm.endsAt ? { ends_at: wallClockToInstant(addForm.endsAt, zone) } : {}),
      ...(addForm.location.trim() ? { location: addForm.location.trim() } : {}),
      ...(addForm.mapUrl.trim() ? { map_url: addForm.mapUrl.trim() } : {}),
    }
    setAddSubmitting(true)
    setAddErrors(noErrors())
    try {
      const response = await authFetch(`/gatherings/${gathering.id}/occurrences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!alive.current) return
      if (response.status === 201) {
        setAddingOccurrence(false)
        setAddForm(EMPTY_OCCURRENCE_FORM)
        setReloadKey((key) => key + 1)
      } else {
        setAddErrors(await errorsFromResponse(response, OCCURRENCE_FIELDS))
      }
    } catch {
      if (alive.current) setAddErrors(networkErrors())
    }
    if (alive.current) setAddSubmitting(false)
  }

  // Deliberately not disabled when one date remains: the server owns the
  // last-occurrence rule, refuses with a 422, and its reason renders beside
  // this control — which is why the refusal surface waited for this phase.
  async function removeOccurrence(occurrenceId: string) {
    setRemoveErrors(null)
    try {
      const response = await authFetch(`/occurrences/${occurrenceId}`, { method: 'DELETE' })
      if (!alive.current) return
      if (response.status === 204) {
        setReloadKey((key) => key + 1)
      } else {
        setRemoveErrors({
          occurrenceId,
          errors: await errorsFromResponse(response, ['occurrence_id']),
        })
      }
    } catch {
      if (alive.current) setRemoveErrors({ occurrenceId, errors: networkErrors() })
    }
  }

  return (
    <main className="auth-screen">
      <h1>{gathering.title}</h1>
      <p>{gatheringTypeLabel(gathering.gathering_type)}</p>
      {gathering.memorial_decedent_name && (
        <p>In memory of {gathering.memorial_decedent_name}</p>
      )}

      {canEdit && !editingGathering && (
        <button type="button" className="link-button" onClick={openGatheringEdit}>
          Edit gathering
        </button>
      )}
      {canEdit && editingGathering && (
        <form
          className="auth-card gathering-form"
          aria-labelledby="edit-gathering-heading"
          onSubmit={(event) => void saveGathering(event)}
        >
          <h2 id="edit-gathering-heading">Edit gathering</h2>

          <label htmlFor="edit-title">Title</label>
          <input
            id="edit-title"
            type="text"
            maxLength={200}
            value={gatheringForm.title}
            aria-describedby={describedBy(gatheringErrors, 'title')}
            onChange={(event) =>
              setGatheringForm((form) => ({ ...form, title: event.target.value }))
            }
          />
          <FieldError errors={gatheringErrors} field="title" />

          {isMemorial && (
            <>
              <label htmlFor="edit-decedent">Decedent's name</label>
              <input
                id="edit-decedent"
                type="text"
                maxLength={200}
                value={gatheringForm.decedentName}
                aria-describedby={describedBy(gatheringErrors, 'memorial_decedent_name')}
                onChange={(event) =>
                  setGatheringForm((form) => ({ ...form, decedentName: event.target.value }))
                }
              />
              {/* Honest about the constraint: PATCH null means "not provided",
                  so the name can be corrected, never removed — no control here
                  pretends to clear it. */}
              <p className="field-hint">The name can be corrected, not removed.</p>
              <FieldError errors={gatheringErrors} field="memorial_decedent_name" />
            </>
          )}

          <button type="submit" disabled={!gatheringDirty || gatheringSubmitting}>
            {gatheringSubmitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setEditingGathering(false)}
          >
            Cancel
          </button>
          <FormLevelErrors errors={gatheringErrors} />
        </form>
      )}

      <section className="auth-card" aria-labelledby="occurrences-heading">
        <h2 id="occurrences-heading">When</h2>
        <p className="field-hint">Times in {zone}.</p>
        <ul className="occurrence-list">
          {gathering.occurrences.map((occurrence) => (
            <li key={occurrence.id} className="occurrence-item">
              {canEdit && editingOccurrenceId === occurrence.id ? (
                <form onSubmit={(event) => void saveOccurrence(event, occurrence)}>
                  <fieldset className="occurrence-fields">
                    <legend>Edit this date</legend>

                    <label htmlFor={`edit-starts-${occurrence.id}`}>Starts</label>
                    <input
                      id={`edit-starts-${occurrence.id}`}
                      type="datetime-local"
                      required
                      value={occurrenceForm.startsAt}
                      aria-describedby={describedBy(occurrenceErrors, 'starts_at', occurrence.id)}
                      onChange={(event) =>
                        setOccurrenceForm((form) => ({ ...form, startsAt: event.target.value }))
                      }
                    />
                    <FieldError errors={occurrenceErrors} field="starts_at" scope={occurrence.id} />

                    <label htmlFor={`edit-ends-${occurrence.id}`}>Ends (optional)</label>
                    <input
                      id={`edit-ends-${occurrence.id}`}
                      type="datetime-local"
                      value={occurrenceForm.endsAt}
                      aria-describedby={describedBy(occurrenceErrors, 'ends_at', occurrence.id)}
                      onChange={(event) =>
                        setOccurrenceForm((form) => ({ ...form, endsAt: event.target.value }))
                      }
                    />
                    <FieldError errors={occurrenceErrors} field="ends_at" scope={occurrence.id} />

                    <label htmlFor={`edit-location-${occurrence.id}`}>Location (optional)</label>
                    <input
                      id={`edit-location-${occurrence.id}`}
                      type="text"
                      value={occurrenceForm.location}
                      aria-describedby={describedBy(occurrenceErrors, 'location', occurrence.id)}
                      onChange={(event) =>
                        setOccurrenceForm((form) => ({ ...form, location: event.target.value }))
                      }
                    />
                    <FieldError errors={occurrenceErrors} field="location" scope={occurrence.id} />

                    <label htmlFor={`edit-map-${occurrence.id}`}>Map link (optional)</label>
                    <input
                      id={`edit-map-${occurrence.id}`}
                      type="text"
                      inputMode="url"
                      value={occurrenceForm.mapUrl}
                      aria-describedby={describedBy(occurrenceErrors, 'map_url', occurrence.id)}
                      onChange={(event) =>
                        setOccurrenceForm((form) => ({ ...form, mapUrl: event.target.value }))
                      }
                    />
                    <FieldError errors={occurrenceErrors} field="map_url" scope={occurrence.id} />

                    {/* The null-is-not-provided constraint, stated rather than
                        faked: a blanked field is left out of the patch, so
                        what's saved stays saved. */}
                    <p className="field-hint">
                      A saved end time, location, or map link can be corrected, not removed —
                      leaving one blank keeps what's already saved.
                    </p>

                    <button type="submit" disabled={!occurrenceDirty || occurrenceSubmitting}>
                      {occurrenceSubmitting ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setEditingOccurrenceId(null)}
                    >
                      Cancel
                    </button>
                    <FormLevelErrors errors={occurrenceErrors} />
                  </fieldset>
                </form>
              ) : (
                <>
                  <p>
                    <strong>
                      {formatInstantRange(occurrence.starts_at, occurrence.ends_at, zone)}
                    </strong>
                  </p>
                  {occurrence.location && <p>{occurrence.location}</p>}
                  {occurrence.map_url && (
                    <p>
                      <a href={occurrence.map_url} target="_blank" rel="noreferrer">
                        Map
                      </a>
                    </p>
                  )}
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openOccurrenceEdit(occurrence)}
                      >
                        Edit this date
                      </button>{' '}
                      <button
                        type="button"
                        className="link-button"
                        aria-describedby={
                          removeErrors?.occurrenceId === occurrence.id
                            ? describedBy(removeErrors.errors, 'occurrence_id', occurrence.id)
                            : undefined
                        }
                        onClick={() => void removeOccurrence(occurrence.id)}
                      >
                        Remove this date
                      </button>
                      {removeErrors?.occurrenceId === occurrence.id && (
                        <>
                          <FieldError
                            errors={removeErrors.errors}
                            field="occurrence_id"
                            scope={occurrence.id}
                          />
                          <FormLevelErrors errors={removeErrors.errors} />
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        {canEdit && !addingOccurrence && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setAddForm(EMPTY_OCCURRENCE_FORM)
              setAddErrors(noErrors())
              setAddingOccurrence(true)
            }}
          >
            Add another date
          </button>
        )}
        {canEdit && addingOccurrence && (
          <form onSubmit={(event) => void addOccurrence(event)}>
            <fieldset className="occurrence-fields">
              <legend>New date</legend>

              <label htmlFor="add-starts">Starts</label>
              <input
                id="add-starts"
                type="datetime-local"
                required
                value={addForm.startsAt}
                aria-describedby={describedBy(addErrors, 'starts_at')}
                onChange={(event) =>
                  setAddForm((form) => ({ ...form, startsAt: event.target.value }))
                }
              />
              <FieldError errors={addErrors} field="starts_at" />

              <label htmlFor="add-ends">Ends (optional)</label>
              <input
                id="add-ends"
                type="datetime-local"
                value={addForm.endsAt}
                aria-describedby={describedBy(addErrors, 'ends_at')}
                onChange={(event) =>
                  setAddForm((form) => ({ ...form, endsAt: event.target.value }))
                }
              />
              <FieldError errors={addErrors} field="ends_at" />

              <label htmlFor="add-location">Location (optional)</label>
              <input
                id="add-location"
                type="text"
                value={addForm.location}
                aria-describedby={describedBy(addErrors, 'location')}
                onChange={(event) =>
                  setAddForm((form) => ({ ...form, location: event.target.value }))
                }
              />
              <FieldError errors={addErrors} field="location" />

              <label htmlFor="add-map">Map link (optional)</label>
              <input
                id="add-map"
                type="text"
                inputMode="url"
                value={addForm.mapUrl}
                aria-describedby={describedBy(addErrors, 'map_url')}
                onChange={(event) =>
                  setAddForm((form) => ({ ...form, mapUrl: event.target.value }))
                }
              />
              <FieldError errors={addErrors} field="map_url" />

              <button type="submit" disabled={addForm.startsAt === '' || addSubmitting}>
                {addSubmitting ? 'Adding…' : 'Add this date'}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setAddingOccurrence(false)}
              >
                Cancel
              </button>
              <FormLevelErrors errors={addErrors} />
            </fieldset>
          </form>
        )}
      </section>

      <Link to="/gatherings">Back to your gatherings</Link>
    </main>
  )
}
