import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { DateBadge } from '../components/Cover'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { GatheringMedia, type GatheringMediaHandle } from '../components/GatheringMedia'
import { Icon } from '../components/Icons'
import { InviteForm, WaitingOn } from '../components/InviteByEmail'
import { OutsideAlert, OutsideInvitationsCard } from '../components/OutsideInvitations'
import { PageCover } from '../components/PageCover'
import {
  firstFieldWithError,
  useFocusRequest,
  useRefMap,
  type FocusSource,
} from '../components/useFocusRequest'
import { authFetch } from '../lib/api'
import {
  effectiveZone,
  formatInstantRange,
  instantToWallClock,
  wallClockToInstant,
} from '../lib/datetime'
import {
  addCoHost,
  CO_HOST_HINT,
  coHostRefusalMessage,
  removeCoHost,
  removeCoHostSentence,
  STEP_DOWN_SENTENCE,
  type CoHost,
  type CoHostList,
} from '../lib/coHosts'
import { COVER_HINT_GATHERING, removePhotoSentence, type CoverBody } from '../lib/covers'
import { announceMenuChange } from '../lib/frame'
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
  PHOTOS_ONLY_LINE,
  roleFlags,
  viewOf,
  type GatheringWithOccurrences,
  type Occurrence,
} from '../lib/gatherings'
import { initials } from '../lib/groups'
import {
  alertSentence,
  fromOutsideLabel,
  groupLine,
  openerOf,
  outsideFlags,
  turnedOffMeanwhile,
} from '../lib/outsideInvitations'
import {
  CO_HOST_ALWAYS_INVITED,
  newcomerLine,
  noOtherMembersLine,
  noPlaceLine,
  PLACE_LABELS,
  PLACES,
  PLACES_HEADING,
  PLACES_HINT,
  placeRefusalMessage,
  promptAction,
  promptLine,
  readPlaces,
  setPlace,
  type Place,
  type PlaceEntry,
  type PlaceList,
} from '../lib/places'
import {
  NOT_ANSWERED,
  RSVP_LIST_VISIBILITIES,
  RSVP_RESPONSES,
  formatArrivalTime,
  rsvpResponseLabel,
  timeForInput,
  totalGoing,
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
  // The host's switch (CK-44): whether photos wait for the host. Two
  // states at the surface — see gatheringPatch for what each one writes.
  reviewPhotos: boolean
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
// it. On the gathering's text fields nothing is clearable — title is NOT
// NULL and the decedent's name is pinned by the memorial CHECK — so a
// blanked one goes out as "" and the server's own refusal renders inline
// (never a fake clear, never a swallowed edit). The one clearable field is
// the host's switch (CK-44): on writes `true`, off writes an explicit `null`
// — inherit, the CK-22 rule exactly — and NEVER `false`. Explicit false
// means "open regardless of what my group later says", and with no group
// default for it to differ from it is indistinguishable from inherit today
// and would ask a host for a preference about a future they have not met;
// the API accepts it, the surface produces it with nothing until rung 2
// exists (consent-gate-defaults 2.3.0 §8).
//
// THE SWITCH IS THE HOST'S ALONE (CK-69; co-hosts §4 — the review is
// reserved): a co-host's PATCH may carry every other field and NEVER
// `requires_approval_override` — the server refuses a co-host's WHOLE body
// on that key with a field-level 422, nothing else applied — so the key is
// written only when the caller is the host. The form never renders the
// switch to a co-host either; this is the second lock on the same door.
function gatheringPatch(
  form: GatheringForm,
  gathering: GatheringWithOccurrences,
  viewer: { isHost: boolean },
): Record<string, string | boolean | null> {
  const patch: Record<string, string | boolean | null> = {}
  const title = form.title.trim()
  if (title !== gathering.title) patch.title = title
  if (gathering.gathering_type === 'memorial') {
    const name = form.decedentName.trim()
    if (name !== (gathering.memorial_decedent_name ?? '')) {
      patch.memorial_decedent_name = name
    }
  }
  // The edit form exists in the full view only, where the server always
  // sends the setting; the fallback (the create default) only satisfies the
  // type — a withheld value is never read (CK-80).
  if (form.rsvpListVisibility !== (gathering.rsvp_list_visibility ?? 'INVITEES')) {
    patch.rsvp_list_visibility = form.rsvpListVisibility
  }
  if (viewer.isHost && form.reviewPhotos !== reviewIsOn(gathering)) {
    patch.requires_approval_override = form.reviewPhotos ? true : null
  }
  return patch
}

// What the switch reads: the host's OWN setting, never the effective value
// (a gathering the ladder gates without the host's say-so would otherwise
// render a switch that is "on" and writes nothing when turned off).
function reviewIsOn(gathering: Pick<GatheringWithOccurrences, 'requires_approval_override'>): boolean {
  return gathering.requires_approval_override === true
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

const GATHERING_FIELDS = [
  'title',
  'memorial_decedent_name',
  'rsvp_list_visibility',
  'requires_approval_override',
]

// §5's accuracy statement (decisions/2026-09-09-consent-gate-defaults.md;
// the-hosts-review §13), rendered on the turning-off path and only there.
// Two clauses: what turning review off means for this gathering — the
// switch renders only for the host, a person, whose groupless and
// privately joined gathering inherits OPEN, so "off" means photos publish
// as soon as they are ready and nobody looks at them first (the record's
// own word for it: unreviewed) — and the honest one about what is already
// waiting: it still needs the host's decision, and the queue stays until
// it gets one (the strand rule). Plain: a hint, never a warning, a block or
// a confirmation. The premise of the first clause is structural today and
// the body does not yet say what inherit resolves to; the share link or
// the group default, whichever comes first, must make this conditional
// (consent-gate-defaults 2.3.0 §8 carries the trigger).
const REVIEW_OFF_STATEMENT =
  "Turning this off means photos are published as soon as they're ready — everyone in this gathering can see them, and nobody looks at them first. Photos already waiting still need your decision, and “Awaiting your review” stays until they get it."
const OCCURRENCE_FIELDS = ['starts_at', 'ends_at', 'location', 'map_url']
// The crumb's word for a gathering that belongs to no group (CK-87; the
// mockup's crumb back to the Gatherings list).
const CRUMB_GATHERINGS = 'Gatherings'
const INVITE_FIELDS = ['destination', 'channel']
const RSVP_FIELDS = ['response', 'stay_included', 'companions', 'arrival_time']

interface RsvpFormState {
  response: string // '' = unanswered — never a defaulted "no"
  stayIncluded: boolean
  // "Bringing anyone?" (CK-29) — the names of the people you're bringing.
  // Empty by default: you RSVP for yourself, and adding nobody costs nothing.
  companions: string[]
  // A bare wall clock ("15:30") at the gathering — sent to the API exactly as
  // typed. The CK-17 profile-zone conversion must NEVER touch it: it has no
  // date and no zone, and wallClockToInstant would silently shift it by the
  // offset for anyone whose profile zone differs from the venue's.
  arrival: string
}

function rsvpFormFromOwn(own: OwnRsvp | null): RsvpFormState {
  if (own === null) {
    return { response: '', stayIncluded: false, companions: [], arrival: '' }
  }
  return {
    response: own.response,
    stayIncluded: own.stay_included,
    companions: [...own.companions],
    arrival: timeForInput(own.arrival_time),
  }
}

// The companion list that actually goes out. A wholly-empty row is "no entry"
// and is omitted (the CK-22 shape: an unfilled control is not a value); a
// whitespace-only row goes out as typed so the server's blank-rejection 422
// renders on it. With a "no" the list is empty — companions are meaningless
// there (the API refuses them), and the wholesale replace clears any saved
// names: "two people are not coming with me" is not information.
function companionsToSend(form: RsvpFormState): string[] {
  if (form.response === 'no') return []
  return form.companions.filter((name) => name !== '')
}

// Dirty-tracking (the CK-18 convention): save is disabled until something
// differs from the saved answer, and an unanswered occurrence stays
// unanswered until a response is actually chosen. Companions compare as
// SENT — an added-but-empty row is not a change.
function rsvpDirty(form: RsvpFormState, own: OwnRsvp | null): boolean {
  if (form.response === '') return false
  const saved = rsvpFormFromOwn(own)
  const sent = companionsToSend(form)
  return (
    form.response !== saved.response ||
    (form.response === 'no' && form.stayIncluded !== saved.stayIncluded) ||
    sent.length !== saved.companions.length ||
    sent.some((name, index) => name !== saved.companions[index]) ||
    form.arrival !== saved.arrival
  )
}

// The per-occurrence RSVP block (CK-27): collapsed by default and loaded only
// when opened — the CK-25 invitations pattern, which keeps the detail page one
// request and keeps a many-date season from fanning out per-row fetches on
// load (the CK-17 N+1 shape). Renders for everyone in the read audience; the
// roster is filtered server-side by the gathering's visibility setting, and
// the mirror check here only chooses the explanatory hint. `organises` is
// the delegable flag (CK-69): the full list in every mode, the companion
// names and the computed total are the organisers' — the host's or a
// co-host's — as the server's `may_administer` decides (CK-68).
//
// Since CK-87 the button that opens it — *RSVP and who's coming* — sits in
// the date's row on the page, beside the answer chip (the mockup's
// `.occ-row`), `aria-expanded` over this block, which the page renders
// beneath the row while it is open and which loads when it mounts. A second
// press closes it, as the mockup's button does. `onAnswer` hands the page the
// caller's answer whenever this block learns it — a save that landed, or the
// block's own read — so the date's chip follows without the gathering being
// read again. Nothing else here changed.
function OccurrenceRsvp({
  occurrenceId,
  zone,
  organises,
  blockId,
  onAnswer,
}: {
  occurrenceId: string
  zone: string
  organises: boolean
  blockId: string
  onAnswer: (response: string | null) => void
}) {
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

  // The page's callback, read when it is needed — the page passes a fresh
  // arrow on every render, and the read must not re-run on each one.
  const onAnswerRef = useRef(onAnswer)
  useEffect(() => {
    onAnswerRef.current = onAnswer
  })

  // Focus after an answer (CK-94), inside this date's block: a refusal to
  // the first field it names, else back to the submit button the press
  // disabled; a landed answer, once the re-read draws it, to the checked
  // answer — the button is disabled again then, nothing being changed.
  const blockRef = useRef<HTMLDivElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusRequest(blockRef)
  const focusAfterRead = useRef(false)

  useEffect(() => {
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
          // The server's answer for the caller — the date's chip follows it.
          onAnswerRef.current(body.own?.response ?? null)
          if (focusAfterRead.current) {
            focusAfterRead.current = false
            requestFocus(
              () => blockRef.current?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? null,
            )
          }
        } else {
          setFailed(true)
          if (focusAfterRead.current) {
            focusAfterRead.current = false
            requestFocus(submitRef)
          }
        }
      } catch {
        if (!cancelled) {
          setFailed(true)
          if (focusAfterRead.current) {
            focusAfterRead.current = false
            requestFocus(submitRef)
          }
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [occurrenceId, reloadKey, requestFocus])

  async function save(event: FormEvent) {
    event.preventDefault()
    const sentCompanions = companionsToSend(form)
    const body: Record<string, unknown> = {
      response: form.response,
      // The flag accompanies a "no" only — with any other answer it is
      // meaningless and the API refuses it, so it goes out false.
      stay_included: form.response === 'no' && form.stayIncluded,
      // The whole list, every save — the server replaces wholesale.
      companions: sentCompanions,
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
        // The answer the server took is the chip's at once (CK-87); the
        // re-read below confirms it.
        onAnswerRef.current(form.response)
        focusAfterRead.current = true
        setReloadKey((key) => key + 1)
      } else {
        // Item-level errors index the SENT list ("companions.0", …).
        setErrors(
          await errorsFromResponse(response, [
            ...RSVP_FIELDS,
            ...sentCompanions.map((_, index) => `companions.${index}`),
          ]),
        )
        requestFocus(() => firstFieldWithError(blockRef.current) ?? submitRef.current)
      }
    } catch {
      if (alive.current) {
        setErrors(networkErrors())
        requestFocus(submitRef)
      }
    }
    if (alive.current) setSubmitting(false)
  }

  // The server enforces visibility; this mirror only picks the hint text.
  // An organiser sees the list in every mode, and the caller always has
  // `own`.
  const maySeeList =
    data !== null &&
    (organises ||
      data.visibility === 'INVITEES' ||
      (data.visibility === 'ATTENDEES' && data.own?.response === 'yes'))

  return (
    <div ref={blockRef} className="rsvp-block" id={blockId}>
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
                  {/* "Store who, compute how many" (CK-29): you RSVP for
                      yourself; if you're bringing someone, you say WHO. No
                      rows is the normal case and costs no clicks. */}
                  <p className="field-hint">Bringing anyone?</p>
                  {form.companions.map((name, index) => {
                    // The 422's loc indexes the SENT list (empty rows are
                    // omitted from it), so map this row to its sent index.
                    const sentIndex = form.companions
                      .slice(0, index)
                      .filter((entry) => entry !== '').length
                    const field = `companions.${sentIndex}`
                    return (
                      <div key={index} className="companion-row">
                        <label htmlFor={`rsvp-companion-${occurrenceId}-${index}`}>
                          Their name
                        </label>
                        <input
                          id={`rsvp-companion-${occurrenceId}-${index}`}
                          type="text"
                          value={name}
                          aria-describedby={
                            name === ''
                              ? undefined
                              : describedBy(errors, field, occurrenceId)
                          }
                          onChange={(event) =>
                            setForm((f) => ({
                              ...f,
                              companions: f.companions.map((entry, i) =>
                                i === index ? event.target.value : entry,
                              ),
                            }))
                          }
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              companions: f.companions.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          Remove
                        </button>
                        {name !== '' && (
                          <FieldError errors={errors} field={field} scope={occurrenceId} />
                        )}
                      </div>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() =>
                      setForm((f) => ({ ...f, companions: [...f.companions, ''] }))
                    }
                  >
                    Add someone
                  </button>
                  <FieldError errors={errors} field="companions" scope={occurrenceId} />

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

              <button ref={submitRef} type="submit" disabled={!rsvpDirty(form, data.own) || submitting}>
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
                <>
                  {/* The computed total (CK-29): derived from the named
                      people on the "Going" rows, never typed by anyone —
                      the organisers' number (CK-69). */}
                  {organises && (
                    <p className="field-hint">
                      Total going: {totalGoing(data.rsvps)}{' '}
                      {totalGoing(data.rsvps) === 1 ? 'person' : 'people'} — counted
                      from the names.
                    </p>
                  )}
                  <ul className="occurrence-list">
                    {data.rsvps.map((row) => (
                      <li key={row.id}>
                        {row.display_name} — {rsvpResponseLabel(row.response)}
                        {row.stay_included ? ' (staying in the loop)' : ''}
                        {/* Companions withheld (null — ATTENDEES, CK-30): the
                            count still tells the mode's story, the names
                            don't. Distinct from [] — "brought nobody" shows
                            nothing at all. */}
                        {row.companions === null && row.total > 1
                          ? `, bringing ${row.total - 1}`
                          : ''}
                        {row.arrival_time
                          ? `, arriving ${formatArrivalTime(row.arrival_time)}`
                          : ''}
                        {row.companions !== null && row.companions.length > 0 && (
                          <ul
                            className="companion-list"
                            aria-label={`Coming with ${row.display_name}`}
                          >
                            {row.companions.map((companionName, index) => (
                              <li key={index}>{companionName}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="field-hint">
              {/* The narrowest setting names the organisers (CK-69): the
                  server shows the full list to the host AND any co-hosts,
                  so "only the host" would be false the day one exists. */}
              {data.visibility === 'HOST_ONLY'
                ? 'Only the host and co-hosts see the full list of answers.'
                : 'The list of answers is shown to people who are going.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// The stable code a refusal carries (`detail.code`), read from a copy of
// the response so the mapper can still read the body; '' when none.
async function refusalCode(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { detail?: { code?: unknown } } | null
    const code = body?.detail?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

// The view-and-edit detail (CK-17 read-only; editing CK-18). Nothing here
// surfaces keeper counts or gathering removal: those are later phases'
// surfaces. `requires_approval` — the EFFECTIVE value, resolved through the
// publication ladder (CK-41) — is READ by the Photos section since CK-43.1
// to decide whether the host's review exists, and is written by nothing;
// `requires_approval_override` — the host's OWN setting — is what the
// switch on the edit form writes since CK-44 (true, or null for inherit).
// The gathering type is not editable — the backend's patchable surface is
// title + decedent name + RSVP-list visibility + the switch.
//
// WHO THE CALLER IS COMES FROM THE BODY (CK-69): `caller_role` — host,
// co-host, or neither — read through lib/gatherings.ts::roleFlags into two
// flags, and every gated control on this page reads one of them on purpose
// (CK-68's classification, one line per check in the api-reference's
// Co-hosts router). `organises` — the host or a co-host — gates the
// DELEGABLE set: the edit form (title, decedent name, the RSVP-list
// visibility), the date controls, the Invitations section, the full RSVP
// list and its total, and the Photos section's takedown and Removed view.
// `isHost` gates the RESERVED set: the review switch inside that same form,
// the review inside the Photos section, and making or removing co-hosts.
// Nothing here compares account ids to decide a role — the page did until
// CK-69 (`host_account_id === person.account_id`), and a co-host was shown
// an invitee's page while the server would let them do most of what the
// host does. Anything but the two known roles gates closed.
//
// WHAT THE CALLER GETS COMES FROM THE BODY TOO (CK-80): `caller_view`, read
// through lib/gatherings.ts::viewOf and nowhere by hand. Anything but `full`
// is THE PHOTOS-ONLY VIEW — the header, one line, and the Photos section
// with no upload and no date label — and the page then reads neither
// `occurrences` nor `rsvp_list_visibility` (NULL: withheld, not empty) and
// asks for nothing the view withholds. On a GROUP's gathering (CK-80, Groups
// 3c) the organisers get Who it's for (each member's place, one tap each,
// `organises` — delegable), the prompt to share once a date has started, and
// an Invitations section that is co-host management alone — no email form
// and no Waiting on, because every emailed invitation to a group's gathering
// is the 409 `members_only` while its outside invitations are off. Nobody is
// told their place.
//
// INVITING PEOPLE OUTSIDE THE GROUP (CK-93; the surface for CK-92's backend;
// the record §5–§7). Three body fields, read through
// lib/outsideInvitations.ts's `outsideFlags` and nowhere by hand, decide
// four things: `may_change` THE CARD (components/OutsideInvitations.tsx —
// the switch, its two steps and, while on, for the organisers, the email
// form and *Waiting on*, moved from the standalone section and shared),
// after Who it's for in the full view and after Photos in the photos-only
// view; `caller_in_group` true THE LINE at the top of Photos; `outside_alert`
// THE ALERT beneath the cover card; and `caller_in_group` exactly false AN
// OUTSIDER'S PAGE, which never reaches for the group — its crumb is
// *Gatherings*, and the Photos section is given no group, so the viewer
// reads none. A body without the fields renders none of it.
//
// THE MOCKUP'S LAYOUT (CK-87; its screens 08 and 09, `gatheringPage()`; the
// merge record §3 item 7; Steven's answers of 2026-11-01). The page column
// (`.page-column`), top to bottom: THE CRUMB — the group by name back to its
// page, or *Gatherings* back to the list for a gathering in no group (it
// replaces CK-80's group line and the loaded page's *Back to your
// gatherings*); THE COVER CARD at the mockup's measure (the cover's `wide`
// variant), the title as the <h1>, the type beneath it and, for a memorial,
// *In memory of {name}*, all over the scrim, with the date badge in the
// full view while a date is still ahead; THE ACTIONS — Add photos (the
// invited tier: one press opens the device's picker, GatheringMedia's
// handle — the Photos section beneath is open on load since CK-88) and Edit
// gathering (the organisers:
// today's form, beneath the actions); the prompt to share; WHEN, each date
// with its time range, its place and map on one line, and its row — the
// answer chip from the body's `caller_response`, *RSVP and who's coming*,
// and the organisers' Edit this date and Remove this date — with the remove
// step and the RSVP block beneath the row; PHOTOS; Who it's for; and the
// Co-hosts or Invitations section. Every section's behaviour is as it was;
// this phase arranged them. Not here, because none is built (the merge
// record §4): *Hosted by*, Chat and the chat preview. Since CK-88 the Photos
// section carries its heading's count, the grid, *See all* and the photo
// viewer (GatheringMedia, point 13).
export function GatheringDetail() {
  const { id } = useParams()
  // A group page's See all lands at `#photos` (CK-88.1b): a fixed string,
  // compared and never navigated to. The Photos section reads it once.
  const arrivedAtPhotos = useLocation().hash === '#photos'
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  // Bumped after every successful mutation: the server re-sorts occurrences
  // by starts_at and stamps updated_at, so the page re-renders from a fresh
  // GET rather than from a locally-guessed merge (optimistic-free).
  const [reloadKey, setReloadKey] = useState(0)
  // The Photos section's handle (CK-87): the page's Add photos opens the
  // device's picker through it, inside the click.
  const mediaRef = useRef<GatheringMediaHandle>(null)
  const editFormId = useId()
  // Which dates' RSVP blocks are open (CK-87: their buttons sit in the
  // dates' rows, each over its own block, as independent as they were).
  const [rsvpOpen, setRsvpOpen] = useState<string[]>([])

  const [editingGathering, setEditingGathering] = useState(false)
  const [gatheringForm, setGatheringForm] = useState<GatheringForm>({
    title: '',
    decedentName: '',
    rsvpListVisibility: 'INVITEES',
    reviewPhotos: false,
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
  // The CK-30 confirmation step: a date somebody answered refuses once (a 409
  // with the confirmation_required marker and the count), and the warning
  // renders beside the control with an explicit "remove anyway". A date with
  // no answers never reaches this state — the server deletes it outright.
  const [confirmRemove, setConfirmRemove] = useState<{
    occurrenceId: string
    rsvpCount: number
  } | null>(null)

  // The invitations section (CK-25; the organisers' — the host's or a
  // co-host's — since CK-69) is COLLAPSED by default and its lists load
  // only when opened — the detail page stays one request for everyone, and
  // anyone who does not organise never has the section at all.
  const [invitationsOpen, setInvitationsOpen] = useState(false)
  const [invitations, setInvitations] = useState<InvitationLists | null>(null)
  const [invitationsFailed, setInvitationsFailed] = useState(false)
  const [invitationsReloadKey, setInvitationsReloadKey] = useState(0)
  const [inviteDestination, setInviteDestination] = useState('')
  const [inviteErrors, setInviteErrors] = useState<FormErrors>(noErrors())
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  // A send on a group's gathering the server refused with `members_only`
  // (CK-93): its outside invitations were turned off meanwhile. The card
  // says so beneath its switch until a send or a change lands.
  const [inviteTurnedOff, setInviteTurnedOff] = useState(false)
  // The page's <h1> (CK-93): Got it on the alert moves focus to it.
  const titleRef = useRef<HTMLHeadingElement>(null)

  // Co-host management (CK-69), inside the Invitations section: the co-host
  // list loads with the invitations when the section opens (only an
  // organiser ever requests it) and re-loads after every make or remove;
  // a refusal lands on the row it names — an Accepted row for a make, a
  // co-host row for a remove or a step-down — in this surface's words for
  // the server's code; a remove and a step-down each take a deliberate
  // second step (the person loses their controls at once), held here as
  // the row whose step is open; one act at a time.
  const [coHosts, setCoHosts] = useState<CoHost[] | null>(null)
  const [coHostsFailed, setCoHostsFailed] = useState(false)
  const [coHostsReloadKey, setCoHostsReloadKey] = useState(0)
  const [coHostError, setCoHostError] = useState<{
    invitationId: string
    errors: FormErrors
  } | null>(null)
  const [coHostActing, setCoHostActing] = useState<string | null>(null)
  const [confirmUnmake, setConfirmUnmake] = useState<string | null>(null)

  // Who it's for and the prompt to share (CK-80), for the organisers of a
  // group's gathering in the full view: one read of the places on mount, in
  // its own card; a change is one PUT, its row re-rendered from the
  // server's entry; one change at a time; a refusal lands on the row — or
  // the prompt line — that drew it, nothing re-read.
  const [placesLoad, setPlacesLoad] = useState<
    { status: 'loading' } | { status: 'loaded'; value: PlaceList } | { status: 'failed' }
  >({ status: 'loading' })
  const [placesKey, setPlacesKey] = useState(0)
  const [placeActing, setPlaceActing] = useState<string | null>(null)
  const [placeRefusal, setPlaceRefusal] = useState<{
    membershipId: string
    where: 'row' | 'prompt'
    message: string
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

  // FOCUS AFTER AN ANSWER (CK-94; reference/frontend/components.md, Focus
  // after an answer). A press disables or removes the control it was made
  // on, and the browser drops focus to the body while the request waits, so
  // every answer names where focus goes next: a 422 to the first field it
  // names, a failure back to the pressed control, a success to the control
  // that carries the act on, or a section's heading where nothing does. One
  // request per piece of the page, each taking focus only from the body or
  // from inside its own piece. A step opens with focus on itself, labelled
  // by its sentence — never on its destructive button.
  const editFormRef = useRef<HTMLFormElement>(null)
  const editGatheringButton = useRef<HTMLButtonElement>(null)
  const gatheringSave = useRef<HTMLButtonElement>(null)
  const whenRef = useRef<HTMLElement>(null)
  const whenHeading = useRef<HTMLHeadingElement>(null)
  const occurrenceFormRef = useRef<HTMLFormElement>(null)
  const occurrenceSave = useRef<HTMLButtonElement>(null)
  const addFormRef = useRef<HTMLFormElement>(null)
  const addSubmit = useRef<HTMLButtonElement>(null)
  const addAnother = useRef<HTMLButtonElement>(null)
  const removeStep = useRef<HTMLDivElement>(null)
  const removeSentenceId = useId()
  // `edit:<id>` and `remove:<id>`, a date's Edit this date and Remove this date.
  const dateButtons = useRefMap<string>()
  const promptRef = useRef<HTMLElement>(null)
  const promptButtons = useRefMap<string>()
  const placesRef = useRef<HTMLElement>(null)
  const placesHeading = useRef<HTMLHeadingElement>(null)
  const placeRows = useRefMap<string>()
  const inviteField = useRef<HTMLInputElement>(null)
  const inviteSubmit = useRef<HTMLButtonElement>(null)
  const coHostsRef = useRef<HTMLElement>(null)
  const coHostStep = useRef<HTMLDivElement>(null)
  const coHostSentenceId = useId()
  // `make:<id>` and `unmake:<id>`, by the accepted invitation's id.
  const coHostButtons = useRefMap<string>()
  // Where focus goes once the co-host list's re-read draws the row a
  // landed make or remove moved (the row is not on screen until then).
  const focusAfterCoHosts = useRef<FocusSource | null>(null)
  const focusInEdit = useFocusRequest(editFormRef)
  const focusInWhen = useFocusRequest(whenRef)
  const focusInPrompt = useFocusRequest(promptRef)
  const focusInPlaces = useFocusRequest(placesRef)
  // The email form is drawn in one of two sections — the Invitations section
  // or the outside card — so its piece is whichever holds it.
  const focusInInvite = useFocusRequest(() => inviteField.current?.closest('section') ?? null)
  const focusInCoHosts = useFocusRequest(coHostsRef)

  const loadedGathering = state.status === 'loaded' ? state.gathering : null
  // THE PAGE'S ONE ROSTER READ (CK-93): the Co-hosts or Invitations
  // section's lists and the outside card's *Waiting on* are one request.
  // It is read while that section is open (only an organiser ever has it),
  // or while the setting is on and the caller organises a group's gathering
  // in the full view — the server refuses the roster to anyone else, a
  // group's admin who organises nothing included — and once per reload
  // whichever holds: the effect keys on the one boolean. Re-fetched after
  // every successful send or revoke, and after a turn-off (optimistic-free,
  // like everything else here).
  const rosterWanted =
    invitationsOpen ||
    (loadedGathering !== null &&
      loadedGathering.group !== null &&
      viewOf(loadedGathering.caller_view).full &&
      roleFlags(loadedGathering.caller_role).organises &&
      outsideFlags(loadedGathering).on)
  useEffect(() => {
    if (!rosterWanted) return
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
  }, [id, rosterWanted, invitationsReloadKey])

  // The co-host list (CK-69), beside the invitations: the same trigger,
  // its own reload key (a make or a remove changes this list and not the
  // invitations), and a failed load says so where the list would be.
  useEffect(() => {
    if (!invitationsOpen) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(`/gatherings/${id}/co-hosts`)
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as Partial<CoHostList>
          setCoHosts(body.co_hosts ?? [])
          setCoHostsFailed(false)
          const target = focusAfterCoHosts.current
          focusAfterCoHosts.current = null
          if (target !== null) focusInCoHosts(target)
        } else {
          setCoHostsFailed(true)
          focusAfterCoHosts.current = null
        }
      } catch {
        if (!cancelled) {
          setCoHostsFailed(true)
          focusAfterCoHosts.current = null
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, invitationsOpen, coHostsReloadKey, focusInCoHosts])

  // The places (CK-80) are read only where the server would answer them: an
  // organiser of a group's gathering, in the full view. For anyone else the
  // route is the gathering's 404 — and in the photos-only view the page asks
  // for nothing the view withholds — so it is never asked.
  const wantsPlaces =
    loadedGathering !== null &&
    loadedGathering.group !== null &&
    viewOf(loadedGathering.caller_view).full &&
    roleFlags(loadedGathering.caller_role).organises
  useEffect(() => {
    const gatheringId = id
    if (!wantsPlaces || gatheringId === undefined) return
    let cancelled = false
    async function load(target: string) {
      const outcome = await readPlaces(target)
      if (!cancelled) {
        setPlacesLoad(outcome.ok ? { status: 'loaded', value: outcome.value } : { status: 'failed' })
      }
    }
    void load(gatheringId)
    return () => {
      cancelled = true
    }
  }, [id, wantsPlaces, placesKey])

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
    // A retry is a control, never a sentence with nothing to press (CK-80;
    // CK-74.1's idiom): Try again re-reads through the loading state.
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error" role="alert">
          This gathering couldn't be loaded just now.
        </p>
        <button
          type="button"
          onClick={() => {
            setState({ status: 'loading' })
            setReloadKey((key) => key + 1)
          }}
        >
          Try again
        </button>
        <Link to="/gatherings">Back to your gatherings</Link>
      </main>
    )
  }

  const { gathering } = state
  const isMemorial = gathering.gathering_type === 'memorial'

  // Inviting people outside the group (CK-93): the body's three fields,
  // read once. AN OUTSIDER'S PAGE NEVER REACHES FOR THE GROUP: the crumb and
  // the Photos section are handed no group, so the crumb is *Gatherings* and
  // the viewer reads nothing about the group's seat.
  const outside = outsideFlags(gathering)
  const shownGroup = outside.outsider ? null : gathering.group
  // THE LINE, for the group's members alone, in both views.
  const lineForGroup =
    outside.inGroup && gathering.group !== null ? groupLine(gathering.group.name, outside.on) : null

  // A change to the setting landed: the returned body replaces the page's;
  // a turn-off reads the roster again (the outsiders' rows and every
  // pending invitation are gone with it).
  function settingLanded(body: GatheringWithOccurrences, turnedOff: boolean) {
    setInviteTurnedOff(false)
    setState({ status: 'loaded', gathering: body })
    if (turnedOff) setInvitationsReloadKey((key) => key + 1)
  }

  // Got it landed: the alert goes from the body the page holds, nothing
  // re-read, and focus goes to the page's <h1> — unless the person moved
  // away from the alert while the request waited (CK-93.1).
  function alertDismissed(takeFocus: boolean) {
    if (takeFocus) titleRef.current?.focus()
    setState((current) =>
      current.status === 'loaded'
        ? { status: 'loaded', gathering: { ...current.gathering, outside_alert: false } }
        : current,
    )
  }

  // THE ALERT (the record §5), beneath the cover card in both views.
  const alert =
    outside.alert && gathering.group !== null ? (
      <OutsideAlert
        gatheringId={gathering.id}
        sentence={alertSentence(openerOf(gathering), gathering.title, gathering.group.name)}
        onDismissed={alertDismissed}
      />
    ) : null

  // THE CARD, for everyone the body says `may_change`; `children` the email
  // form and *Waiting on*, the full view's organisers' while it is on.
  function outsideCard(children: ReactNode) {
    if (!outside.mayChange || gathering.group === null) return null
    return (
      <OutsideInvitationsCard
        gatheringId={gathering.id}
        groupName={gathering.group.name}
        on={outside.on}
        notice={inviteTurnedOff ? turnedOffMeanwhile(gathering.group.name) : null}
        onLanded={settingLanded}
        onRefresh={() => setReloadKey((key) => key + 1)}
      >
        {children}
      </OutsideInvitationsCard>
    )
  }

  // The cover a page act landed, drawn at once from the server's answer (the
  // PUT's `cover` from the viewer's Use as cover — CK-84).
  function coverSet(cover: CoverBody | null) {
    setState((current) =>
      current.status === 'loaded' ? { status: 'loaded', gathering: { ...current.gathering, cover } } : current,
    )
  }

  // The head every view shares (CK-87): THE CRUMB (the mockup's `.crumb
  // .nrow`, CK-86's markup) — the gathering's group by name, back to its
  // page, or *Gatherings*, back to the list, for a gathering in no group —
  // then THE COVER CARD at the mockup's measure (CK-84's components/
  // PageCover.tsx, the cover's `wide` variant since CK-87 — the empty cover
  // until one is set, and Change cover for the organisers in the full view
  // alone: the photos-only view gives no role whatever arrives), with the
  // title, the type and, for a memorial, the decedent line over the scrim.
  // `badge` is the full view's alone: the photos-only view has no dates.
  function head(badge: ReactNode | undefined) {
    const group = shownGroup
    return (
      <>
        <div className="crumb">
          <Link className="nrow" to={group ? `/groups/${group.id}` : '/gatherings'}>
            <Icon name="back" />
            <span className="t">
              <b>{group ? group.name : CRUMB_GATHERINGS}</b>
            </span>
          </Link>
        </div>
        <PageCover
          subject="gathering"
          id={gathering.id}
          cover={gathering.cover}
          badge={badge}
          organises={viewOf(gathering.caller_view).full && roleFlags(gathering.caller_role).organises}
          hint={COVER_HINT_GATHERING}
          photoRemovalSentence={removePhotoSentence(gathering.title)}
          onChanged={() => setReloadKey((key) => key + 1)}
        >
          <h1 ref={titleRef} tabIndex={-1}>
            {gathering.title}
          </h1>
          <p className="cover-card-meta">{gatheringTypeLabel(gathering.gathering_type)}</p>
          {gathering.memorial_decedent_name && (
            <p className="cover-card-meta">In memory of {gathering.memorial_decedent_name}</p>
          )}
        </PageCover>
      </>
    )
  }

  // THE PHOTOS-ONLY VIEW (CK-80; CK-77's memory view), wherever `viewOf`
  // does not say `full` — a member only shared with a group's gathering, or
  // a body this build does not understand (an unknown view shows less). The
  // head — the crumb and the cover card, with no badge and no Change cover —
  // one line saying what this is, and the Photos section with no upload and
  // no date label: no actions, no When, no RSVP, no Edit gathering, no
  // Invitations, no places. This branch NEVER reads `occurrences`,
  // `rsvp_list_visibility` or any date's `caller_response` — the server
  // sends the first two NULL, and withheld is not empty (the CK-30
  // precedent) — and asks for nothing the view withholds. The memory view
  // carries no role (`caller_role` null), and the photos-only view gives
  // none whatever arrives.
  if (viewOf(gathering.caller_view).photosOnly) {
    return (
      <main className="auth-screen page-column gathering-page">
        {head(undefined)}
        {alert}
        <p>{PHOTOS_ONLY_LINE}</p>
        <section className="auth-card" aria-labelledby="photos-heading">
          <GatheringMedia
            gatheringId={gathering.id}
            isHost={false}
            organises={false}
            requiresApproval={gathering.requires_approval}
            occurrences={null}
            canUpload={false}
            cover={gathering.cover}
            group={shownGroup}
            gatheringTitle={gathering.title}
            onCoverSet={coverSet}
            zone={zone}
            arrivedAtPhotos={arrivedAtPhotos}
            groupLine={lineForGroup}
          />
        </section>
        {/* The card after Photos (CK-93): a group's admin or co-admin only
            shared with may change the setting, and gets the switch alone. */}
        {outsideCard(null)}
      </main>
    )
  }

  // The full view from here: the server always sends the dates in it (a
  // null would be an invariant breach, rendered as no dates rather than as
  // a crash).
  const occurrences: Occurrence[] = gathering.occurrences ?? []
  const group = gathering.group

  // The two role flags (CK-69), from the body's `caller_role` and nothing
  // else. Edit affordances render only for an organiser — anyone else sees
  // the read-only page with no edit controls at all, so no one can probe an
  // edit control to distinguish "not yours" from "does not exist" (the
  // 404-not-403 posture) — and the reserved controls for the host alone.
  // The server's own answer decides, so the flags hold however wide later
  // phases open the read audience, and a body with no role — or a role
  // this build does not know — gates closed, not open. (From CK-20 to
  // CK-69 the gate was `host_account_id === person.account_id`: right while
  // the host was the one organiser, and blind to a co-host.)
  const { isHost, organises } = roleFlags(gathering.caller_role)
  // Who may add photographs: the invited tier, which is exactly the full view
  // (CK-77) — the Photos section's `canUpload` and the page's Add photos read
  // the same fact (CK-87).
  const canUpload = viewOf(gathering.caller_view).full

  // The one `now` this render reads its dates against: the prompt to share
  // (a date has started) and the badge (a date still ahead).
  const now = Date.now()
  // THE DATE BADGE (CK-87; CK-85's `DateBadge`, in the profile's zone): the
  // soonest date that starts at or after now — a date in progress reads as
  // past, the one rule's meaning (CK-85) — and none once every date has
  // started.
  const soonestAhead = occurrences.reduce<Occurrence | null>((soonest, occurrence) => {
    const at = Date.parse(occurrence.starts_at)
    if (!Number.isFinite(at) || at < now) return soonest
    return soonest === null || at < Date.parse(soonest.starts_at) ? occurrence : soonest
  }, null)
  const badge =
    soonestAhead !== null ? <DateBadge startsAt={soonestAhead.starts_at} zone={zone} /> : undefined

  // The answer the RSVP block learned — a save that landed, or its read —
  // becomes the date's chip at once, without the gathering read again (the
  // CK-84 coverSet idiom).
  function answerChanged(occurrenceId: string, response: string | null) {
    setState((current) =>
      current.status === 'loaded' && current.gathering.occurrences !== null
        ? {
            status: 'loaded',
            gathering: {
              ...current.gathering,
              occurrences: current.gathering.occurrences.map((occurrence) =>
                occurrence.id === occurrenceId ? { ...occurrence, caller_response: response } : occurrence,
              ),
            },
          }
        : current,
    )
  }

  function toggleRsvp(occurrenceId: string) {
    setRsvpOpen((open) =>
      open.includes(occurrenceId) ? open.filter((id) => id !== occurrenceId) : [...open, occurrenceId],
    )
  }

  const gatheringDirty =
    Object.keys(gatheringPatch(gatheringForm, gathering, { isHost })).length > 0
  // The turning-off path, and only that path: review was on when the form
  // opened and the box is now unchecked. Re-checking withdraws it. The
  // host's alone, like the switch it explains.
  const turningReviewOff = isHost && reviewIsOn(gathering) && !gatheringForm.reviewPhotos
  const editedOccurrence =
    editingOccurrenceId === null
      ? null
      : occurrences.find((o) => o.id === editingOccurrenceId) ?? null
  const occurrenceDirty =
    editedOccurrence !== null &&
    Object.keys(occurrencePatch(occurrenceForm, occurrenceToForm(editedOccurrence, zone), zone))
      .length > 0

  function openGatheringEdit() {
    setGatheringForm({
      title: gathering.title,
      decedentName: gathering.memorial_decedent_name ?? '',
      rsvpListVisibility: gathering.rsvp_list_visibility ?? 'INVITEES',
      reviewPhotos: reviewIsOn(gathering),
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
    const patch = gatheringPatch(gatheringForm, gathering, { isHost })
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
        // The menu draws the title (CK-89.1).
        announceMenuChange()
        focusInEdit(editGatheringButton)
      } else {
        setGatheringErrors(await errorsFromResponse(response, GATHERING_FIELDS))
        focusInEdit(() => firstFieldWithError(editFormRef.current) ?? gatheringSave.current)
      }
    } catch {
      if (alive.current) {
        setGatheringErrors(networkErrors())
        focusInEdit(gatheringSave)
      }
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
        // The menu draws the next date (CK-89.1).
        announceMenuChange()
        focusInWhen(() => dateButtons.get(`edit:${occurrence.id}`))
      } else {
        setOccurrenceErrors(await errorsFromResponse(response, OCCURRENCE_FIELDS))
        focusInWhen(() => firstFieldWithError(occurrenceFormRef.current) ?? occurrenceSave.current)
      }
    } catch {
      if (alive.current) {
        setOccurrenceErrors(networkErrors())
        focusInWhen(occurrenceSave)
      }
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
        // The menu draws the next date (CK-89.1).
        announceMenuChange()
        focusInWhen(addAnother)
      } else {
        setAddErrors(await errorsFromResponse(response, OCCURRENCE_FIELDS))
        focusInWhen(() => firstFieldWithError(addFormRef.current) ?? addSubmit.current)
      }
    } catch {
      if (alive.current) {
        setAddErrors(networkErrors())
        focusInWhen(addSubmit)
      }
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
        setInviteTurnedOff(false)
        setInvitationsReloadKey((key) => key + 1)
        focusInInvite(inviteField)
      } else if (response.status === 409 && group !== null && (await refusalCode(response)) === 'members_only') {
        // A group's gathering whose outside invitations were turned off
        // meanwhile (CK-93): its own line, and the gathering re-read, so the
        // card shows off. Nothing was sent. The card moves focus to its switch
        // when the line appears (CK-93.1).
        if (!alive.current) return
        setInviteTurnedOff(true)
        setReloadKey((key) => key + 1)
      } else if (response.status === 429) {
        // A rate limit is neither a validation failure nor a server error —
        // it gets its own honest line instead of the mapper's generic one.
        setInviteErrors({
          fields: {},
          form: ['Too many invitations just now. Try again in a few minutes.'],
        })
        focusInInvite(inviteSubmit)
      } else {
        setInviteErrors(await errorsFromResponse(response, INVITE_FIELDS))
        focusInInvite(() => firstFieldWithError(inviteField.current?.form ?? null) ?? inviteSubmit.current)
      }
    } catch {
      if (alive.current) {
        setInviteErrors(networkErrors())
        focusInInvite(inviteSubmit)
      }
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
        // Revoke is never disabled, so focus is on it until its row goes:
        // to the address field, where inviting goes on (CK-94).
        focusInInvite(inviteField)
      }
    } catch {
      // The row still shows as pending; retrying the control is the recovery.
    }
  }

  // The name a co-host management line calls a person by: their display
  // name, as the roster and the media rows do; never an email or an id.
  function coHostName(displayName: string | null): string {
    return displayName ?? 'Someone'
  }

  // The host makes a co-host (CK-69; reserved): one click, no confirmation
  // — the host can undo it — posting the accepted invitation's id, the one
  // handle the host already reads here. A success re-reads the co-host
  // list (optimistic-free); a refusal lands on the Accepted row, from its
  // code.
  async function makeCoHost(accepted: { id: string; display_name: string | null }) {
    if (coHostActing !== null) return
    setCoHostActing(accepted.id)
    setCoHostError(null)
    setConfirmUnmake(null)
    const outcome = await addCoHost(gathering.id, accepted.id)
    if (!alive.current) return
    setCoHostActing(null)
    if (outcome.ok) {
      // Focus to the new co-host's Remove as co-host, once the re-read draws it.
      focusAfterCoHosts.current = () => coHostButtons.get(`unmake:${accepted.id}`)
      setCoHostsReloadKey((key) => key + 1)
      // Who it's for carries each member's `co_host` (CK-80): a co-host's
      // row offers Invited alone, so the places are re-read with the list.
      if (wantsPlaces) setPlacesKey((key) => key + 1)
      return
    }
    setCoHostError({
      invitationId: accepted.id,
      errors: { fields: {}, form: [coHostRefusalMessage(outcome.code, coHostName(accepted.display_name))] },
    })
    focusInCoHosts(() => coHostButtons.get(`make:${accepted.id}`))
  }

  // The host removes a co-host, or a co-host steps down — the same DELETE,
  // taken on the second, deliberate click of a step this row opened. On
  // success the host re-reads the co-host list; a co-host who stepped down
  // re-reads THE GATHERING, because their `caller_role` is null now and the
  // page re-renders as an invitee's — every organiser control goes with it.
  async function unmakeCoHost(row: CoHost, steppingDown: boolean) {
    if (coHostActing !== null) return
    setCoHostActing(row.invitation_id)
    setCoHostError(null)
    const outcome = await removeCoHost(gathering.id, row.invitation_id)
    if (!alive.current) return
    setCoHostActing(null)
    setConfirmUnmake(null)
    if (outcome.ok) {
      if (steppingDown) {
        setReloadKey((key) => key + 1)
        // Every organiser control goes with the re-read: to the page's <h1>.
        focusInCoHosts(titleRef)
      } else {
        // Focus to their Make co-host, once the re-read draws it.
        focusAfterCoHosts.current = () => coHostButtons.get(`make:${row.invitation_id}`)
        setCoHostsReloadKey((key) => key + 1)
        // A removed co-host's row in Who it's for offers all three again.
        if (wantsPlaces) setPlacesKey((key) => key + 1)
      }
      return
    }
    setCoHostError({
      invitationId: row.invitation_id,
      errors: { fields: {}, form: [coHostRefusalMessage(outcome.code, coHostName(row.display_name))] },
    })
    focusInCoHosts(() => coHostButtons.get(`unmake:${row.invitation_id}`))
  }

  // Change one member's place (CK-80) — Who it's for's one tap, and the
  // prompt's. One PUT; the row re-renders from the server's entry, and
  // `invitees_chosen` follows the API's documented rule (any move away from
  // invited sets it, and nothing sets it back — once chosen, chosen). It is
  // reversible, and nobody is told. A refusal lands where it was drawn,
  // from its code, with nothing re-read.
  async function changePlace(entry: PlaceEntry, place: Place, where: 'row' | 'prompt') {
    if (placeActing !== null || group === null) return
    setPlaceActing(entry.membership_id)
    setPlaceRefusal(null)
    const outcome = await setPlace(gathering.id, entry.membership_id, place)
    if (!alive.current) return
    setPlaceActing(null)
    if (outcome.ok) {
      const updated = outcome.entry
      setPlacesLoad((current) =>
        current.status !== 'loaded'
          ? current
          : {
              status: 'loaded',
              value: {
                inviteesChosen:
                  current.value.inviteesChosen ||
                  (updated.place !== null && updated.place !== 'invited'),
                members: current.value.members.map((member) =>
                  member.membership_id === updated.membership_id ? updated : member,
                ),
              },
            },
      )
      if (where === 'prompt') {
        // The prompt's line goes: to the next line's button, else to Who
        // it's for's heading (the prompt has no heading of its own).
        const next = stillASurprise[stillASurprise.findIndex((m) => m.membership_id === entry.membership_id) + 1]
        focusInPrompt(() => (next ? promptButtons.get(next.membership_id) : placesHeading.current))
      } else {
        focusInPlaces(checkedPlace(entry.membership_id))
      }
      return
    }
    setPlaceRefusal({
      membershipId: entry.membership_id,
      where,
      message: placeRefusalMessage(outcome.code, entry.display_name, group.name),
    })
    if (where === 'prompt') focusInPrompt(() => promptButtons.get(entry.membership_id))
    else focusInPlaces(checkedPlace(entry.membership_id))
  }

  // A member's row in Who it's for: its checked place, the one the server
  // answered (the radio chosen on a success, the place kept on a refusal).
  function checkedPlace(membershipId: string): FocusSource {
    return () => placeRows.get(membershipId)?.querySelector<HTMLElement>('input:checked') ?? null
  }

  // Refresh the list goes as it is pressed: to Who it's for's heading
  // (CK-94, the rule's last rung — the row is re-read).
  function refreshPlaces() {
    setPlaceRefusal(null)
    setPlacesKey((key) => key + 1)
    focusInPlaces(placesHeading)
  }

  const places = placesLoad.status === 'loaded' ? placesLoad.value : null
  // THE PROMPT TO SHARE (Steven, 2026-10-27; record §4): for an organiser of
  // a group's gathering, once any of its dates has started, one line per
  // member still kept a surprise — so a surprise is never left hidden by
  // forgetting. No dialog, no notification.
  const anyDateStarted = occurrences.some(
    (occurrence) => new Date(occurrence.starts_at).getTime() <= now,
  )
  const stillASurprise =
    organises && group !== null && anyDateStarted && places !== null
      ? places.members.filter((member) => member.place === 'left_out')
      : []

  // Deliberately not disabled when one date remains: the server owns the
  // last-occurrence rule, refuses with a 422, and its reason renders beside
  // this control — which is why the refusal surface waited for this phase.
  // Since CK-30 the endpoint carries a SECOND refusal, machine-distinguished
  // by its status and marker, never by wording: a date somebody answered
  // draws a 409 with `confirmation_required` and the count, and the retry
  // carries ?confirm=true. The last-occurrence 422 stays on the formErrors
  // path and must never gain a confirmation affordance.
  async function removeOccurrence(occurrenceId: string, confirmed = false) {
    setRemoveErrors(null)
    setConfirmRemove(null)
    try {
      const response = await authFetch(
        `/occurrences/${occurrenceId}${confirmed ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      )
      if (!alive.current) return
      if (response.status === 204) {
        setReloadKey((key) => key + 1)
        // The menu draws the next date (CK-89.1).
        announceMenuChange()
        // The date goes with the re-read: to When's heading.
        focusInWhen(whenHeading)
        return
      }
      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as {
          detail?: { code?: string; rsvp_count?: number }
        } | null
        if (
          body?.detail?.code === 'confirmation_required' &&
          typeof body.detail.rsvp_count === 'number'
        ) {
          setConfirmRemove({ occurrenceId, rsvpCount: body.detail.rsvp_count })
          focusInWhen(removeStep)
          return
        }
      }
      setRemoveErrors({
        occurrenceId,
        errors: await errorsFromResponse(response, ['occurrence_id']),
      })
      focusInWhen(() => dateButtons.get(`remove:${occurrenceId}`))
    } catch {
      if (alive.current) {
        setRemoveErrors({ occurrenceId, errors: networkErrors() })
        focusInWhen(() => dateButtons.get(`remove:${occurrenceId}`))
      }
    }
  }

  return (
    <main className="auth-screen page-column gathering-page">
      {head(badge)}

      {alert}

      {/* THE ACTIONS (CK-87; the mockup's `.gactions`): Add photos for
          everyone who can upload — ONE press opens the device's picker
          (GatheringMedia's handle, called inside the click; the Photos
          section is open on load since CK-88) — and Edit gathering for the
          organisers, over
          today's form beneath this row. No Chat: the chat is not built. */}
      {(canUpload || organises) && (
        <div className="gathering-actions">
          {canUpload && (
            <button type="button" className="btn btn-primary" onClick={() => mediaRef.current?.pickPhotos()}>
              <Icon name="addpic" />
              Add photos
            </button>
          )}
          {organises && (
            <button
              ref={editGatheringButton}
              type="button"
              className="btn"
              aria-expanded={editingGathering}
              aria-controls={editFormId}
              onClick={() => (editingGathering ? setEditingGathering(false) : openGatheringEdit())}
            >
              Edit gathering
            </button>
          )}
        </div>
      )}

      {organises && editingGathering && (
        <form
          ref={editFormRef}
          id={editFormId}
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
          {/* Companion names disclose household composition — this
              setting is who gets to see them. Everyone always sees their own
              answer, whatever it says; an organiser — the reader of this
              form — always sees the full list. */}
          <p className="field-hint">
            Everyone can always see their own answer; you always see the full list.
          </p>
          <FieldError errors={gatheringErrors} field="rsvp_list_visibility" />

          {/* The host's switch (CK-44; consent-gate-defaults §5 and §10.3):
              rung 1 of the publication ladder, written by a person. THE
              HOST'S ALONE — reserved (co-hosts §4; CK-68): this form renders
              for a co-host too since CK-69, and the switch, its hint and the
              statement render for the host only; gatheringPatch never
              writes the key for anyone else, because the server refuses a
              co-host's whole body on it. Never disabled. Two states at the
              surface: on writes `true`, off writes an explicit `null`
              (inherit) and never `false` (see gatheringPatch). The
              statement below appears on the turning-off path alone; turning
              it on needs no justification and gets none. */}
          {isHost && (
            <>
              <label htmlFor="edit-review-photos">
                <input
                  id="edit-review-photos"
                  type="checkbox"
                  checked={gatheringForm.reviewPhotos}
                  aria-describedby={describedBy(gatheringErrors, 'requires_approval_override')}
                  onChange={(event) =>
                    setGatheringForm((form) => ({ ...form, reviewPhotos: event.target.checked }))
                  }
                />{' '}
                Review photos before they're published
              </label>
              <p className="field-hint">
                When this is on, each photo waits for you to publish or decline it before anyone
                else in this gathering can see it.
              </p>
              {turningReviewOff && <p className="field-hint">{REVIEW_OFF_STATEMENT}</p>}
              <FieldError errors={gatheringErrors} field="requires_approval_override" />
            </>
          )}

          <button ref={gatheringSave} type="submit" disabled={!gatheringDirty || gatheringSubmitting}>
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

      {stillASurprise.length > 0 && group !== null && (
        // The prompt (CK-80): one line per member still kept a surprise once
        // a date has started, the one tap beside it — PUT shared_with, and
        // the line goes. Nothing is sent to the member.
        <section ref={promptRef} className="auth-card" aria-label={PLACE_LABELS.left_out}>
          <ul className="occurrence-list">
            {stillASurprise.map((member) => (
              <li key={member.membership_id}>
                <p>{promptLine(member.display_name)}</p>
                <button
                  ref={promptButtons.register(member.membership_id)}
                  type="button"
                  disabled={placeActing !== null}
                  onClick={() => void changePlace(member, 'shared_with', 'prompt')}
                >
                  {promptAction(member.display_name)}
                </button>
                {placeRefusal?.where === 'prompt' &&
                  placeRefusal.membershipId === member.membership_id && (
                    <FormLevelErrors errors={{ fields: {}, form: [placeRefusal.message] }} />
                  )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section ref={whenRef} className="auth-card" aria-labelledby="occurrences-heading">
        {/* Focusable by script alone (tabIndex -1): where focus lands once a
            removed date has gone (CK-94). */}
        <h2 ref={whenHeading} id="occurrences-heading" tabIndex={-1}>
          When
        </h2>
        <p className="field-hint">Times in {zone}.</p>
        <ul className="occurrence-list occurrence-dates">
          {occurrences.map((occurrence) => (
            <li key={occurrence.id} className="occurrence-item">
              {organises && editingOccurrenceId === occurrence.id ? (
                <form ref={occurrenceFormRef} onSubmit={(event) => void saveOccurrence(event, occurrence)}>
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

                    <button ref={occurrenceSave} type="submit" disabled={!occurrenceDirty || occurrenceSubmitting}>
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
                  <p className="occurrence-when">
                    <strong>
                      {formatInstantRange(occurrence.starts_at, occurrence.ends_at, zone)}
                    </strong>
                  </p>
                  {/* The place and the map on one line (CK-87; the mockup's
                      `.where`): *{place} · Map*, the link alone with no
                      place, or the place alone with no map. A stored map
                      value that fails the scheme guard renders as plain text
                      — the person can see what is stored (a silently
                      vanished field is its own bug), but nothing navigates
                      to it (CK-21). */}
                  {(occurrence.location || occurrence.map_url) && (
                    <p className="occurrence-where">
                      {occurrence.location && <span>{occurrence.location}</span>}
                      {occurrence.location && occurrence.map_url && ' · '}
                      {occurrence.map_url &&
                        (safeHttpUrl(occurrence.map_url) ? (
                          <a href={occurrence.map_url} target="_blank" rel="noreferrer">
                            Map
                          </a>
                        ) : (
                          <span>{occurrence.map_url}</span>
                        ))}
                    </p>
                  )}
                  {/* The date's row (CK-87; the mockup's `.occ-row`): the
                      answer chip — the caller's own answer from the body's
                      `caller_response`, or *Not answered* in the dashed chip
                      — then RSVP and who's coming, then the organisers'
                      Edit this date and Remove this date. The chip is text in
                      the row, never the button's name. */}
                  <div className="occurrence-row">
                    <span className={occurrence.caller_response ? 'answer' : 'answer answer-none'}>
                      {occurrence.caller_response
                        ? rsvpResponseLabel(occurrence.caller_response)
                        : NOT_ANSWERED}
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={rsvpOpen.includes(occurrence.id)}
                      aria-controls={`rsvp-block-${occurrence.id}`}
                      onClick={() => toggleRsvp(occurrence.id)}
                    >
                      RSVP and who's coming
                    </button>
                    {organises && (
                      <>
                        <button
                          ref={dateButtons.register(`edit:${occurrence.id}`)}
                          type="button"
                          className="link-button"
                          onClick={() => openOccurrenceEdit(occurrence)}
                        >
                          Edit this date
                        </button>
                        <button
                          ref={dateButtons.register(`remove:${occurrence.id}`)}
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
                      </>
                    )}
                  </div>
                  {organises && (
                    <>
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
                      {confirmRemove?.occurrenceId === occurrence.id && (
                        // The step (CK-94): a group labelled by its sentence,
                        // where focus lands when it opens — never on its
                        // destructive button.
                        <div ref={removeStep} role="group" aria-labelledby={removeSentenceId} tabIndex={-1}>
                          {/* The human consequence, in people, not rows —
                              and removing it is a deliberate second click,
                              never a default (CK-30). */}
                          <p id={removeSentenceId} className="form-error" role="alert">
                            <span aria-hidden="true">⚠ </span>
                            {confirmRemove.rsvpCount === 1
                              ? '1 person has answered for this date. Removing it discards their answer.'
                              : `${confirmRemove.rsvpCount} people have answered for this date. Removing it discards their answers.`}
                          </p>
                          <button
                            type="button"
                            onClick={() => void removeOccurrence(occurrence.id, true)}
                          >
                            Remove it anyway
                          </button>{' '}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              setConfirmRemove(null)
                              focusInWhen(() => dateButtons.get(`remove:${occurrence.id}`))
                            }}
                          >
                            Don't remove it
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {rsvpOpen.includes(occurrence.id) && (
                    <OccurrenceRsvp
                      occurrenceId={occurrence.id}
                      zone={zone}
                      organises={organises}
                      blockId={`rsvp-block-${occurrence.id}`}
                      onAnswer={(response) => answerChanged(occurrence.id, response)}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        {organises && !addingOccurrence && (
          <button
            ref={addAnother}
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
        {organises && addingOccurrence && (
          <form ref={addFormRef} onSubmit={(event) => void addOccurrence(event)}>
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

              <button ref={addSubmit} type="submit" disabled={addForm.startsAt === '' || addSubmitting}>
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

      {/* Photos (CK-38): renders for everyone in the read audience — the
          list is filtered server-side by the per-state audience rule, so a
          keeper or invitee who uploaded nothing sees an empty list, never a
          photograph nobody has approved. Open on load since CK-88, with its
          heading, its count, the grid and the photo viewer — the section's
          own (GatheringMedia renders the heading this section is labelled
          by). isHost chooses the wording of who can see a
          pending photograph, and — with the gathering's effective
          requires_approval (CK-41), since CK-43.1, or with anything waiting
          in the list, since CK-44 — whether the host's review exists in the
          section at all; organises (CK-69) opens the delegable side — the
          takedown, the Removed view and Put back from it — to a co-host;
          the server decides who sees anything and who may act. The switch
          that writes the setting is in the edit form above. */}
      <section className="auth-card" aria-labelledby="photos-heading">
        <GatheringMedia
          ref={mediaRef}
          gatheringId={gathering.id}
          isHost={isHost}
          organises={organises}
          requiresApproval={gathering.requires_approval}
          occurrences={occurrences}
          canUpload={canUpload}
          cover={gathering.cover}
          group={shownGroup}
          gatheringTitle={gathering.title}
          onCoverSet={coverSet}
          zone={zone}
          arrivedAtPhotos={arrivedAtPhotos}
          groupLine={lineForGroup}
        />
      </section>

      {organises && group !== null && (
        // WHO IT'S FOR (CK-80; record §4), the organisers' on a group's
        // gathering: each member's place, changed with one tap — reversible,
        // and nobody is told. A co-host's row offers Invited alone (the
        // server refuses the other two, `is_co_host`); a member with no
        // place shows none checked until one is chosen. The names are what
        // every member reads on the group page; the places are the
        // organisers' alone. A radio group's name is its row's index, never
        // a membership id.
        <section ref={placesRef} className="auth-card" aria-labelledby="places-heading">
          {/* Focusable by script alone (tabIndex -1): where focus lands once
              the prompt's last line has gone (CK-94). */}
          <h2 ref={placesHeading} id="places-heading" tabIndex={-1}>
            {PLACES_HEADING}
          </h2>
          {placesLoad.status === 'loading' && <p>Loading…</p>}
          {placesLoad.status === 'failed' && (
            <>
              <p className="form-error" role="alert">
                <span aria-hidden="true">⚠ </span>
                Who it's for couldn't be loaded just now.
              </p>
              <button
                type="button"
                onClick={() => {
                  setPlacesLoad({ status: 'loading' })
                  setPlacesKey((key) => key + 1)
                }}
              >
                Try again
              </button>
            </>
          )}
          {places !== null && (
            <>
              <p className="field-hint">{PLACES_HINT}</p>
              <p className="field-hint">{newcomerLine(places.inviteesChosen, group.name)}</p>
              {places.members.length === 0 && (
                <p className="field-hint">{noOtherMembersLine(group.name)}</p>
              )}
              {places.members.map((member, index) => (
                <fieldset
                  key={member.membership_id}
                  ref={placeRows.register(member.membership_id)}
                  className="occurrence-fields"
                >
                  <legend>
                    <span className="member-initials" aria-hidden="true">
                      {initials(member.display_name)}
                    </span>{' '}
                    {member.display_name}
                    {member.co_host && (
                      <>
                        {' · '}
                        <span className="member-role">Co-host</span>
                      </>
                    )}
                  </legend>
                  {PLACES.map((place) => (
                    <label key={place}>
                      <input
                        type="radio"
                        name={`gathering-place-${index}`}
                        value={place}
                        checked={member.place === place}
                        disabled={placeActing !== null || (member.co_host && place !== 'invited')}
                        onChange={() => void changePlace(member, place, 'row')}
                      />{' '}
                      {PLACE_LABELS[place]}
                    </label>
                  ))}
                  {member.co_host && <p className="field-hint">{CO_HOST_ALWAYS_INVITED}</p>}
                  {member.place === null && (
                    <p className="field-hint">{noPlaceLine(member.display_name)}</p>
                  )}
                  {placeRefusal?.where === 'row' &&
                    placeRefusal.membershipId === member.membership_id && (
                      <>
                        <FormLevelErrors errors={{ fields: {}, form: [placeRefusal.message] }} />
                        <button type="button" className="link-button" onClick={refreshPlaces}>
                          Refresh the list
                        </button>
                      </>
                    )}
                </fieldset>
              ))}
            </>
          )}
        </section>
      )}

      {/* THE CARD (CK-93), after Who it's for: the switch for everyone the
          body says may change it; while on, for the gathering's organisers,
          the email form and *Waiting on* — the standalone section's, shared
          — beneath it. A group's admin who organises nothing gets the switch
          alone (the server refuses them the create and the roster). */}
      {outsideCard(
        outside.on && organises ? (
          <>
            <InviteForm
              destination={inviteDestination}
              onDestinationChange={setInviteDestination}
              errors={inviteErrors}
              submitting={inviteSubmitting}
              onSubmit={(event) => void sendInvitation(event)}
              fieldRef={inviteField}
              submitRef={inviteSubmit}
            />
            {invitationsFailed && (
              <p className="form-error" role="alert">
                <span aria-hidden="true">⚠ </span>
                The invitation list couldn't be loaded just now.
              </p>
            )}
            {invitations && (
              <WaitingOn
                pending={invitations.pending}
                zone={zone}
                onRevoke={(pendingId) => void revokeInvitation(pendingId)}
              />
            )}
          </>
        ) : null,
      )}

      {organises && (
        // The Invitations section (CK-25). On a GROUP's gathering it is the
        // co-host section alone (CK-80): every emailed invitation to a
        // group's gathering is the 409 `members_only` (CK-76) while its
        // outside invitations are off (CK-92) — its members get their place
        // on Who it's for — so no email form and no *Waiting on* is offered
        // here (the CK-18 lesson); while they are on, both are in the card
        // above (CK-93). What stays is CK-69's co-host management: the
        // co-host list, and the invited members — the materialized
        // invitation rows — with Make co-host.
        <section ref={coHostsRef} className="auth-card" aria-labelledby="invitations-heading">
          <h2 id="invitations-heading">{group !== null ? 'Co-hosts' : 'Invitations'}</h2>
          {!invitationsOpen ? (
            <button
              type="button"
              className="link-button"
              onClick={() => setInvitationsOpen(true)}
            >
              {group !== null ? 'Show co-hosts' : 'Invite people'}
            </button>
          ) : (
            <>
              {group === null && (
                <InviteForm
                  destination={inviteDestination}
                  onDestinationChange={setInviteDestination}
                  errors={inviteErrors}
                  submitting={inviteSubmitting}
                  onSubmit={(event) => void sendInvitation(event)}
                  fieldRef={inviteField}
                  submitRef={inviteSubmit}
                />
              )}

              {invitationsFailed && (
                <p className="form-error" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  {group !== null
                    ? "The list of who's invited couldn't be loaded just now."
                    : "The invitation list couldn't be loaded just now."}
                </p>
              )}
              {invitations && (
                <>
                  {group === null && (
                    <WaitingOn
                      pending={invitations.pending}
                      zone={zone}
                      onRevoke={(pendingId) => void revokeInvitation(pendingId)}
                    />
                  )}
                  {/* Co-hosts (CK-69; co-hosts §4): the list for every
                      organiser; the host alone makes and removes one, and
                      reads the hint that says what they are handing over;
                      a co-host reads the list and steps down from their
                      own row — nobody else's — and nowhere else on the
                      page is the list shown. On a group's gathering the
                      section's own heading says Co-hosts (CK-80). */}
                  {group === null && <h3>Co-hosts</h3>}
                  {isHost && <p className="field-hint">{CO_HOST_HINT}</p>}
                  {coHostsFailed && (
                    <p className="form-error" role="alert">
                      <span aria-hidden="true">⚠ </span>
                      The co-host list couldn't be loaded just now.
                    </p>
                  )}
                  {coHosts !== null &&
                    (coHosts.length === 0 ? (
                      <p className="field-hint">No co-hosts yet.</p>
                    ) : (
                      <ul className="occurrence-list" aria-label="Co-hosts">
                        {coHosts.map((row) => {
                          const name = coHostName(row.display_name)
                          // The host removes anyone; a co-host steps down from
                          // their OWN row only (the server hides the rest).
                          const mayUnmake = isHost || row.is_self
                          const steppingDown = !isHost && row.is_self
                          const confirming = mayUnmake && confirmUnmake === row.invitation_id
                          const acting = coHostActing === row.invitation_id
                          return (
                            <li key={row.invitation_id}>
                              {name}
                              {mayUnmake && !confirming && (
                                <>
                                  {' '}
                                  <button
                                    ref={coHostButtons.register(`unmake:${row.invitation_id}`)}
                                    type="button"
                                    className="link-button"
                                    disabled={coHostActing !== null}
                                    onClick={() => {
                                      setCoHostError(null)
                                      setConfirmUnmake(row.invitation_id)
                                      focusInCoHosts(coHostStep)
                                    }}
                                  >
                                    {steppingDown ? 'Step down' : 'Remove as co-host'}
                                  </button>
                                </>
                              )}
                              {confirming && (
                                // The second, deliberate step: the person
                                // loses their controls the moment it lands,
                                // so the first click only asks, and the
                                // do-nothing beside it does nothing. Since
                                // CK-94 a group labelled by its sentence,
                                // where focus lands when it opens.
                                <div
                                  ref={coHostStep}
                                  role="group"
                                  aria-labelledby={coHostSentenceId}
                                  tabIndex={-1}
                                >
                                  <p id={coHostSentenceId} className="field-hint">
                                    {steppingDown ? STEP_DOWN_SENTENCE : removeCoHostSentence(name)}
                                  </p>
                                  <button
                                    type="button"
                                    disabled={coHostActing !== null}
                                    onClick={() => void unmakeCoHost(row, steppingDown)}
                                  >
                                    {acting
                                      ? steppingDown
                                        ? 'Stepping down…'
                                        : 'Removing…'
                                      : steppingDown
                                        ? 'Step down'
                                        : 'Remove as co-host'}
                                  </button>{' '}
                                  <button
                                    type="button"
                                    className="link-button"
                                    disabled={coHostActing !== null}
                                    onClick={() => {
                                      setConfirmUnmake(null)
                                      focusInCoHosts(() => coHostButtons.get(`unmake:${row.invitation_id}`))
                                    }}
                                  >
                                    {steppingDown ? 'Stay a co-host' : 'Keep as co-host'}
                                  </button>
                                </div>
                              )}
                              {coHostError?.invitationId === row.invitation_id && (
                                <FormLevelErrors errors={coHostError.errors} />
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    ))}
                  {/* On a group's gathering the accepted rows are the
                      invited members' materialized invitations (CK-76), so
                      the list says Invited (CK-80). */}
                  <h3>{group !== null ? 'Invited' : 'Accepted'}</h3>
                  {invitations.accepted.length === 0 ? (
                    <p className="field-hint">
                      {group !== null ? 'No one else is invited yet.' : 'No one has accepted yet.'}
                    </p>
                  ) : (
                    <ul
                      className="occurrence-list"
                      aria-label={group !== null ? 'Invited' : 'Accepted'}
                    >
                      {invitations.accepted.map((accepted) => {
                        // An Accepted row that is a co-host says so instead
                        // of offering the act again; the act waits for the
                        // co-host list to be known, so no row is ever offered
                        // "Make co-host" while it might already be one.
                        const isCoHost =
                          coHosts !== null && coHosts.some((row) => row.invitation_id === accepted.id)
                        // Someone invited from outside the group (CK-93;
                        // Steven's answer 4) says so, and is offered no
                        // Make co-host: a group's gathering's co-host is a
                        // member (the server's `not_a_member`).
                        if (group !== null && accepted.from_outside === true) {
                          return (
                            <li key={accepted.id}>
                              {fromOutsideLabel(coHostName(accepted.display_name), group.name)}
                            </li>
                          )
                        }
                        return (
                          <li key={accepted.id}>
                            {accepted.display_name}
                            {isCoHost && ' — Co-host'}
                            {isHost && coHosts !== null && !isCoHost && (
                              <>
                                {' '}
                                <button
                                  ref={coHostButtons.register(`make:${accepted.id}`)}
                                  type="button"
                                  className="link-button"
                                  disabled={coHostActing !== null}
                                  onClick={() => void makeCoHost(accepted)}
                                >
                                  {coHostActing === accepted.id ? 'Making co-host…' : 'Make co-host'}
                                </button>
                              </>
                            )}
                            {coHostError?.invitationId === accepted.id && (
                              <FormLevelErrors errors={coHostError.errors} />
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </main>
  )
}
