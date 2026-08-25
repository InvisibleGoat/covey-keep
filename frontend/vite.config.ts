import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
// The .ts extension is required here: this file type-checks under
// tsconfig.node.json's nodenext resolution (allowImportingTsExtensions).
import { PRODUCT_NAME } from './src/brand.ts'

// index.html cannot import TypeScript, so the build injects the brand name
// into its %PRODUCT_NAME% placeholder. `order: 'pre'` runs before Vite's own
// env replacement, which would otherwise warn about (and leave behind) a
// placeholder it cannot resolve.
function brandTitle(): Plugin {
  return {
    name: 'brand-title',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME),
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    brandTitle(),
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
        name: PRODUCT_NAME,
        short_name: PRODUCT_NAME,
        display: 'standalone',
      },
    }),
  ],
})
