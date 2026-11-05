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
    // A limit for a test that hangs, not for one that is slow. Under the suite's
    // own load the slowest tests read 4.7 s against the default of 5, and a test
    // past its limit is abandoned, not stopped: it goes on running beside the next
    // tests in its file, on the same document and the same React, and an `act` it
    // left open can fail every one of them.
    testTimeout: 30_000,
    setupFiles: ['./src/test-support/testingLibrary.ts'],
    // Vitest blanks every CSS import unless told otherwise — a `?raw` read
    // included, which made a stylesheet pin read an empty string and pass.
    // The raw reads alone get the file's text (styles/look.test.tsx, CK-81);
    // a stylesheet a component imports stays blank, as it always has.
    css: { include: [/\.css\?raw$/] },
  },
})
