// App colour tokens (mirror of the --po-* variables in app.css) and the text
// pairs that must pass WCAG AA 4.5:1. Checked by tokens.test.ts and by
// scripts/check-contrast.mjs. Orange (#E8541A) is only ever a fill: text on
// it is ink, and orange-coloured text uses the darker accent-ink.
//
// v10 palette: a cool grey ground (#F1F3F8) under pure white cards with a 1px
// hairline and a soft cool shadow, a deep ink sidebar, and four status colours
// (paid green, refused red, pending amber, info blue) that each carry a tint,
// a text colour and a border colour. app.css is the single source of the
// values; tokens.test.ts fails if this file and app.css disagree.
export const PO_TOKENS = {
  paper: '#F1F3F8',
  surface: '#FFFFFF',
  sunken: '#EEF1F7',
  rail: '#0E1219',
  ink: '#0E1219',
  grey: '#475066',
  line: '#D9DEE8',
  lineStrong: '#7C869B',
  accent: '#E8541A',
  accentInk: '#B03A08',
  ok: '#0B6B3A',
  okBg: '#DDF3E5',
  okLine: '#9BD4B0',
  bad: '#B42318',
  badBg: '#FDE7E4',
  badLine: '#F2A9A1',
  badDeep: '#6E1A12',
  warn: '#8A4A00',
  warnBg: '#FEF0CC',
  warnLine: '#EDC96B',
  info: '#1E4F94',
  infoBg: '#E4EEFC',
  infoLine: '#A9C6EE',
  navFg: '#BAC2D2',
  navHover: '#1B2130',
  navLine: '#2A3243',
  skelA: '#E3E7EF',
  skelB: '#F1F3F8',
  white: '#FFFFFF',
} as const

export const PO_CONTRAST_PAIRS: Array<{ name: string; fg: string; bg: string }> = [
  { name: 'po ink on paper', fg: '#0E1219', bg: '#F1F3F8' },
  { name: 'po grey on paper', fg: '#475066', bg: '#F1F3F8' },
  { name: 'po grey on surface', fg: '#475066', bg: '#FFFFFF' },
  { name: 'po grey on sunken', fg: '#475066', bg: '#EEF1F7' },
  { name: 'po ink on surface', fg: '#0E1219', bg: '#FFFFFF' },
  { name: 'po ink on sunken (address tile)', fg: '#0E1219', bg: '#EEF1F7' },
  { name: 'po ink on accent', fg: '#0E1219', bg: '#E8541A' },
  { name: 'po ink on accent fill (ink hover)', fg: '#0E1219', bg: '#E8541A' },
  { name: 'po accent-ink on paper', fg: '#B03A08', bg: '#F1F3F8' },
  { name: 'po accent-ink on surface', fg: '#B03A08', bg: '#FFFFFF' },
  { name: 'po accent-ink on sunken', fg: '#B03A08', bg: '#EEF1F7' },
  { name: 'po paper on ink', fg: '#F1F3F8', bg: '#0E1219' },
  { name: 'po paper on ink fill (secondary hover)', fg: '#F1F3F8', bg: '#0E1219' },
  { name: 'po white on ink (code block)', fg: '#FFFFFF', bg: '#0E1219' },
  // status: paid / refused / pending / info, as chip (text on tint), on a card and on the ground
  { name: 'po ok (paid) on ok-bg', fg: '#0B6B3A', bg: '#DDF3E5' },
  { name: 'po ok (paid) on surface', fg: '#0B6B3A', bg: '#FFFFFF' },
  { name: 'po ok (paid) on sunken', fg: '#0B6B3A', bg: '#EEF1F7' },
  { name: 'po ok (paid) on paper', fg: '#0B6B3A', bg: '#F1F3F8' },
  { name: 'po bad (refused) on bad-bg', fg: '#B42318', bg: '#FDE7E4' },
  { name: 'po bad (refused) on surface', fg: '#B42318', bg: '#FFFFFF' },
  { name: 'po bad (refused) on paper', fg: '#B42318', bg: '#F1F3F8' },
  { name: 'po bad (refused) on warn-bg', fg: '#B42318', bg: '#FEF0CC' },
  { name: 'po warn (pending) on warn-bg', fg: '#8A4A00', bg: '#FEF0CC' },
  { name: 'po warn (pending) on surface', fg: '#8A4A00', bg: '#FFFFFF' },
  { name: 'po info on info-bg', fg: '#1E4F94', bg: '#E4EEFC' },
  { name: 'po info on surface', fg: '#1E4F94', bg: '#FFFFFF' },
  { name: 'po white on danger', fg: '#FFFFFF', bg: '#B42318' },
  { name: 'po white on danger fill', fg: '#FFFFFF', bg: '#6E1A12' },
  // dark sidebar
  { name: 'po nav text on rail', fg: '#BAC2D2', bg: '#0E1219' },
  { name: 'po nav text on nav hover', fg: '#BAC2D2', bg: '#1B2130' },
  { name: 'po white on rail', fg: '#FFFFFF', bg: '#0E1219' },
  { name: 'po white on nav hover', fg: '#FFFFFF', bg: '#1B2130' },
]

// Non-text contrast (WCAG 1.4.11, >= 3:1): the input border and focus ring.
export const PO_NON_TEXT_PAIRS: Array<{ name: string; fg: string; bg: string }> = [
  { name: 'po input border on surface', fg: '#7C869B', bg: '#FFFFFF' },
  { name: 'po accent focus ring on surface', fg: '#E8541A', bg: '#FFFFFF' },
]
