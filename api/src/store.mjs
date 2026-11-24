// PayOnce API server — server-side store (JSON files under data/).
// Jobs, receipts, verifier-run counters, live-refusal records and
// rate-limit windows. Nothing here holds keys. Everything the frontend
// needs after a payment (the payment tx hash for a CCD pay — the v2
// contract does not record it, F5) is recovered from this store first,
// then from the recorded evidence index.
// Files are written atomically (tmp + rename) so a crash never leaves a
// half-written job behind.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, FRESH_ID_START } from './config.mjs';

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
export function loadJobs() {
  return loadJson('jobs.json', {});
}
export function saveJobs(jobs) {
  saveJson('jobs.json', jobs);
}
export function runningJobFor(jobs, payableId, rail) {
  return Object.values(jobs).find(
    (j) => j.payable_id === payableId && j.rail === rail && j.state === 'running',
  ) ?? null;
}

// ---- receipts ----
export function loadReceipts() {
  return loadJson('receipts.json', {});
}
export function saveReceipts(receipts) {
  saveJson('receipts.json', receipts);
}

// ---- counters ----
export function loadCounters() {
  return loadJson('counters.json', {
    verifierRuns: 0,
    verifierPassed: 0,
    verifierFailed: 0,
    lastVerifierRunAt: null,
    liveRefusals: [], // { txHash, code, at } — refusals this server observed live
    nextFreshId: FRESH_ID_START,
    freshIds: [], // payable ids this server created (for the /api/invoices scan)
  });
}
export function saveCounters(c) {
  saveJson('counters.json', c);
}

// ---- rate limits (in-memory sliding windows; the budget numbers in
// /api/health are the caller's remaining quota) ----
const windows = new Map(); // key -> [epochMs, ...]
export function hitWindow(key, windowMs, limit) {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return { allowed: false, left: 0, resetMs: windowMs - (now - arr[0]) };
  arr.push(now);
  windows.set(key, arr);
  return { allowed: true, left: limit - arr.length, resetMs: windowMs };
}
export function leftInWindow(key, windowMs, limit) {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  return Math.max(0, limit - arr.length);
}
