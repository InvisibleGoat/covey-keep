import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { authFetch } from '../lib/api'
import { effectiveZone, formatInstantRange } from '../lib/datetime'
import { gatheringTypeLabel, type GatheringWithOccurrences } from '../lib/gatherings'

type DetailState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'failed' }
  | { status: 'loaded'; gathering: GatheringWithOccurrences }

// Read-only detail (CK-17). Editing — the gathering PATCH, occurrence
// add/patch/delete — is CK-18. Nothing here surfaces requires_approval,
// keeper counts, or admin state: those are later phases' surfaces.
export function GatheringDetail() {
  const { id } = useParams()
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [state, setState] = useState<DetailState>({ status: 'loading' })

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
  }, [id])

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
  return (
    <main className="auth-screen">
      <h1>{gathering.title}</h1>
      <p>{gatheringTypeLabel(gathering.gathering_type)}</p>
      {gathering.memorial_decedent_name && (
        <p>In memory of {gathering.memorial_decedent_name}</p>
      )}

      <section className="auth-card" aria-labelledby="occurrences-heading">
        <h2 id="occurrences-heading">When</h2>
        <p className="field-hint">Times in {zone}.</p>
        <ul className="occurrence-list">
          {gathering.occurrences.map((occurrence) => (
            <li key={occurrence.id} className="occurrence-item">
              <p>
                <strong>{formatInstantRange(occurrence.starts_at, occurrence.ends_at, zone)}</strong>
              </p>
              {occurrence.location && <p>{occurrence.location}</p>}
              {occurrence.map_url && (
                <p>
                  <a href={occurrence.map_url} target="_blank" rel="noreferrer">
                    Map
                  </a>
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <Link to="/gatherings">Back to your gatherings</Link>
    </main>
  )
}
