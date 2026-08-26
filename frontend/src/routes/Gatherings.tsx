import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { effectiveZone, formatInstant } from '../lib/datetime'
import {
  gatheringTypeLabel,
  nextOrMostRecent,
  type Gathering,
  type GatheringWithOccurrences,
} from '../lib/gatherings'

type LoadStatus = 'loading' | 'loaded' | 'failed'

export function Gatherings() {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [gatherings, setGatherings] = useState<Gathering[]>([])
  // gathering id → the occurrence date its list entry leads with. Filled by
  // per-gathering detail fetches: GET /gatherings carries no occurrence data
  // (reported to the backend backlog as a CK-17 finding) — for the handful of
  // gatherings an account keeps, parallel detail reads carry the list.
  const [leadDates, setLeadDates] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch('/gatherings')
        if (!response.ok) {
          if (!cancelled) setStatus('failed')
          return
        }
        const body = (await response.json()) as { gatherings: Gathering[] }
        if (cancelled) return
        setGatherings(body.gatherings)
        setStatus('loaded')

        const dates: Record<string, string> = {}
        await Promise.all(
          body.gatherings.map(async (gathering) => {
            try {
              const detail = await authFetch(`/gatherings/${gathering.id}`)
              if (!detail.ok) return
              const withOccurrences = (await detail.json()) as GatheringWithOccurrences
              const lead = nextOrMostRecent(withOccurrences.occurrences, new Date())
              if (lead) dates[gathering.id] = lead.starts_at
            } catch {
              // A missing date on one row is not a failed list.
            }
          }),
        )
        if (!cancelled) setLeadDates(dates)
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
                {leadDates[gathering.id] && ` · ${formatInstant(leadDates[gathering.id], zone)}`}
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
