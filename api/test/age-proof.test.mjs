// PayOnce API — age-proof tests (G8). No chain, no sends, no real prover:
// the mock prover below re-implements the REAL prover policy
// (services/prover.mjs `decide()`) exactly — same rules, same 403 rule
// codes — parameterized with a test issuer (idp:0) and the same held tags
// (dob, nationality). The real sidecar file (prover-C3.private.json) is
// NOT in this workspace, so the live-prover leg stays BLOCKED-on-provision;
// these tests prove the proxy, the gate, and the 403/400 shapes.
//
// Run: node --test test/age-proof.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createAgeProofHandlers, isAgeGated, ageGateCheck,
  recordVerifiedAgeProof, findFreshAgeProof, clearAgeProofs,
  extractPresentationHolder,
  AGE_PROOF_FRESH_MS, VERIFIER_URL,
} from '../src/age-proof.mjs';

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const TEST_ISSUER = 'did:ccd:testnet:idp:0';
const AGE_LOWER = '18000101';

function pastDate(yearsAgo, daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return `${d.getFullYear() - yearsAgo}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const yyyymmddToUtc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
const daysBetween = (a, b) => (yyyymmddToUtc(b) - yyyymmddToUtc(a)) / 86400000;
const allowedAgeUppers = () => [18, 21].flatMap((n) => [pastDate(n, 0), pastDate(n, 1)]);
const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ---- faithful copy of the real prover's decide() (services/prover.mjs) ----
// Held tags in the lab: dob + nationality. Issuer: the test idp:0.
function mockDecide(req) {
  const deny = (rule, reason) => ({ allowed: false, rule, reason });
  if (!req || typeof req !== 'object') return deny('MALFORMED', 'request is not an object');
  if (!Array.isArray(req.subjectClaims) || req.subjectClaims.length !== 1) return deny('ONE_SUBJECT', 'exactly one subject claim is allowed');
  const sc = req.subjectClaims[0];
  if (!sc || sc.type !== 'identity') return deny('SUBJECT_TYPE', 'only identity-type subject claims are routed here');
  if (!Array.isArray(sc.source) || sc.source.length !== 1 || sc.source[0] !== 'accountCredential') return deny('SOURCE', 'only the account credential may be proven');
  const issuers = (sc.issuers || []).map((i) => (typeof i === 'string' ? i : JSON.stringify(i)).toLowerCase());
  if (issuers.length !== 1 || issuers[0] !== TEST_ISSUER) return deny('ISSUER', 'only the held identity provider may be used');
  const st = sc.statements;
  if (!Array.isArray(st) || st.length < 1 || st.length > 2) return deny('STATEMENT_COUNT', 'between 1 and 2 statements');
  const tags = new Set();
  for (const s of st) {
    if (!s || typeof s !== 'object') return deny('MALFORMED', 'statement is not an object');
    if (s.type === 'RevealAttribute' || s.type === 'AttributeValue') return deny('REVEAL_REFUSED', `reveal of ${s.attributeTag} is refused by policy`);
    if (!['dob', 'nationality', 'countryOfResidence'].includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_ALLOWED', `attribute ${s.attributeTag} is outside {dob, nationality, countryOfResidence}`);
    if (!['dob', 'nationality'].includes(s.attributeTag)) return deny('ATTRIBUTE_NOT_HELD', `this prover holds no opening for ${s.attributeTag}`);
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

const TEST_CRED_ID = '9'.repeat(64); // fake credId of the mock holder credential
const OTHER_CRED_ID = '8'.repeat(64); // a different credential (a different holder)
const TEST_PAYER = '4TestPayer';
const OTHER_HOLDER = '4OtherHolder';
// The mock presentation carries a V1 account credential whose
// credentialSubject.id is the credential DID (the real V1 shape —
// @concordium/web-sdk 12.0.3: `did:ccd:<net>:cred:<64-hex credId>`).
// The mock resolver below maps that credId to TEST_PAYER, so the M2
// holder binding can be exercised end to end.
const FAKE_PRESENTATION = {
  type: 'VerifiablePresentation',
  proof: { type: 'ConcordiumWeakLinkingProofV1', created: '2026-11-24T00:00:00Z' },
  verifiableCredential: [{
    type: ['VerifiableCredential', 'ConcordiumVerifiableCredentialV1', 'ConcordiumAccountBasedCredential'],
    credentialSubject: { id: `did:ccd:testnet:cred:${TEST_CRED_ID}`, statement: [] },
    issuer: TEST_ISSUER,
  }],
};
function presentationWithCredId(credId) {
  return {
    type: 'VerifiablePresentation',
    proof: { type: 'ConcordiumWeakLinkingProofV1', created: '2026-11-24T00:00:00Z' },
    verifiableCredential: [{
      type: ['VerifiableCredential', 'ConcordiumVerifiableCredentialV1', 'ConcordiumAccountBasedCredential'],
      credentialSubject: { id: `did:ccd:testnet:cred:${credId}`, statement: [] },
      issuer: TEST_ISSUER,
    }],
  };
}
const HOLDER_LESS_PRESENTATION = {
  type: 'VerifiablePresentation',
  proof: { type: 'ConcordiumWeakLinkingProofV1', created: '2026-11-24T00:00:00Z' },
  verifiableCredential: [],
};

// Fix-back-2 MF1 (J31 shape): a presentation with ONLY a bare top-level
// `holder` account DID and zero credentials. The old code trusted that
// DID verbatim (kind 'account', no chain check) and filed the proof.
const HOLDER_DID_ONLY_PRESENTATION = {
  type: 'VerifiablePresentation',
  proof: { type: 'ConcordiumWeakLinkingProofV1', created: '2026-11-24T00:00:00Z' },
  holder: `did:ccd:testnet:acc:${TEST_PAYER}`,
  verifiableCredential: [],
};

let mockServer;
let proverUrl;
before(async () => {
  mockServer = createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { service: 'scoped-prover', network: 'Testnet', attributesHeld: ['dob', 'nationality'] });
    }
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch { return send(400, { error: 'BAD_REQUEST' }); }
      if (req.method === 'POST' && req.url === '/policy-check') {
        const d = mockDecide(body.request);
        return send(d.allowed ? 200 : 403, d);
      }
      if (req.method === 'POST' && req.url === '/presentation') {
        const d = mockDecide(body.request);
        if (!d.allowed) return send(403, { refused: true, ...d });
        return send(200, { presentation: FAKE_PRESENTATION });
      }
      return send(404, { error: 'NOT_FOUND' });
    });
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  proverUrl = `http://127.0.0.1:${mockServer.address().port}`;
});
after(async () => { await new Promise((resolve) => mockServer.close(resolve)); });

