import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { authFetch } from '../lib/api'
import {
  effectiveZone,
  formatInstant,
  formatInstantRange,
  instantToWallClock,
  wallClockToInstant,
} from '../lib/datetime'
import { type InvitationLists } from '../lib/invitations'
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
import {
  RSVP_LIST_VISIBILITIES,
  RSVP_RESPONSES,
  formatArrivalTime,
  rsvpResponseLabel,
  timeForInput,
  type OwnRsvp,
  type RsvpLists,
} from '../lib/rsvps'
import { safeHttpUrl } from '../lib/url'

type DetailState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'failed' }
  | { status: 'loaded'; gathering: GatheringWithOccurrences }

interface GatheringForm {
  title: string
  decedentName: string
  rsvpListVisibility: string
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

// PATCH bodies carry only what changed, under merge-patch semantics (CK-22):
// an ABSENT field leaves the stored value alone, an explicit `null` clears
// it. On the gathering nothing is clearable — title is NOT NULL and the
// decedent's name is pinned by the memorial CHECK — so a blanked one goes
// out as "" and the server's own refusal renders inline (never a fake
// clear, never a swallowed edit).
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
  if (form.rsvpListVisibility !== gathering.rsvp_list_visibility) {
    patch.rsvp_list_visibility = form.rsvpListVisibility
  }
  return patch
}

// The occurrence's optional fields (ends_at, location, map_url) ARE clearable
// (CK-22): "had a saved value, now blank" is a real change that goes out as
// explicit `null`. A field that was empty and is still empty is OMITTED, not
// sent as null — a no-op write would muddy what null means. A whitespace-only
// entry is neither: it goes out as typed so the server's blank-rejection 422
// renders (blank is never a clear — the backend refuses "" everywhere).
function occurrencePatch(
  form: OccurrenceForm,
  server: OccurrenceForm,
  zone: string,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  // starts_at is NOT NULL server-side: a date can be moved, never removed
  // (the input is `required`, so a blank one simply isn't a change to send).
  if (form.startsAt !== '' && form.startsAt !== server.startsAt) {
    patch.starts_at = wallClockToInstant(form.startsAt, zone)
  }
  if (form.endsAt !== server.endsAt) {
    patch.ends_at = form.endsAt === '' ? null : wallClockToInstant(form.endsAt, zone)
  }
  const textPatch = (raw: string, saved: string): string | null | undefined => {
    const trimmed = raw.trim()
    if (raw === '') return saved === '' ? undefined : null
    if (trimmed === '') return raw
    return trimmed === saved ? undefined : trimmed
  }
  const location = textPatch(form.location, server.location)
  if (location !== undefined) patch.location = location
  const mapUrl = textPatch(form.mapUrl, server.mapUrl)
  if (mapUrl !== undefined) patch.map_url = mapUrl
  return patch
}

const GATHERING_FIELDS = ['title', 'memorial_decedent_name', 'rsvp_list_visibility']
const OCCURRENCE_FIELDS = ['starts_at', 'ends_at', 'location', 'map_url']
const INVITE_FIELDS = ['destination', 'channel']
const RSVP_FIELDS = ['response', 'stay_included', 'adult_count', 'child_count', 'arrival_time']

interface RsvpFormState {
  response: string // '' = unanswered — never a defaulted "no"
  stayIncluded: boolean
  adults: string
  children: string
  // A bare wall clock ("15:30") at the gathering — sent to the API exactly as
  // typed. The CK-17 profile-zone conversion must NEVER touch it: it has no
  // date and no zone, and wallClockToInstant would silently shift it by the
  // offset for anyone whose profile zone differs from the venue's.
  arrival: string
}

function rsvpFormFromOwn(own: OwnRsvp | null): RsvpFormState {
  if (own === null) {
    return { response: '', stayIncluded: false, adults: '1', children: '0', arrival: '' }
  }
  return {
    response: own.response,
    stayIncluded: own.stay_included,
    adults: String(own.adult_count),
    children: String(own.child_count),
    arrival: timeForInput(own.arrival_time),
  }
}

// Dirty-tracking (the CK-18 convention): save is disabled until something
// differs from the saved answer, and an unanswered occurrence stays
// unanswered until a response is actually chosen.
function rsvpDirty(form: RsvpFormState, own: OwnRsvp | null): boolean {
  if (form.response === '') return false
  const saved = rsvpFormFromOwn(own)
  return (
    form.response !== saved.response ||
    (form.response === 'no' && form.stayIncluded !== saved.stayIncluded) ||
    form.adults !== saved.adults ||
    form.children !== saved.children ||
    form.arrival !== saved.arrival
  )
}

