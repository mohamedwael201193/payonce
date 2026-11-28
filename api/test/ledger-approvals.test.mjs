// G16 hash-chained ledger with an anchored head; G11 wallet-signed approvals (real ed25519 signatures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AccountAddress, buildBasicAccountSigner, signMessage } from '@concordium/web-sdk';
import * as ed from '@noble/ed25519';
import { createLedger, entryHash, headBytesHex, parseHeadBytes, ZERO } from '../src/vop-ledger.mjs';
import { createApprovals } from '../src/approvals.mjs';

const PAYER = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const PAYEE = '4MDjZpfasyxR8sJDnyXewHU13QzxpNmhn3xUmeBxcui8mUS7Ns';
const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
function memKv() {
  const m = new Map();
  return { m, get: async (ns, k) => structuredClone(m.get(`${ns}|${k}`) ?? null), put: async (ns, k, v) => { m.set(`${ns}|${k}`, structuredClone(v)); },
    list: async (ns) => [...m.entries()].filter(([k]) => k.startsWith(`${ns}|`)).map(([k, v]) => ({ key: k.slice(ns.length + 1), value: structuredClone(v) })) };
}

test('ledger: entries link by hash; verify recomputes; tampering is caught', async () => {
  const kv = memKv(); const L = createLedger({ kv, send: async () => ({ txHash: 'a'.repeat(64) }), status: async () => ({}) });
  const a = await L.append({ kind: 'check', verdict: 'MATCH', evidence_hash: '1'.repeat(64) });
  const b = await L.append({ kind: 'check', verdict: 'NO_MATCH', evidence_hash: '2'.repeat(64) });
  assert.equal(a.seq, 1); assert.equal(a.prev_hash, ZERO); assert.equal(b.prev_hash, a.entry_hash);
  assert.equal(a.entry_hash, entryHash(1, ZERO, { kind: 'check', verdict: 'MATCH', evidence_hash: '1'.repeat(64) }));
  assert.equal((await L.verify()).ok, true);
  const k = 'vop_ledger|e:0000000001'; const row = kv.m.get(k); row.entry.verdict = 'NO_MATCH'; kv.m.set(k, row);
  const v = await L.verify(); assert.equal(v.ok, false); assert.ok(v.problems.some((p) => /does not recompute/.test(p)));
});

test('ledger: concurrent appends stay a single chain', async () => {
  const L = createLedger({ kv: memKv(), send: async () => ({ txHash: 'a'.repeat(64) }), status: async () => ({}) });
  await Promise.all([...Array(20)].map((_, i) => L.append({ i })));
  const v = await L.verify(); assert.equal(v.ok, true); assert.equal(v.entries, 20);
});

test('ledger head anchor: 45-byte PVOH1 payload, gap respected, unknown status never resent, read-back matches', async () => {
  let t = Date.parse('2026-11-28T08:00:00Z'); const sent = [];
  let fail = null;
  const kv = memKv();
  const L = createLedger({ kv, now: () => t, send: async (hex) => { if (fail) { const e = fail; fail = null; throw e; } sent.push(hex); return { txHash: String(sent.length).padStart(64, '0') }; },
    status: async (h) => ({ status: 'finalized', dataHex: sent[Number(h) - 1] }) });
  assert.equal((await L.anchorHead()).skipped, 'empty');
  await L.append({ x: 1 });
  const a1 = await L.anchorHead();
  assert.equal(a1.state, 'sent'); assert.equal(Buffer.from(a1.data_hex, 'hex').length, 45);
  assert.deepEqual(parseHeadBytes(a1.data_hex), { seq: 1, head: (await L.head()).hash });
  assert.equal((await L.anchorHead()).skipped, 'head already anchored');
  await L.append({ x: 2 });
  assert.equal((await L.anchorHead()).skipped, 'not due');
  t += 11 * 60_000;
  fail = new Error('socket hang up'); // status unknown
  const a2 = await L.anchorHead({ urgent: true });
  assert.equal(a2.state, 'unknown'); assert.equal(sent.length, 1);
  assert.equal((await L.anchorHead({ urgent: true })).skipped, 'head already anchored', 'an unknown-status anchor is not resent');
  const v = await L.verify(); assert.equal(v.ok, true); assert.equal(v.anchors[0].matches_ledger, true);
  assert.equal(headBytesHex(1, 'f'.repeat(64)).length, 90);
});

test('approval: real wallet signature verifies against the account keys; wrong key, wrong message, expiry refused; ledger + anchor', async () => {
  const sk = randomBytes(32); const pk = Buffer.from(await ed.getPublicKeyAsync(sk)).toString('hex');
  const signer = buildBasicAccountSigner(sk.toString('hex'));
  const info = { accountAddress: AccountAddress.fromBase58(PAYER), accountThreshold: 1, accountCredentials: { 0: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pk } } } } } } } };
  let t = Date.now(); const kv = memKv();
  const ledger = createLedger({ kv, now: () => t, send: async () => ({ txHash: 'b'.repeat(64) }), status: async () => ({}) });
  const vop = { check: async ({ payee }) => ({ verdict: payee === PAYEE ? 'CLOSE_MATCH' : 'NO_MATCH', evidence_hash: 'e'.repeat(64), payable: false }) };
  const ap = createApprovals({ kv, vop, seller: SELLER, accountInfo: async () => info, ledger, hitWindow: async () => ({ allowed: true }), now: () => t });
  await assert.rejects(ap.request({ payer: PAYER, payee: SELLER, name: 'X', amount_micro: '1000' }, 'ip'), (e) => e.code === 'no_match');
  const r = await ap.request({ payer: PAYER, payee: PAYEE, name: 'Ada Lovelace Ltd', amount_micro: '1000000' }, 'ip');
  assert.match(r.message, /I approve paying 1 CCD to account 4MDjZp/); assert.match(r.message, /CLOSE_MATCH \(evidence e{64}\)/);
  const good = await signMessage(AccountAddress.fromBase58(PAYER), r.message, signer);
  const otherSigner = buildBasicAccountSigner(randomBytes(32).toString('hex'));
  await assert.rejects(ap.verify(r.approval_id, { signature: await signMessage(AccountAddress.fromBase58(PAYER), r.message, otherSigner) }), (e) => e.code === 'bad_signature');
  await assert.rejects(ap.verify(r.approval_id, { signature: await signMessage(AccountAddress.fromBase58(PAYER), `${r.message} tampered`, signer) }), (e) => e.code === 'bad_signature');
  const v = await ap.verify(r.approval_id, { signature: JSON.stringify(good) });
  assert.equal(v.approved, true); assert.match(v.approval_hash, /^[0-9a-f]{64}$/); assert.equal(v.ledger.seq, 1); assert.equal(v.anchor.tx_hash, 'b'.repeat(64));
  assert.equal((await ap.valid(r.approval_id, { payer: PAYER, payee: PAYEE, amount_micro: '1000000' })).approved, true);
  await assert.rejects(ap.valid(r.approval_id, { payer: PAYER, payee: PAYEE, amount_micro: '2000000' }), (e) => e.code === 'approval_mismatch');
  t += 31 * 60_000;
  await assert.rejects(ap.valid(r.approval_id, { payer: PAYER, payee: PAYEE, amount_micro: '1000000' }), (e) => e.code === 'expired');
  const r2 = await ap.request({ payer: PAYER, payee: PAYEE, name: 'Ada Lovelace Ltd', amount_micro: '1000' }, 'ip');
  t += 11 * 60_000;
  await assert.rejects(ap.verify(r2.approval_id, { signature: good }), (e) => e.code === 'expired');
});
