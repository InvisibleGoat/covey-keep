import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the PWA plugin has no business
// running under tests, and the brand-title plugin is exercised by the build
// itself (a missed placeholder would ship a literal %PRODUCT_NAME% title).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The PWA plugin's virtual module has no provider under tests, and Vite's
      // import analysis refuses an unresolvable import before vi.mock() can
      // intercept it — so the id resolves to an inert stub, and a test that
      // drives the update lifecycle mocks that same id (CK-75.1).
      'virtual:pwa-register/react': fileURLToPath(
        new URL('./src/test-support/pwaRegister.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
  },
})
