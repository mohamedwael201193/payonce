// PayOnce API server — persistence backend selection (JSON vs Postgres).
//   - No DATABASE_URL (or PAYONCE_STORE=json): the original JSON-file store
//     under api/data/ (local dev + unit tests). State is lost on a Render
//     restart — that is the pre-existing behaviour, kept only for dev.
//   - DATABASE_URL set: Render Postgres (payonce-db, paid Basic 256MB).
//     The server FAILS FAST at startup when the DB is unreachable — it
//     never silently falls back to the ephemeral JSON store, because a
//     silent fallback is exactly how the 2026-11-24 receipt defect
//     happened (state lost, receipts 404, stats reset).
// DATABASE_URL is read from the environment only (Render env var). It is
// never printed, logged, or written to a file by this module.
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const FORCE_JSON = (process.env.PAYONCE_STORE ?? '').toLowerCase() === 'json';

export function isPostgres() {
  return !FORCE_JSON && DATABASE_URL.length > 0;
}
export function storeKind() {
  return isPostgres() ? 'postgres' : 'json';
}

let pool = null;
export function getPool() {
  if (!isPostgres()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 5, // Basic 256MB allows 100 connections; 5 is plenty for one Node process
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  }
  return pool;
}

export async function closeStore() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Test seam (pg-mem validation + CI only): replace the pool with a
 *  provided one. Production never calls it. */
export function setPoolForTest(p) {
  pool = p;
}

let initPromise = null;
/** Connect + migrate + seed (Postgres) or no-op (JSON). Idempotent; the
 *  same promise is returned to every caller. Rejects when Postgres was
 *  selected but is unreachable — callers must fail loudly on that. */
export function initStore() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  if (!isPostgres()) {
    console.log('[store] backend=json (no DATABASE_URL; local dev only — state is ephemeral on Render)');
    return { kind: 'json', seeded: false };
  }
  const pgstore = await import('./pgstore.mjs');
  await pgstore.ensureSchema();
  const seeded = await pgstore.seedIfEmpty();
  console.log(`[store] backend=postgres (DATABASE_URL set) seed=${seeded ? 'imported-from-api/data' : 'already-present'}`);
  return { kind: 'postgres', seeded };
}
