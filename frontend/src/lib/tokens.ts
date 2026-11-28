// Design tokens — single source of truth.
// v10 (28 Nov): paper, line, ink, body and muted are the /app cool neutrals
// (src/app/tokens.css); the beige cream is gone. The sky stays the hero accent.
// Sunset palette, matched to the Altura reference video (frame-by-frame
// analysis ~/workspace/payonce-build/design-fix/VIDEO_ANALYSIS.md,
// 2026-11-24): vivid orange sunset sky, cream paper, near-black ink.
// Replaces the P2 §4.3 "dawn teal / ink" palette.
// Do NOT invent a palette anywhere else.
// All pairs below are WCAG AA (4.5:1+) per the contrast check
// (scripts/check-contrast.mjs + tokens.test.ts).

// Explorer bases — the live value comes from /api/config (config.explorer);
// these are the testnet fallbacks, identical to the ones HomePage/ReceiptPage
// use. Testnet only, never mainnet.
export const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/'
export const EXPLORER_INSTANCE = 'https://ccdexplorer.io/testnet/instance/'
export const EXPLORER_HOME = 'https://ccdexplorer.io/testnet'

export const TOKENS = {
  sky: {
    '0': '#7C2D12',
    '1': '#9A3412',
    '2': '#C2410C',
    '3': '#FDBA74',
    '4': '#FFF7ED',
  },
  cloud: { highlight: '#FFFFFF', shadow: '#FED7AA', deep: '#FDBA74', rim: '#FFF7ED' },
  paper: '#F1F3F8',
  paper2: '#E6EAF2',
  card: '#FFFFFF',
  line: '#D9DEE8',
  ink: '#0E1219',
  body: '#2F3747',
  muted: '#475066',
  brand600: '#B4430F',
  brand700: '#9A3412',
  amber: '#F2B872',
  verified: { text: '#14532D', bg: '#E7F5EC' },
  unpaid: { text: '#7A4A00', bg: '#FFF4E0' },
  refused: { text: '#8A1C12', bg: '#FDECEA', solid: '#B42318' },
} as const

// Text pairs that must pass WCAG AA 4.5:1 (checked by scripts/check-contrast.mjs).
// Ratios verified with the same luminance math on 2026-11-24 (lowest 5.18:1).
export const CONTRAST_PAIRS: Array<{ name: string; fg: string; bg: string }> = [
  { name: 'white on brand-600', fg: '#FFFFFF', bg: '#B4430F' },
  { name: 'white on brand-700', fg: '#FFFFFF', bg: '#9A3412' },
  { name: 'brand-600 on paper', fg: '#B4430F', bg: '#F1F3F8' },
  { name: 'brand-700 on white', fg: '#9A3412', bg: '#FFFFFF' },
  { name: 'ink on paper', fg: '#0E1219', bg: '#F1F3F8' },
  { name: 'body on paper', fg: '#2F3747', bg: '#F1F3F8' },
  { name: 'muted on paper', fg: '#475066', bg: '#F1F3F8' },
  { name: 'muted on card', fg: '#475066', bg: '#FFFFFF' },
  { name: 'white on sky-1', fg: '#FFFFFF', bg: '#9A3412' },
  { name: 'white on sky-0', fg: '#FFFFFF', bg: '#7C2D12' },
  { name: 'white on sky-2', fg: '#FFFFFF', bg: '#C2410C' },
  { name: 'ink on sky-3', fg: '#0E1219', bg: '#FDBA74' },
  { name: 'ink on amber', fg: '#0E1219', bg: '#F2B872' },
  { name: 'white on refused-solid', fg: '#FFFFFF', bg: '#B42318' },
  { name: 'ink on horizon', fg: '#0E1219', bg: '#FFF7ED' },
  { name: 'paper on ink', fg: '#F1F3F8', bg: '#0E1219' },
  { name: 'white on ink', fg: '#FFFFFF', bg: '#0E1219' },
  { name: 'verified badge', fg: '#14532D', bg: '#E7F5EC' },
  { name: 'unpaid badge', fg: '#7A4A00', bg: '#FFF4E0' },
  { name: 'refused badge', fg: '#8A1C12', bg: '#FDECEA' },
]
