// Spend mandate (signed, anchored, enforced) + the seller-side buyer gate. Real ed25519 signatures, stubbed chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AccountAddress, buildBasicAccountSigner, signMessage } from '@concordium/web-sdk';
import * as ed from '@noble/ed25519';
import { createMandates, mandateMessage, parseMandateMessage, anchorDataHex } from '../src/mandate.mjs';
import { createBuyerGate } from '../src/buyer-gate.mjs';
import { createX402Seller, TESTNET_CAIP2 } from '../src/x402-seller.mjs';
import { createX402Client } from '../src/x402-client.mjs';
import { sha256Hex } from '../src/vop.mjs';

const BUYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const OTHER = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const PAYTO = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
function memKv() {
  const m = new Map();
  return { m, get: async (ns, k) => structuredClone(m.get(`${ns}|${k}`) ?? null), put: async (ns, k, v) => { m.set(`${ns}|${k}`, structuredClone(v)); },
    putIfAbsent: async (ns, k, v) => { if (m.has(`${ns}|${k}`)) return false; m.set(`${ns}|${k}`, structuredClone(v)); return true; },
    list: async (ns) => [...m.entries()].filter(([k]) => k.startsWith(`${ns}|`)).map(([k, v]) => ({ key: k.slice(ns.length + 1), value: structuredClone(v) })) };
}
async function keys() {
  const sk = randomBytes(32); const pk = Buffer.from(await ed.getPublicKeyAsync(sk)).toString('hex');
  return { signer: buildBasicAccountSigner(sk.toString('hex')), info: { accountAddress: AccountAddress.fromBase58(BUYER), accountThreshold: 1, accountCredentials: { 0: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pk } } } } } } } } };
}
async function setup(over = {}) {
  const k = await keys(); const kv = memKv(); let t = Date.parse('2026-11-28T12:00:00Z'); const chain = new Map(); let sends = 0;
  const deps = {
    kv, now: () => t, accountInfo: async () => k.info, explorer: (h) => `https://x/${h}`,
    anchorStatus: async (h) => chain.get(h) ?? null,
    buyer: { account: BUYER, agent_token: 1488, sign: (m) => signMessage(AccountAddress.fromBase58(BUYER), m, k.signer), sendAnchor: async (hex) => { sends++; const h = randomBytes(32).toString('hex'); chain.set(h, { status: 'finalized', dataHex: hex, sender: BUYER }); return { txHash: h }; } },
    defaults: { per_purchase_micro: '100000', total_micro: '250000', ttl_ms: 86_400_000 }, ...over,
  };
  return { k, kv, chain, deps, svc: createMandates(deps), tick: (ms) => { t += ms; }, sends: () => sends };
}

test('message format round-trips and rejects any edit', () => {
  const m = { account: BUYER, agent_token: 1488, per_purchase_micro: '100000', total_micro: '1000000', expires_ms: Date.parse('2026-12-01T00:00:00.000Z'), id: 'ab'.repeat(12) };
  const txt = mandateMessage(m); assert.deepEqual(parseMandateMessage(txt), m);
  assert.equal(parseMandateMessage(txt.replace('100000', '100001 ')), null);
  assert.equal(parseMandateMessage(txt.replace('1000000', '99999')), null, 'total below the per-purchase cap is refused');
  assert.equal(parseMandateMessage(`${txt}\nextra`), null);
});

test('bootstrap: signs with the buyer key, sends ONE anchor from the buyer account, registers; a second call is a no-op', async () => {
  const s = await setup();
  const a = await s.svc.bootstrap();
  assert.equal(a.state, 'ready'); assert.equal(a.account, BUYER); assert.equal(a.anchor.state, 'finalized'); assert.equal(a.anchor.sender, BUYER);
  assert.equal(a.hash, sha256Hex(a.message)); assert.equal(s.chain.get(a.anchor.tx_hash).dataHex, anchorDataHex(a.hash));
  assert.equal((await s.svc.bootstrap()).hash, a.hash); assert.equal(s.sends(), 1);
});

