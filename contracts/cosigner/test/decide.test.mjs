// PayOnce co-signer decision table (plan P1 §6.2) — 35 cases, node:test.
// Run: `node --test cosigner/test/` from the contract work dir.
// The seven v1 refusals are re-recorded as C-19 (wrong payee), C-20 (two
// amounts), C-21 (memo for another payable), C-22 (memo missing), C-26
// (payable never reserved) and C-06 (reserve again while Reserved).

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, prepareSignature, memoFor, MARGIN_MS } from '../decide.mjs';

const AGENT = 'C3';
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const LEGAL = 'aa'.repeat(32);

function payable(over = {}) {
  return {
    seller: 'SELLER',
    id: 1,
    payee: 'PAYEE',
    amount: 5_000_000,
    asset: 'EUDemo',
    dueMs: T0 + 10 * DAY,
    expectedPayer: AGENT,
    legalRef: LEGAL,
    status: 'Unpaid',
    reservedBy: null,
    expiresMs: null,
    ...over,
  };
}

function snapshot(over = {}) {
  const s = {
    agentAccount: AGENT,
    slotTimeMs: T0,
    nextNonce: 42,
    agentStatus: 'Active',
    eudemoBalance: 100_000_000,
    payable: payable(),
    approval: {
      tier: 2,
      legalRef: LEGAL,
      perPayableCap: 10_000_000,
      periodCap: 100_000_000,
      periodSecs: 86_400,
    },
    usage: 0,
    memoScanFound: false,
    ledgerUnresolved: [],
    ...over,
  };
  if (over.payable) s.payable = { ...payable(), ...over.payable };
  return s;
}

/** Snapshot with the payable Reserved by the agent, expiring in 1 h. */
function reservedSnapshot(over = {}) {
  const expiresMs = T0 + 3_600_000;
  const reserved = { status: 'Reserved', reservedBy: AGENT, expiresMs };
  return snapshot({ ...over, payable: { ...reserved, ...(over.payable || {}) } });
}

function reserveReq(over = {}) {
  return {
    kind: 'reserve_plt',
    sender: AGENT,
    version: 1,
    sponsor: true,
    numSignatures: 2,
    nonce: 42,
    headerExpiryMs: T0 + 3_600_000,
    ...over,
  };
}

function transferReq(over = {}) {
  return {
    kind: 'transfer',
    sender: AGENT,
    version: 1,
    sponsor: true,
    numSignatures: 2,
    nonce: 42,
    // Boundary-safe default: exactly expires - 60 s (C-28 is the boundary).
    headerExpiryMs: T0 + 3_600_000 - MARGIN_MS,
    operations: [
      {
        token: 'EUDemo',
        recipient: 'PAYEE',
        amount: 5_000_000,
        memo: memoFor('SELLER', 1),
        memoCanonical: true,
      },
    ],
    ...over,
  };
}

function confirmReq(over = {}) {
  return {
    kind: 'confirm',
    sender: AGENT,
    version: 1,
    sponsor: true,
    numSignatures: 2,
    nonce: 42,
    headerExpiryMs: T0 + 3_600_000 - MARGIN_MS,
    transfer: {
      finalized: true,
      from: AGENT,
      to: 'PAYEE',
      amount: 5_000_000,
      memo: memoFor('SELLER', 1),
      blockTimeMs: T0 + 1_800_000,
    },
    ...over,
  };
}

const refuse = (code) => ({ decision: 'REFUSE', code });

// C-01..C-04: request shape
test('C-01 sender is not C3', () => {
  assert.deepEqual(decide(snapshot(), reserveReq({ sender: 'OTHER' })), refuse('NOT_C3'));
  assert.deepEqual(
    decide(reservedSnapshot(), transferReq({ sender: 'OTHER' })),
    refuse('NOT_C3'),
  );
});

test('C-02 version 0', () => {
  assert.deepEqual(
    decide(reservedSnapshot(), transferReq({ version: 0 })),
    refuse('BAD_VERSION'),
  );
});

test('C-03 no sponsor', () => {
  assert.deepEqual(
    decide(reservedSnapshot(), transferReq({ sponsor: false })),
    refuse('NO_SPONSOR'),
  );
});

test('C-04 numSignatures = 1', () => {
  assert.deepEqual(
    decide(reservedSnapshot(), transferReq({ numSignatures: 1 })),
    refuse('BAD_SIGNATURES'),
  );
});

