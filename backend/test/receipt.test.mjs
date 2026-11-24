// PayOnce backend — walletless receipt tests (live, testnet only, read-only).
// Run: node --test test/receipt.test.mjs
// No mocks: every test reads the live testnet node and real invoice documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildReceipt, computeRecordHash, receiptIdFor } from '../src/receipt/build.mjs';
import { verifyReceipt } from '../src/receipt/verify.mjs';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc6 = readFileSync(join(BACKEND, 'test', 'invoices', 'invoice-006-ccd.txt'));
const doc7 = readFileSync(join(BACKEND, 'test', 'invoices', 'invoice-007-eudemo.txt'));

// Live proof hashes (test/live-e2e-2026-11-24.json).
const PROOF = JSON.parse(readFileSync(join(BACKEND, 'test', 'live-e2e-2026-11-24.json'), 'utf8'));
const HASHES_6 = { registerTx: PROOF.railA.registerTx, payTx: PROOF.railA.payTx };
const HASHES_7 = {
  registerTx: PROOF.railB.registerTx,
  reserveTx: PROOF.railB.reserveTx,
  transferTx: PROOF.railB.transferTx,
  confirmTx: PROOF.railB.confirmTx,
};
// A second, UNCONFIRMED 0.01 EUDemo transfer to the same payee — the
// receipt must pin the CONFIRMED transfer tx, not just any transfer.
const UNCONFIRMED_TRANSFER_7 = 'ddf21bf7c38af5db728bf069a727fb49cb0d6b7ee915ebb6f8da3ff468aa3328';

test('build+verify round-trip live for payable 6 (CCD, 12/12)', async () => {
  const receipt = await buildReceipt({ payableId: 6, ...HASHES_6, docBytes: doc6 });
  assert.equal(receipt.payableId, 6);
  assert.equal(receipt.asset, 'CCD');
  assert.equal(receipt.amount, '500000');
  assert.equal(receipt.payTx, HASHES_6.payTx);
  assert.equal(receipt.registerTx, HASHES_6.registerTx);
  assert.equal(receipt.network, 'testnet');
  assert.equal(receipt.registry, '<13149,0>');
  assert.equal(receipt.verifier.passed, 12);
  assert.equal(receipt.verifier.total, 12);
  assert.equal(receipt.verifier.allPass, true);
  assert.equal(receipt.receiptId, receiptIdFor(6, HASHES_6.payTx));
  assert.match(receipt.nonce, /^[0-9a-f]{32}$/);
  assert.ok(receipt.footer.includes('Testnet receipt'));

  const result = await verifyReceipt(receipt, { docBytes: doc6 });
  assert.equal(result.allPass, true, `failures: ${JSON.stringify(result.failures)}`);
  assert.equal(result.failures.length, 0);
});

test('build+verify round-trip live for payable 7 (EUDemo, 15/15)', async () => {
  const receipt = await buildReceipt({ payableId: 7, ...HASHES_7, docBytes: doc7 });
  assert.equal(receipt.payableId, 7);
  assert.equal(receipt.asset, 'EUDemo');
  assert.equal(receipt.amount, '10000');
  assert.equal(receipt.transferTx, HASHES_7.transferTx);
  assert.equal(receipt.reserveTx, HASHES_7.reserveTx);
  assert.equal(receipt.confirmTx, HASHES_7.confirmTx);
  assert.equal(receipt.verifier.passed, 15);
  assert.equal(receipt.verifier.total, 15);
  assert.equal(receipt.verifier.allPass, true);
  assert.equal(receipt.receiptId, receiptIdFor(7, HASHES_7.transferTx));

  const result = await verifyReceipt(receipt, { docBytes: doc7 });
  assert.equal(result.allPass, true, `failures: ${JSON.stringify(result.failures)}`);
  assert.equal(result.failures.length, 0);
});

