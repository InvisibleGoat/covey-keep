import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the PWA plugin has no business
// running under tests, and the brand-title plugin is exercised by the build
// itself (a missed placeholder would ship a literal %PRODUCT_NAME% title).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
  },
})
