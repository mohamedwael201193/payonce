// The recorded hosted x402 settle (qa/x402-settle-live.mjs, 2026-11-26) is internally consistent and holds no
// secret. This is a file check, not a live check: the live proof is the transactions it names, which anyone can
// re-read from the chain (the keyless verifier line in the file is how it was checked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./x402-hosted-settle-2026-11-26.json', import.meta.url));
const raw = readFileSync(path, 'utf8');
const ev = JSON.parse(raw);
const HASH = /^[0-9a-f]{64}$/;

test('hosted settle evidence: every transaction is a full 64-hex hash and the payable ended Paid', () => {
  assert.equal(ev.ok, true);
  assert.equal(ev.network, 'testnet');
  for (const h of [ev.payable.register_tx, ev.payable.reserve_tx, ev.payable.confirm_tx, ev.steps.settle.transaction]) assert.match(h, HASH);
  assert.equal(ev.payable.status_after, 'Paid');
});

test('hosted settle evidence: the facilitator verified, and the settled transfer was read back from the chain', () => {
  assert.equal(ev.steps.verify.isValid, true);
  assert.equal(ev.steps.verify.facilitator, 'hosted');
  assert.ok(ev.steps.verify.binding_checks.every((c) => c.ok), 'every PayOnce binding check passed');
  // The facilitator's own settle answer is recorded as it was (it can lag on finalization);
  // the proof is the read-back, never the facilitator word alone.
  assert.equal(ev.steps.settle_readback.confirmed, true);
  assert.equal(ev.steps.settle_tx_on_chain.status, 'finalized');
  const t = ev.steps.settle_tx_on_chain.events.filter((e) => e.tag === 'TokenTransfer');
  assert.equal(t.length, 1);
  assert.equal(t[0].tokenId, 'EUDemo');
  assert.equal(t[0].amount, ev.amount_base_units);
  assert.equal(t[0].to, ev.payable.payee);
  assert.equal(t[0].from, ev.payable.payer);
});

test('hosted settle evidence: the independent keyless verifier passed 14/14', () => {
  assert.match(ev.steps.keyless_verifier.summary, /ALL CHECKS PASS \(14\/14\)/);
});

test('hosted settle evidence: holds no key, seed or API-key material', () => {
  assert.ok(!/api[-_ ]?key|x-api-key|seed|private/i.test(raw), 'no secret-looking field names');
  assert.ok(!/\b(?:[a-z]{3,10} ){11}[a-z]{3,10}\b/.test(raw), 'no 12-word run');
});