// The per-occurrence RSVP block (CK-27): collapsed by default and loaded only
// when opened — the CK-25 invitations pattern, which keeps the detail page one
// request and keeps a many-date season from fanning out per-row fetches on
// load (the CK-17 N+1 shape). Renders for everyone in the read audience; the
// roster is filtered server-side by the host's visibility setting, and the
// mirror check here only chooses the explanatory hint.
function OccurrenceRsvp({
  occurrenceId,
  zone,
  isAdmin,
}: {
  occurrenceId: string
  zone: string
  isAdmin: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<RsvpLists | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<RsvpFormState>(rsvpFormFromOwn(null))
  const [errors, setErrors] = useState<FormErrors>(noErrors())
  const [submitting, setSubmitting] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(`/occurrences/${occurrenceId}/rsvps`)
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as RsvpLists
          setData(body)
          setForm(rsvpFormFromOwn(body.own))
          setFailed(false)
        } else {
          setFailed(true)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [occurrenceId, open, reloadKey])

  async function save(event: FormEvent) {
    event.preventDefault()
    const body: Record<string, unknown> = {
      response: form.response,
      // The flag accompanies a "no" only — with any other answer it is
      // meaningless and the API refuses it, so it goes out false.
      stay_included: form.response === 'no' && form.stayIncluded,
      adult_count: Number(form.adults || '0'),
      child_count: Number(form.children || '0'),
      // Sent exactly as typed — a bare wall clock, no conversion (see above).
      ...(form.arrival !== '' ? { arrival_time: form.arrival } : {}),
    }
    setSubmitting(true)
    setErrors(noErrors())
    try {
      const response = await authFetch(`/occurrences/${occurrenceId}/rsvp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!alive.current) return
      if (response.ok) {
        setReloadKey((key) => key + 1)
      } else {
        setErrors(await errorsFromResponse(response, RSVP_FIELDS))
      }
    } catch {
      if (alive.current) setErrors(networkErrors())
    }
    if (alive.current) setSubmitting(false)
  }

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        RSVP and who's coming
      </button>
    )
  }

  // The server enforces visibility; this mirror only picks the hint text.
  // The admin sees the list in every mode, and the caller always has `own`.
  const maySeeList =
    data !== null &&
    (isAdmin ||
      data.visibility === 'INVITEES' ||
      (data.visibility === 'ATTENDEES' && data.own?.response === 'yes'))

  return (
    <div className="rsvp-block">
      {failed && (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          RSVPs couldn't be loaded just now.
        </p>
      )}
      {data && (
        <>
          <form onSubmit={(event) => void save(event)}>
            <fieldset className="occurrence-fields">
              <legend>Are you coming?</legend>
              {data.own === null && <p className="field-hint">You haven't answered yet.</p>}
              {RSVP_RESPONSES.map(({ value, label }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`rsvp-response-${occurrenceId}`}
                    value={value}
                    checked={form.response === value}
                    onChange={() => setForm((f) => ({ ...f, response: value }))}
                  />{' '}
                  {label}
                </label>
              ))}
              <FieldError errors={errors} field="response" scope={occurrenceId} />

              {form.response === 'no' && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.stayIncluded}
                      onChange={(event) =>
                        setForm((f) => ({ ...f, stayIncluded: event.target.checked }))
                      }
                    />{' '}
                    Keep me included
                  </label>
                  <p className="field-hint">
                    Can't make it, but want to stay in the loop. This changes what you
                    hear about — never what you can see.
                  </p>
                  <FieldError errors={errors} field="stay_included" scope={occurrenceId} />
                </>
              )}

              {(form.response === 'yes' || form.response === 'maybe') && (
                <>
                  <label htmlFor={`rsvp-adults-${occurrenceId}`}>Adults</label>
                  <input
                    id={`rsvp-adults-${occurrenceId}`}
                    type="number"
                    min={0}
                    max={99}
                    value={form.adults}
                    aria-describedby={describedBy(errors, 'adult_count', occurrenceId)}
                    onChange={(event) =>
                      setForm((f) => ({ ...f, adults: event.target.value }))
                    }
                  />
                  <FieldError errors={errors} field="adult_count" scope={occurrenceId} />

                  <label htmlFor={`rsvp-children-${occurrenceId}`}>Children</label>
                  <input
                    id={`rsvp-children-${occurrenceId}`}
                    type="number"
                    min={0}
                    max={99}
                    value={form.children}
                    aria-describedby={describedBy(errors, 'child_count', occurrenceId)}
                    onChange={(event) =>
                      setForm((f) => ({ ...f, children: event.target.value }))
                    }
                  />
                  <FieldError errors={errors} field="child_count" scope={occurrenceId} />

                  <label htmlFor={`rsvp-arrival-${occurrenceId}`}>
                    Arriving around (optional)
                  </label>
                  <input
                    id={`rsvp-arrival-${occurrenceId}`}
                    type="time"
                    value={form.arrival}
                    aria-describedby={describedBy(errors, 'arrival_time', occurrenceId)}
                    onChange={(event) =>
                      setForm((f) => ({ ...f, arrival: event.target.value }))
                    }
                  />
                  {/* The occurrence's stated zone, beside the time it applies
                      to — this is a clock time at the gathering, not an
                      instant in the viewer's zone. */}
                  <p className="field-hint">Clock time at the gathering — times in {zone}.</p>
                  <FieldError errors={errors} field="arrival_time" scope={occurrenceId} />
                </>
              )}

              <button type="submit" disabled={!rsvpDirty(form, data.own) || submitting}>
                {submitting ? 'Saving…' : data.own === null ? 'Send RSVP' : 'Update RSVP'}
              </button>
              <FormLevelErrors errors={errors} />
            </fieldset>
          </form>

          {maySeeList ? (
            <>
              <h3>Who's coming</h3>
              {data.rsvps.length === 0 ? (
                <p className="field-hint">No one has answered yet.</p>
              ) : (
                <ul className="occurrence-list">
                  {data.rsvps.map((row) => (
                    <li key={row.id}>
                      {row.display_name} — {rsvpResponseLabel(row.response)}
                      {row.stay_included ? ' (staying in the loop)' : ''}
                      {(row.response === 'yes' || row.response === 'maybe') &&
                        ` — ${row.adult_count} ${row.adult_count === 1 ? 'adult' : 'adults'}, ${row.child_count} ${row.child_count === 1 ? 'child' : 'children'}`}
                      {row.arrival_time
                        ? `, arriving ${formatArrivalTime(row.arrival_time)}`
                        : ''}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="field-hint">
              {data.visibility === 'HOST_ONLY'
                ? 'Only the host sees the full list of answers.'
                : 'The list of answers is shown to people who are going.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// The view-and-edit detail (CK-17 read-only; editing CK-18). Nothing here
// surfaces requires_approval, keeper counts, or gathering removal: those are
// later phases' surfaces. The gathering type is not editable — the backend's
// patchable surface is title + decedent name + RSVP-list visibility only.
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
    rsvpListVisibility: 'INVITEES',
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

  // The invitations section (CK-25, admin only) is COLLAPSED by default and
  // its list loads only when opened — the detail page stays one request for
  // everyone, and a non-admin never has the section at all.
  const [invitationsOpen, setInvitationsOpen] = useState(false)
  const [invitations, setInvitations] = useState<InvitationLists | null>(null)
  const [invitationsFailed, setInvitationsFailed] = useState(false)
  const [invitationsReloadKey, setInvitationsReloadKey] = useState(0)
  const [inviteDestination, setInviteDestination] = useState('')
  const [inviteErrors, setInviteErrors] = useState<FormErrors>(noErrors())
  const [inviteSubmitting, setInviteSubmitting] = useState(false)

  // Cancel-on-unmount for mutation handlers (the CK-19 convention covers
  // every in-flight request, not just the load effect below).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Loads only once the admin opens the section; re-fetched after every
  // successful send or revoke (optimistic-free, like everything else here).
  useEffect(() => {
    if (!invitationsOpen) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(`/gatherings/${id}/invitations`)
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as Partial<InvitationLists>
          setInvitations({ pending: body.pending ?? [], accepted: body.accepted ?? [] })
          setInvitationsFailed(false)
        } else {
          setInvitationsFailed(true)
        }
      } catch {
        if (!cancelled) setInvitationsFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, invitationsOpen, invitationsReloadKey])

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
      rsvpListVisibility: gathering.rsvp_list_visibility,
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

  async function sendInvitation(event: FormEvent) {
    event.preventDefault()
    setInviteSubmitting(true)
    setInviteErrors(noErrors())
    try {
      // The channel is pinned to EMAIL: the API accepts SMS in its schema but
      // refuses it as not-yet-available, and offering a control the API
      // rejects is worse than none (the CK-18 lesson) — the UI grows the
      // choice when SMS delivery actually ships.
      const response = await authFetch(`/gatherings/${gathering.id}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'EMAIL', destination: inviteDestination.trim() }),
      })
      if (!alive.current) return
      if (response.status === 201) {
        setInviteDestination('')
        setInvitationsReloadKey((key) => key + 1)
      } else if (response.status === 429) {
        // A rate limit is neither a validation failure nor a server error —
        // it gets its own honest line instead of the mapper's generic one.
        setInviteErrors({
          fields: {},
          form: ['Too many invitations just now. Try again in a few minutes.'],
        })
      } else {
        setInviteErrors(await errorsFromResponse(response, INVITE_FIELDS))
      }
    } catch {
      if (alive.current) setInviteErrors(networkErrors())
    }
    if (alive.current) setInviteSubmitting(false)
  }

  async function revokeInvitation(pendingId: string) {
    try {
      const response = await authFetch(`/invitations/pending/${pendingId}`, {
        method: 'DELETE',
      })
      if (!alive.current) return
      // A 404 means it stopped being pending (accepted, or already revoked
      // elsewhere) — either way the list is stale, so re-fetch it too.
      if (response.status === 204 || response.status === 404) {
        setInvitationsReloadKey((key) => key + 1)
      }
    } catch {
      // The row still shows as pending; retrying the control is the recovery.
    }
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

          <label htmlFor="edit-rsvp-visibility">Who can see the RSVP list</label>
          <select
            id="edit-rsvp-visibility"
            value={gatheringForm.rsvpListVisibility}
            aria-describedby={describedBy(gatheringErrors, 'rsvp_list_visibility')}
            onChange={(event) =>
              setGatheringForm((form) => ({
                ...form,
                rsvpListVisibility: event.target.value,
              }))
            }
          >
            {RSVP_LIST_VISIBILITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {/* Adult and child counts disclose household composition — this
              setting is who gets to see them. Everyone always sees their own
              answer, whatever it says. */}
          <p className="field-hint">
            Everyone can always see their own answer; you always see the full list.
          </p>
          <FieldError errors={gatheringErrors} field="rsvp_list_visibility" />

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

                    {/* Blanking clears (CK-22): a blanked optional field goes
                        out as explicit null and the saved value is removed. */}
                    <p className="field-hint">
                      Leaving the end time, location, or map link blank removes what's saved
                      there.
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
                  {occurrence.map_url &&
                    (safeHttpUrl(occurrence.map_url) ? (
                      <p>
                        <a href={occurrence.map_url} target="_blank" rel="noreferrer">
                          Map
                        </a>
                      </p>
                    ) : (
                      // A stored value that fails the scheme guard renders as
                      // plain text — the person can see what is stored (a
                      // silently vanished field is its own bug), but nothing
                      // navigates to it.
                      <p>{occurrence.map_url}</p>
                    ))}
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
                  <OccurrenceRsvp
                    occurrenceId={occurrence.id}
                    zone={zone}
                    isAdmin={canEdit}
                  />
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

      {canEdit && (
        <section className="auth-card" aria-labelledby="invitations-heading">
          <h2 id="invitations-heading">Invitations</h2>
          {!invitationsOpen ? (
            <button
              type="button"
              className="link-button"
              onClick={() => setInvitationsOpen(true)}
            >
              Invite people
            </button>
          ) : (
            <>
              <form onSubmit={(event) => void sendInvitation(event)}>
                <label htmlFor="invite-destination">Email address</label>
                <input
                  id="invite-destination"
                  type="email"
                  required
                  value={inviteDestination}
                  aria-describedby={describedBy(inviteErrors, 'destination')}
                  onChange={(event) => setInviteDestination(event.target.value)}
                />
                <FieldError errors={inviteErrors} field="destination" />
                <FieldError errors={inviteErrors} field="channel" />
                <p className="field-hint">
                  They'll get an email with a link to this gathering. Invitations expire
                  after 7 days.
                </p>
                <button
                  type="submit"
                  disabled={inviteDestination.trim() === '' || inviteSubmitting}
                >
                  {inviteSubmitting ? 'Sending…' : 'Send invitation'}
                </button>
                <FormLevelErrors errors={inviteErrors} />
              </form>

              {invitationsFailed && (
                <p className="form-error" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  The invitation list couldn't be loaded just now.
                </p>
              )}
              {invitations && (
                <>
                  <h3>Waiting on</h3>
                  {invitations.pending.length === 0 ? (
                    <p className="field-hint">No pending invitations.</p>
                  ) : (
                    <ul className="occurrence-list">
                      {invitations.pending.map((pending) => (
                        <li key={pending.id}>
                          {pending.destination}
                          {' — '}
                          {new Date(pending.expires_at).getTime() <= Date.now()
                            ? 'expired'
                            : `expires ${formatInstant(pending.expires_at, zone)}`}{' '}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void revokeInvitation(pending.id)}
                          >
                            Revoke
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Accepted</h3>
                  {invitations.accepted.length === 0 ? (
                    <p className="field-hint">No one has accepted yet.</p>
                  ) : (
                    <ul className="occurrence-list">
                      {invitations.accepted.map((accepted) => (
                        <li key={accepted.id}>{accepted.display_name}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      <Link to="/gatherings">Back to your gatherings</Link>
    </main>
  )
}
