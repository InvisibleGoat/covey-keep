import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { effectiveZone, formatInstant } from '../lib/datetime'
import { gatheringTypeLabel, type GatheringListItem } from '../lib/gatherings'

type LoadStatus = 'loading' | 'loaded' | 'failed'

export function Gatherings() {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [gatherings, setGatherings] = useState<GatheringListItem[]>([])

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
  }, [])

  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading your gatherings…</p>
      </main>
    )
  }

  if (status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Your gatherings</h1>
        <p className="form-error">Something went wrong loading your gatherings. Try again.</p>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  // The empty state is a real screen — it is what every new account sees.
  if (gatherings.length === 0) {
    return (
      <main className="auth-screen">
        <h1>No gatherings yet</h1>
        <p>The gatherings you keep will live here — every one you create or choose to hold on to.</p>
        <Link to="/gatherings/new">Create your first gathering</Link>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  return (
    <main className="auth-screen">
      <h1>Your gatherings</h1>
      <p className="field-hint">Times in {zone}.</p>
      <ul className="gathering-list">
        {gatherings.map((gathering) => (
          <li key={gathering.id}>
            <Link className="gathering-item" to={`/gatherings/${gathering.id}`}>
              <strong>{gathering.title}</strong>
              <p>
                {gatheringTypeLabel(gathering.gathering_type)}
                {gathering.next_occurrence &&
                  ` · ${formatInstant(gathering.next_occurrence.starts_at, zone)}`}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/gatherings/new">New gathering</Link>
      <Link to="/home">Back home</Link>
    </main>
  )
}
