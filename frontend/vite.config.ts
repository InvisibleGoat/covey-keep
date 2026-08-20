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
      manifest: {
        name: 'Covey Keep',
        short_name: 'Covey Keep',
        display: 'standalone',
      },
    }),
  ],
})
