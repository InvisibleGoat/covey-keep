import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { effectiveZone } from '../lib/datetime'
import { listItemLine, viewOf, type GatheringListItem } from '../lib/gatherings'

type LoadStatus = 'loading' | 'loaded' | 'failed'

export function Gatherings() {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [gatherings, setGatherings] = useState<GatheringListItem[]>([])
  // Bumped by Try again: the ordinary read over again, through the loading
  // state (the CK-74.1 idiom).
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      // ONE request: since CK-20 each list item carries next_occurrence (the
      // backend's next-or-most-recent rule) — the CK-17 per-gathering detail
      // fetches and their per-row degrade are gone with the N+1 they existed
      // to work around.
      try {
        const response = await authFetch('/gatherings')
        if (!response.ok) {
          if (!cancelled) setStatus('failed')
          return
        }
        const body = (await response.json()) as { gatherings: GatheringListItem[] }
        if (cancelled) return
        setGatherings(body.gatherings)
        setStatus('loaded')
      } catch {
        if (!cancelled) setStatus('failed')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading your gatherings…</p>
      </main>
    )
  }

  if (status === 'failed') {
    // A retry is a control, never a sentence with nothing to press (CK-80;
    // CK-74.1's idiom): Try again re-reads through the loading state.
    return (
      <main className="auth-screen">
        <h1>Your gatherings</h1>
        <p className="form-error" role="alert">
          Something went wrong loading your gatherings.
        </p>
        <button
          type="button"
          onClick={() => {
            setStatus('loading')
            setReloadKey((key) => key + 1)
          }}
        >
          Try again
        </button>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  // The empty state is a real screen — it is what every new account sees.
  // It says what the list holds — what you host, co-host, are invited to or
  // can see the photos of — and never "keep": since CK-77 keeping lets no
  // one in, so a gathering you keep and are none of those is not here.
  if (gatherings.length === 0) {
    return (
      <main className="auth-screen">
        <h1>No gatherings yet</h1>
        <p>Gatherings you start or are invited to will be listed here.</p>
        <Link to="/gatherings/new">Create your first gathering</Link>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  // The hint names the zone only when a date is on screen: the photos-only
  // view carries none (CK-80).
  const anyDate = gatherings.some(
    (gathering) => viewOf(gathering.caller_view).full && gathering.next_occurrence !== null,
  )

  return (
    <main className="auth-screen">
      <h1>Your gatherings</h1>
      {anyDate && <p className="field-hint">Times in {zone}.</p>}
      <ul className="gathering-list">
        {gatherings.map((gathering) => (
          <li key={gathering.id}>
            <Link className="gathering-item" to={`/gatherings/${gathering.id}`}>
              <strong>{gathering.title}</strong>
              {/* The type, then the date — or "You can see its photos" in
                  the photos-only view, where no date was sent — then the
                  group's name on a group's gathering (CK-80). */}
              <p>{listItemLine(gathering, zone, true)}</p>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/gatherings/new">New gathering</Link>
      <Link to="/home">Back home</Link>
    </main>
  )
}
