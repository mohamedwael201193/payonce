// Embeddable "payee check" badge. The SVG is also served by GET /api/badge/:account.svg (api/src/badge-svg.mjs).
// Match is the only green. Close match, No match and Not possible are never painted as a pass.
import type { Verdict } from './contracts'

export const BADGE_API = 'https://payonce-api-n98a.onrender.com'
export const BADGE_PAGE = 'https://payonce-tau.vercel.app'

export const BADGE_WORD: Record<Verdict | 'NOT_BOUND' | 'PROVEN' | 'UNPROVEN', string> = {
  MATCH: 'Match',
  CLOSE_MATCH: 'Close match',
  NO_MATCH: 'No match',
  UNVERIFIED: 'Not possible',
  NOT_BOUND: 'Not bound',
  PROVEN: 'Name proven',
  UNPROVEN: 'Unverified payee',
}

const COLOR: Record<string, { fg: string; bg: string; ink: string }> = {
  MATCH: { fg: '#0e7a4c', bg: '#e8f6ee', ink: '#0e7a4c' },
  CLOSE_MATCH: { fg: '#9a5b00', bg: '#fff4e0', ink: '#9a5b00' },
  NO_MATCH: { fg: '#b42318', bg: '#fdecea', ink: '#b42318' },
  UNVERIFIED: { fg: '#5b6472', bg: '#eef0f3', ink: '#3d4450' },
  NOT_BOUND: { fg: '#9a5b00', bg: '#fff4e0', ink: '#9a5b00' },
  PROVEN: { fg: '#0e1219', bg: '#eef0f3', ink: '#0e1219' },
  UNPROVEN: { fg: '#5b6472', bg: '#eef0f3', ink: '#3d4450' },
}

export type BadgeKind = keyof typeof BADGE_WORD

/** Never returns MATCH green unless kind === 'MATCH'. */
export function badgeColors(kind: BadgeKind) {
  return COLOR[kind] ?? COLOR.UNVERIFIED
}

export function badgeKind(input: { verdict?: Verdict | null; payable?: boolean; verified?: boolean; named?: boolean }): BadgeKind {
  if (input.verdict === 'MATCH' && input.payable) return 'MATCH'
  if (input.verdict === 'MATCH') return 'NOT_BOUND'
  if (input.verdict) return input.verdict
  if (input.named && input.verified) return 'PROVEN'
  return 'UNPROVEN'
}

export function badgeSvg(kind: BadgeKind, { width }: { width?: number } = {}): string {
  const word = BADGE_WORD[kind]
  const c = badgeColors(kind)
  const w = width ?? Math.max(196, 86 + word.length * 8 + 24)
  const statements: Record<string, string> = {
    MATCH: 'The receiving account belongs to the name on the invoice.',
    CLOSE_MATCH: 'The name on the invoice is close to the verified name, not the same.',
    NO_MATCH: 'The receiving account does not belong to the name on the invoice.',
    UNVERIFIED: 'The receiving account could not be verified as belonging to the name on the invoice.',
    NOT_BOUND: 'The name matches, but this account is not a payee yet.',
    PROVEN: 'This account has proven a name.',
    UNPROVEN: 'This account has not proven a name.',
  };
  const label = `PayOnce: ${word}. ${statements[kind] ?? statements.UNVERIFIED} Testnet.`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="28" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  <rect width="${w}" height="28" rx="6" fill="${c.bg}"/>
  <path d="M0 6a6 6 0 0 1 6-6h70v28H6a6 6 0 0 1-6-6z" fill="#0e1219"/>
  <text x="10" y="19" fill="#fff" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="650">PayOnce</text>
  <text x="86" y="19" fill="${c.ink}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="650">${esc(word)}</text>
</svg>`
}

export function badgeSrc(account: string, name?: string): string {
  const q = name?.trim() ? `?name=${encodeURIComponent(name.trim())}` : ''
  return `${BADGE_API}/api/badge/${account}.svg${q}`
}

export function badgeMarkdown(account: string, name?: string): string {
  return `[![PayOnce payee check](${badgeSrc(account, name)})](${BADGE_PAGE}/p/${account})`
}

export function badgeHtml(account: string, name?: string): string {
  const word = name?.trim() ? 'PayOnce payee check' : 'PayOnce payee'
  return `<a href="${BADGE_PAGE}/p/${account}"><img src="${badgeSrc(account, name)}" alt="${word}" /></a>`
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}
