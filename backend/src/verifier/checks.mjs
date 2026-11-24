// PayOnce backend — keyless verifier, check definitions (v2).
// CCD branch: 12 checks. PLT branch: 14 checks. A `doc` check is appended
// only when an invoice document is supplied; otherwise it is recorded as
// SKIPPED, never silently passed.
// F10 (plan §0): the v1 verifier never checked the pay_ccd parameter nor the
// contract's own Paid event, so a tx for payable 4 passed payable 1's check.
// Checks CCD-04 and CCD-05 close that hole. They are the first thing this
// verifier proves (see test/verify-negatives.test.mjs N-01).
import { createHash } from 'node:crypto';
import { decodeLoggedEvents, decodeContractEvent } from '../events.mjs';
import { canonicalMemo, decodeCborMemo, encodeCborMemo } from '../chain.mjs';

function check(id, name, ok, detail) {
  return { id, name, status: ok ? 'PASS' : 'FAIL', detail: detail ?? '' };
}
function skip(id, name, detail) {
  return { id, name, status: 'SKIP', detail: detail ?? '' };
}

function summarize(checks) {
  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const skipped = checks.filter((c) => c.status === 'SKIP').length;
  return { checks, passed, failed, skipped, total: checks.length, allPass: failed === 0 };
}

/** CCD branch: verify a pay_ccd transaction against a payable id. */
export function verifyCcd(ctx) {
  const { payableId, txHash, summary, blockTime, view, balance, docBytes } = ctx;
  const checks = [];
  checks.push(check('CCD-01', 'tx-finalized', summary.status === 'finalized', `status=${summary.status}`));
  const txType = summary.summary?.transactionType ?? summary.summary?.type ?? '';
  checks.push(check('CCD-02', 'tx-is-contract-update', /update/i.test(String(txType)), `type=${txType}`));
  const updated = (summary.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && String(e.address?.index) === '13149' && e.receiveName === 'payable_registry.pay_ccd',
  );
  checks.push(check('CCD-03', 'update-targets-registry', !!updated, updated ? `receiveName=${updated.receiveName}` : 'no pay_ccd Updated event'));
  // F10-a: the update parameter MUST be the payable id, u64 little-endian.
  let paramId = null;
  if (updated?.message) {
    const msg = Buffer.from(updated.message, 'hex');
    if (msg.length === 8) paramId = Number(msg.readBigUInt64LE(0));
  }
  checks.push(check('CCD-04', 'parameter-binds-payable-id (F10)', paramId === payableId, `parameter id=${paramId}, requested=${payableId}`));
  // F10-b: the contract's own Paid event MUST carry the same id.
  const logged = updated ? decodeLoggedEvents(updated) : [];
  const paid = logged.find((e) => e.event === 'Paid');
  checks.push(check('CCD-05', 'paid-event-binds-payable-id (F10)', !!paid && paid.payableId === payableId, paid ? `Paid event id=${paid.payableId}` : 'no Paid event'));
  checks.push(check('CCD-06', 'paid-event-payer-is-sender', !!paid && paid.payer === summary.summary?.sender, paid ? `payer=${paid.payer}, sender=${summary.summary?.sender}` : 'no Paid event'));
  checks.push(check('CCD-07', 'paid-event-amount-is-stored', !!paid && paid.amount === view.amount, paid ? `event amount=${paid.amount}, stored=${view.amount}` : 'no Paid event'));
  const transferred = (summary.summary?.events ?? []).find((e) => e.tag === 'Transferred');
  const transferredOk =
    !!transferred &&
    String(transferred.from?.index) === '13149' &&
    transferred.to === view.payee &&
    String(transferred.amount) === view.amount;
  checks.push(check('CCD-08', 'transferred-to-stored-payee', transferredOk, transferred ? `to=${transferred.to}, amount=${transferred.amount}, stored payee=${view.payee}, stored amount=${view.amount}` : 'no Transferred event'));
  checks.push(check('CCD-09', 'registry-status-paid', view.status === 'Paid', `status=${view.status}`));
  checks.push(check('CCD-10', 'registry-balance-zero', String(balance) === '0', `balance=${balance} microCCD`));
  const beforeDue = new Date(blockTime.slotTime).getTime() <= Number(view.dueMs);
  checks.push(check('CCD-11', 'payment-before-due', beforeDue, `block time=${blockTime.slotTime}, due=${view.due}`));
  if (docBytes) {
    const hash = createHash('sha256').update(docBytes).digest('hex');
    checks.push(check('CCD-12', 'doc-hash-matches', hash === view.docHash, `sha256(doc)=${hash.slice(0, 16)}…, stored=${view.docHash.slice(0, 16)}…`));
  } else {
    checks.push(skip('CCD-12', 'doc-hash-matches', 'no invoice document supplied; stored doc_hash recorded, not passed'));
  }
  return summarize(checks);
}

/** PLT branch, transfer-only: verify a TokenTransfer against a payable id.
 *  Used by the co-signer confirm gate (before confirm, the payable is still
 *  Reserved — the Paid-status / stored-hash checks do not apply yet). */
