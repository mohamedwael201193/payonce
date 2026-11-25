// PayOnce API server — JSON-file implementation of the server store.
// The ORIGINAL store (api/data/ JSON + cosigner-ledger.jsonl + documents/),
// kept for local dev and unit tests (no DATABASE_URL). Behaviour is
// identical to the pre-migration code; every function is async so the
// facade can swap in Postgres without touching callers.
// WARNING: on Render this backend is ephemeral — a restart/redeploy loses
// every runtime write (the 2026-11-24 receipt defect). Production must
// run with DATABASE_URL set (Postgres). See src/db.mjs.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, FRESH_ID_START } from './config.mjs';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const LEDGER_PATH = join(DATA_DIR, 'cosigner-ledger.jsonl');
const DOCS_DIR = join(DATA_DIR, 'documents');

mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) {
  try {
    const p = join(DATA_DIR, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(name, value) {
  const p = join(DATA_DIR, name);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, p);
}

// ---- jobs ----
export async function loadJobs() {
  return loadJson('jobs.json', {});
}
export async function saveJob(job) {
  const jobs = loadJson('jobs.json', {});
  jobs[job.job_id] = job;
  saveJson('jobs.json', jobs);
}
export async function saveJobs(jobs) {
  saveJson('jobs.json', jobs);
}

// ---- receipts ----
export async function loadReceipts() {
  return loadJson('receipts.json', {});
}
export async function saveReceipt(receipt) {
  const receipts = loadJson('receipts.json', {});
  receipts[receipt.payable_id] = receipt;
  saveJson('receipts.json', receipts);
}
export async function saveReceipts(receipts) {
  saveJson('receipts.json', receipts);
}

// ---- counters ----
export function defaultCounters() {
  return {
    verifierRuns: 0,
    verifierPassed: 0,
    verifierFailed: 0,
    lastVerifierRunAt: null,
    liveRefusals: [],
    nextFreshId: FRESH_ID_START,
    freshIds: [],
  };
}
export async function loadCounters() {
  return loadJson('counters.json', defaultCounters());
}
export async function saveCounters(c) {
  saveJson('counters.json', c);
}

// ---- consents (one record per payable, keyed by payableId) ----
// Main-defect fix (2026-11-25): b55ae35's consent.mjs / receipts.mjs /
// server.mjs import these, but no backend ever implemented them.
// Same map-file shape as receipts: loadConsents() returns {} when no
// consent has ever been recorded; saveConsent upserts by payableId.
export async function loadConsents() {
  return loadJson('consents.json', {});
}
export async function saveConsent(record) {
  const consents = loadJson('consents.json', {});
  consents[record.payableId] = record;
  saveJson('consents.json', consents);
}

// ---- buyer agent (single record: the demo payer's CIS-8004 registration) ----
// Main-defect fix (2026-11-25): same missing-export defect as consents.
// loadBuyerAgent() returns the record or null when never registered;
// saveBuyerAgent overwrites the single record.
export async function loadBuyerAgent() {
  return loadJson('buyer-agent.json', null);
}
export async function saveBuyerAgent(record) {
  saveJson('buyer-agent.json', record);
}

// ---- rate limits (in-memory sliding windows; reset on restart —
// the JSON backend is dev-only, so this is documented, not hidden) ----
const windows = new Map(); // key -> [epochMs, ...]
export async function hitWindow(key, windowMs, limit) {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return { allowed: false, left: 0, resetMs: windowMs - (now - arr[0]) };
  arr.push(now);
  windows.set(key, arr);
  return { allowed: true, left: limit - arr.length, resetMs: windowMs };
}
export async function leftInWindow(key, windowMs, limit) {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  return Math.max(0, limit - arr.length);
}

// ---- co-signer ledger (append-only JSONL) ----
export async function appendLedgerEntry(entry) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
}
export async function ledgerRows() {
  try {
    if (!existsSync(LEDGER_PATH)) return [];
    return readFileSync(LEDGER_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
export async function resolveLedgerTransfer(payableKey, txHash) {
  const entries = await ledgerRows();
  let changed = false;
  const out = entries.map((e) => {
    if (e.payableKey === payableKey && e.state === 'unresolved' && (!txHash || e.txHash === txHash)) {
      changed = true;
      return { ...e, state: 'resolved' };
    }
    return e;
  });
  if (changed) {
    writeFileSync(LEDGER_PATH, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return changed;
}

// ---- lab documents ----
export async function storeDocumentRecord(id, text) {
  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(join(DOCS_DIR, `${id}.txt`), text, 'utf8');
  return sha256Hex(Buffer.from(text, 'utf8'));
}
export async function storedDocumentRecord(id) {
  const p = join(DOCS_DIR, `${id}.txt`);
  return existsSync(p) ? readFileSync(p) : null;
}
