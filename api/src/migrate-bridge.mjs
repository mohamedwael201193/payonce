// PayOnce API — TEMPORARY HTTP migration bridge (one-shot, user-approved).
// Added 2026-11-25 for the Render move (Ffcvv workspace -> 0xelan
// workspace). Direct DB-to-DB copy is PROVEN impossible from inside
// Render (the public Postgres gateway terminates TLS; internal hostnames
// are account-scoped), so the VM pulls a dump from the old API over
// HTTPS and pushes it to the new API over HTTPS instead.
//   POST /api/migrate/export  -> { tables: { name: { count, md5, rows } } }
//   POST /api/migrate/import  -> { tables: { name: { rows } } } (TRUNCATE + INSERT, then re-read counts + md5)
// Both require header X-Migration-Token equal to env MIGRATION_TOKEN.
// Any other caller gets the generic 404 — the route does not leak its
// existence (no distinct 401 body). When MIGRATION_TOKEN is unset the
// routes do not exist at all.
// REMOVE THIS FILE + its two routes in server.mjs + the MIGRATION_TOKEN
// env var from both services immediately after the migration verifies.
// The dump holds testnet payables/receipts/jobs/counters only — the
// seed phrase / private key are env vars, never DB rows. Tables are the
// six payonce_* tables from pgstore.mjs; the payables themselves live on
// chain and are not copied.
import { createHash, timingSafeEqual } from 'node:crypto';
import { getPool } from './db.mjs';

const TABLES = [
  { name: 'payonce_counters', orderBy: '"id"' },
  { name: 'payonce_jobs', orderBy: '"job_id"' },
  { name: 'payonce_receipts', orderBy: '"payable_id"' },
  { name: 'payonce_documents', orderBy: '"payable_id"' },
  { name: 'payonce_ledger', orderBy: '"id"' },
  { name: 'payonce_rate_hits', orderBy: '"key", "window_start"' },
];

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Deterministic serialisation for checksums: sorted keys, Dates as ISO strings.
function stable(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('hex') };
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

function checksum(rows) {
  const h = createHash('md5');
  for (const row of rows) h.update(`${JSON.stringify(stable(row))}\n`);
  return h.digest('hex');
}

// Unwrap a top-level column value that travelled as a {$date} / {$bytes}
// marker. Nested objects (JSONB payloads) pass through untouched, so a
// payload that legitimately contains such a key is never rewritten.
function unwrapTop(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$date') return new Date(value.$date);
    if (keys.length === 1 && keys[0] === '$bytes') return Buffer.from(value.$bytes, 'hex');
  }
  return value;
}

function authorized(req) {
  const token = process.env.MIGRATION_TOKEN ?? '';
  if (!token) return false;
  const header = req.headers['x-migration-token'];
  if (typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMigrateHandlers({ readBody, sendJson, notFound, badRequest }) {
  async function handleMigrateExport(req, res) {
    if (!authorized(req)) return notFound(res);
    const pool = getPool();
    if (!pool) return notFound(res);
    const tables = {};
    for (const { name, orderBy } of TABLES) {
      const rows = (await pool.query(`SELECT * FROM ${q(name)} ORDER BY ${orderBy}`)).rows;
      tables[name] = { count: rows.length, md5: checksum(rows), rows };
    }
    sendJson(res, 200, { tables });
  }

  async function handleMigrateImport(req, res) {
    if (!authorized(req)) return notFound(res);
    const pool = getPool();
    if (!pool) return notFound(res);
    const body = await readBody(req, 16 * 1024 * 1024);
    const incoming = body?.tables;
    if (!incoming || typeof incoming !== 'object') return badRequest(res, 'import needs { tables: { <name>: { rows: [...] } } }.');
    const result = {};
    for (const { name, orderBy } of TABLES) {
      const t = incoming[name];
      if (!t || !Array.isArray(t.rows)) return badRequest(res, `import needs tables.${name}.rows (array).`);
      const rows = t.rows.map((r) => {
        const out = {};
        for (const [k, v] of Object.entries(r)) out[k] = unwrapTop(v);
        return out;
      });
      await pool.query(`TRUNCATE TABLE ${q(name)} RESTART IDENTITY`);
      if (rows.length) {
        const cols = Object.keys(rows[0]);
        const BATCH = 200;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const placeholders = [];
          const values = [];
          batch.forEach((row, bi) => {
            placeholders.push(`(${cols.map((_, ci) => `$${bi * cols.length + ci + 1}`).join(', ')})`);
            for (const c of cols) values.push(row[c] ?? null);
          });
          await pool.query(
            `INSERT INTO ${q(name)} (${cols.map(q).join(', ')}) VALUES ${placeholders.join(', ')}`,
            values,
          );
        }
      }
      if (name === 'payonce_ledger') {
        await pool.query(`SELECT setval(pg_get_serial_sequence('payonce_ledger', 'id'), COALESCE((SELECT MAX("id") FROM "payonce_ledger"), 1))`);
      }
      const fresh = (await pool.query(`SELECT * FROM ${q(name)} ORDER BY ${orderBy}`)).rows;
      result[name] = { inserted: rows.length, count: fresh.length, md5: checksum(fresh) };
    }
    sendJson(res, 200, { ok: true, tables: result });
  }

  return { handleMigrateExport, handleMigrateImport };
}
