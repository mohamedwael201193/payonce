import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev only: /api is proxied to the dev stub server (scripts/dev-api-stub.mjs,
// port 7401) when it is running. Production serves /api from the real backend
// on the same origin. The stub serves REAL recorded testnet data, labelled
// "Recorded run, 24 Nov 2026" — it is never part of the production build.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7401',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
})
