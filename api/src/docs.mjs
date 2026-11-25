// PayOnce API server — lab documents + recorded evidence index.
// Every document served here hashes to the on-chain doc_hash for its
// payable (the fingerprint check proves it):
//   - payables 1–5 (contract matrix): the registered document is exactly
//     the marker string `payonce-live-matrix-<n>` — sha256 of that string
//     IS the on-chain doc_hash (matrix-v2.mjs DOC(n)). No invoice text
//     exists for them; the marker is what was registered.
//   - payables 10–11 (v2 happy path): the lab invoice files from the
//     backend tree (hashes verified against the chain at startup).
//   - fresh payables: the lab invoice this server generated at creation
//     time (stored under data/documents/), hashed before registering.
// Anything else: 404 (P3 §16.5 — the document endpoint returns lab
// documents only).
// The evidence index is built from the backend's recorded run files
// (test/*.json + the contract matrix result): real tx hashes, real
// refusals, real receipts — labelled "Recorded run, 24 Nov 2026".
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_DIR } from './backend.mjs';
import { SELLER2_ADDRESS } from './config.mjs';
import { storeDocumentRecord, storedDocumentRecord } from './store.mjs';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

export function matrixDocBytes(id) {
  return Buffer.from(`payonce-live-matrix-${id}`, 'utf8');
}

/** Deterministic lab invoice text for a fresh payable (same shape as the
 *  v2 happy-path invoice files). The hash of THESE bytes is registered. */
export function generateLabDocument({ id, asset, amount, payee, seller, due }) {
  const amountLine = asset === 'CCD'
    ? `Amount: ${(Number(amount) / 1e6).toFixed(6)} CCD (${amount} microCCD)`
    : `Amount: ${(Number(amount) / 1e6).toFixed(2)} EUDemo (${amount} base units, 6 decimals)`;
  return [
    `PAYONCE LAB INVOICE — payable ${id} (${asset === 'CCD' ? 'CCD' : 'EUDemo'})`,
    `Seller: ${seller}`,
    `Payee: ${payee}`,
    amountLine,
    `Due: ${new Date(Number(due)).toISOString()}`,
    'Test only — Concordium testnet, no real goods or services.',
    '',
  ].join('\n');
}

/** Store a lab document for a fresh payable (Postgres payonce_documents
 *  when DATABASE_URL is set, api/data/documents/ otherwise). Returns its
 *  SHA-256 hex — the hash that is registered on chain. */
export async function storeDocument(id, text) {
  return storeDocumentRecord(id, text);
}

export async function storedDocument(id) {
  return storedDocumentRecord(id);
}

const V2_INVOICE_FILES = {
  10: 'test/invoices/invoice-010-v2-ccd.txt',
  11: 'test/invoices/invoice-011-v2-eudemo.txt',
};

// Second seller's invoice files (live 2026-11-25): payable 1, 0.5 CCD;
// payable 2, 10 EUDemo.
const SELLER2_INVOICE_FILES = {
  1: 'test/invoices/invoice-seller2-001-ccd.txt',
  2: 'test/invoices/invoice-seller2-002-eudemo.txt',
};

/** Document bytes for a payable id, or null when no lab document exists. */
export async function docForPayableForSeller(seller, id) {
  if (seller === SELLER2_ADDRESS && SELLER2_INVOICE_FILES[id]) {
    const p = join(BACKEND_DIR, SELLER2_INVOICE_FILES[id]);
    if (existsSync(p)) return readFileSync(p);
    return null;
  }
  return docForPayable(id);
}

export async function docForPayable(id) {
  const stored = await storedDocument(id);
  if (stored) return stored;
  if (V2_INVOICE_FILES[id]) {
    const p = join(BACKEND_DIR, V2_INVOICE_FILES[id]);
    if (existsSync(p)) return readFileSync(p);
  }
  if (id >= 1 && id <= 5) return matrixDocBytes(id);
  return null;
}

// ---- recorded evidence index (built once at startup) ----

function loadJsonIfExists(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

function collectTxHashes(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) && /tx|hash/i.test(k)) out.push({ key: k, hash: v });
    else if (typeof v === 'object') collectTxHashes(v, out);
  }
  return out;
}

