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
    // The full suite runs 19+ files in parallel on 1.5 shared CPUs; the
    // two heaviest routing tests take 5.1–5.7 s EVEN UNLOADED, at/above
    // the 5 s vitest default — 3 red of 4 full runs across the landing
    // judges, all pure timeouts, no assertion ever failed. 15 s is
    // headroom for the loaded VM, not for a slow app.
    testTimeout: 15_000,
  },
})
