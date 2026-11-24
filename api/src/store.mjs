// PayOnce API server — server-side store (facade).
// Backend is selected by src/db.mjs: Postgres when DATABASE_URL is set,
// the original JSON files under api/data/ otherwise (local dev + tests).
// Every function is async and self-initialising (the first call runs the
// migration + seed for Postgres); the server also awaits initStore()
// explicitly at startup so a dead DB fails fast instead of failing the
// first request.
// What lives here: pay jobs, receipts, verifier-run counters, live-refusal
// records, rate-limit windows, the co-signer ledger, lab documents.
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

// ---- receipts ----
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