let evidence = null;
export function evidenceIndex() {
  if (evidence) return evidence;
  const v2 = loadJsonIfExists(join(BACKEND_DIR, 'test/v2-live-e2e-2026-11-24.json'));
  const s2 = loadJsonIfExists(join(BACKEND_DIR, 'test/second-seller-e2e-2026-11-25.json'));
  const s2eudemo = loadJsonIfExists(join(BACKEND_DIR, 'test/second-seller-e2e-2026-11-25-eudemo.json'));
  const v1 = loadJsonIfExists(join(BACKEND_DIR, 'test/live-e2e-2026-11-24.json'));
  const x402 = loadJsonIfExists(join(BACKEND_DIR, 'test/x402-e2e-2026-11-24.json'));
  const mcp = loadJsonIfExists(join(BACKEND_DIR, 'test/mcp-live-pay-2026-11-24.json'));
  const matrix = loadJsonIfExists(join(BACKEND_DIR, '../contracts/scripts/matrix-v2-result.json'));

  // Payment txs for the v2 happy path (from the recorded run, not guessed).
  const paymentTx = {};
  if (v2?.railA?.payTx) paymentTx[10] = { payTx: v2.railA.payTx, registerTx: v2.railA.registerTx ?? null };
  if (v2?.railB) {
    paymentTx[11] = {
      transferTx: v2.railB.transferTx,
      reserveTx: v2.railB.reserveTx ?? null,
      confirmTx: v2.railB.confirmTx ?? null,
      registerTx: v2.railB.registerTx ?? null,
    };
  }

  // On-chain refusals recorded in the evidence (distinct tx hashes whose
  // summary carries a rejectReason). The chain has no refusal counter, so
  // this count is: recorded refusals in the evidence files + live refusals
  // this server observes (persisted in the store). Method documented in
  // API_REPORT.md; the number is never presented as a chain counter.
  const refused = new Map();
  const scanForRejects = (obj, source) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach((e) => scanForRejects(e, source)); return; }
    const summary = obj.summary ?? obj.registerSummary ?? null;
    const hash = obj.hash ?? obj.hashHex ?? obj.txHash ?? null;
    const rr = summary?.rejectReason ?? obj.rejectReason ?? null;
    if (hash && rr !== null && rr !== undefined) {
      refused.set(hash, { code: typeof rr === 'object' ? rr.rejectReason : rr, source });
    }
    for (const v of Object.values(obj)) scanForRejects(v, source);
  };
  if (matrix?.results) scanForRejects(matrix.results, 'matrix-v2');
  if (v1) scanForRejects(v1, 'live-e2e-v1');
  if (v2) scanForRejects(v2, 'v2-live-e2e');
  if (x402) scanForRejects(x402, 'x402-e2e');
  if (mcp) scanForRejects(mcp, 'mcp-live-pay');

  // Second seller's recorded payments (live 2026-11-25): payable 1, CCD;
  // payable 2, EUDemo. Payable 2 keeps ALL its legs (reserve / transfer /
  // confirm), not just the transfer: the receipt builder mirrors the
  // seller-1 EUDemo branch, which needs the reserve + confirm legs for
  // its fail-closed verifier rows (fix-back §4.1 — the old shape stored
  // only { payTx: transferTx }, which mislabelled the transfer as
  // 'Payment' and dropped the other legs, so the verifier never ran).
  const paymentTxSeller2 = {};
  if (s2?.payTx) paymentTxSeller2[1] = { payTx: s2.payTx, registerTx: s2.registerTx ?? null };
  if (s2eudemo?.transferTx) {
    paymentTxSeller2[2] = {
      transferTx: s2eudemo.transferTx,
      reserveTx: s2eudemo.reserveTx ?? null,
      confirmTx: s2eudemo.confirmTx ?? null,
      registerTx: s2eudemo.registerTx ?? null,
    };
  }
  evidence = { v2, v1, x402, mcp, matrix, paymentTx, refused, s2, s2eudemo, paymentTxSeller2 };
  return evidence;
}

/** Recorded payment transactions for a payable (evidence index only). */
export function recordedPaymentTx(id) {
  return evidenceIndex().paymentTx[id] ?? null;
}

/** Recorded payment transactions for one seller's payable. */
export function recordedPaymentTxForSeller(seller, id) {
  if (seller !== SELLER2_ADDRESS) return null;
  return evidenceIndex().paymentTxSeller2[id] ?? null;
}

/** Distinct on-chain refusals recorded in the evidence files. */
export function recordedRefusals() {
  return evidenceIndex().refused;
}

/** A recorded run (for GET /api/recorded/:id): the v2 happy path for
 *  10/11, the v1 run for 1/2/4/6/7, matrix cases otherwise. Steps carry
 *  the real tx hashes from the evidence files. Seller-aware (fix-back
 *  §4.3): seller 2's runs come from its own evidence files (s2 /
 *  s2eudemo) — a ?seller=<S2> request must never be answered with
 *  seller 1's v1 run for the same id. */
