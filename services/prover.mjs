// Scoped prover sidecar (Concordium TESTNET). A tiny local HTTP service that holds ONLY prover-C3.private.json:
// the dob and nationality openings of one account credential. It holds no seed, no signing key, no other attributes,
// and it does not read .env or lab/core. It answers only the statement shapes on the allow-list below and refuses the rest.
//
// Endpoints (bound to 127.0.0.1):
//   GET  /health         -> service info, attributes held (names only), allow-list summary
//   POST /policy-check   -> body { request: <VerificationRequestV1 JSON> }; decision only, no chain call, no proof
//   POST /presentation   -> body { request: <anchored VerificationRequestV1 JSON> }; policy, then anchor check, then proof
import { createServer } from 'http';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(DIR, 'prover-C3.private.json');
const PORT = Number(process.env.PROVER_PORT || 8788);
const HOST = '127.0.0.1';
const NETWORK = 'Testnet';
const EU = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
const AGE_LOWER = '18000101';
const AGE_YEARS = [18, 21];
const MAX_BODY = 64 * 1024;
const PROVABLE = ['dob', 'nationality', 'countryOfResidence'];

// Load the sidecar once. Keep only what the SDK needs; anything else in the file is ignored.
const raw = JSON.parse(readFileSync(SIDECAR, 'utf8'));
const HELD = {
  network: raw.network,
  issuer: raw.issuer,
  credId: raw.credId,
  values: Object.fromEntries(Object.entries(raw.values).filter(([k]) => PROVABLE.includes(k))),
  randomness: Object.fromEntries(Object.entries(raw.randomness).filter(([k]) => PROVABLE.includes(k))),
};
const HELD_TAGS = Object.keys(HELD.values);
const SECRET_STRINGS = [...Object.values(HELD.values), ...Object.values(HELD.randomness)];
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

