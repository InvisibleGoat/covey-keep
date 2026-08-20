import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Replace the app shell on deploy — the default strategy kept serving a
      // stale bundle across deploys (bit during CK-4 verification).
      registerType: 'autoUpdate',
      // Registration is owned by src/components/PwaUpdatePrompt.tsx (CK-8.1);
      // letting the plugin also inject its register script would register the
      // worker twice. This must be `null`, NOT the `false` the type docs call
      // equivalent: the plugin decides whether to bake skipWaiting/clientsClaim
      // into the worker via `injectRegister == null`, so `false` silently
      // builds a prompt-shaped worker that waits forever under autoUpdate.
      injectRegister: null,
      manifest: {
        name: 'Covey Keep',
        short_name: 'Covey Keep',
        display: 'standalone',
      },
    }),
  ],
})