// ---- fake req/res + handler deps ----
function fakeRes() {
  const res = {
    status: null, body: null, headers: {},
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(data) {
      if (data !== undefined && data !== null && data !== '') {
        try { this.body = JSON.parse(String(data)); } catch { this.body = String(data); }
      }
    },
  };
  return res;
}
function makeDeps({ fetchImpl, now = () => Date.now(), resolveHolderAccount, presentationOverride } = {}) {
  // Mock holder resolution: the mock credential belongs to TEST_PAYER;
  // a different credential belongs to OTHER_HOLDER; anything else is
  // unresolvable. Pass resolveHolderAccount: null to simulate "no
  // resolver configured" (fail closed), or presentationOverride to make
  // the mock prover return a different presentation for /presentation.
  const resolve = resolveHolderAccount === undefined
    ? async (credId) => (credId === TEST_CRED_ID ? TEST_PAYER : credId === OTHER_CRED_ID ? OTHER_HOLDER : null)
    : resolveHolderAccount;
  let fetchFn = fetchImpl ?? fetch;
  if (presentationOverride !== undefined) {
    const inner = fetchFn;
    fetchFn = async (url, options) => {
      if (String(url).endsWith('/presentation')) {
        return new Response(JSON.stringify({ presentation: presentationOverride }), { status: 200 });
      }
      return inner(url, options);
    };
  }
  return {
    proverUrl,
    fetchImpl: fetchFn,
    now,
    resolveHolderAccount: resolve,
    readBody: async (req) => {
      if (req._bodyError) throw new Error(req._bodyError);
      return req._body;
    },
    sendJson: (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); },
    apiError: (res, status, code, layer, message, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code, layer, message, retryable: false, ...extra } }));
    },
    rateLimited: (res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limited', layer: 'app', message: 'Too many tries.', retryable: true } }));
    },
    hitWindow: async () => ({ allowed: true, resetMs: 0 }),
    clientIp: () => '127.0.0.1',
    attemptsPerMinutePerIp: 10,
  };
}
function reqWith(body) { return { _body: body }; }

