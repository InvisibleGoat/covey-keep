// The inert `virtual:pwa-register/react` the test suite resolves to
// (vitest.config.ts aliases the virtual id here; CK-75.1).
//
// The PWA plugin is deliberately not loaded under tests, so the virtual module
// has no provider there, and Vite's import analysis refuses an import it
// cannot resolve before any vi.mock() can intercept it. This hook registers
// nothing, reports no update and touches no worker; a test that needs to drive
// the update lifecycle mocks the virtual id with vi.mock(), which lands on this
// same resolved path. Never imported by application code — the app's one
// registration is components/AppUpdateProvider.tsx.
import type { Dispatch, SetStateAction } from 'react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

export function useRegisterSW(_options?: RegisterSWOptions): {
  needRefresh: [boolean, Dispatch<SetStateAction<boolean>>]
  offlineReady: [boolean, Dispatch<SetStateAction<boolean>>]
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>
} {
  return {
    needRefresh: [false, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: async () => {},
  }
}