test('bootstrap never resends an anchor whose outcome is unknown', async () => {
  const s = await setup(); let n = 0;
  s.deps.buyer.sendAnchor = async () => { n++; throw new Error('socket hang up'); };
  const svc = createMandates(s.deps);
  await assert.rejects(svc.bootstrap());
  const again = await svc.bootstrap();
  assert.equal(again.state, 'anchor_unknown'); assert.equal(n, 1);
});

test('authorize: within cap passes; over the per-purchase cap, over the total, or after expiry is refused before anything is signed', async () => {
  const s = await setup(); await s.svc.bootstrap();
  const ok = await s.svc.authorize({ amount_micro: '10000' }); assert.equal(ok.ok, true); assert.equal(ok.headers['x-buyer-agent'], '1488');
  await s.svc.settle(ok.reservation, { tx_hash: 'c'.repeat(64) });
  const big = await s.svc.authorize({ amount_micro: '100001' }); assert.equal(big.ok, false); assert.equal(big.code, 'over_per_purchase_cap');
  for (let i = 0; i < 2; i++) { const r = await s.svc.authorize({ amount_micro: '100000' }); assert.equal(r.ok, true); await s.svc.settle(r.reservation, { tx_hash: String(i).repeat(64) }); }
  const tot = await s.svc.authorize({ amount_micro: '100000' }); assert.equal(tot.ok, false); assert.equal(tot.code, 'over_total_budget');
  const small = await s.svc.authorize({ amount_micro: '40000' }); assert.equal(small.ok, true, 'exactly the remaining budget is allowed (10000+200000+40000 = 250000)');
  s.tick(2 * 86_400_000); const late = await s.svc.authorize({ amount_micro: '1' }); assert.equal(late.code, 'mandate_expired');
});

test('concurrent purchases cannot overspend; a released reservation frees its amount; an unknown outcome stays counted', async () => {
  const s = await setup();
  await s.svc.bootstrap();
  const rs = await Promise.all([1, 2, 3, 4].map(() => s.svc.authorize({ amount_micro: '100000' })));
  assert.equal(rs.filter((r) => r.ok).length, 2, '250000 budget fits two of 100000');
  const first = rs.find((r) => r.ok); await s.svc.settle(first.reservation, { released: true });
  assert.equal((await s.svc.authorize({ amount_micro: '100000' })).ok, true);
  const second = rs.filter((r) => r.ok)[1]; await s.svc.settle(second.reservation, {});
  assert.equal((await s.svc.authorize({ amount_micro: '100000' })).ok, false, 'unknown outcome is treated as spent');
});

test('register: a third-party mandate needs a valid signature, a finalized anchor sent by that account, and carrying the hash', async () => {
  const s = await setup(); const k = s.k;
  const m = { account: BUYER, agent_token: 7, per_purchase_micro: '5', total_micro: '50', expires_ms: Date.parse('2026-11-29T00:00:00.000Z'), id: 'cd'.repeat(12) };
  const message = mandateMessage(m); const hash = sha256Hex(message);
  const sig = await signMessage(AccountAddress.fromBase58(BUYER), message, k.signer);
  const tx = 'e'.repeat(64);
  await assert.rejects(s.svc.register({ message, signature: sig, anchor_tx: tx }), (e) => e.code === 'anchor_not_final');
  s.chain.set(tx, { status: 'finalized', dataHex: anchorDataHex('0'.repeat(64)), sender: BUYER });
  await assert.rejects(s.svc.register({ message, signature: sig, anchor_tx: tx }), (e) => e.code === 'anchor_mismatch');
  s.chain.set(tx, { status: 'finalized', dataHex: anchorDataHex(hash), sender: OTHER });
  await assert.rejects(s.svc.register({ message, signature: sig, anchor_tx: tx }), (e) => e.code === 'anchor_sender');
  const bad = await signMessage(AccountAddress.fromBase58(BUYER), message, buildBasicAccountSigner(randomBytes(32).toString('hex')));
  s.chain.set(tx, { status: 'finalized', dataHex: anchorDataHex(hash), sender: BUYER });
  await assert.rejects(s.svc.register({ message, signature: bad, anchor_tx: tx }), (e) => e.code === 'bad_signature');
  await assert.rejects(s.svc.register({ message: `${message} `, signature: sig, anchor_tx: tx }), (e) => e.code === 'bad_message');
  const ok = await s.svc.register({ message, signature: sig, anchor_tx: tx }); assert.equal(ok.hash, hash); assert.equal(ok.current, true);
});