// C-05..C-18: reserve_plt
test('C-05 reserve_plt on a CCD payable', () => {
  assert.deepEqual(
    decide(snapshot({ payable: { asset: 'CCD' } }), reserveReq()),
    refuse('WRONG_ASSET'),
  );
});

test('C-06 payable Reserved (reserve again)', () => {
  assert.deepEqual(
    decide(reservedSnapshot(), reserveReq()),
    refuse('WRONG_STATUS'),
  );
});

test('C-07 payable Voided', () => {
  assert.deepEqual(
    decide(snapshot({ payable: { status: 'Voided' } }), reserveReq()),
    refuse('VOIDED'),
  );
});

test('C-08 reserve by an account other than expected_payer', () => {
  assert.deepEqual(
    decide(snapshot({ payable: { expectedPayer: 'PAYER2' } }), reserveReq()),
    refuse('NOT_EXPECTED_PAYER'),
  );
});

test('C-09 reserve with no approval', () => {
  assert.deepEqual(decide(snapshot({ approval: null }), reserveReq()), refuse('NOT_APPROVED'));
});

test('C-10 reserve with legal_ref mismatch', () => {
  assert.deepEqual(
    decide(
      snapshot({ approval: { tier: 2, legalRef: 'bb'.repeat(32), perPayableCap: 10_000_000, periodCap: 100_000_000, periodSecs: 86_400 } }),
      reserveReq(),
    ),
    refuse('LEGAL_REF_MISMATCH'),
  );
});

test('C-11 reserve over the caps (per-payable and period)', () => {
  const small = { tier: 2, legalRef: LEGAL, perPayableCap: 4_999_999, periodCap: 100_000_000, periodSecs: 86_400 };
  assert.deepEqual(decide(snapshot({ approval: small }), reserveReq()), refuse('CAP_EXCEEDED'));
  const tight = { tier: 2, legalRef: LEGAL, perPayableCap: 10_000_000, periodCap: 4_999_999, periodSecs: 86_400 };
  assert.deepEqual(decide(snapshot({ approval: tight }), reserveReq()), refuse('CAP_EXCEEDED'));
  const used = { tier: 2, legalRef: LEGAL, perPayableCap: 10_000_000, periodCap: 100_000_000, periodSecs: 86_400 };
  assert.deepEqual(
    decide(snapshot({ approval: used, usage: 96_000_000 }), reserveReq()),
    refuse('CAP_EXCEEDED'),
  );
});

test('C-12 reserve while the agent is Revoked', () => {
  assert.deepEqual(
    decide(snapshot({ agentStatus: 'Revoked' }), reserveReq()),
    refuse('AGENT_NOT_ACTIVE'),
  );
});

test('C-13 reserve with insufficient EUDemo', () => {
  assert.deepEqual(
    decide(snapshot({ eudemoBalance: 4_999_999 }), reserveReq()),
    refuse('INSUFFICIENT_BALANCE'),
  );
});

test('C-14 reserve while a finalized payment already exists (memo scan)', () => {
  assert.deepEqual(
    decide(snapshot({ memoScanFound: true }), reserveReq()),
    refuse('MEMO_SCAN'),
  );
});

test('C-15 reserve while the ledger has an unresolved entry', () => {
  assert.deepEqual(
    decide(
      snapshot({ ledgerUnresolved: [{ payableKey: 'SELLER:1', kind: 'transfer' }] }),
      reserveReq(),
    ),
    refuse('LEDGER'),
  );
});

test('C-16 reserve with a bad nonce', () => {
  assert.deepEqual(decide(snapshot(), reserveReq({ nonce: 43 })), refuse('BAD_NONCE'));
});

test('C-17 reserve after due', () => {
  assert.deepEqual(
    decide(snapshot({ slotTimeMs: T0 + 11 * DAY }), reserveReq()),
    refuse('PAST_DUE'),
  );
});

test('C-18 valid reserve signs', () => {
  assert.deepEqual(decide(snapshot(), reserveReq()), { decision: 'SIGN' });
});

// C-19..C-25: transfer shape
test('C-19 transfer to the wrong payee', () => {
  const req = transferReq();
  req.operations[0].recipient = 'ATTACKER';
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('WRONG_PAYEE'));
});

