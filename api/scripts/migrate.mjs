// PayOnce API — one-shot data migration: OLD Render Postgres -> NEW Render Postgres.
// Runs as a Render Job on the new API service (inside Render's network; the VM
// cannot reach Render Postgres directly — the egress proxy kills TLS).
//   Env: OLD_DB_URL (old DB external connection string), DATABASE_URL (new DB).
//   node api/scripts/migrate.mjs
// Idempotent: per table, CREATE-if-missing from the old DDL, TRUNCATE, COPY all
// rows, then verify row counts + an md5 checksum over deterministically
// serialised rows. Exits non-zero on any mismatch. Prints table names + counts
// only — never row contents (rows can hold wallet material) and never
// connection strings.
import { createHash } from 'node:crypto';
import pg from 'pg';

const OLD_URL = process.env.OLD_DB_URL ?? '';
const NEW_URL = process.env.DATABASE_URL ?? '';
if (!OLD_URL || !NEW_URL) {
  console.error('[migrate] FATAL: OLD_DB_URL and DATABASE_URL must both be set');
  process.exit(2);
}

const oldPool = new pg.Pool({
  connectionString: OLD_URL,
  ssl: { rejectUnauthorized: false }, // old DB via its external URL: TLS required
  max: 2,
  connectionTimeoutMillis: 15_000,
});
const newPool = new pg.Pool({
  connectionString: NEW_URL, // new DB via its internal URL: same as the API server
  max: 2,
  connectionTimeoutMillis: 15_000,
});

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

async function listTables(pool) {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

async function describeTable(pool, table) {
  const cols = await pool.query(
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr
     FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [table],
  );
  const pk = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
     WHERE conrelid = $1::regclass AND contype = 'p'`,
    [table],
  );
  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return { columns: cols.rows, pk: pk.rows[0]?.def ?? null, indexes: idx.rows };
}

function pkColumns(desc) {
  if (!desc.pk) return null;
  const m = desc.pk.match(/\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

// A nextval() default on a bigint/integer/smallint column is a serial: replay
// it as the serial pseudo-type (which creates its own sequence) instead of
// replaying the nextval() that names a sequence that does not exist yet.
function columnDef(c) {
  const nextval = /^nextval\('[^']+'::regclass\)$/.test(c.default_expr ?? '');
  if (nextval) {
    const serial = { bigint: 'BIGSERIAL', integer: 'SERIAL', smallint: 'SMALLSERIAL' }[c.type];
    if (serial) return `${q(c.name)} ${serial}${c.notnull ? ' NOT NULL' : ''}`;
  }
  let s = `${q(c.name)} ${c.type}`;
  if (c.default_expr) s += ` DEFAULT ${c.default_expr}`;
  if (c.notnull) s += ' NOT NULL';
  return s;
}

function buildCreate(table, desc) {
  const parts = desc.columns.map(columnDef);
  if (desc.pk) parts.push(desc.pk);
  return `CREATE TABLE IF NOT EXISTS ${q(table)} (${parts.join(', ')})`;
}

async function copyTable(table) {
  const desc = await describeTable(oldPool, table);
  const cols = desc.columns.map((c) => c.name);
  const orderCols = pkColumns(desc) ?? cols;
  const orderBy = orderCols.map(q).join(', ');

  await newPool.query(buildCreate(table, desc));
  for (const ix of desc.indexes) {
    if (ix.indexname.endsWith('_pkey')) continue; // created by the PK constraint
    await newPool.query(ix.indexdef.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));
  }

  const oldRows = (await oldPool.query(`SELECT * FROM ${q(table)} ORDER BY ${orderBy}`)).rows;
  const oldMd5 = checksum(oldRows);

  await newPool.query(`TRUNCATE TABLE ${q(table)} RESTART IDENTITY`);
  const BATCH = 200;
  for (let i = 0; i < oldRows.length; i += BATCH) {
    const batch = oldRows.slice(i, i + BATCH);
    const placeholders = [];
    const values = [];
    batch.forEach((row, bi) => {
      placeholders.push(`(${cols.map((_, ci) => `$${bi * cols.length + ci + 1}`).join(', ')})`);
      for (const c of cols) values.push(row[c] ?? null);
    });
    await newPool.query(
      `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  // Fix serial sequences after explicit-id COPY (e.g. payonce_ledger.id).
  for (const c of desc.columns) {
    if (/^nextval\('[^']+'::regclass\)$/.test(c.default_expr ?? '')) {
      await newPool.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${q(c.name)}) FROM ${q(table)}), 1))`,
        [table, c.name],
      );
    }
  }

  const newCount = (await newPool.query(`SELECT COUNT(*)::int AS n FROM ${q(table)}`)).rows[0].n;
  const newRows = (await newPool.query(`SELECT * FROM ${q(table)} ORDER BY ${orderBy}`)).rows;
  const newMd5 = checksum(newRows);
  const ok = newCount === oldRows.length && newMd5 === oldMd5;
  console.log(`[migrate] ${ok ? 'PASS' : 'FAIL'} ${table} old=${oldRows.length} new=${newCount} old_md5=${oldMd5} new_md5=${newMd5}`);
  return ok;
}

const oldTables = await listTables(oldPool);
const newTables = await listTables(newPool);
console.log(`[migrate] old tables (${oldTables.length}): ${oldTables.join(', ')}`);
console.log(`[migrate] new tables (${newTables.length}): ${newTables.join(', ')}`);
const extra = newTables.filter((t) => !oldTables.includes(t));
if (extra.length) console.log(`[migrate] NOTE new-only tables left untouched: ${extra.join(', ')}`);

let allOk = true;
for (const table of oldTables) {
  try {
    if (!(await copyTable(table))) allOk = false;
  } catch (e) {
    console.error(`[migrate] FAIL ${table}: ${e.message}`);
    allOk = false;
  }
}

await oldPool.end();
await newPool.end();
console.log(allOk ? '[migrate] ALL TABLES PASS' : '[migrate] MISMATCH — see FAIL lines above');
process.exit(allOk ? 0 : 1);