// ---- request fixtures ----
function baseRequest(statements) {
  return {
    challenge: 'a'.repeat(64),
    subjectClaims: [{
      type: 'identity',
      source: ['accountCredential'],
      issuers: [TEST_ISSUER],
      statements,
    }],
  };
}
const dob18 = () => ({ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(18, 1) });
const dob21 = () => ({ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(21, 1) });
const euSet = () => ({ type: 'AttributeInSet', attributeTag: 'nationality', set: [...EU] });

// The 18 forbidden shapes (SCOPED_LOG P-refuse), each with its exact rule.
const FORBIDDEN = [
  ['reveal firstName', baseRequest([{ type: 'RevealAttribute', attributeTag: 'firstName' }]), 'REVEAL_REFUSED'],
  ['reveal lastName', baseRequest([{ type: 'RevealAttribute', attributeTag: 'lastName' }]), 'REVEAL_REFUSED'],
  ['reveal idDocNo', baseRequest([{ type: 'RevealAttribute', attributeTag: 'idDocNo' }]), 'REVEAL_REFUSED'],
  ['reveal dob', baseRequest([{ type: 'RevealAttribute', attributeTag: 'dob' }]), 'REVEAL_REFUSED'],
  ['AttributeValue firstName', baseRequest([{ type: 'AttributeValue', attributeTag: 'firstName', value: 'Guest' }]), 'REVEAL_REFUSED'],
  ['membership on firstName', baseRequest([{ type: 'AttributeInSet', attributeTag: 'firstName', set: ['Guest'] }]), 'ATTRIBUTE_NOT_ALLOWED'],
  ['range on idDocNo', baseRequest([{ type: 'AttributeInRange', attributeTag: 'idDocNo', lower: '10000000', upper: '99999999' }]), 'ATTRIBUTE_NOT_ALLOWED'],
  ['countryOfResidence (not held)', baseRequest([{ type: 'AttributeInSet', attributeTag: 'countryOfResidence', set: [...EU] }]), 'ATTRIBUTE_NOT_HELD'],
  ['narrow dob range', baseRequest([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '19900101', upper: '19900131' }]), 'RANGE_TOO_NARROW'],
  ['dob lower 19000101', baseRequest([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '19000101', upper: pastDate(18, 1) }]), 'RANGE_NOT_ALLOWED'],
  ['dob upper today-16y', baseRequest([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(16, 1) }]), 'RANGE_NOT_ALLOWED'],
  ['dob as membership', baseRequest([{ type: 'AttributeInSet', attributeTag: 'dob', set: ['20000101'] }]), 'STATEMENT_TYPE'],
  ['nationality set {DE}', baseRequest([{ type: 'AttributeInSet', attributeTag: 'nationality', set: ['DE'] }]), 'SET_NOT_ALLOWED'],
  ['nationality set EU+US', baseRequest([{ type: 'AttributeInSet', attributeTag: 'nationality', set: [...EU, 'US'] }]), 'SET_NOT_ALLOWED'],
  ['identity-credential source', (() => { const r = baseRequest([dob18()]); r.subjectClaims[0].source = ['identityCredential']; return r; })(), 'SOURCE'],
  ['idp:1 issuer', (() => { const r = baseRequest([dob18()]); r.subjectClaims[0].issuers = ['did:ccd:testnet:idp:1']; return r; })(), 'ISSUER'],
  ['three statements', baseRequest([dob18(), euSet(), { type: 'AttributeInSet', attributeTag: 'countryOfResidence', set: [...EU] }]), 'STATEMENT_COUNT'],
  ['duplicate dob', baseRequest([dob18(), { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(21, 1) }]), 'DUPLICATE'],
];

