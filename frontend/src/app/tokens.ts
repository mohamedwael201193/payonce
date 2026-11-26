// App colour tokens (mirror of the --po-* variables in app.css) and the text
// pairs that must pass WCAG AA 4.5:1. Checked by tokens.test.ts and by
// scripts/check-contrast.mjs. Orange (#E8541A) is only ever a fill: text on
// it is ink, and orange-coloured text uses the darker accent-ink.
export const PO_TOKENS = {
  paper: '#EFEDE4',
  surface: '#F8F6EF',
  sunken: '#E6E3D6',
  ink: '#181914',
  grey: '#5C594F',
  line: '#D4D0C0',
  accent: '#E8541A',
  accentInk: '#A8380A',
  ok: '#1D5A36',
  okBg: '#DBEADB',
  bad: '#98291A',
  badBg: '#F3D9D1',
  warn: '#6C4800',
  warnBg: '#F0E2BB',
} as const

export const PO_CONTRAST_PAIRS: Array<{ name: string; fg: string; bg: string }> = [
  { name: 'po ink on paper', fg: '#181914', bg: '#EFEDE4' },
  { name: 'po grey on paper', fg: '#5C594F', bg: '#EFEDE4' },
  { name: 'po grey on surface', fg: '#5C594F', bg: '#F8F6EF' },
  { name: 'po grey on sunken', fg: '#5C594F', bg: '#E6E3D6' },
  { name: 'po ink on accent', fg: '#181914', bg: '#E8541A' },
  { name: 'po ink on accent hover', fg: '#181914', bg: '#F06A32' },
  { name: 'po accent-ink on paper', fg: '#A8380A', bg: '#EFEDE4' },
  { name: 'po accent-ink on surface', fg: '#A8380A', bg: '#F8F6EF' },
  { name: 'po paper on ink', fg: '#EFEDE4', bg: '#181914' },
  { name: 'po ok on ok-bg', fg: '#1D5A36', bg: '#DBEADB' },
  { name: 'po bad on bad-bg', fg: '#98291A', bg: '#F3D9D1' },
  { name: 'po warn on warn-bg', fg: '#6C4800', bg: '#F0E2BB' },
  { name: 'po ok on surface', fg: '#1D5A36', bg: '#F8F6EF' },
  { name: 'po bad on surface', fg: '#98291A', bg: '#F8F6EF' },
]
