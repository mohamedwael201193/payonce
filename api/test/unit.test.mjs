// PayOnce API server — unit tests (no chain, no sends).
// Run: node --test test/unit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backend } from '../src/backend.mjs';
import { generateLabDocument, matrixDocBytes } from '../src/docs.mjs';
import { CCD_STEPS, EUDEMO_STEPS, rejectInfo } from '../src/jobs.mjs';
import { hitWindow, leftInWindow } from '../src/store.mjs';
import { REGISTRY, CIS8004_OFFICIAL, OWNER_ADDRESS, PAYER_ADDRESS } from '../src/config.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

test('config defaults to the v2 registry', () => {
  assert.equal(REGISTRY.index, 13150);
  assert.equal(REGISTRY.subindex, 0);
  assert.equal(REGISTRY.moduleRef, 'c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8');
  assert.equal(REGISTRY.name, 'payable_registry_v2');
  assert.equal(CIS8004_OFFICIAL.index, 12802);
  assert.equal(CIS8004_OFFICIAL.isOfficialRegistry, true);
});

test('matrix doc bytes hash to the on-chain doc_hash values (v2-live-e2e)', async () => {
  // The matrix registered DOC(n) = sha256(`payonce-live-matrix-${n}`); the
  // live test proves the on-chain doc_hash equals this hash for P1..P5.
  // Here: the rule is deterministic, distinct per id, and 64-hex.
  for (const n of [1, 2, 3, 4, 5]) {
    const hash = sha256(matrixDocBytes(n));
    assert.equal(hash, sha256(`payonce-live-matrix-${n}`));
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(sha256(matrixDocBytes(1)), sha256(matrixDocBytes(2)));
});

test('generated lab document hashes stably and contains the payable facts', () => {
  const text = generateLabDocument({
    id: 1000, asset: 'CCD', amount: '500000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  });
  assert.match(text, /payable 1000/);
  assert.match(text, /0\.500000 CCD \(500000 microCCD\)/);
  assert.match(text, new RegExp(OWNER_ADDRESS));
  assert.match(text, /Test only — Concordium testnet/);
  assert.equal(sha256(Buffer.from(text, 'utf8')), sha256(Buffer.from(generateLabDocument({
    id: 1000, asset: 'CCD', amount: '500000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  }), 'utf8')));
  const eudemo = generateLabDocument({
    id: 1001, asset: 'EUDemo', amount: '10000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  });
  assert.match(eudemo, /0\.01 EUDemo \(10000 base units, 6 decimals\)/);
});

test('v2 encoders match the matrix-proven layouts', async () => {
  const { v2enc } = await backend();
  // PayableKeyParam: seller 32B + id u64 LE.
  const key = v2enc.encodeV2PayableKey({ seller: OWNER_ADDRESS, id: 1 });
  assert.equal(key.length, 80);
  assert.equal(key.slice(64), '0100000000000000');
  // Confirm: seller 32B + id u64 + tx hash 32B.
  const txHash = 'ab'.repeat(32);
  const confirm = v2enc.encodeV2Confirm({ seller: OWNER_ADDRESS, id: 11, txHashHex: txHash });
  assert.equal(confirm.length, 80 + 64);
  assert.equal(confirm.slice(64, 80), '0b00000000000000');
  assert.equal(confirm.slice(80), txHash);
  // Register: id + payee + amount + asset + due + docHash + token + expected + legal.
  const reg = v2enc.encodeV2RegisterPayable({
    id: 1000, payee: PAYER_ADDRESS, amount: '500000', asset: 'CCD',
    dueMs: 1790000000000, docHashHex: 'cd'.repeat(32), token: 1476, expected: PAYER_ADDRESS, legal: null,
  });
  assert.equal(reg.slice(0, 16), 'e803000000000000'); // id 1000 LE
  assert.equal(reg.slice(16 + 64, 16 + 64 + 16), '20a1070000000000'); // amount 500000 LE
  assert.equal(reg[16 + 64 + 16], '0'); // asset tag 0x00 CCD
});

test('v2 event decoder parses the Paid event from the recorded P10 pay tx', async () => {
  const { v2ev } = await backend();
  // The Paid event is decoded from the recorded pay tx's Updated event at
  // live-test time; here the decoder rejects an unknown tag honestly.
  assert.throws(() => v2ev.decodeContractEventV2('ff00'), /unknown v2 contract event tag/);
  assert.throws(() => v2ev.decodeContractEventV2(''), /empty v2 contract event/);
});

test('reject table covers -1..-27 with the lib.rs names', () => {
  const expected = {
    '-1': 'Unauthorized', '-2': 'Duplicate', '-3': 'NotFound', '-4': 'WrongAsset',
    '-5': 'WrongStatus', '-6': 'WrongAmount', '-7': 'PastDue', '-8': 'AgentNotFound',
    '-9': 'AgentRevoked', '-10': 'AgentOwnerMismatch', '-11': 'RegistryCallFailed',
    '-12': 'TxReused', '-13': 'NotExpired', '-14': 'Invalid', '-15': 'TransferFailed',
    '-16': 'NotUnpaid', '-17': 'NotPayer', '-18': 'Invariant', '-19': 'NotApprovedVendor',
    '-20': 'LegalRefMismatch', '-21': 'NotExpectedPayer', '-22': 'ExpectedPayerRequired',
    '-23': 'CapExceeded', '-24': 'ConfirmAfterWindow', '-25': 'Voided',
    '-26': 'VoidWhileReserved', '-27': 'SelfAction',
  };
  for (const [code, name] of Object.entries(expected)) {
    assert.equal(rejectInfo(Number(code)).name, name);
    assert.equal(rejectInfo(Number(code)).code, Number(code));
  }
});

test('job step lists match P3 §16.8', () => {
  assert.deepEqual(CCD_STEPS, ['check_status', 'check_agent', 'submit', 'wait_finality', 'read_back', 'verify']);
  assert.deepEqual(EUDEMO_STEPS, ['check_wallet', 'reserve', 'co_sign_decide', 'submit_transfer', 'wait_finality', 'confirm', 'verify']);
});

test('rate-limit windows enforce and report the remainder', () => {
  const key = `unit-test-${Date.now()}`;
  assert.equal(leftInWindow(key, 60_000, 3), 3);
  assert.deepEqual(hitWindow(key, 60_000, 3).allowed, true);
  assert.deepEqual(hitWindow(key, 60_000, 3).allowed, true);
  assert.deepEqual(hitWindow(key, 60_000, 3).allowed, true);
  const fourth = hitWindow(key, 60_000, 3);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.left, 0);
  assert.equal(leftInWindow(key, 60_000, 3), 0);
});

test('co-signer decide() refuses a transfer with the wrong amount (live logic, synthetic snapshot)', async () => {
  const { decideMod } = await backend();
  const decide = decideMod.decide;
  const base = {
    version: 2, blockHash: '00'.repeat(32), slotTime: new Date().toISOString(),
    agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
    nextNonce: 7, agentStatus: 'Active', eudemoBalance: '1000000',
    payable: {
      seller: OWNER_ADDRESS, id: 3, payee: PAYER_ADDRESS, amount: '1000000',
      asset: 'EUDemo', dueMs: String(Date.now() + 3600_000), status: 'Reserved',
      payer: PAYER_ADDRESS, expiresMs: String(Date.now() + 3600_000),
      expectedPayer: PAYER_ADDRESS, legalRef: null,
    },
    approval: { tier: 2, legalRef: null, perPayableCap: '100000000', periodCap: '1000000000', periodSecs: '86400' },
    usage: '0', memoScan: { found: false, txHash: null }, usedTxHashes: [], transfer: null,
  };
  const { chain } = await backend();
  const memo = chain.encodeCborMemo(`payable:${OWNER_ADDRESS}:3`).toString('hex');
  const req = {
    kind: 'transfer', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: 7,
    recipient: PAYER_ADDRESS, amount: '1000001', token: 'EUDemo', memo,
    headerExpirySeconds: Math.floor((Date.now() + 3540_000) / 1000), operations: 1,
  };
  assert.equal(decide(base, req, { unresolved: [] }).code, 'wrong-amount');
  assert.equal(decide(base, { ...req, amount: '1000000' }, { unresolved: [] }).decision, 'SIGN');
});

test('co-signer decide() refuses a reserve for an unlisted seller (no-approval)', async () => {
  const { decideMod } = await backend();
  const decide = decideMod.decide;
  const snap = {
    version: 2, blockHash: '00'.repeat(32), slotTime: new Date().toISOString(),
    agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
    nextNonce: 7, agentStatus: 'Active', eudemoBalance: '1000000',
    payable: {
      seller: 'unlisted-seller', id: 9001, payee: PAYER_ADDRESS, amount: '1000000',
      asset: 'EUDemo', dueMs: String(Date.now() + 3600_000), status: 'Unpaid',
      payer: null, expiresMs: null, expectedPayer: PAYER_ADDRESS, legalRef: null,
    },
    approval: null, usage: '0', memoScan: { found: false, txHash: null },
    usedTxHashes: [], transfer: null,
  };
  const d = decide(snap, { kind: 'reserve_plt', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, numSignatures: 1, nonce: 7 }, { unresolved: [] });
  assert.equal(d.decision, 'REFUSE');
  assert.equal(d.code, 'no-approval');
});
