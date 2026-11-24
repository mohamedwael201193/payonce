// PayOnce API server — v2 keyless verifier (testnet only).
// The backend's verifier (src/verifier/checks.mjs) is v1-only: it hardcodes
// registry <13149,0>, the v1 `payable:<id>` memo, the 8-byte pay_ccd
// parameter and the v1 event layouts. This module is the v2 branch with
// the SAME check discipline:
//   - before_pay: 9 checks (P3 §7.2a)
//   - after_pay CCD: 10 checks (P3 §7.2b)
//   - after_pay EUDemo: 12 checks (P3 §7.2b)
//   - transfer gate (before confirm): the PLT transfer checks + reservation
// F10 (plan §0) is closed on BOTH rails: the payment transaction's
// parameter AND the contract's own Paid/PltConfirmed event must bind the
// SAME (seller, id) as the payable being checked — a tx for another
// payable fails `invoked_pay_ccd` / `memo` here, exactly as N-01 proved
// for v1 (payable-1 check with payable-4's tx fails).
// A check the inputs cannot run is `not_run`, never silently passed.
// No wallet, no key, no env: only chain reads + the doc bytes.
import { createHash } from 'node:crypto';
import { backend } from './backend.mjs';
import { REGISTRY, CIS8004_OFFICIAL } from './config.mjs';
import { agentOf, canonicalMemoV2 } from './chain-v2.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function row(id, label, status, detail, layer = 'chain') {
  return { id, label, status, detail, layer };
}

function summarize(checks) {
  const passed = checks.filter((c) => c.status === 'ok').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  return { checks, passed, failed, total: checks.length, allPass: failed === 0 };
}

async function agentCheck(c, view) {
  try {
    const agent = await agentOf(c, Number(view.agentToken));
    if (!agent) {
      return row('agent', 'Seller agent is Active on the official CIS-8004 registry', 'fail', `agentOf(${view.agentToken}) returned nothing on <${CIS8004_OFFICIAL.index},${CIS8004_OFFICIAL.subindex}>`, 'chain');
    }
    const ownerOk = agent.owner === view.seller;
    const activeOk = agent.statusName === 'Active';
    const ok = ownerOk && activeOk;
    return row(
      'agent',
      'Seller agent is Active on the official CIS-8004 registry',
      ok ? 'ok' : 'fail',
      `token ${view.agentToken} on <${CIS8004_OFFICIAL.index},${CIS8004_OFFICIAL.subindex}>: owner=${agent.owner.slice(0, 8)}… (${ownerOk ? 'matches seller' : 'DOES NOT match seller'}), status=${agent.statusName}`,
      'chain',
    );
  } catch (e) {
    return row('agent', 'Seller agent is Active on the official CIS-8004 registry', 'fail', `agentOf read failed: ${e.message}`, 'chain');
  }
}

function docCheck(view, docBytes, docSha256) {
  if (docBytes) {
    const hash = sha256(docBytes);
    return row('doc', 'Invoice document matches the on-chain hash', hash === view.docHash ? 'ok' : 'fail', `sha256(doc)=${hash.slice(0, 16)}…, stored=${view.docHash.slice(0, 16)}…`, 'chain');
  }
  if (docSha256) {
    return row('doc', 'Invoice document matches the on-chain hash', docSha256.toLowerCase() === view.docHash.toLowerCase() ? 'ok' : 'fail', `supplied sha256=${docSha256.slice(0, 16)}…, stored=${view.docHash.slice(0, 16)}…`, 'chain');
  }
  return row('doc', 'Invoice document matches the on-chain hash', 'not_run', 'no invoice document supplied; stored doc_hash recorded, not passed', 'chain');
}

function registryZeroCheck(balance) {
  return row('registry_zero', 'Registry holds no CCD after the payment', String(balance) === '0' ? 'ok' : 'fail', `balance=${balance} microCCD`, 'chain');
}

function statusPaidCheck(view) {
  return row(
    'status_paid',
    'Registry status is Paid',
    view.status === 'Paid' ? 'ok' : 'fail',
    view.status === 'Paid'
      ? `Paid by ${view.record?.payer?.slice(0, 8)}… at ${view.record?.paidAt ?? '—'}`
      : `status=${view.status}`,
    'chain',
  );
}

/**
 * Before-pay: 9 checks. `chainTimeMs` is CHAIN time (last finalized block),
 * never the local clock. `payerBalances` = { ccdAvailableMicro, eudemoBase }.
 * Verdict rule (P3 §7.2a): ready iff registered + agent + due + status ok
 * and doc ok-or-not-run. Paid status yields verdict 'paid'.
 */