export function recordedRunFor(id, seller = null) {
  const ev = evidenceIndex();
  const steps = [];
  const push = (step, detail, txHash = null, layer = 'chain') => steps.push({ step, detail, txHash, layer });
  if (seller === SELLER2_ADDRESS) {
    if (id === 1 && ev.s2) {
      const r = ev.s2;
      push('register', 'Payable 1 registered (seller 2, CCD 0.5, payee = seller 2, due 26 Nov 2026)', r.registerTx);
      push('pay', 'Buyer B paid via pay_ccd (0.5 CCD attached)', r.payTx);
      push('verify', 'Verifier re-run: 10/10 checks pass (CCD branch)', null, 'app');
      return { payable_id: 1, seller: SELLER2_ADDRESS, date: '2026-11-25', steps };
    }
    if (id === 2 && ev.s2eudemo) {
      const r = ev.s2eudemo;
      push('register', 'Payable 2 registered (seller 2, EUDemo 10, payee = seller 2, due 26 Nov 2026)', r.registerTx);
      push('reserve', 'Buyer B reserved the payable (co-signer gate: SIGN)', r.reserveTx);
      push('transfer', 'EUDemo transfer 10 to seller 2, memo payable:3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr:2', r.transferTx);
      push('confirm', 'Buyer B confirmed the transfer hash on chain', r.confirmTx);
      push('verify', 'Verifier re-run: 12/12 checks pass (EUDemo branch) — as recorded 2026-11-25; the branch now runs 14 checks', null, 'app');
      return { payable_id: 2, seller: SELLER2_ADDRESS, date: '2026-11-25', steps };
    }
    return null;
  }
  if (id === 10 && ev.v2?.railA) {
    const r = ev.v2.railA;
    push('register', 'Payable 10 registered (CCD 0.5, payee1, due 26 Dec 2026)', r.registerTx);
    push('pay', 'Owner paid via pay_ccd (0.5 CCD attached)', r.payTx);
    push('verify', 'Verifier re-run: 10/10 checks pass (CCD branch)', null, 'app');
    return { payable_id: 10, date: '2026-11-24', steps };
  }
  if (id === 11 && ev.v2?.railB) {
    const r = ev.v2.railB;
    push('register', 'Payable 11 registered (EUDemo 0.01, payee2, due 26 Dec 2026)', r.registerTx);
    push('reserve', 'Seller B reserved the payable (co-signer gate: SIGN)', r.reserveTx);
    push('transfer', 'EUDemo transfer 0.01 to payee2, memo payable:<seller>:11', r.transferTx);
    push('confirm', 'Seller confirmed the transfer hash on chain', r.confirmTx);
    push('verify', 'Verifier re-run: 12/12 checks pass (EUDemo branch) — as recorded 2026-11-24; the branch now runs 14 checks', null, 'app');
    return { payable_id: 11, date: '2026-11-24', steps };
  }
  if (ev.v1) {
    // v1 recorded run (payables 1, 2, 4, 6, 7, 10, 11 on <13149,0>).
    const v1ids = { 1: 'payable 1 (CCD 1.0)', 2: 'payable 2 (EUDemo 1.0)', 4: 'payable 4 (CCD 0.5)', 6: 'payable 6 (CCD 0.5)', 7: 'payable 7 (EUDemo 1.0)' };
    if (v1ids[id]) {
      push('run', `Recorded run, 24 Nov 2026 — ${v1ids[id]} on the v1 registry <13149,0> (superseded by v2 <13150,0>)`, null, 'app');
      for (const { key, hash } of collectTxHashes(ev.v1)) {
        if (key.toLowerCase().includes(String(id))) push(key, `recorded transaction ${hash.slice(0, 8)}…`, hash);
      }
      return { payable_id: id, date: '2026-11-24', steps };
    }
  }
  return null;
}

// ---- judge files (only files that exist, SHA-256 computed at startup) ----

const JUDGE_FILE_DEFS = [
  { name: 'verify-payable-v2.mjs', path: () => join(new URL('../src/', import.meta.url).pathname, 'verify-payable-v2.mjs') },
  { name: 'verify-payable.mjs', path: () => join(BACKEND_DIR, 'src/verifier/verify-payable.mjs') },
  { name: 'v2-live-e2e-2026-11-24.json', path: () => join(BACKEND_DIR, 'test/v2-live-e2e-2026-11-24.json') },
  { name: 'live-e2e-2026-11-24.json', path: () => join(BACKEND_DIR, 'test/live-e2e-2026-11-24.json') },
  { name: 'invoice-010-v2-ccd.txt', path: () => join(BACKEND_DIR, 'test/invoices/invoice-010-v2-ccd.txt') },
  { name: 'invoice-011-v2-eudemo.txt', path: () => join(BACKEND_DIR, 'test/invoices/invoice-011-v2-eudemo.txt') },
  { name: 'invoice-006-ccd.txt', path: () => join(BACKEND_DIR, 'test/invoices/invoice-006-ccd.txt') },
  { name: 'invoice-007-eudemo.txt', path: () => join(BACKEND_DIR, 'test/invoices/invoice-007-eudemo.txt') },
];

export function judgeFiles() {
  const out = [];
  for (const def of JUDGE_FILE_DEFS) {
    const p = def.path();
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    out.push({ name: def.name, url: `/api/judges/files/${encodeURIComponent(def.name)}`, sha256: sha256Hex(bytes), path: p });
  }
  return out;
}