// ---- helpers (never print secret values) ----
function pastDate(yearsAgo, daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return `${d.getFullYear() - yearsAgo}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const yyyymmddToUtc = s => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
const daysBetween = (a, b) => (yyyymmddToUtc(b) - yyyymmddToUtc(a)) / 86400000;
const allowedAgeUppers = () => AGE_YEARS.flatMap(n => [pastDate(n, 0), pastDate(n, 1)]);
const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function sanitize(msg) {
  let s = String(msg ?? '');
  for (const x of SECRET_STRINGS) if (typeof x === 'string' && x.length >= 6) s = s.split(x).join('[REDACTED]');
  return s.replace(/[0-9a-fA-F]{64,}/g, '[REDACTED-HEX]').replace(/(?:\b[a-z]{2,12}\b[\s,;:]+){11,}\b[a-z]{2,12}\b/gi, '[REDACTED-WORDS]').slice(0, 200);
}

// ---- allow-list ----
// Pure function of the request JSON and the held tags. Returns { allowed, rule, reason }.
export function decide(req) {
  const deny = (rule, reason) => ({ allowed: false, rule, reason });
  if (!req || typeof req !== 'object') return deny('MALFORMED', 'request is not an object');
  if (!Array.isArray(req.subjectClaims) || req.subjectClaims.length !== 1) return deny('ONE_SUBJECT', 'exactly one subject claim is allowed');
  const sc = req.subjectClaims[0];
  if (!sc || sc.type !== 'identity') return deny('SUBJECT_TYPE', 'only identity-type subject claims are routed here');
  if (!Array.isArray(sc.source) || sc.source.length !== 1 || sc.source[0] !== 'accountCredential') return deny('SOURCE', 'only the account credential may be proven');
  const issuers = (sc.issuers || []).map(i => (typeof i === 'string' ? i : JSON.stringify(i)).toLowerCase());
  if (issuers.length !== 1 || issuers[0] !== `did:ccd:${NETWORK.toLowerCase()}:idp:${HELD.issuer}`) return deny('ISSUER', 'only the held identity provider may be used');
  const st = sc.statements;
  if (!Array.isArray(st) || st.length < 1 || st.length > 2) return deny('STATEMENT_COUNT', 'between 1 and 2 statements');
  const tags = new Set();
  for (const s of st) {
    if (!s || typeof s !== 'object') return deny('MALFORMED', 'statement is not an object');
    if (s.type === 'RevealAttribute' || s.type === 'AttributeValue') return deny('REVEAL_REFUSED', `reveal of ${s.attributeTag} is refused by policy`);
    if (!PROVABLE.includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_ALLOWED', `attribute ${s.attributeTag} is outside {dob, nationality, countryOfResidence}`);
    if (!HELD_TAGS.includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_HELD', `this prover holds no opening for ${s.attributeTag}`);
    if (tags.has(s.attributeTag)) return deny('DUPLICATE', `attribute ${s.attributeTag} appears twice`);
    tags.add(s.attributeTag);
    if (s.attributeTag === 'dob') {
      if (s.type !== 'AttributeInRange') return deny('STATEMENT_TYPE', 'dob may only be proven as an age range');
      if (typeof s.lower !== 'string' || typeof s.upper !== 'string' || !/^\d{8}$/.test(s.lower) || !/^\d{8}$/.test(s.upper)) return deny('MALFORMED', 'dob bounds must be YYYYMMDD');
      if (daysBetween(s.lower, s.upper) < 365) return deny('RANGE_TOO_NARROW', 'dob range narrower than 1 year is refused');
      if (s.lower !== AGE_LOWER) return deny('RANGE_NOT_ALLOWED', `dob lower bound must be ${AGE_LOWER}`);
      if (!allowedAgeUppers().includes(s.upper)) return deny('RANGE_NOT_ALLOWED', 'dob upper bound must be today minus 18 or 21 years');
    } else {
      if (s.type !== 'AttributeInSet') return deny('STATEMENT_TYPE', `${s.attributeTag} may only be proven as membership`);
      if (!Array.isArray(s.set) || !sortedEq(s.set, EU)) return deny('SET_NOT_ALLOWED', 'membership set must be exactly the EU set');
    }
  }
  return { allowed: true, rule: 'ALLOWED', reason: 'statement shapes match the allow-list' };
}

// ---- proof path (only reached after decide() allows the request) ----
async function makePresentation(reqJson) {
  const { VerificationRequestV1, VerifiablePresentationV1, CredentialRegistrationId } = sdk;
  const request = VerificationRequestV1.fromJSON(reqJson);
  const sc = request.subjectClaims[0];
  const statements = VerifiablePresentationV1.noRevealRequestedStatements(sc.statements);
  const claims = [VerifiablePresentationV1.createAccountClaims(NETWORK, CredentialRegistrationId.fromHexString(HELD.credId), HELD.issuer, statements)];
  const inputs = [{ type: 'account', issuer: HELD.issuer, values: HELD.values, randomness: HELD.randomness }];
  const pres = await VerifiablePresentationV1.createFromAnchor(client, request, claims, inputs, []);
  return pres.toJSON();
}

// ---- HTTP ----
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, {
        service: 'scoped-prover', network: NETWORK, credId: HELD.credId, attributesHeld: HELD_TAGS,
        // The issuer DID is public (it names the identity provider on
        // chain); the API health passes it through so the /verify-age page
        // can build demo requests without hardcoding an IdP.
        issuerDid: `did:ccd:${NETWORK.toLowerCase()}:idp:${HELD.issuer}`,
        allowList: [
          `dob AttributeInRange lower=${AGE_LOWER} upper=today-18y or today-21y (+0 or +1 day)`,
          'nationality AttributeInSet, set exactly the EU 27',
          'countryOfResidence AttributeInSet, set exactly the EU 27 (only if held)',
        ],
        refuses: ['RevealAttribute / AttributeValue', 'attributes outside {dob, nationality, countryOfResidence}', 'attributes not held', 'dob ranges narrower than 1 year or with other bounds', 'non-EU sets', 'non-account sources', 'other identity providers'],
      });
    }
    if (req.method === 'POST' && req.url === '/policy-check') {
      const body = await readBody(req);
      const d = decide(body.request);
      return send(res, d.allowed ? 200 : 403, d);
    }
    if (req.method === 'POST' && req.url === '/presentation') {
      const body = await readBody(req);
      const d = decide(body.request);
      if (!d.allowed) return send(res, 403, { refused: true, ...d });
      try {
        const presentation = await makePresentation(body.request);
        return send(res, 200, { presentation });
      } catch (e) {
        return send(res, 422, { refused: false, error: { name: String(e?.name ?? typeof e), message: sanitize(e?.message) } });
      }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    return send(res, 400, { error: 'BAD_REQUEST', message: sanitize(e?.message) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(JSON.stringify({ listening: `http://${HOST}:${PORT}`, attributesHeld: HELD_TAGS })));
}
