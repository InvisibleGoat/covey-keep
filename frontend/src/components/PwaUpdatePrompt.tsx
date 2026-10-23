import { useAppUpdate } from './useAppUpdate'

// The update notice (CK-8.1). Since CK-75.1 a READER of AppUpdateProvider,
// which owns the registration, the update checks and the ready state — this
// component registers nothing. The behaviour is CK-8.1's unchanged: nothing
// until a new worker has activated, then a persistent, non-blocking notice
// with Reload and Not now; a dismissed notice returns on the next check.
export function PwaUpdatePrompt() {
  const { updateReady, dismissed, dismiss } = useAppUpdate()

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
      <button type="button" onClick={dismiss}>
        Not now
      </button>
    </div>
  )
}
