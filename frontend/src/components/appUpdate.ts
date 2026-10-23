import { createContext } from 'react'

// The app's update state (CK-75.1): what the one service-worker owner knows
// about a newer version, read by the update notice and by the catch-all
// screen. Owned by AppUpdateProvider; read through useAppUpdate.
export interface AppUpdateState {
  // A newer worker has activated and taken control of the page (CK-8.1's
  // autoUpdate lifecycle — onNeedReload fired), so a plain reload loads the
  // newer bundle. The page swap still waits for the person.
  updateReady: boolean
  // The person put the notice off with "Not now". Dismissal defers rather
  // than ends: the next update check clears it (see AppUpdateProvider).
  dismissed: boolean
  dismiss: () => void
  // Ask the worker to check for a newer version now — online only, a failed
  // check swallowed. The same check the hourly and on-visible timers run.
  checkForUpdate: () => void
}

export const AppUpdateContext = createContext<AppUpdateState | null>(null)
