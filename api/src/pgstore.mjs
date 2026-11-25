// PayOnce API server — Postgres implementation of the server store.
// Tables (all `payonce_*`, created by ensureSchema, never dropped):
//   payonce_jobs        job_id TEXT PK, payload JSONB (one row per pay job)
//   payonce_receipts    (seller TEXT, payable_id INT) composite PK,
//                       payload JSONB (one row per (seller, payable) —
//                       second-seller fix-back 2026-11-25 §4.2: payable
//                       ids collide across sellers, so the bare
//                       payable_id PK is replaced; ensureSchema migrates
//                       an existing old-shape table, see below)
//   payonce_counters    id INT PK (=1), payload JSONB (verifier runs,
//                       live refusals, nextFreshId, freshIds)
//   payonce_consents    (seller TEXT, payable_id INT) composite PK,
//                       payload JSONB (one consent record per (seller,
//                       payable) — second-seller fix-back §4.3, supersedes
//                       the main-defect fix's bare-payableId keying;
//                       main-defect fix 2026-11-25: b55ae35 imported
//                       loadConsents/saveConsent but no backend had them)
//   payonce_buyer_agent id INT PK (=1), payload JSONB (the single
//                       buyer-agent registration record — same defect)
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
import { DATA_DIR, FRESH_ID_START, OWNER_ADDRESS } from './config.mjs';

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
      seller TEXT NOT NULL,
      payable_id INTEGER NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (seller, payable_id)
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_counters (
      id INTEGER PRIMARY KEY DEFAULT 1,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_consents (
      seller TEXT NOT NULL,
      payable_id INTEGER NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (seller, payable_id)
    )`,
    `CREATE TABLE IF NOT EXISTS payonce_buyer_agent (
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
  // Migrate pre-fix-back tables from the bare-payable_id PK to the
  // composite (seller, payable_id) PK (second-seller fix-back §4.2/§4.3).
  // A fresh DB already has the new shape (CREATE above) and is skipped:
  // the migration only fires when the live PK is exactly
  // `PRIMARY KEY (payable_id)`. Legacy rows are hand-attributed to
  // seller 1 — every receipt/consent the pre-patch server ever wrote was
  // seller 1's by construction (the server was seller-1-only), and the
  // colliding ids 1/2 were Unpaid for seller 1, so no legacy row for a
  // colliding id exists to misattribute. The equivalent manual SQL is
  // documented in the fix-back report (FIXBACK_REPORT.md §4.2) for a
  // DBA-run migration instead of this boot-time one.
  await migrateToCompositeKey(pool, 'payonce_receipts');
  await migrateToCompositeKey(pool, 'payonce_consents');
}

/**
 * One-table migration: bare `payable_id` PK → composite
 * `(seller, payable_id)` PK. No-op unless the live PK is exactly the old
 * single-column one. Runs only against real Postgres (ensureSchema is
 * only called when DATABASE_URL is set), so pg_catalog introspection is
 * available here.
 */
async function migrateToCompositeKey(pool, table) {
  const r = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
    [table],
  );
  if ((r.rows[0]?.def ?? '') !== 'PRIMARY KEY (payable_id)') return;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS seller TEXT`);
  await pool.query(
    `UPDATE ${table} SET seller = COALESCE(payload->>'seller', $1) WHERE seller IS NULL`,
    [OWNER_ADDRESS],
  );
  await pool.query(`ALTER TABLE ${table} ALTER COLUMN seller SET NOT NULL`);
  await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
  await pool.query(`ALTER TABLE ${table} ADD PRIMARY KEY (seller, payable_id)`);
  console.log(`[migrate] ${table}: bare payable_id PK -> composite (seller, payable_id) PK`);
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
      // Seed rows are seller-less (pre-patch receipts.json); every one is
      // seller 1's by construction — see the migration note in
      // ensureSchema. The payload's own seller wins when present.
      const seller = payload?.seller ?? OWNER_ADDRESS;
      await pool.query('INSERT INTO payonce_receipts (seller, payable_id, payload, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (seller, payable_id) DO NOTHING', [seller, Number(payableId), payload]);
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
  if ((await tableCount(pool, 'payonce_consents')) === 0) {
    const consents = readSeedJson('consents.json') ?? {};
    for (const [payableId, payload] of Object.entries(consents)) {
      const seller = payload?.seller ?? OWNER_ADDRESS;
      await pool.query('INSERT INTO payonce_consents (seller, payable_id, payload, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (seller, payable_id) DO NOTHING', [seller, Number(payableId), payload]);
    }
    if (Object.keys(consents).length) { imported = true; console.log(`[seed] consents: ${Object.keys(consents).length} imported`); }
  }
  // No seed for payonce_buyer_agent: the record exists only once the
  // buyer agent is registered on chain (registerBuyerAgent); there is no
  // committed seed file for it.
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

// ---- receipts (keyed by (seller, payable_id) — §4.2) ----
export async function loadReceipts() {
  const r = await getPool().query('SELECT seller, payable_id, payload FROM payonce_receipts');
  return Object.fromEntries(r.rows.map((row) => [`${row.seller}:${row.payable_id}`, row.payload]));
}
export async function saveReceipt(receipt) {
  await getPool().query(
    'INSERT INTO payonce_receipts (seller, payable_id, payload, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (seller, payable_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [receipt.seller ?? OWNER_ADDRESS, receipt.payable_id, receipt],
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

// ---- consents (one record per (seller, payable), keyed by seller:payableId) ----
// Main-defect fix (2026-11-25): same upsert shape as saveReceipt;
// loadConsents() returns {} when the table is empty. Second-seller
// fix-back (§4.3): the key is composite, superseding the main-defect
// fix's bare-payableId keying.
export async function loadConsents() {
  const r = await getPool().query('SELECT seller, payable_id, payload FROM payonce_consents');
  return Object.fromEntries(r.rows.map((row) => [`${row.seller}:${row.payable_id}`, row.payload]));
}
export async function saveConsent(record) {
  await getPool().query(
    'INSERT INTO payonce_consents (seller, payable_id, payload, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (seller, payable_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [record.seller ?? OWNER_ADDRESS, record.payableId, record],
  );
}

// ---- buyer agent (single row, id = 1) ----
// Main-defect fix (2026-11-25): same single-row shape as the counters
// table; loadBuyerAgent() returns null when never registered.
export async function loadBuyerAgent() {
  const r = await getPool().query('SELECT payload FROM payonce_buyer_agent WHERE id = 1');
  return r.rows[0]?.payload ?? null;
}
export async function saveBuyerAgent(record) {
  await getPool().query(
    'INSERT INTO payonce_buyer_agent (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
    [record],
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
