// PayOnce co-signer decision function — pure, no I/O, no wall clock.
// Plan P1 §4.1: `decide(snapshot, request)` returns SIGN or REFUSE <code>.
// The snapshot is taken at ONE finalized block hash and holds everything the
// rule needs; the decision is re-runnable by anyone from chain state.
// The function never reads the local clock (F8), never reads the signed
// transfer's header expiry without bounding it (F6), never signs for an
// unapproved seller (F7), and never signs while an earlier payment exists
// (F9: memo scan + ledger).
//
// Refusal codes are descriptive strings (the plan's C-table names REFUSE;
// two codes are pinned by the plan: MEMO_SCAN and LEDGER).
//
// Time is always chain time (snapshot.slotTimeMs). The 60 s margin is
// MARGIN_MS from the v1 co-signer (plan §3.1 R-b).

export const MARGIN_MS = 60_000;

/** Memo format for v2 (plan §1.1 D1): `payable:<seller>:<id>`. */
export function memoFor(seller, id) {
  return `payable:${seller}:${id}`;
}

/**
 * snapshot: {
 *   agentAccount: string,          // the 2-of-3 agent account (C3)
 *   slotTimeMs: number,            // chain time at the snapshot block
 *   nextNonce: number,
 *   agentStatus: 'Active' | 'Revoked',
 *   eudemoBalance: number,         // minor units
 *   payable: {
 *     seller, id, payee, amount, asset: 'CCD' | 'EUDemo',
 *     dueMs, expectedPayer, legalRef,   // legalRef: hex string | null
 *     status: 'Unpaid'|'Reserved'|'Paid'|'Voided',
 *     reservedBy, expiresMs,
 *   },
 *   approval: null | { tier, legalRef, perPayableCap, periodCap, periodSecs },
 *   usage: number,                 // current period usage (minor units)
 *   memoScanFound: boolean,        // finalized transfer with this memo from C3
 *   ledgerUnresolved: array,       // unresolved ledger entries for this key
 * }
 * request: {
 *   kind: 'reserve_plt' | 'transfer' | 'confirm',
 *   sender, version, sponsor, numSignatures, nonce, headerExpiryMs,
 *   operations?: [{ token, recipient, amount, memo, memoCanonical }],
 *   transfer?: { finalized, from, to, amount, memo, blockTimeMs },
 * }
 */
