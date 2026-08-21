import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

// The browser only re-fetches sw.js on navigation, and an installed PWA in
// standalone mode can go days without one — so ask for a re-check every
// 60 minutes, and whenever the tab becomes visible again.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

// Owns service-worker registration (vite.config.ts sets injectRegister: null
// so this is the only registration) and the update lifecycle: with
// registerType 'autoUpdate' the new worker activates and takes control on its
// own, but the page showing the new shell waits for the person to choose.
export function PwaUpdatePrompt() {
  const [updateReady, setUpdateReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // Mirror of updateReady for the check() closure below, which outlives renders.
  const updateReadyRef = useRef(false)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  useRegisterSW({
    // Without this callback, the register helper reloads the page itself the
    // moment a new worker activates. A reload that fires under someone
    // mid-sentence destroys unsaved form content — so no reload happens here,
    // only the notice.
    onNeedReload() {
      updateReadyRef.current = true
      setUpdateReady(true)
      setDismissed(false)
    },
    onRegisteredSW(_swUrl, reg) {
      if (reg) setRegistration(reg)
    },
  })

  useEffect(() => {
    if (!registration) return
    const check = () => {
      // A dismissed notice returns on the next check rather than never —
      // dismissal defers the update; it must not strand someone on an old
      // build indefinitely.
      if (updateReadyRef.current) setDismissed(false)
      if (!navigator.onLine) return
      // A failed check (flaky connection, captive portal) must never throw
      // into the app; the next check simply tries again.
      registration.update().catch(() => {})
    }
    const interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [registration])

  if (!updateReady || dismissed) return null

  return (
    <div className="update-notice" role="status">
      <p>A new version is ready.</p>
      {/* The new worker already controls the page (autoUpdate), so picking up
          the new shell is a plain reload — updateServiceWorker() is a no-op
          in this mode. */}
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button type="button" onClick={() => setDismissed(true)}>
        Not now
      </button>
    </div>
  )
}
