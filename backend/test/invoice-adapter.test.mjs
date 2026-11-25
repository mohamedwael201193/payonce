// PayOnce backend — D5 invoice-text adapter tests (node --test).
//
// What is proven here (all against REAL files / REAL verifier code, no mocks
// of the payment path):
//   1. ScriptedAdapter extracts amount/payee/due/invoiceId from both REAL
//      test invoices with confidence 1.0 and no warnings.
//   2. The adapter is OFF by default: module-level parseInvoiceText returns
//      { disabled: true } with no enableAdapter() call and no env var.
//   3. enableAdapter('scripted') turns it on; disableAdapter() turns it off.
//   4. PAYONCE_INVOICE_ADAPTER=scripted enables it with no code call.
//   5. LlmAdapter without credentials throws the D5-off message; with
//      credentials its parse is still a stub (throws, never calls an API),
//      and the key is never exposed on the instance.
//   6. The guard passes on the REAL payment-path files.
//   7. The guard catches a tampered file (proves it is a real check).
//   8. A tampered invoice still extracts the CHANGED amount (adapter reads
//      text, not chain state) — AND the REAL verifier's CCD-12 doc-hash
//      check still FAILS on that tampered text, proving adapter output can
//      never override the on-chain hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ScriptedAdapter,
  LlmAdapter,
  InvoiceTextAdapter,
  registerAdapter,
  getAdapter,
  listAdapters,
  enableAdapter,
  disableAdapter,
  isAdapterEnabled,
  getEnabledAdapterName,
  parseInvoiceText,
  DISABLED_MESSAGE,
  ADAPTER_ENABLED,
} from '../src/invoice-adapter/adapter.mjs';
import {
  assertNoLlmInPaymentPath,
  PAYMENT_PATH_FILES,
} from '../src/invoice-adapter/guard.mjs';
import { verifyCcd } from '../src/verifier/checks.mjs';

// Clean slate: no env-var enable, nothing enabled (defensive — the module
// already defaults to OFF, but a test must never depend on run order).
delete process.env.PAYONCE_INVOICE_ADAPTER;
disableAdapter();

const INVOICE_006 = readFileSync(
  fileURLToPath(new URL('./invoices/invoice-006-ccd.txt', import.meta.url)),
  'utf8',
);
const INVOICE_007 = readFileSync(
  fileURLToPath(new URL('./invoices/invoice-007-eudemo.txt', import.meta.url)),
  'utf8',
);
const PAYEE = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

test('D5-01 disabled by default: parse returns { disabled: true }', () => {
  assert.equal(isAdapterEnabled(), false);
  assert.equal(getEnabledAdapterName(), null);
  assert.equal(ADAPTER_ENABLED, false);
  const out = parseInvoiceText(INVOICE_006);
  assert.equal(out.disabled, true);
  assert.deepEqual(out.fields, {});
  assert.equal(out.confidence, 0);
  assert.equal(out.source, 'disabled');
  assert.match(out.warnings.join(' '), /OFF by default/);
});

test('D5-02 ScriptedAdapter extracts invoice-006 (CCD) with confidence 1.0', () => {
  const adapter = new ScriptedAdapter();
  assert.ok(adapter instanceof InvoiceTextAdapter);
  const out = adapter.parseInvoiceText(INVOICE_006);
  assert.deepEqual(out.fields, {
    amount: '0.5',
    currency: 'CCD',
    payee: PAYEE,
    due: '2026-11-25T07:55:46.945Z',
    invoiceId: '6',
  });
  assert.equal(out.confidence, 1.0);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.source, 'scripted');
  // Extracted text fields ONLY — never a hash, decision, or approval.
  assert.ok(!('hash' in out) && !('docHash' in out));
  assert.ok(!('decision' in out) && !('approved' in out) && !('approve' in out));
  assert.ok(!JSON.stringify(out).includes('sha256'));
});

