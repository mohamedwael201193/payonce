// PayOnce API server — server-side store (facade).
// Backend is selected by src/db.mjs: Postgres when DATABASE_URL is set,
// the original JSON files under api/data/ otherwise (local dev + tests).
// Every function is async and self-initialising (the first call runs the
// migration + seed for Postgres); the server also awaits initStore()
// explicitly at startup so a dead DB fails fast instead of failing the
// first request.
// What lives here: pay jobs, receipts, verifier-run counters, live-refusal
// records, rate-limit windows, the co-signer ledger, lab documents,
// consent records (one per (seller, payable), keyed by seller:payableId),
// the buyer-agent registration (single record).
// Nothing here holds keys. The payables themselves live ON CHAIN (the
// registry is the payable store); this store holds only server-side state.
// Single-row saves (saveJob/saveReceipt) are the hot path: a whole-table
// rewrite would lose a concurrent job's update. Bulk saves are kept for
// the rare whole-store writes.
import { initStore, isPostgres } from './db.mjs';
import * as json from './jsonstore.mjs';
import * as pgstore from './pgstore.mjs';

function impl() {
  return isPostgres() ? pgstore : json;
}

/** Ensure the backend is ready (migrate + seed for Postgres). */
export async function ready() {
  return initStore();
}

export function runningJobFor(jobs, payableId, rail) {
  return Object.values(jobs).find(
    (j) => j.payable_id === payableId && j.rail === rail && j.state === 'running',
  ) ?? null;
}

// ---- jobs ----
export async function loadJobs() {
  await initStore();
  return impl().loadJobs();
}
export async function saveJob(job) {
  await initStore();
  return impl().saveJob(job);
}
export async function saveJobs(jobs) {
  await initStore();
  return impl().saveJobs(jobs);
}

// ---- receipts (keyed by (seller, payable_id) — second-seller fix-back §4.2) ----
export { receiptKey, consentKey } from './jsonstore.mjs';

export async function loadReceipts() {
  await initStore();
  return impl().loadReceipts();
}
export async function saveReceipt(receipt) {
  await initStore();
  return impl().saveReceipt(receipt);
}
export async function saveReceipts(receipts) {
  await initStore();
  return impl().saveReceipts(receipts);
}

// ---- counters ----
export async function loadCounters() {
  await initStore();
  return impl().loadCounters();
}
export async function saveCounters(c) {
  await initStore();
  return impl().saveCounters(c);
}
// Serialised read-modify-write of the counters document. The counters row
// is ONE document (verifier runs, live refusals, fresh-id allocation); the
// old load ... await chain finality ... save pattern overwrote concurrent
// changes (a pay job finishing, a verify run) with a stale copy and could
// move nextFreshId BACKWARDS, so the next create hit chain Duplicate (-2).
// Every mutation now goes through this queue: the mutator runs on a fresh
// load and its result is saved before the next one starts. (One API
// process; a second instance would need a row lock in pgstore as well.)
let counterQueue = Promise.resolve();
export function updateCounters(mutator) {
  const run = counterQueue.then(async () => {
    const c = await loadCounters();
    const out = await mutator(c);
    await saveCounters(c);
    return out;
  });
  counterQueue = run.catch(() => {});
  return run;
}

// ---- consents (one record per (seller, payable), keyed by seller:payableId) ----
// Added by the main-defect fix (2026-11-25): b55ae35 imported
// loadConsents/saveConsent from this facade (consent.mjs, receipts.mjs,
// server.mjs) without ever implementing them, so server.mjs could not
// even be imported. Second-seller fix-back (§4.3): the key is composite
// (seller:payableId), superseding the main-defect fix's bare-payableId
// keying. Semantics are exactly what the callers already assume:
// loadConsents() returns the { 'seller:payableId': record } map ({} when
// none exist) and saveConsent(record) upserts by (record.seller,
// record.payableId).
export async function loadConsents() {
  await initStore();
  return impl().loadConsents();
}
export async function saveConsent(record) {
  await initStore();
  return impl().saveConsent(record);
}

// ---- buyer agent (single record: the demo payer's CIS-8004 registration) ----
// Same defect as consents: b55ae35 imported loadBuyerAgent/saveBuyerAgent
// (buyer-agent.mjs, server.mjs) without implementing them.
// loadBuyerAgent() returns the record or null when never registered;
// saveBuyerAgent(record) overwrites the single record.
export async function loadBuyerAgent() {
  await initStore();
  return impl().loadBuyerAgent();
}
export async function saveBuyerAgent(record) {
  await initStore();
  return impl().saveBuyerAgent(record);
}

// ---- rate limits ----
export async function hitWindow(key, windowMs, limit) {
  await initStore();
  return impl().hitWindow(key, windowMs, limit);
}
export async function leftInWindow(key, windowMs, limit) {
  await initStore();
  return impl().leftInWindow(key, windowMs, limit);
}

// ---- co-signer ledger ----
export async function appendLedgerEntry(entry) {
  await initStore();
  return impl().appendLedgerEntry(entry);
}
export async function ledgerRows() {
  await initStore();
  return impl().ledgerRows();
}
export async function resolveLedgerTransfer(payableKey, txHash) {
  await initStore();
  return impl().resolveLedgerTransfer(payableKey, txHash);
}

// ---- lab documents ----
export async function storeDocumentRecord(id, text) {
  await initStore();
  return impl().storeDocumentRecord(id, text);
}
export async function storedDocumentRecord(id) {
  await initStore();
  return impl().storedDocumentRecord(id);
}
