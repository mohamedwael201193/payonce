// PayOnce backend — walletless receipt verifier (EU AI Act Art. 12 record).
// verifyReceipt() re-runs the WHOLE verification from chain alone, using
// ONLY the receipt's own fields + the invoice doc bytes: it re-fetches the
// live view, tx statuses, block times and registry balance, re-runs the
// keyless verifier, checks the stored docHash against sha256(docBytes),
// checks recordHash recomputes, checks receiptId recomputes, and checks
// the stored fields match the live view. No wallet, no key, no env.
// Chain-fetch failures are reported as FAIL checks, never thrown, so a
// caller always gets a verdict object.
import { createHash } from 'node:crypto';
import { grpcClient, getTxStatus, getBlockTime } from '../chain.mjs';
import { getPayable, getRegistryBalance } from '../registry.mjs';
import { decodeLoggedEvents } from '../events.mjs';
import { verifyCcd, verifyPlt } from '../verifier/checks.mjs';
import { sha256Hex, canonicalJson, receiptIdFor, computeRecordHash } from './build.mjs';

function check(id, name, ok, detail) {
  return { id, name, status: ok ? 'PASS' : 'FAIL', detail: detail ?? '' };
}

/**
 * Re-verify a receipt from chain alone.
 * @param {object} receipt - receipt object as produced by buildReceipt
 * @param {object} opts - { docBytes: Buffer }
 * @returns {{ allPass: boolean, checks: Array, failures: Array }}
 */
export async function verifyReceipt(receipt, { docBytes } = {}) {
  const checks = [];
  const fail = (id, name, detail) => checks.push(check(id, name, false, detail));
  const pass = (id, name, detail) => checks.push(check(id, name, true, detail));

  if (!receipt || typeof receipt !== 'object') throw new Error('verifyReceipt: receipt object is required');
  if (!Buffer.isBuffer(docBytes) || docBytes.length === 0) throw new Error('verifyReceipt: docBytes (invoice document) is required');

  const payableId = receipt.payableId;
  const isCcd = receipt.asset === 'CCD';
  const paymentTx = isCcd ? receipt.payTx : receipt.transferTx;

  // --- Receipt-integrity checks (no chain needed) ---
  const expectedReceiptId = paymentTx ? receiptIdFor(payableId, paymentTx) : null;
  if (expectedReceiptId && expectedReceiptId === receipt.receiptId) {
    pass('RCPT-01', 'receipt-id-recomputes', `receiptId=${String(receipt.receiptId).slice(0, 16)}…`);
  } else {
    fail('RCPT-01', 'receipt-id-recomputes', `stored=${String(receipt.receiptId).slice(0, 16)}…, recomputed=${String(expectedReceiptId).slice(0, 16)}…`);
  }

  const { recordHash, ...withoutRecordHash } = receipt;
  if (recordHash && computeRecordHash(withoutRecordHash) === recordHash) {
    pass('RCPT-02', 'record-hash-recomputes', `recordHash=${String(recordHash).slice(0, 16)}…`);
  } else {
    fail('RCPT-02', 'record-hash-recomputes', `stored=${String(recordHash).slice(0, 16)}…, recomputed=${computeRecordHash(withoutRecordHash).slice(0, 16)}…`);
  }

  const docHash = sha256Hex(docBytes);
  if (docHash === receipt.docHash) {
    pass('RCPT-03', 'doc-hash-matches', `sha256(doc)=${docHash.slice(0, 16)}…`);
  } else {
    fail('RCPT-03', 'doc-hash-matches', `sha256(doc)=${docHash.slice(0, 16)}…, stored=${String(receipt.docHash).slice(0, 16)}…`);
  }

  // --- Live chain re-verification ---
  const client = grpcClient();
  let view = null;
  let balance = null;
  try {
    view = await getPayable(client, payableId);
    balance = await getRegistryBalance(client);
  } catch (e) {
    fail('RCPT-04', 'live-view-readable', `get_payable failed: ${e.message}`);
    const failures = checks.filter((c) => c.status === 'FAIL');
    return { allPass: false, checks, failures };
  }

  const fieldMismatches = [];
  for (const [field, live] of [
    ['seller', view.seller],
    ['payer', view.record?.payer],
    ['payee', view.payee],
    ['amount', view.amount],
    ['asset', view.asset],
    ['due', view.due],
    ['docHash', view.docHash],
    ['paidAt', view.record?.paidAt],
  ]) {
    if (String(receipt[field]) !== String(live)) fieldMismatches.push(`${field}: stored=${receipt[field]}, live=${live}`);
  }
  if (fieldMismatches.length === 0) {
    pass('RCPT-04', 'stored-fields-match-live-view', 'seller/payer/payee/amount/asset/due/docHash/paidAt all match');
  } else {
    fail('RCPT-04', 'stored-fields-match-live-view', fieldMismatches.join('; '));
  }

  if (receipt.registerTx) {
    try {
      const rs = await getTxStatus(client, receipt.registerTx);
      if (rs.status === 'finalized') pass('RCPT-05', 'register-tx-finalized', `status=${rs.status}`);
      else fail('RCPT-05', 'register-tx-finalized', `status=${rs.status}`);
    } catch (e) {
      fail('RCPT-05', 'register-tx-finalized', `register tx not found: ${e.message}`);
    }
  } else {
    fail('RCPT-05', 'register-tx-finalized', 'receipt has no registerTx');
  }

  // Re-run the keyless verifier from chain alone.
  try {
    const paySummary = await getTxStatus(client, paymentTx);
    const payBlockTime = await getBlockTime(client, paySummary.blockHash);
    // G7 fix-back-3 MF-2: the view here is the v1 registry <13149,0>
    // (getPayable above) — bind it explicitly, as in build.mjs.
    const ctx = { payableId, txHash: paymentTx, summary: paySummary, blockTime: payBlockTime, view, balance, docBytes, registryIndex: '13149' };
    let result;
    if (isCcd) {
      result = verifyCcd(ctx);
    } else {
      if (receipt.reserveTx) {
        const rs = await getTxStatus(client, receipt.reserveTx);
        const rbt = await getBlockTime(client, rs.blockHash);
        const upd = (rs.summary?.events ?? []).find(
          (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.reserve_plt',
        );
        ctx.reserve = { blockTime: rbt, logged: upd ? decodeLoggedEvents(upd) : [] };
      }
      if (receipt.confirmTx) {
        const cs = await getTxStatus(client, receipt.confirmTx);
        const cbt = await getBlockTime(client, cs.blockHash);
        // G7 fix-back-4 ADV-2: see build.mjs — PLT-12 requires the
        // PltConfirmed event, not just the block time.
        const cupd = (cs.summary?.events ?? []).find(
          (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.confirm_plt',
        );
        ctx.confirm = { blockTime: cbt, logged: cupd ? decodeLoggedEvents(cupd) : [] };
      }
      result = verifyPlt(ctx);
    }
    checks.push(...result.checks);
  } catch (e) {
    fail('RCPT-06', 'payment-tx-reverifiable', `payment tx ${paymentTx} could not be re-verified: ${e.message}`);
  }

  const failures = checks.filter((c) => c.status === 'FAIL');
  return { allPass: failures.length === 0, checks, failures };
}

export { sha256Hex, canonicalJson };
