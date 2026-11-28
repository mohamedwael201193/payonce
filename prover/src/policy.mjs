// Allow-list for the scoped prover. Pure functions: no I/O, no secrets.
// Only age >= 18/21 range proofs (width >= 1 year) and nationality /
// countryOfResidence membership in the EU 27 are allowed. Everything else is refused.
export const EU = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
export const AGE_LOWER = '18000101';
export const AGE_YEARS = [18, 21];
export const PROVABLE = ['dob', 'nationality', 'countryOfResidence'];

export function pastDate(yearsAgo, daysOffset, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + daysOffset);
  return `${d.getFullYear() - yearsAgo}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const yyyymmddToUtc = s => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
const daysBetween = (a, b) => (yyyymmddToUtc(b) - yyyymmddToUtc(a)) / 86400000;
export const allowedAgeUppers = (now) => AGE_YEARS.flatMap(n => [pastDate(n, 0, now), pastDate(n, 1, now)]);
const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * @param req   VerificationRequestV1 JSON
 * @param held  { network, issuer, tags: string[] }  (tags = attributes this prover holds openings for)
 */
export function decide(req, held, now = new Date()) {
  const deny = (rule, reason) => ({ allowed: false, rule, reason });
  if (!req || typeof req !== 'object') return deny('MALFORMED', 'request is not an object');
  if (!Array.isArray(req.subjectClaims) || req.subjectClaims.length !== 1) return deny('ONE_SUBJECT', 'exactly one subject claim is allowed');
  const sc = req.subjectClaims[0];
  if (!sc || sc.type !== 'identity') return deny('SUBJECT_TYPE', 'only identity-type subject claims are routed here');
  if (!Array.isArray(sc.source) || sc.source.length !== 1 || sc.source[0] !== 'accountCredential') return deny('SOURCE', 'only the account credential may be proven');
  const issuers = (sc.issuers || []).map(i => (typeof i === 'string' ? i : JSON.stringify(i)).toLowerCase());
  if (issuers.length !== 1 || issuers[0] !== `did:ccd:${String(held.network).toLowerCase()}:idp:${held.issuer}`) return deny('ISSUER', 'only the held identity provider may be used');
  const st = sc.statements;
  if (!Array.isArray(st) || st.length < 1 || st.length > 2) return deny('STATEMENT_COUNT', 'between 1 and 2 statements');
  const tags = new Set();
  for (const s of st) {
    if (!s || typeof s !== 'object') return deny('MALFORMED', 'statement is not an object');
    if (s.type === 'RevealAttribute' || s.type === 'AttributeValue') return deny('REVEAL_REFUSED', `reveal of ${s.attributeTag} is refused by policy`);
    if (!PROVABLE.includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_ALLOWED', `attribute ${s.attributeTag} is outside {dob, nationality, countryOfResidence}`);
    if (!held.tags.includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_HELD', `this prover holds no opening for ${s.attributeTag}`);
    if (tags.has(s.attributeTag)) return deny('DUPLICATE', `attribute ${s.attributeTag} appears twice`);
    tags.add(s.attributeTag);
    if (s.attributeTag === 'dob') {
      if (s.type !== 'AttributeInRange') return deny('STATEMENT_TYPE', 'dob may only be proven as an age range');
      if (typeof s.lower !== 'string' || typeof s.upper !== 'string' || !/^\d{8}$/.test(s.lower) || !/^\d{8}$/.test(s.upper)) return deny('MALFORMED', 'dob bounds must be YYYYMMDD');
      if (daysBetween(s.lower, s.upper) < 365) return deny('RANGE_TOO_NARROW', 'dob range narrower than 1 year is refused');
      if (s.lower !== AGE_LOWER) return deny('RANGE_NOT_ALLOWED', `dob lower bound must be ${AGE_LOWER}`);
      if (!allowedAgeUppers(now).includes(s.upper)) return deny('RANGE_NOT_ALLOWED', 'dob upper bound must be today minus 18 or 21 years');
    } else {
      if (s.type !== 'AttributeInSet') return deny('STATEMENT_TYPE', `${s.attributeTag} may only be proven as membership`);
      if (!Array.isArray(s.set) || !sortedEq(s.set, EU)) return deny('SET_NOT_ALLOWED', 'membership set must be exactly the EU set');
    }
  }
  return { allowed: true, rule: 'ALLOWED', reason: 'statement shapes match the allow-list' };
}
