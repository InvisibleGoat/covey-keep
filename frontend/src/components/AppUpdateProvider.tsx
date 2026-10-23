import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { AppUpdateContext, type AppUpdateState } from './appUpdate'

// The browser only re-fetches sw.js on navigation, and an installed PWA in
// standalone mode can go days without one — so ask for a re-check every
// 60 minutes, and whenever the tab becomes visible again.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

// The ONE owner of service-worker registration (vite.config.ts sets
// injectRegister: null so this is the only registration) and of the update
// lifecycle (CK-8.1; lifted out of PwaUpdatePrompt at CK-75.1 so the
// catch-all screen can read the same state and ask for the same check —
// never a second registration). With registerType 'autoUpdate' the new
// worker activates and takes control on its own, but the page showing the
// new shell waits for the person: this provider only says an update is
// ready; the notice and the catch-all each offer the reload.
export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [updateReady, setUpdateReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // Mirrors for the check() closure below, which outlives renders.
  const updateReadyRef = useRef(false)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  useRegisterSW({
    // Without this callback, the register helper reloads the page itself the
    // moment a new worker activates. A reload that fires under someone
    // mid-sentence destroys unsaved form content — so no reload happens here,
    // only the state the notice and the catch-all read.
    onNeedReload() {
      updateReadyRef.current = true
      setUpdateReady(true)
      setDismissed(false)
    },
    onRegisteredSW(_swUrl, reg) {
      if (reg) {
        registrationRef.current = reg
        setRegistration(reg)
      }
    },
  })

  // Stable, so a screen may call it from a mount effect exactly once. Before
  // the registration arrives there is nothing to ask — and nothing lost: a
  // fresh load registers the worker, and registering is itself a check.
  const checkForUpdate = useCallback(() => {
    // A dismissed notice returns on the next check rather than never —
    // dismissal defers the update; it must not strand someone on an old
    // build indefinitely.
    if (updateReadyRef.current) setDismissed(false)
    if (!navigator.onLine) return
    // A failed check (flaky connection, captive portal) must never throw
    // into the app; the next check simply tries again.
    registrationRef.current?.update().catch(() => {})
  }, [])

  useEffect(() => {
    if (!registration) return
    const interval = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [registration, checkForUpdate])

  const dismiss = useCallback(() => setDismissed(true), [])

  const value = useMemo<AppUpdateState>(
    () => ({ updateReady, dismissed, dismiss, checkForUpdate }),
    [updateReady, dismissed, dismiss, checkForUpdate],
  )

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>
}
