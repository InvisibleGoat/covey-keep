import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

// The history entry the photo viewer adds (CK-88; Steven's answer 4): its state
// is this and nothing else — no id, no photo, nothing about who is looking.
const PHOTO_VIEWER_STATE = { photoViewer: true } as const

function isViewerState(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { photoViewer?: unknown }).photoViewer === true
}

// THE ONE HISTORY ENTRY AN OPEN VIEWER ADDS (CK-88; one copy since CK-88.1b, for
// a gathering's grid and a group page's sections). `push` adds it for the same
// path and search; `pop` takes it back, so every close but Back leaves the
// history where it began; and `onBack` is what to do when the person leaves it
// by Back themselves — the caller closes the viewer and pops nothing. The entry
// is pending until the navigation lands, then recognised by its own key, so an
// older entry that also carries the marker (a reload) is never mistaken for it,
// and a reload on the marker opens nothing. A close asked for before it landed
// pops it on arrival.
export function useViewerEntry(onBack: () => void): { push: () => void; pop: () => void } {
  const navigate = useNavigate()
  const location = useLocation()
  const historyEntry = useRef<{ phase: 'pending' | 'pushed'; from: string; key: string | null; cancelled: boolean } | null>(
    null,
  )

  const latestOnBack = useRef(onBack)
  useLayoutEffect(() => {
    latestOnBack.current = onBack
  })

  useEffect(() => {
    const entry = historyEntry.current
    if (entry === null) return
    if (entry.phase === 'pending') {
      if (location.key === entry.from || !isViewerState(location.state)) return
      if (entry.cancelled) {
        historyEntry.current = null
        navigate(-1)
        return
      }
      entry.phase = 'pushed'
      entry.key = location.key
      return
    }
    if (location.key !== entry.key) {
      historyEntry.current = null
      latestOnBack.current()
    }
  }, [location.key, location.state, navigate])

  function push() {
    historyEntry.current = { phase: 'pending', from: location.key, key: null, cancelled: false }
    navigate({ pathname: location.pathname, search: location.search }, { state: PHOTO_VIEWER_STATE })
  }

  function pop() {
    const entry = historyEntry.current
    if (entry === null) return
    if (entry.phase === 'pushed') {
      historyEntry.current = null
      navigate(-1)
    } else {
      entry.cancelled = true
    }
  }

  return { push, pop }
}