test('verify fails on tampered doc bytes (doc-hash check)', async () => {
  const receipt = await buildReceipt({ payableId: 6, ...HASHES_6, docBytes: doc6 });
  const tamperedDoc = Buffer.concat([doc6, Buffer.from('\nTAMPERED')]);
  const result = await verifyReceipt(receipt, { docBytes: tamperedDoc });
  assert.equal(result.allPass, false);
  const ids = result.failures.map((f) => f.id);
  assert.ok(ids.includes('RCPT-03'), `expected RCPT-03 in failures, got ${ids}`);
  assert.ok(ids.includes('CCD-12'), `expected CCD-12 in failures, got ${ids}`);
});

test('verify fails on tampered stored tx hash (pins the CONFIRMED transfer)', async () => {
  const receipt = await buildReceipt({ payableId: 7, ...HASHES_7, docBytes: doc7 });
  // Swap in the other, unconfirmed transfer to the same payee.
  const tampered = { ...receipt, transferTx: UNCONFIRMED_TRANSFER_7 };
  const result = await verifyReceipt(tampered, { docBytes: doc7 });
  assert.equal(result.allPass, false);
  const ids = result.failures.map((f) => f.id);
  assert.ok(ids.includes('PLT-11'), `expected PLT-11 (stored-tx-hash-matches) in failures, got ${ids}`);
  assert.ok(ids.includes('RCPT-01'), `expected RCPT-01 (receipt-id) in failures, got ${ids}`);
});

test('verify fails on tampered stored CCD pay tx', async () => {
  const receipt = await buildReceipt({ payableId: 6, ...HASHES_6, docBytes: doc6 });
  const tampered = { ...receipt, payTx: receipt.registerTx };
  const result = await verifyReceipt(tampered, { docBytes: doc6 });
  assert.equal(result.allPass, false);
  assert.ok(result.failures.length > 0);
});

test('build throws for an Unpaid payable (payable 3)', async () => {
  await assert.rejects(
    () => buildReceipt({ payableId: 3, registerTx: '0'.repeat(64), docBytes: doc7 }),
    /not Paid/,
  );
});

test('recordHash recomputes from the canonical receipt JSON', async () => {
  const receipt = await buildReceipt({ payableId: 6, ...HASHES_6, docBytes: doc6 });
  const { recordHash, ...without } = receipt;
  assert.equal(computeRecordHash(without), recordHash);
  // Any field change breaks the stored record hash.
  const tampered = { ...receipt, amount: '1' };
  const result = await verifyReceipt(tampered, { docBytes: doc6 });
  assert.equal(result.allPass, false);
  assert.ok(result.failures.some((f) => f.id === 'RCPT-02'));
});

test('CLI build+verify smoke test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'payonce-receipt-'));
  const out = join(dir, 'receipt-006.json');
  const built = execFileSync(
    'node',
    ['src/receipt/cli.mjs', 'build', '6', '--doc', 'test/invoices/invoice-006-ccd.txt', '--out', out],
    { cwd: BACKEND, encoding: 'utf8' },
  );
  assert.match(built, /Receipt built for payable 6/);
  const receipt = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(receipt.verifier.passed, 12);

  const verified = execFileSync(
    'node',
    ['src/receipt/cli.mjs', 'verify', out, '--doc', 'test/invoices/invoice-006-ccd.txt'],
    { cwd: BACKEND, encoding: 'utf8' },
  );
  assert.match(verified, /RECEIPT VERIFIED/);

  // CLI verify exits non-zero on a tampered receipt.
  const tamperedPath = join(dir, 'receipt-tampered.json');
  writeFileSync(tamperedPath, JSON.stringify({ ...receipt, transferTx: undefined, payTx: receipt.registerTx }));
  assert.throws(
    () => execFileSync('node', ['src/receipt/cli.mjs', 'verify', tamperedPath, '--doc', 'test/invoices/invoice-006-ccd.txt'], { cwd: BACKEND, encoding: 'utf8' }),
    /Command failed/,
  );
});