for (const [name, request, rule] of FORBIDDEN) {
  test(`policy-check: ${name} -> 403 ${rule}`, async () => {
    const h = createAgeProofHandlers(makeDeps());
    const res = fakeRes();
    await h.handlePolicyCheck(reqWith({ request }), res);
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.rule, rule);
    assert.equal(res.body.allowed, false);
  });
}

test('policy-check: all 4 allowed shapes -> 200', async () => {
  const h = createAgeProofHandlers(makeDeps());
  const allowed = [
    baseRequest([dob18(), euSet()]),
    baseRequest([dob21(), euSet()]),
    baseRequest([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(18, 0) }]),
    baseRequest([euSet()]),
  ];
  for (const request of allowed) {
    const res = fakeRes();
    await h.handlePolicyCheck(reqWith({ request }), res);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.allowed, true);
    assert.equal(res.body.rule, 'ALLOWED');
  }
});

test('policy-check: malformed body -> 400 invalid', async () => {
  const h = createAgeProofHandlers(makeDeps());
  const res = fakeRes();
  await h.handlePolicyCheck(reqWith({}), res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid');
});

test('health: prover up -> 200 with allow-list + anchors', async () => {
  const h = createAgeProofHandlers(makeDeps());
  const res = fakeRes();
  await h.handleHealth({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.prover_available, true);
  assert.deepEqual(res.body.prover.attributes_held, ['dob', 'nationality']);
  assert.match(res.body.anchored_run.vra, /^[0-9a-f]{64}$/);
  assert.match(res.body.anchored_run.vaa, /^[0-9a-f]{64}$/);
  // Precision: the page must never claim an under-18-holder test.
  assert.equal(JSON.stringify(res.body).includes('under-18'), false);
  assert.match(JSON.stringify(res.body.proven_rejections), /tampered presentation/);
});

function verifierStub(status) {
  return async (url, options) => {
    if (url === VERIFIER_URL) return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'Invalid cryptographic proofs' }), { status });
    return fetch(url, options);
  };
}

test('verify: allowed shape + verifier 200 -> 200 valid:true, filed for the payable', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200), now: () => nowMs }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.deepEqual(res.body.statements, ['dob>=18', 'nationality in EU27']);
  assert.equal(res.body.filed_for_payable, 1007);
  assert.equal(res.body.binding, 'bound');
  assert.equal(res.body.holder, TEST_PAYER);
  assert.ok(findFreshAgeProof(TEST_PAYER, 1007, nowMs), 'proof must be on file for the gate');
  clearAgeProofs();
});

// ---- M1 fix-back: statements are derived from the request, and only a
// dob 18+ proof is filed ----
test('M1: nationality-only request -> 200 valid:true, but claims NO age and files NOTHING (gate still 409)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200), now: () => nowMs }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.deepEqual(res.body.statements, ['nationality in EU27']);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'no_dob_proof');
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  assert.equal(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, TEST_PAYER, nowMs)?.code, 'age_proof_required');
  clearAgeProofs();
});

test('M1: dob>=21-only request -> claims dob>=18 + dob>=21, claims NO nationality, files (18+ proven)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200), now: () => nowMs }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob21()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.deepEqual(res.body.statements, ['dob>=18', 'dob>=21']);
  assert.equal(res.body.filed_for_payable, 1007);
  assert.equal(res.body.binding, 'bound');
  assert.ok(findFreshAgeProof(TEST_PAYER, 1007, nowMs));
  clearAgeProofs();
});

