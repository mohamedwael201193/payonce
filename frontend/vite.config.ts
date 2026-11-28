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
  build: {
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: they change only when a dependency changes, so a
        // redeploy of our own code does not make returning visitors fetch React again.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return 'vendor-react'
          if (id.includes('@tanstack')) return 'vendor-query'
          if (/framer-motion|motion-dom|motion-utils/.test(id)) return 'vendor-motion'
          if (id.includes('lucide-react')) return 'vendor-icons'
          return undefined
        },
      },
    },
  },
})