export function decide(snapshot, request) {
  const refuse = (code) => ({ decision: 'REFUSE', code });
  const p = snapshot.payable;
  const now = snapshot.slotTimeMs;

  // Common to every kind: only the agent account may ask (C-01).
  if (request.sender !== snapshot.agentAccount) return refuse('NOT_C3');

  if (request.kind === 'reserve_plt') {
    if (p.asset !== 'EUDemo') return refuse('WRONG_ASSET'); // C-05
    if (p.status === 'Reserved') return refuse('WRONG_STATUS'); // C-06
    if (p.status === 'Voided') return refuse('VOIDED'); // C-07
    if (p.status === 'Paid') return refuse('ALREADY_PAID'); // C-33
    if (p.expectedPayer !== snapshot.agentAccount) return refuse('NOT_EXPECTED_PAYER'); // C-08
    if (!snapshot.approval) return refuse('NOT_APPROVED'); // C-09
    if (snapshot.approval.legalRef != null && p.legalRef !== snapshot.approval.legalRef) {
      return refuse('LEGAL_REF_MISMATCH'); // C-10
    }
    if (
      p.amount > snapshot.approval.perPayableCap ||
      snapshot.usage + p.amount > snapshot.approval.periodCap
    ) {
      return refuse('CAP_EXCEEDED'); // C-11
    }
    if (snapshot.agentStatus !== 'Active') return refuse('AGENT_NOT_ACTIVE'); // C-12
    if (snapshot.eudemoBalance < p.amount) return refuse('INSUFFICIENT_BALANCE'); // C-13
    if (snapshot.memoScanFound) return refuse('MEMO_SCAN'); // C-14
    if (snapshot.ledgerUnresolved && snapshot.ledgerUnresolved.length > 0) {
      return refuse('LEDGER'); // C-15
    }
    if (request.nonce !== snapshot.nextNonce) return refuse('BAD_NONCE'); // C-16
    if (now > p.dueMs) return refuse('PAST_DUE'); // C-17
    if (request.headerExpiryMs != null && request.headerExpiryMs <= now) {
      return refuse('HEADER_EXPIRY');
    }
    return { decision: 'SIGN' }; // C-18
  }

  if (request.kind === 'transfer') {
    if (request.version !== 1) return refuse('BAD_VERSION'); // C-02
    if (!request.sponsor) return refuse('NO_SPONSOR'); // C-03
    if (request.numSignatures !== 2) return refuse('BAD_SIGNATURES'); // C-04
    const ops = request.operations ?? [];
    if (ops.length !== 1) return refuse('MULTI_OPERATION'); // C-24
    const op = ops[0];
    if (op.token !== 'EUDemo') return refuse('WRONG_TOKEN'); // C-25
    if (op.recipient !== p.payee) return refuse('WRONG_PAYEE'); // C-19
    if (op.amount !== p.amount) return refuse('WRONG_AMOUNT'); // C-20
    if (op.memo == null || op.memo === '') return refuse('MEMO_MISSING'); // C-22
    if (op.memo !== memoFor(p.seller, p.id)) return refuse('WRONG_MEMO'); // C-21
    if (op.memoCanonical !== true) return refuse('MEMO_NONCANONICAL'); // C-23
    if (p.status === 'Unpaid') return refuse('NOT_RESERVED'); // C-26
    if (p.status === 'Voided') return refuse('VOIDED'); // C-07
    if (p.status === 'Paid') return refuse('ALREADY_PAID'); // C-33
    if (p.reservedBy !== snapshot.agentAccount) return refuse('RESERVED_BY_OTHER'); // C-27
    // The approval is re-checked at signing (plan §2): a revoke after the
    // reserve must refuse the transfer (C-32).
    if (!snapshot.approval) return refuse('APPROVAL_REVOKED'); // C-32
    if (snapshot.approval.legalRef != null && p.legalRef !== snapshot.approval.legalRef) {
      return refuse('LEGAL_REF_MISMATCH'); // C-10
    }
    if (
      p.amount > snapshot.approval.perPayableCap ||
      snapshot.usage + p.amount > snapshot.approval.periodCap
    ) {
      return refuse('CAP_EXCEEDED'); // C-11
    }
    if (snapshot.agentStatus !== 'Active') return refuse('AGENT_NOT_ACTIVE'); // C-12
    if (snapshot.eudemoBalance < p.amount) return refuse('INSUFFICIENT_BALANCE'); // C-13
    if (snapshot.memoScanFound) return refuse('MEMO_SCAN'); // C-14
    if (snapshot.ledgerUnresolved && snapshot.ledgerUnresolved.length > 0) {
      return refuse('LEDGER'); // C-15
    }
    if (request.nonce !== snapshot.nextNonce) return refuse('BAD_NONCE'); // C-16
    if (now > p.dueMs) return refuse('PAST_DUE'); // C-17
    // C-31: already within the margin of expiry — refuse outright, before
    // looking at the header (a transfer signed this late cannot land in time).
    if (now + MARGIN_MS > p.expiresMs) return refuse('TOO_CLOSE_TO_EXPIRY');
    // R-b: the co-signed transfer's header expiry must leave at least the
    // margin inside the reservation window (C-28 boundary SIGN at exactly
    // expires - 60 s; C-29/C-30 REFUSE).
    if (request.headerExpiryMs == null || request.headerExpiryMs > p.expiresMs - MARGIN_MS) {
      return refuse('HEADER_EXPIRY');
    }
    if (request.headerExpiryMs <= now) return refuse('HEADER_EXPIRY');
    return { decision: 'SIGN' };
  }

  if (request.kind === 'confirm') {
    if (p.status === 'Unpaid') return refuse('NOT_RESERVED'); // C-26
    if (p.status === 'Voided') return refuse('VOIDED');
    if (p.status === 'Paid') return refuse('ALREADY_PAID'); // C-33
    if (p.reservedBy !== snapshot.agentAccount) return refuse('RESERVED_BY_OTHER'); // C-27
    // R-d: confirm only after the transfer is finalized and passes the
    // verifier's checks (one transfer, EUDemo, from C3, to payee, stored
    // amount, memo, block time inside the window).
    const t = request.transfer ?? {};
    if (t.finalized !== true) return refuse('TRANSFER_NOT_FINALIZED');
    if (t.from !== snapshot.agentAccount) return refuse('WRONG_PAYER');
    if (t.to !== p.payee) return refuse('WRONG_PAYEE');
    if (t.amount !== p.amount) return refuse('WRONG_AMOUNT');
    if (t.memo !== memoFor(p.seller, p.id)) return refuse('WRONG_MEMO');
    if (t.blockTimeMs == null || t.blockTimeMs > p.expiresMs) {
      return refuse('CONFIRM_LATE');
    }
    return { decision: 'SIGN' };
  }

  return refuse('UNKNOWN_KIND');
}

/**
 * Signing wrapper (plan §3.4): the ledger entry is written BEFORE any
 * signature is returned. If the write fails, the request is refused and NO
 * signature is produced (C-35). The actual signature comes from the KMS
 * path in production; this wrapper returns the decision plus a placeholder
 * marking that a signature may be produced — never a real key.
 */
export function prepareSignature(snapshot, request, ledgerStore) {
  const d = decide(snapshot, request);
  if (d.decision !== 'SIGN') return d;
  try {
    ledgerStore.append({
      payableKey: `${snapshot.payable.seller}:${snapshot.payable.id}`,
      kind: request.kind,
      headerExpiryMs: request.headerExpiryMs ?? null,
      atMs: snapshot.slotTimeMs,
    });
  } catch {
    return { decision: 'REFUSE', code: 'LEDGER_WRITE_FAILED' };
  }
  return { decision: 'SIGN', signature: 'SIGNATURE_PLACEHOLDER' };
}