export async function verifyBeforePay(c, { view, docBytes = null, docSha256 = null, chainTimeMs, payerBalances }) {
  const checks = [];
  checks.push(row('registered', 'Payable is registered on the test registry', 'ok', `seller=${view.seller.slice(0, 8)}…, id=${view.id}, asset=${view.asset}, amount=${view.amount}`, 'chain'));
  checks.push(docCheck(view, docBytes, docSha256));
  checks.push(await agentCheck(c, view));
  checks.push(row('identity', 'Seller identity', 'info', 'Not verified. No company (LEI) or identity proof is attached to this seller.', 'app'));
  checks.push(row('payee', 'Payee on the invoice', 'info', `payee=${view.payee}`, 'app'));
  const amountLabel = view.asset === 'CCD'
    ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
    : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo (testnet demo token, not a euro stablecoin)`;
  checks.push(row('amount', 'Amount on the invoice', 'info', `${amountLabel} (${view.amount} base units)`, 'app'));
  const pastDue = chainTimeMs > Number(view.dueMs);
  checks.push(row('due', 'Invoice is not past due', pastDue ? 'fail' : 'ok', `chain time=${new Date(chainTimeMs).toISOString()}, due=${view.due}`, 'chain'));
  const statusOk = view.status === 'Unpaid';
  checks.push(row(
    'status',
    'Payable is Unpaid',
    statusOk ? 'ok' : 'fail',
    view.status === 'Paid'
      ? `already Paid by ${view.record?.payer?.slice(0, 8)}… at ${view.record?.paidAt ?? '—'}`
      : view.status === 'Reserved'
        ? `Reserved by ${view.record?.payer?.slice(0, 8)}… until ${view.record?.expires ?? '—'}`
        : `status=${view.status}`,
    'chain',
  ));
  // Balance: the demo payer must cover the amount + fee headroom. One send
  // reserves maxEnergy (6000 NRG) x the energy price (~0.0078 CCD/NRG) ~= 47
  // CCD, so 50 CCD covers one worst-case send plus margin. (The node's
  // check is per send, not per rail — sends are sequential.)
  const FEE_HEADROOM_MICROCCD = 50_000_000n; // 50 CCD headroom for the pay txs
  let balanceOk = true;
  let balanceDetail = '';
  if (view.asset === 'CCD') {
    const need = BigInt(view.amount) + FEE_HEADROOM_MICROCCD;
    const have = BigInt(payerBalances?.ccdAvailableMicro ?? '0');
    balanceOk = have >= need;
    balanceDetail = `payer holds ${have} microCCD available, needs ${need} (amount + 100 CCD fee headroom)`;
  } else {
    const haveToken = BigInt(payerBalances?.eudemoBase ?? '0');
    const haveCcd = BigInt(payerBalances?.ccdAvailableMicro ?? '0');
    balanceOk = haveToken >= BigInt(view.amount) && haveCcd >= FEE_HEADROOM_MICROCCD;
    balanceDetail = `payer holds ${haveToken} EUDemo base units (needs ${view.amount}) and ${haveCcd} microCCD for fees (needs ${FEE_HEADROOM_MICROCCD})`;
  }
  checks.push(row('balance', 'Payer balance covers the payment', balanceOk ? 'ok' : 'fail', balanceDetail, 'chain'));

  const byId = Object.fromEntries(checks.map((ch) => [ch.id, ch]));
  let verdict = 'blocked';
  let blockedReason = null;
  if (view.status === 'Paid') {
    verdict = 'paid';
  } else if (
    byId.registered.status === 'ok'
    && byId.agent.status === 'ok'
    && byId.due.status === 'ok'
    && byId.status.status === 'ok'
    && (byId.doc.status === 'ok' || byId.doc.status === 'not_run')
  ) {
    verdict = 'ready';
  } else {
    const firstFail = checks.find((ch) => ch.status === 'fail');
    blockedReason = firstFail ? firstFail.id : 'blocked';
  }
  return { ...summarize(checks), verdict, blockedReason };
}

/** Decode the v2 pay_ccd parameter (seller 32B + id u64) from an Updated event. */
async function decodePayCcdParam(updated) {
  const { registryV1 } = await backend();
  if (!updated?.message) return null;
  const msg = Buffer.from(updated.message, 'hex');
  if (msg.length !== 40) return { malformed: true, length: msg.length };
  return {
    seller: registryV1.accountFromBytes(msg.subarray(0, 32)),
    id: Number(msg.readBigUInt64LE(32)),
  };
}

/** After-pay CCD: 10 checks (P3 §7.2b). */
export async function verifyCcdV2(c, ctx) {
  const { payableId, txHash, summary, blockTime, view, balance, docBytes = null, docSha256 = null } = ctx;
  const { v2ev } = await backend();
  const checks = [];
  checks.push(row('registered', 'Payable is registered on the test registry', 'ok', `seller=${view.seller.slice(0, 8)}…, id=${view.id}`, 'chain'));
  checks.push(docCheck(view, docBytes, docSha256));
  checks.push(await agentCheck(c, view));
  checks.push(registryZeroCheck(balance));
  checks.push(statusPaidCheck(view));
  checks.push(row('tx_finalized', 'Payment transaction is finalized', summary.status === 'finalized' ? 'ok' : 'fail', `status=${summary.status}`, 'chain'));

  const updated = (summary.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && String(e.address?.index) === String(REGISTRY.index) && e.receiveName === `${REGISTRY.name}.pay_ccd`,
  );
  const param = await decodePayCcdParam(updated);
  const paramOk = !!param && !param.malformed && param.seller === view.seller && param.id === payableId;
  const logged = updated ? v2ev.decodeLoggedEventsV2(updated) : [];
  const paid = logged.find((e) => e.event === 'Paid');
  const paidBindsOk = !!paid && paid.seller === view.seller && paid.payableId === payableId;
  const invokedOk = !!updated && paramOk && paidBindsOk;
  checks.push(row(
    'invoked_pay_ccd',
    'The payment transaction invoked pay_ccd for this payable',
    invokedOk ? 'ok' : 'fail',
    !updated
      ? 'no pay_ccd Updated event in the transaction'
      : !paramOk
        ? `pay_ccd parameter binds seller=${param?.seller?.slice(0, 8) ?? '?'}…, id=${param?.id ?? '?'}, expected seller=${view.seller.slice(0, 8)}…, id=${payableId}`
        : !paidBindsOk
          ? `Paid event binds seller=${paid?.seller?.slice(0, 8) ?? '?'}…, id=${paid?.payableId ?? '?'}, expected id=${payableId}`
          : `pay_ccd parameter (seller, id=${payableId}) and Paid event agree; payer=${paid.payer.slice(0, 8)}…, amount=${paid.amount}`,
    'chain',
  ));
  const sender = summary.summary?.sender;
  checks.push(row(
    'sender_is_payer',
    'The transaction sender is the recorded payer',
    !!paid && !!sender && paid.payer === sender && view.record?.payer === sender ? 'ok' : 'fail',
    `sender=${sender ?? '?'}, Paid event payer=${paid?.payer ?? '?'}, stored payer=${view.record?.payer ?? '?'}`,
    'chain',
  ));
  const transferred = (summary.summary?.events ?? []).filter((e) => e.tag === 'Transferred');
  const toPayee = transferred.filter(
    (t) => String(t.from?.index) === String(REGISTRY.index) && t.to === view.payee && String(t.amount) === view.amount,
  );
  checks.push(row(
    'single_transfer_to_payee',
    'Exactly one transfer from the registry to the stored payee',
    toPayee.length === 1 ? 'ok' : 'fail',
    `Transferred events=${transferred.length}, registry→payee with stored amount=${toPayee.length}`,
    'chain',
  ));
  const otherTransfers = transferred.filter(
    (t) => !(String(t.from?.index) === String(REGISTRY.index) && t.to === view.payee)
      && !(t.to === `${REGISTRY.index}` || String(t.to?.index) === String(REGISTRY.index)),
  );
  checks.push(row(
    'no_other_transfer',
    'No other transfer in the payment transaction',
    otherTransfers.length === 0 ? 'ok' : 'fail',
    otherTransfers.length === 0
      ? `all ${transferred.length} Transferred events are the attached amount into the registry and the payout to the payee`
      : `unexpected transfers: ${JSON.stringify(otherTransfers).slice(0, 200)}`,
    'chain',
  ));
  return summarize(checks);
}

/** PLT transfer checks shared by the confirm gate and the full receipt run. */
export function pltTransferChecks(ctx) {
  const { payableId, summary, blockTime, view, reserve = null } = ctx;
  const checks = [];
  checks.push(row('tx_finalized', 'Transfer transaction is finalized', summary.status === 'finalized' ? 'ok' : 'fail', `status=${summary.status}`, 'chain'));
  const transfers = (summary.summary?.events ?? []).filter((e) => e.tag === 'TokenTransfer');
  checks.push(row('one_token_transfer', 'Exactly one token transfer', transfers.length === 1 ? 'ok' : 'fail', `TokenTransfer events=${transfers.length}`, 'chain'));
  const t = transfers[0];
  checks.push(row('token_eudemo', 'Token is EUDemo', !!t && t.tokenId === 'EUDemo' ? 'ok' : 'fail', t ? `tokenId=${t.tokenId}` : 'no TokenTransfer event', 'chain'));
  const payer = view.record?.payer;
  checks.push(row('from_payer', 'Transfer sender is the reserving payer', !!t && t.from?.address === payer ? 'ok' : 'fail', t ? `from=${t.from?.address}, payer=${payer}` : 'no TokenTransfer event', 'chain'));
  checks.push(row('to_payee', 'Transfer recipient is the stored payee', !!t && t.to?.address === view.payee ? 'ok' : 'fail', t ? `to=${t.to?.address}, payee=${view.payee}` : 'no TokenTransfer event', 'chain'));
  checks.push(row('amount', 'Transfer amount is the stored amount', !!t && String(t.amount?.value ?? t.amount) === view.amount ? 'ok' : 'fail', t ? `amount=${t.amount?.value ?? t.amount}, stored=${view.amount}` : 'no TokenTransfer event', 'chain'));
  return { checks, transfer: t };
}

/** Memo check (v2 canonical memo `payable:<seller>:<id>`). */
export async function pltMemoCheck(view, transfer) {
  const { chain } = await backend();
  const memo = transfer ? chain.decodeCborMemo(transfer.memo ?? '') : { text: '', canonical: false };
  const expected = canonicalMemoV2(view.seller, view.id);
  const ok = memo.text === expected && memo.canonical;
  return row('memo', 'Transfer memo is the canonical payable memo', ok ? 'ok' : 'fail', `memo=${JSON.stringify(memo.text)}, expected=${JSON.stringify(expected)}, canonical=${memo.canonical}`, 'chain');
}

/** PLT transfer gate (before confirm): transfer checks + reservation window. */
export async function verifyPltTransferV2(ctx) {
  const { payableId, summary, blockTime, view, reserve } = ctx;
  const { checks, transfer } = pltTransferChecks(ctx);
  checks.push(await pltMemoCheck(view, transfer));
  if (reserve?.logged) {
    const reserved = reserve.logged.find((e) => e.event === 'Reserved');
    const payer = view.record?.payer;
    const reserveOk =
      !!reserved
      && reserved.seller === view.seller
      && reserved.payableId === payableId
      && reserved.payer === payer
      && new Date(reserve.blockTime.slotTime).getTime() < new Date(blockTime.slotTime).getTime()
      && new Date(blockTime.slotTime).getTime() <= Number(reserved.expiresMs);
    checks.push(row(
      'reservation_precedes_transfer',
      'Reservation precedes the transfer inside its window',
      reserveOk ? 'ok' : 'fail',
      reserved ? `reserved by ${reserved.payer.slice(0, 8)}… at ${reserve.blockTime.slotTime}, expires ${reserved.expires}` : 'no Reserved event in the reserve transaction',
      'chain',
    ));
  } else {
    checks.push(row('reservation_precedes_transfer', 'Reservation precedes the transfer inside its window', 'not_run', 'no reserve transaction supplied; reservation not checked', 'chain'));
  }
  return summarize(checks);
}

/** After-pay EUDemo: exactly the 12 P3 §7.2b checks. The two extra
 * receipt-binding checks (stored tx hash, paid_at == confirm block time)
 * live in the receipt re-verifier (receipts.mjs), not here. */
export async function verifyPltV2(c, ctx) {
  const { payableId, txHash, summary, blockTime, view, balance, docBytes = null, docSha256 = null, reserve = null, confirm = null } = ctx;
  const checks = [];
  checks.push(row('registered', 'Payable is registered on the test registry', 'ok', `seller=${view.seller.slice(0, 8)}…, id=${view.id}`, 'chain'));
  checks.push(docCheck(view, docBytes, docSha256));
  checks.push(await agentCheck(c, view));
  checks.push(registryZeroCheck(balance));
  checks.push(statusPaidCheck(view));
  const { checks: transferChecks, transfer } = pltTransferChecks(ctx);
  checks.push(...transferChecks);
  checks.push(await pltMemoCheck(view, transfer));
  return summarize(checks);
}

/** Receipt-binding extras (not part of the 12 P3 after-pay checks). */
export function pltReceiptExtraChecks(view, txHash, confirm) {
  const checks = [];
  checks.push(row(
    'stored_tx_hash',
    'Stored payment hash is the transfer transaction',
    view.record?.txHash === txHash ? 'ok' : 'fail',
    `stored tx=${view.record?.txHash?.slice(0, 16) ?? 'none'}…, checked tx=${txHash.slice(0, 16)}…`,
    'chain',
  ));
  if (confirm) {
    const paidAtOk = String(view.record?.paidAtMs) === String(new Date(confirm.blockTime.slotTime).getTime());
    checks.push(row('paid_at_is_confirm_time', 'Paid time is the confirm block time', paidAtOk ? 'ok' : 'fail', `view paid_at=${view.record?.paidAt}, confirm block time=${confirm.blockTime.slotTime}`, 'chain'));
  } else {
    checks.push(row('paid_at_is_confirm_time', 'Paid time is the confirm block time', 'not_run', 'no confirm transaction supplied; paid_at recorded, not passed', 'chain'));
  }
  return checks;
}