test('C-20 transfer of the wrong amount (too much and too little)', () => {
  const tooMuch = transferReq();
  tooMuch.operations[0].amount = 5_000_001;
  assert.deepEqual(decide(reservedSnapshot(), tooMuch), refuse('WRONG_AMOUNT'));
  const tooLittle = transferReq();
  tooLittle.operations[0].amount = 4_999_999;
  assert.deepEqual(decide(reservedSnapshot(), tooLittle), refuse('WRONG_AMOUNT'));
});

test('C-21 transfer with the memo for another payable', () => {
  const req = transferReq();
  req.operations[0].memo = memoFor('SELLER', 2);
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('WRONG_MEMO'));
});

test('C-22 transfer with no memo', () => {
  const req = transferReq();
  delete req.operations[0].memo;
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('MEMO_MISSING'));
  const empty = transferReq();
  empty.operations[0].memo = '';
  assert.deepEqual(decide(reservedSnapshot(), empty), refuse('MEMO_MISSING'));
});

test('C-23 transfer with a non-canonical memo', () => {
  const req = transferReq();
  req.operations[0].memoCanonical = false;
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('MEMO_NONCANONICAL'));
});

test('C-24 transfer with two operations', () => {
  const req = transferReq();
  req.operations.push({ ...req.operations[0] });
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('MULTI_OPERATION'));
});

test('C-25 transfer of the wrong token', () => {
  const req = transferReq();
  req.operations[0].token = 'CCD';
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('WRONG_TOKEN'));
});

// C-26..C-33: reservation / window / approval state
test('C-26 confirm while the payable was never reserved', () => {
  assert.deepEqual(decide(snapshot(), confirmReq()), refuse('NOT_RESERVED'));
});

test('C-27 transfer while Reserved by another account', () => {
  const s = reservedSnapshot({ payable: { reservedBy: 'PAYER2' } });
  assert.deepEqual(decide(s, transferReq()), refuse('RESERVED_BY_OTHER'));
});

test('C-28 transfer whose header expires exactly at expires - 60s signs', () => {
  assert.deepEqual(decide(reservedSnapshot(), transferReq()), { decision: 'SIGN' });
});

test('C-29 transfer whose header expires at expires - 59s', () => {
  const req = transferReq({ headerExpiryMs: T0 + 3_600_000 - MARGIN_MS + 1000 });
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('HEADER_EXPIRY'));
});

test('C-30 transfer whose header expires after expires', () => {
  const req = transferReq({ headerExpiryMs: T0 + 3_600_000 + 1000 });
  assert.deepEqual(decide(reservedSnapshot(), req), refuse('HEADER_EXPIRY'));
});

test('C-31 transfer while now is within 60s of expires', () => {
  const s = reservedSnapshot({ slotTimeMs: T0 + 3_600_000 - 30_000 });
  assert.deepEqual(decide(s, transferReq()), refuse('TOO_CLOSE_TO_EXPIRY'));
});

test('C-32 transfer after the approval was revoked', () => {
  assert.deepEqual(
    decide(reservedSnapshot({ approval: null }), transferReq()),
    refuse('APPROVAL_REVOKED'),
  );
});

test('C-33 transfer after the payable was Paid', () => {
  const s = reservedSnapshot({ payable: { status: 'Paid' } });
  assert.deepEqual(decide(s, transferReq()), refuse('ALREADY_PAID'));
});

// C-34..C-35: clock independence and ledger write
test('C-34 the decision ignores the local clock', () => {
  const snap = reservedSnapshot();
  const req = transferReq();
  const before = decide(snap, req);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 60_000; // local clock +10 min
    assert.deepEqual(decide(snap, req), before);
    assert.deepEqual(decide(snapshot(), reserveReq()), { decision: 'SIGN' });
  } finally {
    Date.now = realNow;
  }
});

test('C-35 the ledger write fails -> REFUSE and no signature', () => {
  const failingStore = {
    append() {
      throw new Error('disk full');
    },
  };
  const d = prepareSignature(reservedSnapshot(), transferReq(), failingStore);
  assert.deepEqual(d, refuse('LEDGER_WRITE_FAILED'));
  assert.ok(!('signature' in d), 'no signature may be produced when the ledger write fails');

  // Happy path: the entry is written first, then the signature may be made.
  const entries = [];
  const store = { append: (e) => entries.push(e) };
  const ok = prepareSignature(reservedSnapshot(), transferReq(), store);
  assert.equal(ok.decision, 'SIGN');
  assert.equal(ok.signature, 'SIGNATURE_PLACEHOLDER');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payableKey, 'SELLER:1');
  assert.equal(entries[0].kind, 'transfer');
});