test('D5-03 ScriptedAdapter extracts invoice-007 (EUDemo) with confidence 1.0', () => {
  const out = new ScriptedAdapter().parseInvoiceText(INVOICE_007);
  assert.deepEqual(out.fields, {
    amount: '0.01',
    currency: 'EUDemo',
    payee: PAYEE,
    due: '2026-12-26T12:00:00.000Z',
    invoiceId: '7',
  });
  assert.equal(out.confidence, 1.0);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.source, 'scripted');
});

test('D5-04 registry: scripted is registered; bad adapters and unknown names throw', () => {
  assert.ok(listAdapters().includes('scripted'));
  assert.ok(getAdapter('scripted') instanceof ScriptedAdapter);
  assert.throws(() => getAdapter('no-such-adapter'), /no adapter registered/);
  assert.throws(
    () => registerAdapter('bad', {}),
    /must implement parseInvoiceText/,
  );
  assert.throws(() => registerAdapter('', new ScriptedAdapter()), /non-empty string/);
  assert.throws(() => enableAdapter('no-such-adapter'), /no adapter registered/);
});

test('D5-05 enabling the scripted adapter works; disabling restores OFF', () => {
  enableAdapter('scripted');
  assert.equal(isAdapterEnabled(), true);
  assert.equal(getEnabledAdapterName(), 'scripted');
  assert.equal(ADAPTER_ENABLED, true);
  const out = parseInvoiceText(INVOICE_007);
  assert.equal(out.disabled, undefined);
  assert.equal(out.fields.amount, '0.01');
  assert.equal(out.fields.currency, 'EUDemo');
  assert.equal(out.confidence, 1.0);
  disableAdapter();
  assert.equal(isAdapterEnabled(), false);
  assert.equal(parseInvoiceText(INVOICE_007).disabled, true);
});

test('D5-06 PAYONCE_INVOICE_ADAPTER env var enables it with no code call', () => {
  try {
    process.env.PAYONCE_INVOICE_ADAPTER = 'scripted';
    assert.equal(isAdapterEnabled(), true);
    assert.equal(getEnabledAdapterName(), 'scripted');
    const out = parseInvoiceText(INVOICE_006);
    assert.equal(out.fields.amount, '0.5');
    assert.equal(out.fields.invoiceId, '6');
  } finally {
    delete process.env.PAYONCE_INVOICE_ADAPTER;
  }
  // Unsetting the env var disables it again immediately.
  assert.equal(isAdapterEnabled(), false);
  assert.equal(parseInvoiceText(INVOICE_006).disabled, true);
  // An env var naming an UNREGISTERED adapter enables nothing.
  try {
    process.env.PAYONCE_INVOICE_ADAPTER = 'no-such-adapter';
    assert.equal(isAdapterEnabled(), false);
  } finally {
    delete process.env.PAYONCE_INVOICE_ADAPTER;
  }
});

test('D5-07 LlmAdapter without credentials throws the D5-off message', () => {
  for (const bad of [undefined, {}, { provider: 'openai' }, { provider: 'openai', apiKey: 'sk-fake' }]) {
    assert.throws(
      () => new LlmAdapter(bad),
      (e) => e instanceof Error && e.message.includes(DISABLED_MESSAGE),
      `expected D5-off throw for ${JSON.stringify(bad)}`,
    );
  }
});

test('D5-08 LlmAdapter WITH credentials is still a stub: parse throws, key never exposed', () => {
  const fakeKey = 'sk-fake-test-key-not-real';
  const adapter = new LlmAdapter({ provider: 'openai', apiKey: fakeKey, model: 'gpt-test' });
  assert.equal(adapter.sourceTag, 'llm:gpt-test');
  assert.throws(() => adapter.parseInvoiceText(INVOICE_006), /stub: no live provider call/i);
  // The key is held in a private field: not enumerable, not in JSON, not a prop.
  assert.ok(!('apiKey' in adapter));
  assert.ok(!JSON.stringify(adapter).includes(fakeKey));
  assert.ok(!Object.keys(adapter).includes('apiKey'));
});

test('D5-09 guard passes on the REAL payment-path files', () => {
  const result = assertNoLlmInPaymentPath();
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.checked.length, PAYMENT_PATH_FILES.length);
  assert.ok(result.checked.length >= 7);
  for (const f of PAYMENT_PATH_FILES) assert.ok(result.checked.includes(f));
});

