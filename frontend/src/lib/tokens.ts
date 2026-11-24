// Design tokens — single source of truth, from PLAN P2 §4.3 ("dawn teal / ink").
// Verified against the delivered design system (~/workspace/payonce-build/
// design/tokens.css, 2026-11-24): every value below matches tokens.css.
// Do NOT invent a palette anywhere else.
// All pairs below are WCAG AA (4.5:1+) per the contrast table in P2 §4.3.

// Explorer bases — the live value comes from /api/config (config.explorer);
// these are the testnet fallbacks, identical to the ones HomePage/ReceiptPage
// use. Testnet only, never mainnet.
export const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/'
export const EXPLORER_INSTANCE = 'https://ccdexplorer.io/testnet/instance/'
export const EXPLORER_HOME = 'https://ccdexplorer.io/testnet'

export const TOKENS = {
  sky: {
    '0': '#0A2A33',
    '1': '#15505A',
    '2': '#1F6F6A',
    '3': '#A7DCD0',
    '4': '#F7EBDD',
  },
  cloud: { highlight: '#FFFFFF', shadow: '#B9D8D2', deep: '#7FA9A6', rim: '#F7D9C0' },
  paper: '#F4F7F6',
  paper2: '#E9F0EE',
  card: '#FFFFFF',
  line: '#D5E0DE',
  ink: '#0B1F24',
  body: '#3B4F55',
  muted: '#4F6268',
  teal600: '#0F766E',
  teal700: '#1F6F6A',
  amber: '#F2B872',
  verified: { text: '#14532D', bg: '#E7F5EC' },
  unpaid: { text: '#7A4A00', bg: '#FFF4E0' },
  refused: { text: '#8A1C12', bg: '#FDECEA', solid: '#B42318' },
} as const

// Text pairs that must pass WCAG AA 4.5:1 (checked by scripts/check-contrast.mjs).
export const CONTRAST_PAIRS: Array<{ name: string; fg: string; bg: string }> = [
  { name: 'white on teal-600', fg: '#FFFFFF', bg: '#0F766E' },
  { name: 'teal-600 on paper', fg: '#0F766E', bg: '#F4F7F6' },
  { name: 'ink on paper', fg: '#0B1F24', bg: '#F4F7F6' },
  { name: 'body on paper', fg: '#3B4F55', bg: '#F4F7F6' },
  { name: 'muted on paper', fg: '#4F6268', bg: '#F4F7F6' },
  { name: 'muted on card', fg: '#4F6268', bg: '#FFFFFF' },
  { name: 'white on sky-1', fg: '#FFFFFF', bg: '#15505A' },
  { name: 'white on sky-0', fg: '#FFFFFF', bg: '#0A2A33' },
  { name: 'white on sky-2', fg: '#FFFFFF', bg: '#1F6F6A' },
  { name: 'ink on sky-3', fg: '#0B1F24', bg: '#A7DCD0' },
  { name: 'ink on amber', fg: '#0B1F24', bg: '#F2B872' },
  { name: 'white on refused-solid', fg: '#FFFFFF', bg: '#B42318' },
  { name: 'ink on horizon', fg: '#0B1F24', bg: '#F7EBDD' },
  { name: 'paper on ink', fg: '#F4F7F6', bg: '#0B1F24' },
  { name: 'teal-700 on white', fg: '#1F6F6A', bg: '#FFFFFF' },
  { name: 'verified badge', fg: '#14532D', bg: '#E7F5EC' },
  { name: 'unpaid badge', fg: '#7A4A00', bg: '#FFF4E0' },
  { name: 'refused badge', fg: '#8A1C12', bg: '#FDECEA' },
]
