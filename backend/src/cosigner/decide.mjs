// PayOnce backend — co-signer decision function (pure, no I/O, no clock).
// decide(snapshot, request, ledger) -> { decision, code, reasons }.
// It reads ONLY the snapshot (taken at one finalized block) and the request.
// Chain time comes from snapshot.slotTime; the local clock is never read
// (plan F8 / test C-34). Every refusal carries a stable machine code.
// The signer (key) is NOT here: signing happens in server.mjs, only after
// decide() returns SIGN and the ledger entry is durably written (C-35).
import { decodeCborMemo, encodeCborMemo } from '../chain.mjs';

export const MARGIN_MS = 60_000; // R-b: header expiry must be >= 60 s before the window ends.

function refuse(code, reason) {
  return { decision: 'REFUSE', code, reasons: [reason] };
}
function sign() {
  return { decision: 'SIGN', code: null, reasons: [] };
}

function canonicalMemoV(snapshot) {
  const { seller, id } = snapshot.payable;
  return snapshot.version === 2 && seller ? `payable:${seller}:${id}` : `payable:${id}`;
}

/**
 * snapshot: {
 *   version, blockHash, slotTime (ISO, chain time), agentAccount, sponsorAccount,
 *   nextNonce, agentStatus ('Active'|'Revoked'|'NotFound'), eudemoBalance (string),
 *   payable: { seller, id, payee, amount, asset, dueMs, status ('Unpaid'|'Reserved'|'Paid'|'Voided'),
 *              payer, expiresMs, expectedPayer, legalRef },
 *   approval: null | { tier, legalRef, perPayableCap, periodCap, periodSecs },
 *   usage (string), memoScan: { found, txHash }, usedTxHashes: [hex],
 *   transfer: null | { found, from, to, amount, memo, blockTimeMs }  // for confirm
 * }
 * request: {
 *   kind: 'reserve_plt'|'transfer'|'confirm',
 *   sender, nonce, txVersion, sponsor, numSignatures,
 *   recipient, amount, token, memo (hex), headerExpirySeconds, operations,
 *   txHash  // confirm only
 * }
 * ledger: { unresolved: [{ payableKey, txHash, headerExpiry, reservationExpires }] }
 */