test('D5-10 guard catches a tampered file (proves the check is real)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'payonce-guard-'));
  try {
    const dirty = join(dir, 'dirty.mjs');
    writeFileSync(dirty, '// totally innocent\nconst x = "llm";\n');
    assert.throws(
      () => assertNoLlmInPaymentPath([dirty]),
      (e) => e instanceof Error && /LLM FOUND IN PAYMENT PATH/.test(e.message) && e.message.includes('llm'),
    );
    const clean = join(dir, 'clean.mjs');
    writeFileSync(clean, '// nothing to see here\n');
    assert.equal(assertNoLlmInPaymentPath([clean]).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal verifyCcd context: only the CCD-12 doc-hash outcome is asserted. */
function ccdCtx({ docBytes, docHash }) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(6n);
  return {
    payableId: 6,
    txHash: '00'.repeat(32),
    summary: {
      status: 'finalized',
      summary: {
        transactionType: 'contract update',
        events: [
          {
            tag: 'Updated',
            address: { index: '13149' },
            receiveName: 'payable_registry.pay_ccd',
            message: idBuf.toString('hex'),
          },
        ],
      },
    },
    blockTime: { slotTime: '2026-11-24T00:00:00.000Z' },
    view: {
      amount: '500000',
      payee: PAYEE,
      status: 'Paid',
      dueMs: Date.parse('2026-11-25T07:55:46.945Z'),
      due: '2026-11-25T07:55:46.945Z',
      docHash,
    },
    balance: '0',
    docBytes,
    // G7 fix-back-3 MF-2: registry-less offline fixture — explicit opt-in.
    unbound: true,
  };
}

test('D5-11 tampered invoice: adapter reads the CHANGED amount — verifier hash still FAILS', () => {
  const tampered = INVOICE_006.replace('0.5 CCD', '9.99 CCD');
  assert.notEqual(tampered, INVOICE_006);

  // The adapter reads TEXT, not chain state: it reports the tampered amount.
  const extracted = new ScriptedAdapter().parseInvoiceText(tampered);
  assert.equal(extracted.fields.amount, '9.99');
  assert.equal(extracted.fields.currency, 'CCD');
  assert.equal(extracted.confidence, 1.0);

  // The on-chain stored hash is the hash of the ORIGINAL bytes.
  const originalHash = sha256(Buffer.from(INVOICE_006, 'utf8'));
  assert.notEqual(sha256(Buffer.from(tampered, 'utf8')), originalHash);

  // The REAL verifier's CCD-12 doc-hash check FAILS on the tampered text:
  // adapter output can never override the hash.
  const tamperedResult = verifyCcd(
    ccdCtx({ docBytes: Buffer.from(tampered, 'utf8'), docHash: originalHash }),
  );
  const ccd12Tampered = tamperedResult.checks.find((c) => c.id === 'CCD-12');
  assert.equal(ccd12Tampered.status, 'FAIL');

  // Control: the same check PASSES on the untampered bytes (the check works).
  const originalResult = verifyCcd(
    ccdCtx({ docBytes: Buffer.from(INVOICE_006, 'utf8'), docHash: originalHash }),
  );
  const ccd12Original = originalResult.checks.find((c) => c.id === 'CCD-12');
  assert.equal(ccd12Original.status, 'PASS');
});

test('D5-12 ScriptedAdapter reports missing fields with partial confidence', () => {
  const out = new ScriptedAdapter().parseInvoiceText('PAYONCE TEST INVOICE — payable 9\nAmount: 1 CCD\n');
  assert.equal(out.fields.amount, '1');
  assert.equal(out.fields.invoiceId, '9');
  assert.equal(out.confidence, 0.6); // 3 of 5 fields
  assert.ok(out.warnings.includes('missing field: payee'));
  assert.ok(out.warnings.includes('missing field: due'));
  assert.throws(() => new ScriptedAdapter().parseInvoiceText(42), TypeError);
});
