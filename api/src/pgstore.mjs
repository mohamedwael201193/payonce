// PayOnce API server — Postgres implementation of the server store.
// Tables (all `payonce_*`, created by ensureSchema, never dropped):
//   payonce_jobs        job_id TEXT PK, payload JSONB (one row per pay job)
//   payonce_receipts    payable_id INT PK, payload JSONB (one row per receipt)
//   payonce_counters    id INT PK (=1), payload JSONB (verifier runs,
//                       live refusals, nextFreshId, freshIds)
//   payonce_rate_hits   (key, window_start) PK, hits INT (hourly budgets)
//   payonce_ledger      BIGSERIAL PK, payable_key TEXT, payload JSONB
//                       (co-signer ledger, append-only)
//   payonce_documents   payable_id INT PK, content TEXT, sha256 TEXT
//                       (lab invoice documents for fresh payables)
// The payables themselves live ON CHAIN (the registry is the payable
// store); this store holds only the server-side state listed above.
// Seed: on first boot, when a table is empty, its content is imported
// from the repo's committed api/data/ files (jobs/receipts/counters/
// ledger/documents) — the seed is the pre-defect state, so a fresh DB
// starts with receipts 10/11/1000-1003, refused counter 3, nextFreshId
// 1005. The import is idempotent (empty-table gate per table).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from './db.mjs';
import { DATA_DIR, FRESH_ID_START } from './config.mjs';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

export async function ensureSchema() {
  const pool = getPool();
  // One statement per query: a multi-statement string fails halfway with
  // a confusing error (and pg-mem cannot parse it at all); separate
  // statements report exactly which table failed.
  const statements = [
    `CREATE TABLE IF NOT EXISTS payonce_jobs (
      job_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_receipts (
      payable_id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_counters (
      id INTEGER PRIMARY KEY DEFAULT 1,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_rate_hits (
      key TEXT NOT NULL,
      window_start BIGINT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key, window_start)
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_ledger (
      id BIGSERIAL PRIMARY KEY,
      payable_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS payonce_ledger_key_idx ON payonce_ledger (payable_key)`,
    `CREATE TABLE IF NOT EXISTS payonce_documents (
      payable_id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`,
  ];
  for (const sql of statements) await pool.query(sql);
}

async function tableCount(pool, table) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return r.rows[0].n;
}

function readSeedJson(name) {
  try {
    const p = join(DATA_DIR, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch (e) {
    console.warn(`[seed] could not read ${name}: ${e.message}`);
    return null;
  }
}

/** Import the repo seed state into every table that is still empty.
 *  Returns true when at least one row was imported. */
export async function seedIfEmpty() {
  const pool = getPool();
  let imported = false;

  if ((await tableCount(pool, 'payonce_jobs')) === 0) {
    const jobs = readSeedJson('jobs.json') ?? {};
    for (const [jobId, payload] of Object.entries(jobs)) {
      await pool.query('INSERT INTO payonce_jobs (job_id, payload, updated_at) VALUES ($1, $2, now()) ON CONFLICT (job_id) DO NOTHING', [jobId, payload]);
    }
    if (Object.keys(jobs).length) { imported = true; console.log(`[seed] jobs: ${Object.keys(jobs).length} imported`); }
  }
  if ((await tableCount(pool, 'payonce_receipts')) === 0) {
    const receipts = readSeedJson('receipts.json') ?? {};
    for (const [payableId, payload] of Object.entries(receipts)) {
      await pool.query('INSERT INTO payonce_receipts (payable_id, payload, updated_at) VALUES ($1, $2, now()) ON CONFLICT (payable_id) DO NOTHING', [Number(payableId), payload]);
    }
    if (Object.keys(receipts).length) { imported = true; console.log(`[seed] receipts: ${Object.keys(receipts).length} imported`); }
  }
  if ((await tableCount(pool, 'payonce_counters')) === 0) {
    const counters = readSeedJson('counters.json');
    if (counters) {
      await pool.query('INSERT INTO payonce_counters (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO NOTHING', [counters]);
      imported = true;
      console.log(`[seed] counters: verifierRuns=${counters.verifierRuns} liveRefusals=${(counters.liveRefusals ?? []).length} nextFreshId=${counters.nextFreshId}`);
    }
  }
  if ((await tableCount(pool, 'payonce_ledger')) === 0) {
    const p = join(DATA_DIR, 'cosigner-ledger.jsonl');
    let n = 0;
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())) {
        try {
          const entry = JSON.parse(line);
          await pool.query('INSERT INTO payonce_ledger (payable_key, payload, created_at) VALUES ($1, $2, now())', [entry.payableKey ?? '', entry]);
          n += 1;
        } catch { /* skip a bad line, keep the rest */ }
      }
    }
    if (n) { imported = true; console.log(`[seed] ledger: ${n} entries imported`); }
  }
  if ((await tableCount(pool, 'payonce_documents')) === 0) {
    const dir = join(DATA_DIR, 'documents');
    let n = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
        const id = Number(f.replace(/\.txt$/, ''));
        if (!Number.isInteger(id)) continue;
        const content = readFileSync(join(dir, f), 'utf8');
        await pool.query(
          'INSERT INTO payonce_documents (payable_id, content, sha256, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (payable_id) DO NOTHING',
          [id, content, sha256Hex(Buffer.from(content, 'utf8'))],
        );
        n += 1;
      }
    }
    if (n) { imported = true; console.log(`[seed] documents: ${n} imported`); }
  }
  return imported;
}