test('M1: dob>=18-only request -> claims dob>=18 only, files', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200), now: () => nowMs }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.statements, ['dob>=18']);
  assert.equal(res.body.filed_for_payable, 1007);
  assert.equal(res.body.binding, 'bound');
  clearAgeProofs();
});

// ---- M2 fix-back: the filed record is bound to the presentation holder ----
test('M2: proof for a holder != payer -> 200 valid:true, but files NOTHING (gate still 409)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({
    fetchImpl: verifierStub(200), now: () => nowMs,
    presentationOverride: presentationWithCredId(OTHER_CRED_ID),
  }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'holder_mismatch');
  assert.equal(res.body.holder, OTHER_HOLDER);
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  assert.equal(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, TEST_PAYER, nowMs)?.code, 'age_proof_required');
  clearAgeProofs();
});

test('M2: holder credential unresolvable -> files NOTHING (fail closed)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({
    fetchImpl: verifierStub(200), now: () => nowMs,
    resolveHolderAccount: async () => null,
  }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'holder_unresolved');
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  clearAgeProofs();
});

test('M2: no resolver configured -> files NOTHING (fail closed)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({
    fetchImpl: verifierStub(200), now: () => nowMs,
    resolveHolderAccount: null,
  }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'holder_unresolved');
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  clearAgeProofs();
});

test('M2: presentation with no holder at all -> files NOTHING (fail closed)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({
    fetchImpl: verifierStub(200), now: () => nowMs,
    presentationOverride: HOLDER_LESS_PRESENTATION,
  }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'holder_missing');
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  clearAgeProofs();
});

// ---- Fix-back-2 MF1: a bare holder account DID is never trusted ----
test('MF1: extractPresentationHolder ignores a bare account DID (no chain check exists for it)', () => {
  assert.equal(extractPresentationHolder(HOLDER_DID_ONLY_PRESENTATION), null);
  assert.equal(extractPresentationHolder({ holder: 'did:ccd:testnet:acc:4TestPayer', verifiableCredential: [] }), null);
  // The real V1 shape still extracts: a credential DID resolves on chain.
  assert.deepEqual(
    extractPresentationHolder(presentationWithCredId(TEST_CRED_ID)),
    { kind: 'cred', credId: TEST_CRED_ID },
  );
});

test('MF1 (J31 shape): holder-DID-only presentation + zero credentials -> 200 valid:true, but files NOTHING (fail closed)', async () => {
  clearAgeProofs();
  const nowMs = Date.now();
  const h = createAgeProofHandlers(makeDeps({
    fetchImpl: verifierStub(200), now: () => nowMs,
    presentationOverride: HOLDER_DID_ONLY_PRESENTATION,
  }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: TEST_PAYER }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'holder_missing');
  assert.equal(res.body.holder, null);
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007, nowMs), null);
  assert.equal(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, TEST_PAYER, nowMs)?.code, 'age_proof_required');
  clearAgeProofs();
});

test('verify: no payable+payer supplied -> verifies only, files nothing (binding not_requested)', async () => {
  clearAgeProofs();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200) }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]) }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(res.body.binding, 'not_requested');
  assert.deepEqual(res.body.statements, ['dob>=18', 'nationality in EU27']);
  clearAgeProofs();
});

// ---- F2a fix-back: verify-only path for a client-supplied presentation ----
test('F2a: verify-presentation with verifier 200 -> 200 valid:true, files NOTHING (verify only)', async () => {
  clearAgeProofs();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200) }));
  const res = fakeRes();
  await h.handleVerifyPresentation(reqWith({ presentation: FAKE_PRESENTATION }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.valid, true);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007), null);
  clearAgeProofs();
});

test('F2a: verify-presentation with verifier 400 (tampered shape) -> 400 valid:false, nothing filed', async () => {
  clearAgeProofs();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(400) }));
  const res = fakeRes();
  await h.handleVerifyPresentation(reqWith({ presentation: { type: 'VerifiablePresentation', proof: { tampered: true } } }), res);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.valid, false);
  assert.equal(res.body.verifier_status, 400);
  assert.equal(res.body.filed_for_payable, null);
  assert.equal(findFreshAgeProof(TEST_PAYER, 1007), null);
  clearAgeProofs();
});