test('verifyForSale: a seller re-checks signature, anchor, expiry, cap and that the mandate is the current one', async () => {
  const s = await setup(); const m = await s.svc.bootstrap();
  assert.equal((await s.svc.verifyForSale({ hash: m.hash, token: 1488, payer: BUYER, amount_micro: '10000' })).ok, true);
  const bad = await s.svc.verifyForSale({ hash: m.hash, token: 1488, payer: OTHER, amount_micro: '10000' }); assert.equal(bad.ok, false); assert.match(bad.reasons.join(), /different account/);
  const cap = await s.svc.verifyForSale({ hash: m.hash, token: 1488, payer: BUYER, amount_micro: '100001' }); assert.match(cap.reasons.join(), /above the mandate/);
  const tok = await s.svc.verifyForSale({ hash: m.hash, token: 5, payer: BUYER, amount_micro: '1' }); assert.match(tok.reasons.join(), /different agent token/);
  assert.equal((await s.svc.verifyForSale({ hash: 'f'.repeat(64), payer: BUYER, amount_micro: '1' })).ok, false);
  s.tick(2 * 86_400_000); assert.match((await s.svc.verifyForSale({ hash: m.hash, token: 1488, payer: BUYER, amount_micro: '1' })).reasons.join(), /expired/);
});

// ---- the gate ----
const passChecks = (over = {}) => ['exists', 'active', 'owner', 'mcp_agent_of', 'agent_wallet', 'badge'].map((id) => ({ id, status: over[id] ?? 'ok' }));
async function gateSetup(mode, checkOver = {}) {
  const s = await setup(); const m = await s.svc.bootstrap();
  const gate = createBuyerGate({ mode, mandates: s.svc, checkBuyer: async () => ({ verdict: Object.values(checkOver).includes('fail') ? 'refuse' : 'pass', checks: passChecks(checkOver), evidence: { badge: { badge_valid: true } } }) });
  return { s, m, gate, headers: { 'x-buyer-agent': '1488', 'x-buyer-mandate': m.hash } };
}
test('gate required: a verified agent with a valid mandate passes; each missing piece refuses', async () => {
  const { gate, headers, m } = await gateSetup('required');
  const ok = await gate.check({ headers, payer: BUYER, amount_micro: '10000' }); assert.equal(ok.ok, true); assert.equal(ok.buyer.verified, true); assert.equal(ok.buyer.mandate.hash, m.hash);
  const noHeaders = await gate.check({ headers: {}, payer: BUYER, amount_micro: '10000' }); assert.equal(noHeaders.ok, false); assert.equal(noHeaders.buyer.reasons.length, 2);
  const overCap = await gate.check({ headers, payer: BUYER, amount_micro: '100001' }); assert.equal(overCap.ok, false);
  const wrongPayer = await gate.check({ headers, payer: OTHER, amount_micro: '1' }); assert.equal(wrongPayer.ok, false);
  const noPayer = await gate.check({ headers, payer: null, amount_micro: '1' }); assert.equal(noPayer.ok, false);
});
test('gate required: a badge or agentWallet check that is not "ok" (even not_run) refuses', async () => {
  for (const over of [{ badge: 'not_run' }, { agent_wallet: 'not_run' }, { owner: 'fail' }, { active: 'fail' }]) {
    const { gate, headers } = await gateSetup('required', over);
    assert.equal((await gate.check({ headers, payer: BUYER, amount_micro: '1' })).ok, false, JSON.stringify(over));
  }
});
test('gate optional: always lets the sale through and reports whether the buyer was verified', async () => {
  const { gate, headers } = await gateSetup('optional');
  assert.equal((await gate.check({ headers, payer: BUYER, amount_micro: '1' })).buyer.verified, true);
  const anon = await gate.check({ headers: {}, payer: BUYER, amount_micro: '1' }); assert.equal(anon.ok, true); assert.equal(anon.buyer.verified, false);
});

