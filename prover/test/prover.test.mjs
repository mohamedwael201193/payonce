// Prover service tests: no chain, no real openings. Fake openings, stub presentation builder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProverServer, loadOpenings } from '../src/prover.mjs';
import { EU, pastDate } from '../src/policy.mjs';

const TOKEN = 't'.repeat(40);
const FAKE_DOB = 'FAKE-DOB-OPENING-1234567';
const FAKE_RAND = 'FAKE-RANDOMNESS-7654321';
const ISSUER = 'did:ccd:testnet:idp:0';
const held = loadOpenings(JSON.stringify({
  network: 'Testnet', issuer: 0, credId: '9'.repeat(96),
  values: { dob: FAKE_DOB, nationality: 'DE', firstName: 'LEAK-ME' },
  randomness: { dob: FAKE_RAND, nationality: 'RND2', firstName: 'LEAK-ME-TOO' },
}));

let server, base, calls = 0, failProof = false;
before(async () => {
  server = createProverServer({
    held, token: TOKEN,
    makePresentation: async () => { calls++; if (failProof) throw new Error(`boom ${FAKE_DOB} ${FAKE_RAND}`); return { type: 'VerifiablePresentationV1-stub' }; },
    limits: { any: 1000, proof: 1000, badAuth: 1000 },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const post = (path, body, headers = auth) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

function baseRequest(statements) {
  return { challenge: 'a'.repeat(64), subjectClaims: [{ type: 'identity', source: ['accountCredential'], issuers: [ISSUER], statements }] };
}
const dob18 = () => ({ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(18, 1) });
const dob21 = () => ({ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: pastDate(21, 1) });
const euSet = () => ({ type: 'AttributeInSet', attributeTag: 'nationality', set: [...EU] });

// The 18 forbidden shapes, each with its exact rule. This prover holds dob + nationality only.
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
  test(`forbidden: ${name} -> 403 ${rule} on /policy-check and /presentation`, async () => {
    const before = calls;
    const a = await post('/policy-check', { request });
    assert.equal(a.status, 403);
    const ja = await a.json();
    assert.equal(ja.rule, rule);
    assert.equal(ja.allowed, false);
    const b = await post('/presentation', { request });
    assert.equal(b.status, 403);
    assert.equal((await b.json()).rule, rule);
    assert.equal(calls, before, 'no proof was built');
  });
}

test('allowed shapes -> 200 and a presentation', async () => {
  for (const request of [baseRequest([dob18(), euSet()]), baseRequest([dob21(), euSet()]), baseRequest([dob18()]), baseRequest([euSet()])]) {
    const pc = await post('/policy-check', { request });
    assert.equal(pc.status, 200);
    const r = await post('/presentation', { request });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).presentation);
  }
});

test('auth: no token / wrong token -> 401 on every route but /healthz', async () => {
  const req = baseRequest([dob18()]);
  for (const h of [{ 'content-type': 'application/json' }, { authorization: 'Bearer wrong', 'content-type': 'application/json' }, { authorization: TOKEN, 'content-type': 'application/json' }]) {
    assert.equal((await post('/presentation', { request: req }, h)).status, 401);
    assert.equal((await post('/policy-check', { request: req }, h)).status, 401);
    assert.equal((await fetch(base + '/health', { headers: h })).status, 401);
  }
  const hz = await fetch(base + '/healthz');
  assert.equal(hz.status, 200);
  assert.deepEqual(await hz.json(), { ok: true });
});

test('health: names the attributes held, never the values; extra attributes are dropped at load', async () => {
  const r = await fetch(base + '/health', { headers: auth });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text).attributesHeld, ['dob', 'nationality']);
  for (const s of [FAKE_DOB, FAKE_RAND, 'LEAK-ME', held.credId]) assert.ok(!text.includes(s));
  assert.equal(held.values.firstName, undefined);
});

test('proof failure: error is sanitised, openings never echoed', async () => {
  failProof = true;
  const r = await post('/presentation', { request: baseRequest([dob18()]) });
  failProof = false;
  assert.equal(r.status, 422);
  const text = await r.text();
  assert.ok(!text.includes(FAKE_DOB) && !text.includes(FAKE_RAND));
  assert.ok(text.includes('REDACTED'));
});

test('unknown route 404, bad JSON 400', async () => {
  assert.equal((await fetch(base + '/nope', { headers: auth })).status, 404);
  const r = await fetch(base + '/policy-check', { method: 'POST', headers: auth, body: 'not json' });
  assert.equal(r.status, 400);
});

test('rate limit: /presentation allows 3 per window then 429; bad-auth flood is limited', async () => {
  let t = Date.now();
  const s = createProverServer({ held, token: TOKEN, makePresentation: async () => ({}), now: () => t, limits: { any: 100, proof: 3, badAuth: 5 } });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const go = () => fetch(b + '/presentation', { method: 'POST', headers: auth, body: JSON.stringify({ request: baseRequest([dob18()]) }) });
  assert.deepEqual([(await go()).status, (await go()).status, (await go()).status], [200, 200, 200]);
  const limited = await go();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  t += 61_000;
  assert.equal((await go()).status, 200);
  const bad = [];
  for (let i = 0; i < 7; i++) bad.push((await fetch(b + '/health', { headers: { authorization: 'Bearer x' } })).status);
  assert.deepEqual(bad, [401, 401, 401, 401, 401, 429, 429]);
  s.closeAllConnections();
  s.close();
});

test('refuses to start without a strong token or valid openings', () => {
  assert.throws(() => createProverServer({ held, token: 'short', makePresentation: async () => ({}) }));
  assert.throws(() => loadOpenings(''), /PROVER_OPENINGS_JSON/);
  assert.throws(() => loadOpenings('{}'), /lacks/);
});