export function verifyPltTransfer(ctx) {
  const { payableId, txHash, summary, blockTime, view, reserve } = ctx;
  const checks = [];
  checks.push(check('PLT-01', 'tx-finalized', summary.status === 'finalized', `status=${summary.status}`));
  const transfers = (summary.summary?.events ?? []).filter((e) => e.tag === 'TokenTransfer');
  checks.push(check('PLT-02', 'exactly-one-token-transfer', transfers.length === 1, `TokenTransfer events=${transfers.length}`));
  const t = transfers[0];
  checks.push(check('PLT-03', 'token-is-eudemo', !!t && t.tokenId === 'EUDemo', t ? `tokenId=${t.tokenId}` : 'no TokenTransfer'));
  const payer = view.record?.payer;
  checks.push(check('PLT-04', 'transfer-from-is-payer', !!t && t.from?.address === payer, t ? `from=${t.from?.address}, payer=${payer}` : 'no TokenTransfer'));
  checks.push(check('PLT-05', 'transfer-to-is-payee', !!t && t.to?.address === view.payee, t ? `to=${t.to?.address}, payee=${view.payee}` : 'no TokenTransfer'));
  checks.push(check('PLT-06', 'transfer-amount-is-stored', !!t && String(t.amount?.value) === view.amount, t ? `amount=${t.amount?.value}, stored=${view.amount}` : 'no TokenTransfer'));
  const memo = t ? decodeCborMemo(t.memo ?? '') : { text: '', canonical: false };
  const expectedMemo = canonicalMemo({ id: payableId });
  checks.push(check('PLT-07', 'memo-is-canonical-payable-id', memo.text === expectedMemo, `memo=${JSON.stringify(memo.text)}, expected=${JSON.stringify(expectedMemo)}`));
  checks.push(check('PLT-08', 'memo-bytes-canonical', memo.canonical && memo.text === expectedMemo, 'memo bytes must be exactly the canonical CBOR encoding of the payable id'));
  const beforeDue = new Date(blockTime.slotTime).getTime() <= Number(view.dueMs);
  checks.push(check('PLT-09', 'transfer-before-due', beforeDue, `block time=${blockTime.slotTime}, due=${view.due}`));
  if (reserve) {
    const reserved = reserve.logged?.find((e) => e.event === 'Reserved');
    const reserveOk =
      !!reserved &&
      reserved.payableId === payableId &&
      reserved.payer === payer &&
      new Date(reserve.blockTime.slotTime).getTime() < new Date(blockTime.slotTime).getTime() &&
      new Date(blockTime.slotTime).getTime() <= Number(reserved.expiresMs);
    checks.push(check('PLT-13', 'reservation-precedes-transfer-inside-window', reserveOk, reserved ? `reserved by ${reserved.payer} at ${reserve.blockTime.slotTime}, expires ${reserved.expires}` : 'no Reserved event'));
  } else {
    checks.push(skip('PLT-13', 'reservation-precedes-transfer-inside-window', 'no --reserve-tx supplied; reservation not checked'));
  }
  return summarize(checks);
}

/** PLT branch: verify a TokenTransfer against a payable id (full receipt). */
export function verifyPlt(ctx) {
  const { payableId, txHash, summary, blockTime, view, balance, docBytes, reserve, confirm } = ctx;
  const checks = verifyPltTransfer({ payableId, txHash, summary, blockTime, view, reserve }).checks;
  checks.push(check('PLT-10', 'registry-status-paid', view.status === 'Paid', `status=${view.status}`));
  checks.push(check('PLT-11', 'stored-tx-hash-matches', view.record?.txHash === txHash, `stored tx=${view.record?.txHash?.slice(0, 16)}…, checked tx=${txHash.slice(0, 16)}…`));
  if (confirm) {
    const paidAtOk = String(view.record?.paidAtMs) === String(new Date(confirm.blockTime.slotTime).getTime());
    checks.push(check('PLT-12', 'paid-at-is-confirm-block-time', paidAtOk, `view paid_at=${view.record?.paidAt}, confirm block time=${confirm.blockTime.slotTime}`));
  } else {
    checks.push(skip('PLT-12', 'paid-at-is-confirm-block-time', 'no --confirm-tx supplied; paid_at recorded, not passed'));
  }
  checks.push(check('PLT-14', 'registry-balance-zero', String(balance) === '0', `balance=${balance} microCCD`));
  if (docBytes) {
    const hash = createHash('sha256').update(docBytes).digest('hex');
    checks.push(check('PLT-15', 'doc-hash-matches', hash === view.docHash, `sha256(doc)=${hash.slice(0, 16)}…, stored=${view.docHash.slice(0, 16)}…`));
  } else {
    checks.push(skip('PLT-15', 'doc-hash-matches', 'no invoice document supplied; stored doc_hash recorded, not passed'));
  }
  return summarize(checks);
}

export { decodeContractEvent };
