// Scoped prover service (Concordium TESTNET), hosted as its OWN web service, separate from the PayOnce API.
// It holds ONLY the dob and nationality openings of one account credential, read from the environment variable
// PROVER_OPENINGS_JSON (a Render env var; never in git, never logged). It holds no seed, no signing key and no other
// attribute. It answers only the statement shapes on the allow-list in policy.mjs and refuses the rest with 403.
//
// Every route except GET /healthz needs `Authorization: Bearer <PAYONCE_PROVER_TOKEN>`. Requests are rate-limited.
//   GET  /healthz        -> { ok: true } (no auth, no data; for the platform health check)
//   GET  /health         -> service info, attributes held (names only), allow-list summary
//   POST /policy-check   -> body { request }; decision only, no chain call, no proof
//   POST /presentation   -> body { request: <anchored VerificationRequestV1 JSON> }; policy, then proof
import { createServer } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import { decide, EU, AGE_LOWER, PROVABLE } from './policy.mjs';

const MAX_BODY = 64 * 1024;

/** Parse + minimise the openings env var. Throws a generic error (never echoes the value). */
export function loadOpenings(json) {
  let raw;
  try { raw = JSON.parse(json); } catch { throw new Error('PROVER_OPENINGS_JSON is missing or not valid JSON'); }
  if (!raw || typeof raw !== 'object' || !raw.credId || !raw.values || !raw.randomness || raw.issuer === undefined) {
    throw new Error('PROVER_OPENINGS_JSON lacks network, issuer, credId, values, randomness');
  }
  const pick = o => Object.fromEntries(Object.entries(o).filter(([k]) => PROVABLE.includes(k)));
  return { network: raw.network ?? 'Testnet', issuer: raw.issuer, credId: raw.credId, values: pick(raw.values), randomness: pick(raw.randomness) };
}

function sanitizer(held) {
  const secrets = [...Object.values(held.values), ...Object.values(held.randomness)];
  return msg => {
    let s = String(msg ?? '');
    for (const x of secrets) if (typeof x === 'string' && x.length >= 6) s = s.split(x).join('[REDACTED]');
    return s.replace(/[0-9a-fA-F]{64,}/g, '[REDACTED-HEX]').replace(/(?:\b[a-z]{2,12}\b[\s,;:]+){11,}\b[a-z]{2,12}\b/gi, '[REDACTED-WORDS]').slice(0, 200);
  };
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
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

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Sliding-window limiter. */
function limiter(max, windowMs, now) {
  const hits = [];
  return () => {
    const t = now();
    while (hits.length && hits[0] <= t - windowMs) hits.shift();
    if (hits.length >= max) return Math.ceil((hits[0] + windowMs - t) / 1000);
    hits.push(t);
    return 0;
  };
}

/**
 * @param o.held          result of loadOpenings
 * @param o.token         the bearer secret
 * @param o.makePresentation async (requestJson) => presentation JSON (only called after the policy allows)
 * @param o.now           () => ms (tests)
 */
export function createProverServer({ held, token, makePresentation, now = Date.now, limits = {} }) {
  if (!token || token.length < 24) throw new Error('PAYONCE_PROVER_TOKEN must be set (at least 24 characters)');
  const heldInfo = { network: held.network, issuer: held.issuer, tags: Object.keys(held.values) };
  const sanitize = sanitizer(held);
  const anyLimit = limiter(limits.any ?? 60, 60_000, now);
  const proofLimit = limiter(limits.proof ?? 10, 60_000, now);
  const badAuthLimit = limiter(limits.badAuth ?? 20, 60_000, now);

  return createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true });
      if (!tokenOk(req.headers.authorization, token)) {
        const wait = badAuthLimit();
        if (wait) { res.setHeader('retry-after', String(wait)); return send(res, 429, { error: 'RATE_LIMITED' }); }
        return send(res, 401, { error: 'UNAUTHORIZED' });
      }
      const wait = anyLimit();
      if (wait) { res.setHeader('retry-after', String(wait)); return send(res, 429, { error: 'RATE_LIMITED' }); }

      if (req.method === 'GET' && url === '/health') {
        return send(res, 200, {
          service: 'scoped-prover', network: held.network, attributesHeld: heldInfo.tags,
          issuerDid: `did:ccd:${String(held.network).toLowerCase()}:idp:${held.issuer}`,
          allowList: [
            `dob AttributeInRange lower=${AGE_LOWER} upper=today-18y or today-21y (+0 or +1 day)`,
            `nationality AttributeInSet, set exactly the EU ${EU.length}`,
            'countryOfResidence AttributeInSet, set exactly the EU 27 (only if held)',
          ],
          refuses: ['RevealAttribute / AttributeValue', 'attributes outside {dob, nationality, countryOfResidence}', 'attributes not held', 'dob ranges narrower than 1 year or with other bounds', 'non-EU sets', 'non-account sources', 'other identity providers'],
        });
      }
      if (req.method === 'POST' && url === '/policy-check') {
        const body = await readBody(req);
        const d = decide(body.request, heldInfo, new Date(now()));
        return send(res, d.allowed ? 200 : 403, d);
      }
      if (req.method === 'POST' && url === '/presentation') {
        const body = await readBody(req);
        const d = decide(body.request, heldInfo, new Date(now()));
        if (!d.allowed) return send(res, 403, { refused: true, ...d });
        const w = proofLimit();
        if (w) { res.setHeader('retry-after', String(w)); return send(res, 429, { error: 'RATE_LIMITED' }); }
        try {
          return send(res, 200, { presentation: await makePresentation(body.request) });
        } catch (e) {
          return send(res, 422, { refused: false, error: { name: String(e?.name ?? typeof e), message: sanitize(e?.message) } });
        }
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      return send(res, 400, { error: 'BAD_REQUEST', message: sanitize(e?.message) });
    }
  });
}
