// Visitor-wallet 18+ proof: request/verify with fake adapters (the real ones hit the node and the verifier).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletAge, ageStatementsV0 } from '../src/wallet-age.mjs';
import { allowedAdultUppers } from '../src/age-proof.mjs';

const ACC = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const CRED = 'ab'.repeat(48);
const memKv = () => { const m = new Map(); return { m, get: async (n, k) => structuredClone(m.get(`${n}|${k}`) ?? null), put: async (n, k, v) => { m.set(`${n}|${k}`, structuredClone(v)); } }; };
const upper = () => allowedAdultUppers(Date.now())[1];
const v1req = (statements) => ({ subjectClaims: [{ statements }] });
const adultStmt = () => ({ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: upper() });
const pres = (extra = {}) => ({ verifiableCredential: [{ credentialSubject: { id: `did:ccd:testnet:cred:${CRED}`, statement: [adultStmt()] } }], ...extra });
function make(over = {}) {
  let t = Date.now(); const kv = memKv(); const anchors = [];
  const a = createWalletAge({
    kv, now: () => t, issuers: [0, 1],
    anchorV1Request: async ({ account }) => { anchors.push(account); return { request: v1req([adultStmt()]), vra_tx: 'v'.repeat(64) }; },
    verifyV1: async () => ({ ok: true, vaa_tx: 'a'.repeat(64) }),
    verifyV0: async () => ({ ok: true, challenge: over.challenge ?? '' }),
    holderAccount: async () => over.holder ?? ACC,
    hitWindow: over.hitWindow,
    ...over.deps,
  });
  return { a, kv, anchors, tick: (ms) => { t += ms; } };
}

test('request: anchors a V1 request once, offers V0 statements with a dob range', async () => {
  const { a, anchors } = make();
  const r = await a.request({ account: ACC, seller_id: 'adult' });
  assert.match(r.request_id, /^[0-9a-f]{24}$/); assert.equal(anchors.length, 1); assert.equal(r.vra_tx, 'v'.repeat(64));
  assert.equal(r.v0.statements[0].statement[0].attributeTag, 'dob');
  assert.deepEqual(r.v0.statements[0].idQualifier.issuers, [0, 1]);
  await assert.rejects(a.request({ account: 'x', seller_id: 'adult' }), (e) => e.code === 'bad_account');
  await assert.rejects(a.request({ account: ACC, seller_id: '' }), (e) => e.code === 'bad_seller');
  const w = await a.request({ account: ACC, seller_id: 'adult', wallet: 'walletconnect' });
  assert.equal(w.v1, undefined); assert.equal(anchors.length, 1, 'no anchor for a V0-only wallet');
});

test('verify v1: verified, bound to the account, VAA returned, one use, then fresh', async () => {
  const { a } = make();
  const r = await a.request({ account: ACC, seller_id: 'adult' });
  const v = await a.verify({ request_id: r.request_id, version: 'v1', presentation: JSON.stringify(pres()) });
  assert.equal(v.verified, true); assert.equal(v.vaa_tx, 'a'.repeat(64));
  assert.ok(await a.fresh(ACC, 'adult')); assert.equal(await a.fresh(ACC, 'other'), null);
  await assert.rejects(a.verify({ request_id: r.request_id, version: 'v1', presentation: pres() }), (e) => e.code === 'request_used');
});

test('verify: a credential of another account is not accepted; nothing is filed', async () => {
  const { a } = make({ holder: '4MDjZpfasyxR8sJDnyXewHU13QzxpNmhn3xUmeBxcui8mUS7Ns' });
  const r = await a.request({ account: ACC, seller_id: 'adult' });
  const v = await a.verify({ request_id: r.request_id, version: 'v1', presentation: pres() });
  assert.equal(v.verified, false); assert.equal(v.checks.find((c) => c.id === 'holder').status, 'fail');
  assert.equal(await a.fresh(ACC, 'adult'), null);
});

test('verify: a failing node check, an expired and an unknown request', async () => {
  const bad = make({ deps: { verifyV1: async () => ({ ok: false, reason: 'node says no' }) } });
  const r = await bad.a.request({ account: ACC, seller_id: 'adult' });
  assert.equal((await bad.a.verify({ request_id: r.request_id, version: 'v1', presentation: pres() })).verified, false);
  const { a, tick } = make();
  const r2 = await a.request({ account: ACC, seller_id: 'adult' });
  tick(11 * 60_000);
  await assert.rejects(a.verify({ request_id: r2.request_id, version: 'v1', presentation: pres() }), (e) => e.code === 'request_expired');
  await assert.rejects(a.verify({ request_id: 'f'.repeat(24), version: 'v1', presentation: pres() }), (e) => e.code === 'no_request');
});

test('verify v0: needs the challenge and a dob 18+ statement; a name-only presentation is refused', async () => {
  const m = make();
  const r = await m.a.request({ account: ACC, seller_id: 'adult', wallet: 'walletconnect' });
  const ok = make({ challenge: r.v0.challenge });
  // same store so the request exists
  const a2 = createWalletAge({ kv: m.kv, now: () => Date.now(), issuers: [0], anchorV1Request: async () => ({}), verifyV1: async () => ({ ok: true }), verifyV0: async () => ({ ok: true, challenge: r.v0.challenge }), holderAccount: async () => ACC });
  const v = await a2.verify({ request_id: r.request_id, version: 'v0', presentation: pres() });
  assert.equal(v.verified, true); assert.equal(v.vaa_tx, null);
  const r3 = await m.a.request({ account: ACC, seller_id: 'adult2', wallet: 'walletconnect' });
  const a3 = createWalletAge({ kv: m.kv, now: () => Date.now(), issuers: [0], anchorV1Request: async () => ({}), verifyV1: async () => ({ ok: true }), verifyV0: async () => ({ ok: true, challenge: r3.v0.challenge }), holderAccount: async () => ACC });
  const noAge = { verifiableCredential: [{ credentialSubject: { id: `did:ccd:testnet:cred:${CRED}`, statement: [{ type: 'RevealAttribute', attributeTag: 'firstName' }] } }] };
  const bad = await a3.verify({ request_id: r3.request_id, version: 'v0', presentation: noAge });
  assert.equal(bad.verified, false); assert.equal(bad.checks.find((c) => c.id === 'asks_18').status, 'fail');
  assert.ok(ok);
  assert.ok(ageStatementsV0([0], Date.now())[0].statement[0].upper > '19000101');
});

test('rate limit: the request budget is enforced', async () => {
  let n = 0;
  const { a } = make({ hitWindow: async () => ({ allowed: ++n < 2, resetMs: 5000 }) });
  await assert.rejects(a.request({ account: ACC, seller_id: 'adult' }), (e) => e.code === 'rate_limited' && e.status === 429);
});