// ---- jobs ----
export async function loadJobs() {
  const r = await getPool().query('SELECT job_id, payload FROM payonce_jobs');
  return Object.fromEntries(r.rows.map((row) => [row.job_id, row.payload]));
}
export async function saveJob(job) {
  await getPool().query(
    'INSERT INTO payonce_jobs (job_id, payload, updated_at) VALUES ($1, $2, now()) ON CONFLICT (job_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [job.job_id, job],
  );
}
export async function saveJobs(jobs) {
  for (const job of Object.values(jobs)) await saveJob(job);
}

// ---- receipts ----
export async function loadReceipts() {
  const r = await getPool().query('SELECT payable_id, payload FROM payonce_receipts');
  return Object.fromEntries(r.rows.map((row) => [row.payable_id, row.payload]));
}
export async function saveReceipt(receipt) {
  await getPool().query(
    'INSERT INTO payonce_receipts (payable_id, payload, updated_at) VALUES ($1, $2, now()) ON CONFLICT (payable_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [receipt.payable_id, receipt],
  );
}
export async function saveReceipts(receipts) {
  for (const receipt of Object.values(receipts)) await saveReceipt(receipt);
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
  const r = await getPool().query('SELECT payload FROM payonce_counters WHERE id = 1');
  return r.rows[0]?.payload ?? defaultCounters();
}
export async function saveCounters(c) {
  await getPool().query(
    'INSERT INTO payonce_counters (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [c],
  );
}

// ---- rate limits (persisted sliding windows; the budget numbers in
// /api/health are the caller's remaining quota and survive restarts) ----
export async function hitWindow(key, windowMs, limit) {
  const pool = getPool();
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const r = await pool.query(
    `INSERT INTO payonce_rate_hits (key, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET hits = payonce_rate_hits.hits + 1
     RETURNING hits`,
    [key, windowStart],
  );
  const hits = r.rows[0].hits;
  // Best-effort prune of expired windows (never blocks the request).
  pool.query('DELETE FROM payonce_rate_hits WHERE window_start < $1', [now - windowMs]).catch(() => {});
  if (hits > limit) return { allowed: false, left: 0, resetMs: windowStart + windowMs - now };
  return { allowed: true, left: limit - hits, resetMs: windowMs };
}
export async function leftInWindow(key, windowMs, limit) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const r = await getPool().query('SELECT hits FROM payonce_rate_hits WHERE key = $1 AND window_start = $2', [key, windowStart]);
  return Math.max(0, limit - (r.rows[0]?.hits ?? 0));
}

// ---- co-signer ledger (append-only) ----
export async function appendLedgerEntry(entry) {
  await getPool().query('INSERT INTO payonce_ledger (payable_key, payload, created_at) VALUES ($1, $2, now())', [entry.payableKey ?? '', entry]);
}
export async function ledgerRows() {
  const r = await getPool().query('SELECT payload FROM payonce_ledger ORDER BY id');
  return r.rows.map((row) => row.payload);
}
export async function resolveLedgerTransfer(payableKey, txHash) {
  const r = await getPool().query(
    `UPDATE payonce_ledger SET payload = jsonb_set(payload, '{state}', '"resolved"')
     WHERE payable_key = $1 AND payload->>'state' = 'unresolved'
       AND ($2::text IS NULL OR payload->>'txHash' = $2)
     RETURNING id`,
    [payableKey, txHash ?? null],
  );
  return r.rowCount > 0;
}

// ---- lab documents ----
export async function storeDocumentRecord(id, text) {
  const hash = sha256Hex(Buffer.from(text, 'utf8'));
  await getPool().query(
    'INSERT INTO payonce_documents (payable_id, content, sha256, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (payable_id) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256',
    [id, text, hash],
  );
  return hash;
}
export async function storedDocumentRecord(id) {
  const r = await getPool().query('SELECT content FROM payonce_documents WHERE payable_id = $1', [id]);
  return r.rows[0] ? Buffer.from(r.rows[0].content, 'utf8') : null;
}