test('F2a: verify-presentation with no presentation -> 400 invalid', async () => {
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200) }));
  const res = fakeRes();
  await h.handleVerifyPresentation(reqWith({}), res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid');
});

test('verify: forbidden shape -> 403 with the exact rule, nothing filed', async () => {
  clearAgeProofs();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(200) }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([{ type: 'RevealAttribute', attributeTag: 'firstName' }]), payable_id: 1007, payer: '4TestPayer' }), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.rule, 'REVEAL_REFUSED');
  assert.equal(findFreshAgeProof('4TestPayer', 1007), null);
});

test('verify: stubbed verifier 400 -> 400 valid:false (shape of the proven live rejection; the stub returns 400 unconditionally, nothing is tampered in this test)', async () => {
  clearAgeProofs();
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: verifierStub(400) }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18(), euSet()]), payable_id: 1007, payer: '4TestPayer' }), res);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.valid, false);
  assert.equal(res.body.verifier_status, 400);
  assert.equal(findFreshAgeProof('4TestPayer', 1007), null);
  clearAgeProofs();
});

// ---- prover down: fail closed with 503 prover_unavailable ----
const downFetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8788'); };
test('prover down: health -> 503 prover_unavailable', async () => {
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: downFetch }));
  const res = fakeRes();
  await h.handleHealth({}, res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'prover_unavailable');
});
test('prover down: policy-check -> 503 prover_unavailable', async () => {
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: downFetch }));
  const res = fakeRes();
  await h.handlePolicyCheck(reqWith({ request: baseRequest([dob18()]) }), res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'prover_unavailable');
});
test('prover down: verify -> 503 prover_unavailable', async () => {
  const h = createAgeProofHandlers(makeDeps({ fetchImpl: downFetch }));
  const res = fakeRes();
  await h.handleVerify(reqWith({ request: baseRequest([dob18()]) }), res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'prover_unavailable');
});

// ---- pay-flow gate ----
test('gate: below threshold (0.5 CCD, 0.01 EUDemo) is not gated', () => {
  assert.equal(isAgeGated({ amount: '500000', asset: 'CCD' }), false);
  assert.equal(isAgeGated({ amount: '10000', asset: 'EUDemo' }), false);
  assert.equal(ageGateCheck({ id: 3, amount: '500000', asset: 'CCD' }, '4Payer'), null);
});
test('gate: at/above threshold without a fresh proof -> 409 age_proof_required', () => {
  clearAgeProofs();
  assert.equal(isAgeGated({ amount: '1000000', asset: 'CCD' }), true);
  assert.equal(isAgeGated({ amount: '1000000', asset: 'EUDemo' }), true);
  assert.equal(isAgeGated({ amount: '2500000', asset: 'CCD' }), true);
  const g = ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, '4Payer');
  assert.equal(g.status, 409);
  assert.equal(g.code, 'age_proof_required');
  assert.equal(g.verify_url, '/verify-age?payable=1007');
});
test('gate: fresh proof on file passes; stale proof (>10 min) does not', () => {
  clearAgeProofs();
  const nowMs = Date.now();
  recordVerifiedAgeProof({ payer: '4Payer', payableId: 1007, verifiedAtMs: nowMs });
  assert.equal(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, '4Payer', nowMs), null);
  assert.ok(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, '4Payer', nowMs + AGE_PROOF_FRESH_MS + 1000));
  assert.equal(ageGateCheck({ id: 1007, amount: '1000000', asset: 'CCD' }, '4OtherPayer', nowMs)?.code, 'age_proof_required');
  assert.equal(ageGateCheck({ id: 1008, amount: '1000000', asset: 'CCD' }, '4Payer', nowMs)?.code, 'age_proof_required');
  clearAgeProofs();
});
