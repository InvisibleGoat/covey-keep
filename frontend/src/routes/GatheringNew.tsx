// The gathering form (CK-17) — one form, two doors (CK-80):
// - `/gatherings/new` renders it with no group: a standalone gathering, and
//   no group choice anywhere (Steven, 2026-10-27).
// - `/groups/:id/gatherings/new` renders it through GroupGatheringNew, which
//   reads the group and its members and passes them as `inGroup`: the body
//   carries `group_id`, and WHO IT'S FOR lists every member but the caller
//   (`is_self` — the creator becomes the host and has no place), each with
//   one of three choices, everyone starting Invited. The two lists in the
//   body come from lib/places.ts::placesBody and nowhere else — every member
//   Invited sends NEITHER list, the whole-group create, so a member who
//   joins later is invited too.
// The type, the title, the decedent name and the dates are the same fields
// either way, mapped through the one 422 mapper.
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { authFetch } from '../lib/api'
import { effectiveZone, wallClockToInstant } from '../lib/datetime'
import {
  describedBy,
  errorsFromResponse,
  networkErrors,
  noErrors,
  type FormErrors,
} from '../lib/formErrors'
import { GATHERING_TYPES, type Gathering } from '../lib/gatherings'
import { initials, type Group, type GroupMember } from '../lib/groups'
import {
  createRefusalMessage,
  listRefusals,
  newcomerLine,
  noOtherMembersLine,
  PLACE_LABELS,
  PLACES,
  PLACES_HEADING,
  PLACES_HINT,
  placesBody,
  type Place,
} from '../lib/places'

// The group a gathering is being made in, as GroupGatheringNew read it.
export interface InGroup {
  group: Group
  members: GroupMember[]
}

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

export function GatheringNew({ inGroup }: { inGroup?: InGroup } = {}) {
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

  // Who it's for (CK-80): every member but the caller, in joining order,
  // each starting Invited. The choices are keyed by membership id — the
  // handle the body carries, and nothing that is ever rendered.
  const others = inGroup ? inGroup.members.filter((member) => !member.is_self) : []
  const [choices, setChoices] = useState<Record<string, Place>>(() =>
    Object.fromEntries(others.map((member) => [member.membership_id, 'invited' as Place])),
  )
  // A list refusal, landed on the member's row it names (membership id →
  // the line from its code).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const choiceMap = new Map<string, Place>(
    others.map((member) => [member.membership_id, choices[member.membership_id] ?? 'invited']),
  )
  const everyoneInvited = [...choiceMap.values()].every((place) => place === 'invited')

  function choose(membershipId: string, place: Place) {
    setChoices((current) => ({ ...current, [membershipId]: place }))
  }

  function chooseEveryone(place: Place) {
    setChoices(Object.fromEntries(others.map((member) => [member.membership_id, place])))
  }

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
    setRowErrors({})

    // The two lists, from placesBody alone: every member Invited sends
    // neither (the whole-group create); otherwise `invited` and, when anyone
    // is kept a surprise, `left_out` — the server shares it with the rest.
    const lists = inGroup ? placesBody(choiceMap) : {}
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
      ...(inGroup ? { group_id: inGroup.group.id, ...lists } : {}),
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
      // An item-level 422 on a list names an entry by its index in the list
      // AS SENT; map it back to the member and say why from its code.
      const refusals =
        inGroup && response.status === 422
          ? listRefusals(await response.clone().json().catch(() => null))
          : []
      const onRows: Record<string, string> = {}
      // The entries that landed on a row are visible to the mapper too, so
      // it never repeats them form-level; one that names no row on screen
      // stays form-level — never swallowed.
      const landed: string[] = []
      for (const refusal of refusals) {
        const membershipId = lists[refusal.list]?.[refusal.index]
        const member = others.find((candidate) => candidate.membership_id === membershipId)
        if (!member) continue
        landed.push(`${refusal.list}.${refusal.index}`)
        if (!(member.membership_id in onRows)) {
          onRows[member.membership_id] = createRefusalMessage(refusal.code, member.display_name)
        }
      }
      setRowErrors(onRows)
      setErrors(await errorsFromResponse(response, [...visibleFields, ...landed]))
    } catch {
      setErrors(networkErrors())
    }
    setSubmitting(false)
  }

  return (
    <main className="auth-screen">
      <h1>{inGroup ? `New gathering in ${inGroup.group.name}` : 'New gathering'}</h1>

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

        {inGroup && (
          // WHO IT'S FOR (CK-80; record §4): one choice of three per member,
          // a radio group whose legend is the member's name, everyone
          // starting Invited; the two bulk buttons cover the common cases —
          // the record's "invite only these; share with everyone else" is
          // Let everyone see the photos, then the few marked Invited. A
          // radio group's name is its row's index, never a membership id.
          <section aria-labelledby="places-heading">
            <h2 id="places-heading">{PLACES_HEADING}</h2>
            {others.length === 0 ? (
              <p className="field-hint">{noOtherMembersLine(inGroup.group.name)}</p>
            ) : (
              <>
                <p className="field-hint">{PLACES_HINT}</p>
                <div className="member-actions">
                  <button type="button" className="link-button" onClick={() => chooseEveryone('invited')}>
                    Invite everyone
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => chooseEveryone('shared_with')}
                  >
                    Let everyone see the photos
                  </button>
                </div>
                {others.map((member, index) => {
                  const chosen = choices[member.membership_id] ?? 'invited'
                  return (
                    <fieldset key={member.membership_id} className="occurrence-fields">
                      <legend>
                        <span className="member-initials" aria-hidden="true">
                          {initials(member.display_name)}
                        </span>{' '}
                        {member.display_name}
                      </legend>
                      {PLACES.map((place) => (
                        <label key={place}>
                          <input
                            type="radio"
                            name={`place-${index}`}
                            value={place}
                            checked={chosen === place}
                            onChange={() => choose(member.membership_id, place)}
                          />{' '}
                          {PLACE_LABELS[place]}
                        </label>
                      ))}
                      {rowErrors[member.membership_id] && (
                        <FormLevelErrors
                          errors={{ fields: {}, form: [rowErrors[member.membership_id]] }}
                        />
                      )}
                    </fieldset>
                  )
                })}
              </>
            )}
            {/* What happens to someone who joins the group while this is
                still ahead — read from the current choice: everyone Invited
                sends neither list, and the gathering stays the whole
                group's (record §9). */}
            <p className="field-hint">{newcomerLine(!everyoneInvited, inGroup.group.name)}</p>
          </section>
        )}

        <button type="submit" disabled={!plausible || submitting}>
          {submitting ? 'Creating…' : 'Create gathering'}
        </button>
        {Object.keys(rowErrors).length > 0 && (
          <p className="field-hint">Nothing was created.</p>
        )}
        <FormLevelErrors errors={errors} />
      </form>

      {inGroup ? (
        <Link to={`/groups/${inGroup.group.id}`}>Back to {inGroup.group.name}</Link>
      ) : (
        <Link to="/gatherings">Back to your gatherings</Link>
      )}
    </main>
  )
}
