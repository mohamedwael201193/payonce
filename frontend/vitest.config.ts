// Vitest config — kept separate from vite.config.ts so `tsc -b` (which
// type-checks vite.config.ts) never sees vitest's `test` field, and the
// dual-vite type conflict from `vitest/config` never surfaces in the build.
// Vitest picks this file up automatically; `vite build` ignores it.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