test('seller with a required gate: a refused buyer is refused BEFORE settle (nothing charged); a verified buyer is settled once and reported', async () => {
  const { gate, headers } = await gateSetup('required'); const log = { settle: 0, rows: [] };
  const seller = createX402Seller({
    facilitator: { verify: async () => ({ isValid: true, payer: BUYER }), settle: async () => { log.settle++; return { success: true, transaction: 'ab'.repeat(32), payer: BUYER }; } },
    check: async () => ({ verdict: 'UNVERIFIED' }), payTo: PAYTO, feePayer: PAYTO, resourceUrl: () => 'https://api.test/x', record: async (r) => log.rows.push(r), gate,
  });
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: 'exact', network: TESTNET_CAIP2, amount: '10000', payTo: PAYTO }, payload: {} })).toString('base64');
  const q = { payee: OTHER, name: 'Acme ApS' };
  const r402 = await seller.handle({ query: q, headers: {} }); assert.equal(r402.status, 402); assert.equal(r402.body.buyerGate.mode, 'required');
  const refused = await seller.handle({ query: q, headers: { 'payment-signature': pay } });
  assert.equal(refused.status, 403); assert.equal(refused.body.nothing_charged, true); assert.equal(log.settle, 0);
  const ok = await seller.handle({ query: q, headers: { 'payment-signature': pay, ...headers } });
  assert.equal(ok.status, 200); assert.equal(ok.body.buyer.verified, true); assert.equal(log.settle, 1); assert.equal(log.rows[0].buyer_verified, true); assert.equal(log.rows[0].buyer_mandate, headers['x-buyer-mandate']);
});

// ---- the buyer client enforces the mandate ----
test('buyer client: an over-cap purchase is refused by the mandate even with a person\u2019s approval; nothing is built or sent; an in-cap one carries the mandate headers', async () => {
  const s = await setup(); await s.svc.bootstrap();
  const calls = { built: 0, sent: [] };
  const req = (amount) => ({ scheme: 'exact', network: TESTNET_CAIP2, asset: 'CCD', amount, payTo: PAYTO, extra: { feePayer: PAYTO } });
  let amount = '2000000';
  const doFetch = async (u, init) => {
    calls.sent.push(init.headers);
    if (!init.headers['payment-signature']) return new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, accepts: [req(amount)] })).toString('base64') } });
    return new Response('{"ok":1}', { status: 200, headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: 'dd'.repeat(32) })).toString('base64') } });
  };
  const client = createX402Client({
    fetch: doFetch, resolve: async () => [{ address: '93.184.216.34' }], mandate: s.svc,
    checkPayee: async () => ({ verdict: 'MATCH', payable: true, standin: false, evidence_hash: 'a'.repeat(64) }),
    buildPayload: async () => { calls.built++; return { x402Version: 2, accepted: req(amount), payload: {} }; }, record: async () => {},
  });
  const over = await client.buy({ url: 'https://seller.example/x', name: 'Seller', approved: true });
  assert.equal(over.paid, false); assert.equal(over.refused_by, 'spend_mandate'); assert.equal(over.decision.code, 'over_per_purchase_cap'); assert.equal(calls.built, 0);
  assert.equal(calls.sent.filter((h) => h['payment-signature']).length, 0);
  amount = '10000';
  const ok = await client.buy({ url: 'https://seller.example/x', name: 'Seller' });
  assert.equal(ok.paid, true); assert.equal(ok.tx_hash, 'dd'.repeat(32)); assert.equal(calls.built, 1);
  const paidHeaders = calls.sent.find((h) => h['payment-signature']); assert.equal(paidHeaders['x-buyer-agent'], '1488'); assert.match(paidHeaders['x-buyer-mandate'], /^[0-9a-f]{64}$/);
  assert.equal((await s.svc.get('current')).spent_micro, '10000');
});
