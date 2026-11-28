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
import { DATA_DIR, FRESH_ID_START, OWNER_ADDRESS } from './config.mjs';

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

// ---- composite keys (second-seller fix-back 2026-11-25, §4.2/§4.3) ----
// Receipts and consents are keyed by (seller, payable id): payable ids
// collide across sellers (seller 1's matrix payable 1 vs seller 2's
// payable 1 are different payables; the registry keys by (seller, id)).
// A stored row only ever matches the seller it was built for — there is
// no bare-id fallback anywhere. Legacy seller-less rows are never served:
// saveReceipt/saveConsent hand-attribute a row with no seller to seller 1
// (OWNER_ADDRESS) — every receipt/consent this server ever wrote before
// the second-seller patch was seller 1's by construction (the server was
// seller-1-only), and the colliding ids 1/2 were Unpaid for seller 1, so
// no legacy row for a colliding id exists. A row planted or loaded under
// a bare key is simply never found by a composite lookup.
export function receiptKey(seller, payableId) {
  return `${seller ?? OWNER_ADDRESS}:${payableId}`;
}
export function consentKey(seller, payableId) {
  return `${seller ?? OWNER_ADDRESS}:${payableId}`;
}

// ---- receipts ----
export async function loadReceipts() {
  return loadJson('receipts.json', {});
}
export async function saveReceipt(receipt) {
  const receipts = loadJson('receipts.json', {});
  receipts[receiptKey(receipt.seller, receipt.payable_id)] = receipt;
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

// ---- consents (one record per (seller, payable), keyed by seller:payableId) ----
// Main-defect fix (2026-11-25): b55ae35's consent.mjs / receipts.mjs /
// server.mjs import these, but no backend ever implemented them.
// Same map-file shape as receipts: loadConsents() returns {} when no
// consent has ever been recorded; saveConsent upserts by (seller,
// payableId). Second-seller fix-back (§4.3): the key is composite —
// the main-defect fix's bare-payableId keying is superseded here, so a
// consent for seller-1 payable 2 can never be reported (or consumed on
// pay) as seller-2 payable 2's consent.
export async function loadConsents() {
  return loadJson('consents.json', {});
}
export async function saveConsent(record) {
  const consents = loadJson('consents.json', {});
  consents[consentKey(record.seller, record.payableId)] = record;
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

// ---- last complete registry scan ----
export async function loadScan() {
  return loadJson('scan.json', null);
}
export async function saveScan(scan) {
  saveJson('scan.json', scan);
}

// ---- generic namespaced records (open sellers, their documents, hosted agent cards) ----
function kvAll() { return loadJson('kv.json', {}); }
export async function kvGet(ns, key) {
  return kvAll()[ns]?.[key] ?? null;
}
export async function kvPut(ns, key, payload) {
  const all = kvAll();
  all[ns] = { ...(all[ns] ?? {}), [key]: payload };
  saveJson('kv.json', all);
}
export async function kvPutIfAbsent(ns, key, payload) {
  const all = kvAll();
  if (all[ns]?.[key] !== undefined) return false;
  all[ns] = { ...(all[ns] ?? {}), [key]: payload };
  saveJson('kv.json', all);
  return true;
}
export async function kvList(ns) {
  return Object.entries(kvAll()[ns] ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
}
export async function kvDelete(ns, key) {
  const all = kvAll();
  if (all[ns]) { delete all[ns][key]; saveJson('kv.json', all); }
}
