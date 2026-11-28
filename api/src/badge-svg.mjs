// Pure SVG for GET /api/badge/:account.svg. Match is the only green.
// Keep in lockstep with frontend/src/dash/badge.ts (words, colours, size).
export const BADGE_WORD = {
  MATCH: 'Match',
  CLOSE_MATCH: 'Close match',
  NO_MATCH: 'No match',
  UNVERIFIED: 'Not possible',
  NOT_BOUND: 'Not bound',
  PROVEN: 'Name proven',
  UNPROVEN: 'Unverified payee',
};
const COLOR = {
  MATCH: { bg: '#e8f6ee', ink: '#0e7a4c' },
  CLOSE_MATCH: { bg: '#fff4e0', ink: '#9a5b00' },
  NO_MATCH: { bg: '#fdecea', ink: '#b42318' },
  UNVERIFIED: { bg: '#eef0f3', ink: '#3d4450' },
  NOT_BOUND: { bg: '#fff4e0', ink: '#9a5b00' },
  PROVEN: { bg: '#eef0f3', ink: '#0e1219' },
  UNPROVEN: { bg: '#eef0f3', ink: '#3d4450' },
};

export function badgeKind({ verdict, payable, verified, named }) {
  // Green Match only when the book has a Bound, matured payee and the name matches.
  if (verdict === 'MATCH' && payable) return 'MATCH';
  if (verdict === 'MATCH') return 'NOT_BOUND';
  if (verdict) return verdict;
  if (named && verified) return 'PROVEN';
  return 'UNPROVEN';
}

export function badgeSvg(kind) {
  const word = BADGE_WORD[kind] ?? BADGE_WORD.UNVERIFIED;
  const c = COLOR[kind] ?? COLOR.UNVERIFIED;
  const w = Math.max(196, 86 + word.length * 8 + 24);
  const statements = {
    MATCH: 'The receiving account belongs to the name on the invoice.',
    CLOSE_MATCH: 'The name on the invoice is close to the verified name, not the same.',
    NO_MATCH: 'The receiving account does not belong to the name on the invoice.',
    UNVERIFIED: 'The receiving account could not be verified as belonging to the name on the invoice.',
    NOT_BOUND: 'The name matches, but this account is not a payee yet.',
    PROVEN: 'This account has proven a name.',
    UNPROVEN: 'This account has not proven a name.',
  };
  const label = `PayOnce: ${word}. ${statements[kind] ?? statements.UNVERIFIED} Testnet.`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="28" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  <rect width="${w}" height="28" rx="6" fill="${c.bg}"/>
  <path d="M0 6a6 6 0 0 1 6-6h70v28H6a6 6 0 0 1-6-6z" fill="#0e1219"/>
  <text x="10" y="19" fill="#fff" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="650">PayOnce</text>
  <text x="86" y="19" fill="${c.ink}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="650">${esc(word)}</text>
</svg>`;
}