export function decide(snapshot, request, ledger) {
  const slotMs = new Date(snapshot.slotTime).getTime();
  if (!Number.isFinite(slotMs)) return refuse('bad-snapshot', 'snapshot.slotTime is not a valid time');
  const p = snapshot.payable;
  const unresolved = ledger?.unresolved ?? [];

  // ---- Common rules (all kinds) ----
  if (request.sender !== snapshot.agentAccount) {
    return refuse('sender-not-agent', `sender ${request.sender} is not the agent account ${snapshot.agentAccount}`);
  }
  if (request.txVersion !== 1) {
    return refuse('bad-tx-version', `tx version ${request.txVersion} is not 1`);
  }
  if (request.nonce !== snapshot.nextNonce) {
    return refuse('bad-nonce', `nonce ${request.nonce} != next_nonce ${snapshot.nextNonce} at block ${snapshot.blockHash}`);
  }
  if (request.sponsor !== snapshot.sponsorAccount) {
    return refuse('sponsor-mismatch', `sponsor ${request.sponsor} is not the expected sponsor ${snapshot.sponsorAccount}`);
  }
  if (slotMs > Number(p.dueMs)) {
    return refuse('past-due', `chain time ${snapshot.slotTime} is past due ${new Date(Number(p.dueMs)).toISOString()}`);
  }
  if (snapshot.agentStatus !== 'Active') {
    return refuse('agent-not-active', `agent status is ${snapshot.agentStatus}`);
  }

  if (request.kind === 'reserve_plt') {
    // The agent account's signature threshold: 2 for the 2-of-3 agent C3,
    // 1 for a 1-of-1 buyer account (the live E2E runs the buyer as the owner).
    // Default 2 preserves the C-04 rule when the snapshot does not say.
    const threshold = snapshot.signatureThreshold ?? 2;
    if (request.numSignatures !== threshold) {
      return refuse('single-signature', `reserve needs ${threshold} signature(s), got ${request.numSignatures}`);
    }
    if (p.asset === 'CCD') return refuse('wrong-asset', 'reserve_plt on a CCD payable');
    if (p.status === 'Reserved') return refuse('already-reserved', 'payable is already Reserved');
    if (p.status === 'Voided') return refuse('voided', 'payable is Voided');
    if (p.status === 'Paid') return refuse('already-paid', 'payable is already Paid');
    if (p.expectedPayer && p.expectedPayer !== snapshot.agentAccount) {
      return refuse('not-expected-payer', `expected_payer ${p.expectedPayer} is not the agent account`);
    }
    if (!snapshot.approval) return refuse('no-approval', 'no vendor approval row for (agent, seller)');
    if (snapshot.approval.legalRef && p.legalRef && snapshot.approval.legalRef !== p.legalRef) {
      return refuse('legal-ref-mismatch', 'payable legal_ref does not match the approval legal_ref');
    }
    if (BigInt(p.amount) > BigInt(snapshot.approval.perPayableCap)) {
      return refuse('cap-exceeded', `amount ${p.amount} exceeds per-payable cap ${snapshot.approval.perPayableCap}`);
    }
    if (BigInt(snapshot.usage) + BigInt(p.amount) > BigInt(snapshot.approval.periodCap)) {
      return refuse('cap-exceeded', `usage ${snapshot.usage} + amount ${p.amount} exceeds period cap ${snapshot.approval.periodCap}`);
    }
    if (BigInt(snapshot.eudemoBalance) < BigInt(p.amount)) {
      return refuse('insufficient-balance', `EUDemo balance ${snapshot.eudemoBalance} below amount ${p.amount}`);
    }
    if (snapshot.memoScan?.found) {
      return refuse('memo-scan-hit', `a finalized transfer with memo ${canonicalMemoV(snapshot)} already exists (${snapshot.memoScan.txHash})`);
    }
    const key = `${p.seller ?? ''}:${p.id}`;
    if (unresolved.some((e) => e.payableKey === key)) {
      return refuse('ledger-unresolved', `an unresolved co-signed transfer exists for payable ${key}`);
    }
    return sign();
  }

  if (request.kind === 'transfer') {
    if (p.status === 'Paid') return refuse('already-paid', 'payable is already Paid');
    if (p.status !== 'Reserved') return refuse('not-reserved', `payable is ${p.status}, not Reserved`);
    if (p.payer !== snapshot.agentAccount) {
      return refuse('reserved-by-other', `payable is reserved by ${p.payer}, not the agent account`);
    }
    if (!snapshot.approval) return refuse('approval-revoked', 'approval was revoked after the reserve');
    if (request.recipient !== p.payee) {
      return refuse('wrong-recipient', `recipient ${request.recipient} is not the stored payee ${p.payee}`);
    }
    if (String(request.amount) !== String(p.amount)) {
      return refuse('wrong-amount', `amount ${request.amount} != stored amount ${p.amount}`);
    }
    if (request.token !== 'EUDemo') return refuse('wrong-token', `token ${request.token} is not EUDemo`);
    if (request.operations !== 1) return refuse('multi-operation', `${request.operations} operations, expected exactly 1 transfer`);
    if (!request.memo) return refuse('memo-missing', 'transfer has no memo');
    const memo = decodeCborMemo(request.memo);
    const expected = canonicalMemoV(snapshot);
    if (memo.text !== expected) {
      return refuse('wrong-memo', `memo ${JSON.stringify(memo.text)} is not ${JSON.stringify(expected)}`);
    }
    if (!memo.canonical) return refuse('memo-non-canonical', 'memo CBOR header is not canonical');
    // R-b: header expiry bound (seconds -> ms).
    const headerExpiryMs = request.headerExpirySeconds * 1000;
    const expiresMs = Number(p.expiresMs);
    if (!(headerExpiryMs > slotMs)) {
      return refuse('header-expired', `header expiry ${request.headerExpirySeconds} is not after chain time`);
    }
    if (slotMs > expiresMs - MARGIN_MS) {
      return refuse('insufficient-margin', `chain time is within 60 s of the reservation expiry`);
    }
    if (headerExpiryMs > expiresMs - MARGIN_MS) {
      return refuse('header-expiry-too-late', `header expiry must be <= reservation expiry - 60 s`);
    }
    return sign();
  }

  if (request.kind === 'confirm') {
    if (p.status !== 'Reserved') return refuse('not-reserved', `payable is ${p.status}, not Reserved`);
    if (p.payer !== snapshot.agentAccount) {
      return refuse('reserved-by-other', `payable is reserved by ${p.payer}, not the agent account`);
    }
    if (slotMs > Number(p.expiresMs)) {
      return refuse('confirm-after-window', 'chain time is past the reservation expiry (contract would reject -24)');
    }
    if (!request.txHash || request.txHash === '0'.repeat(64)) {
      return refuse('bad-tx-hash', 'confirm tx hash is missing or zero');
    }
    if ((snapshot.usedTxHashes ?? []).includes(request.txHash.toLowerCase())) {
      return refuse('tx-reused', `tx hash ${request.txHash} was already used to confirm a payable`);
    }
    // R-d: confirm only after the transfer is finalized and verified.
    const t = snapshot.transfer;
    if (!t?.found) return refuse('transfer-not-verified', 'no finalized transfer found for this payable');
    if (t.from !== snapshot.agentAccount) return refuse('transfer-not-verified', `transfer sender ${t.from} is not the agent account`);
    if (t.to !== p.payee) return refuse('transfer-not-verified', `transfer recipient ${t.to} is not the stored payee`);
    if (String(t.amount) !== String(p.amount)) return refuse('transfer-not-verified', `transfer amount ${t.amount} != stored amount ${p.amount}`);
    if (t.memo !== canonicalMemoV(snapshot)) return refuse('transfer-not-verified', `transfer memo ${JSON.stringify(t.memo)} is not ${JSON.stringify(canonicalMemoV(snapshot))}`);
    if (Number(t.blockTimeMs) > Number(p.expiresMs)) {
      return refuse('transfer-not-verified', 'transfer finalized after the reservation expiry');
    }
    return sign();
  }

  return refuse('unknown-kind', `unknown request kind ${request.kind}`);
}

export { encodeCborMemo };
